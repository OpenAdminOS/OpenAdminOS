import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type {
  ModelScanOutcome,
  ModelScanProbe,
  ProviderId,
  ProviderSummary,
} from "@openadminos/agent-sdk";
import {
  classifyLmStudioEndpoint,
  classifyOllamaEndpoint,
  resolveLmStudioEndpoint,
  resolveOllamaEndpoint,
} from "@openadminos/runtime";

import { LOCAL_AUTO_SELECT_ORDER, isProviderReady } from "../src/shared/provider-detection.js";

/**
 * The first-launch model scan (SPEC.md 4a, first launch). Every check runs
 * in parallel and resolves on its own, each within a short timeout, so the
 * whole scan finishes in about two to three seconds. A check that does not
 * answer in time reports "could not check" with a retry, never a gap.
 *
 * Local only: a check reads local files, runs a local CLI's own version and
 * sign-in status commands, or calls a loopback port. An Ollama or LM Studio
 * endpoint that points off the device is not contacted, and no prompt is
 * sent to any provider.
 */

export const MODEL_SCAN_TIMEOUT_MS = 2_500;
export const MODEL_SCAN_RETRY_TIMEOUT_MS = 10_000;

export interface ModelScanCheck {
  providerId: ProviderId;
  name: string;
  where: "local" | "hosted";
  run(signal: AbortSignal): Promise<ModelScanProbe>;
}

export function checkingProbe(check: Pick<ModelScanCheck, "providerId" | "name" | "where">): ModelScanProbe {
  return { providerId: check.providerId, name: check.name, where: check.where, state: "checking", summary: "Checking", facts: [], ready: false, models: [] };
}

/** Runs one check within `timeoutMs`; a timeout or an error is a designed state. */
export async function runScanCheck(check: ModelScanCheck, timeoutMs: number, now: () => number = Date.now): Promise<ModelScanProbe> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([check.run(controller.signal), timeout]);
    if (result === "timeout") {
      return {
        ...checkingProbe(check),
        state: "could-not-check",
        summary: "Could not check",
        facts: [`${check.name} did not answer within ${formatSeconds(timeoutMs)}. Retry to check again.`],
        durationMs: now() - started,
      };
    }
    return { ...result, durationMs: now() - started };
  } catch (error) {
    return {
      ...checkingProbe(check),
      state: "could-not-check",
      summary: "Could not check",
      facts: [error instanceof Error && error.message ? error.message : `${check.name} could not be checked. Retry to check again.`],
      durationMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every check in parallel and reports each one as it resolves. */
export async function runModelScan(input: {
  checks: readonly ModelScanCheck[];
  timeoutMs?: number;
  onProbe?: (probe: ModelScanProbe) => void;
  now?: () => number;
}): Promise<ModelScanProbe[]> {
  const timeoutMs = input.timeoutMs ?? MODEL_SCAN_TIMEOUT_MS;
  for (const check of input.checks) input.onProbe?.(checkingProbe(check));
  return Promise.all(
    input.checks.map(async (check) => {
      const probe = await runScanCheck(check, timeoutMs, input.now);
      input.onProbe?.(probe);
      return probe;
    }),
  );
}

const OPENADMIN_8B = /(^|\/)openadmin-8b(:|$)/;

export function hasOpenAdmin8B(models: readonly string[]): boolean {
  return models.some((model) => OPENADMIN_8B.test(model));
}

/**
 * What the scan leads to, under the existing provider rules: a ready local
 * provider is selected automatically for an admin who never chose one;
 * a ready hosted provider is only offered, never selected.
 */
export function scanOutcome(
  providers: readonly ProviderSummary[],
  input: { activeProviderId: ProviderId; providerChosenByUser: boolean; pilot?: boolean },
): ModelScanOutcome {
  const active = providers.find((provider) => provider.id === input.activeProviderId);
  const preferredModel = (provider: ProviderSummary) =>
    provider.models.find((model) => OPENADMIN_8B.test(model)) ?? provider.defaultModel ?? provider.models[0];
  if (active && active.isLocal && isProviderReady(active)) {
    const model = preferredModel(active);
    return { kind: "local-ready", providerId: active.id, ...(model ? { model } : {}) };
  }
  for (const id of LOCAL_AUTO_SELECT_ORDER) {
    const candidate = providers.find((provider) => provider.id === id);
    if (candidate?.isLocal !== true || !isProviderReady(candidate)) continue;
    const model = preferredModel(candidate);
    return {
      kind: input.providerChosenByUser || input.pilot ? "local-ready" : "local-selected",
      providerId: candidate.id,
      ...(model ? { model } : {}),
    };
  }
  const hosted = providers.filter((provider) => !provider.isLocal && isProviderReady(provider)).map((provider) => provider.id);
  return hosted.length > 0 ? { kind: "hosted-detected", providerIds: hosted } : { kind: "nothing" };
}

/** Names as the admin knows them. */
export const SCAN_NAMES: Readonly<Record<ProviderId, string>> = {
  ollama: "Ollama",
  "lm-studio": "LM Studio",
  "apple-foundation": "Apple Intelligence",
  anthropic: "Claude Code",
  openai: "Codex",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
  "azure-openai": "Azure OpenAI",
};

/** Turns an existing provider check into a scan result line. */
export function scanProbeFromProvider(
  provider: ProviderSummary,
  extra: { installedOnDisk?: boolean } = {},
): ModelScanProbe {
  const base = {
    providerId: provider.id,
    name: SCAN_NAMES[provider.id] ?? provider.name,
    where: provider.isLocal ? ("local" as const) : ("hosted" as const),
    models: provider.models,
  };
  const ready = isProviderReady(provider);
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  if (provider.id === "ollama" || provider.id === "lm-studio") {
    const openAdmin = provider.id === "ollama" && hasOpenAdmin8B(provider.models);
    if (ready) {
      return {
        ...base,
        state: "found",
        ready,
        summary: `Running, ${count(provider.models.length, "model", "models")}`,
        facts: [
          ...(openAdmin ? ["OpenAdmin 8B is on this device."] : provider.id === "ollama" ? ["OpenAdmin 8B is not pulled yet."] : []),
          ...provider.models.slice(0, 4),
        ],
        ...(provider.id === "ollama" ? { hasOpenAdmin8B: openAdmin } : {}),
      };
    }
    if (provider.status === "error") {
      return { ...base, state: "found", ready: false, summary: "Running, no text model", facts: [provider.detail ?? "Install a text-generation model, then scan again."], ...(provider.id === "ollama" ? { hasOpenAdmin8B: false } : {}) };
    }
    if (extra.installedOnDisk) {
      return {
        ...base,
        state: "found",
        ready: false,
        summary: "Installed, not running",
        facts: [provider.id === "ollama" ? "Start it with `ollama serve`, then scan again." : "Start the LM Studio server, then scan again."],
      };
    }
    return { ...base, state: "not-found", ready: false, summary: "Not installed", facts: [] };
  }

  if (provider.id === "apple-foundation") {
    return ready
      ? { ...base, state: "found", ready, summary: "Ready on this Mac", facts: provider.models.slice(0, 1) }
      : { ...base, state: "not-found", ready: false, summary: "Not available", facts: provider.detail ? [provider.detail] : [] };
  }

  if (provider.id === "azure-openai") {
    return ready
      ? { ...base, state: "found", ready, summary: "Deployment configured", facts: provider.models.slice(0, 1) }
      : { ...base, state: "not-found", ready: false, summary: "Not configured", facts: [] };
  }

  // Hosted CLIs: the CLI's own version and sign-in status, never a model call.
  const cliState = provider.cli?.state;
  if (provider.status === "not-installed" || cliState === "not-installed") {
    return { ...base, state: "not-found", ready: false, summary: "Not installed", facts: [] };
  }
  const version = provider.cli?.version ? [`Version ${provider.cli.version}`] : [];
  if (ready) return { ...base, state: "found", ready, summary: "Signed in", facts: version };
  if (cliState === "signed-out") return { ...base, state: "found", ready: false, summary: "Installed, not signed in", facts: [...version, ...(provider.detail ? [provider.detail] : [])] };
  return { ...base, state: "found", ready: false, summary: "Installed, sign-in not confirmed", facts: [...version, ...(provider.detail ? [provider.detail] : [])] };
}

/** Whether a runtime is installed, from local files only: a binary on PATH or a known app location. */
export async function installedOnDisk(providerId: "ollama" | "lm-studio", env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const binary = providerId === "ollama" ? "ollama" : "lms";
  const names = platform === "win32" ? [`${binary}.exe`] : [binary];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const known =
    providerId === "ollama"
      ? platform === "darwin"
        ? ["/Applications/Ollama.app", "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
        : platform === "win32"
          ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Ollama", "ollama.exe")]
          : ["/usr/local/bin/ollama", "/usr/bin/ollama"]
      : platform === "darwin"
        ? ["/Applications/LM Studio.app", join(home, ".lmstudio", "bin", "lms")]
        : platform === "win32"
          ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "LM Studio", "LM Studio.exe"), join(home, ".lmstudio", "bin", "lms.exe")]
          : [join(home, ".lmstudio", "bin", "lms")];
  const candidates = [...known, ...pathDirs.flatMap((dir) => names.map((name) => join(dir, name)))];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Not here.
    }
  }
  return false;
}

/**
 * The checks for this device, built on the existing provider detection.
 * `check(providerId)` runs that provider's existing check; endpoints that
 * point off the device are refused here before it runs.
 */
export function buildModelScanChecks(input: {
  catalog: readonly ProviderSummary[];
  check: (providerId: ProviderId, signal: AbortSignal) => Promise<ProviderSummary>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Whether Ollama or LM Studio is installed, from local files. Injected in tests. */
  onDisk?: (providerId: "ollama" | "lm-studio") => Promise<boolean>;
}): ModelScanCheck[] {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  return input.catalog
    .filter((provider) => provider.id !== "apple-foundation" || platform === "darwin")
    .map((provider): ModelScanCheck => {
      const meta = { providerId: provider.id, name: SCAN_NAMES[provider.id] ?? provider.name, where: provider.isLocal ? "local" as const : "hosted" as const };
      return {
        ...meta,
        async run(signal) {
          if (provider.id === "ollama" || provider.id === "lm-studio") {
            const endpoint = provider.id === "ollama" ? resolveOllamaEndpoint() : resolveLmStudioEndpoint();
            const trust = provider.id === "ollama" ? classifyOllamaEndpoint(endpoint) : classifyLmStudioEndpoint(endpoint);
            if (!trust.isLocal) {
              return {
                ...checkingProbe(meta),
                state: "could-not-check",
                summary: "Endpoint outside this device",
                facts: [`${meta.name} is set to ${endpoint}. The scan only checks this device. Check it in Settings, Providers.`],
              };
            }
            const [summary, onDisk] = await Promise.all([
              input.check(provider.id, signal),
              input.onDisk ? input.onDisk(provider.id) : installedOnDisk(provider.id, env, platform),
            ]);
            return scanProbeFromProvider(summary, { installedOnDisk: onDisk });
          }
          return scanProbeFromProvider(await input.check(provider.id, signal));
        },
      };
    });
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds`;
}
