import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type {
  ModelScanOutcome,
  ModelScanProbe,
  ProviderId,
  ProviderSummary,
} from "@openadminos/agent-sdk";
import { resolveProviderDefaultModel } from "@openadminos/agent-sdk";
import {
  classifyLmStudioEndpoint,
  classifyOllamaEndpoint,
  resolveLmStudioEndpoint,
  resolveOllamaEndpoint,
} from "@openadminos/runtime";

import { LOCAL_AUTO_SELECT_ORDER, isProviderReady } from "../src/shared/provider-detection.js";
import { checkAdditionalCli, checkAppleFoundation, checkClaudeCode, checkCodex, checkLmStudio, checkOllama } from "./provider-detail.js";

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
/** An HTTP check's own timeout: just under the timeout of the check it runs in, so it fails as a timeout first. */
const httpBudget = (checkTimeoutMs: number) => Math.max(checkTimeoutMs - 200, 100);

export interface ModelScanCheck {
  providerId: ProviderId;
  name: string;
  where: "local" | "hosted";
  target: string;
  /** `timeoutMs` is this run's whole budget: the scan timeout, or the longer one on Retry. */
  run(signal: AbortSignal, timeoutMs: number): Promise<ModelScanProbe>;
}

export function checkingProbe(check: Pick<ModelScanCheck, "providerId" | "name" | "where" | "target">): ModelScanProbe {
  return { providerId: check.providerId, name: check.name, where: check.where, target: check.target, state: "checking", summary: "Checking", facts: [], ready: false, models: [] };
}

/** Exactly what each check runs or reads, shown on its row and in the closing line. */
export const SCAN_TARGETS: Readonly<Record<ProviderId, string>> = {
  ollama: "localhost:11434",
  "lm-studio": "localhost:1234",
  "apple-foundation": "Apple Foundation helper",
  anthropic: "claude --version, claude auth status",
  openai: "codex --version, codex login status",
  copilot: "copilot --version",
  gemini: "gemini --version",
  "azure-openai": "saved Azure settings",
};

function endpointTarget(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.port ? `${url.hostname === "127.0.0.1" ? "localhost" : url.hostname}:${url.port}` : url.hostname;
  } catch {
    return endpoint;
  }
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
    const result = await Promise.race([check.run(controller.signal, timeoutMs), timeout]);
    if (result === "timeout") {
      return {
        ...checkingProbe(check),
        state: "could-not-check",
        summary: "Could not check",
        facts: [`${check.name} did not answer within ${formatSeconds(timeoutMs)}. Retry to check again.`],
        durationMs: now() - started,
      };
    }
    return { ...result, target: result.target || check.target, durationMs: now() - started };
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
  input: {
    activeProviderId: ProviderId;
    providerChosenByUser: boolean;
    pilot?: boolean;
    activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  },
): ModelScanOutcome {
  const active = providers.find((provider) => provider.id === input.activeProviderId);
  // The model Chat will use: the admin's saved model when it is installed,
  // otherwise the provider's default. OpenAdmin 8B is preferred only when
  // no model was chosen for that provider and the scan sets it (or the
  // admin switches to it from the scan).
  const chatModel = (provider: ProviderSummary, prefer8B: boolean) => {
    const saved = input.activeModelByProviderId?.[provider.id];
    const openAdmin = !saved && prefer8B ? provider.models.find((model) => OPENADMIN_8B.test(model)) : undefined;
    return openAdmin ?? resolveProviderDefaultModel(provider, input.activeModelByProviderId).model;
  };
  if (active && active.isLocal && isProviderReady(active)) {
    // The scan writes a model for the active provider only for an admin who never chose one.
    const model = chatModel(active, !input.providerChosenByUser);
    return { kind: "local-ready", providerId: active.id, ...(model ? { model } : {}) };
  }
  for (const id of LOCAL_AUTO_SELECT_ORDER) {
    const candidate = providers.find((provider) => provider.id === id);
    if (candidate?.isLocal !== true || !isProviderReady(candidate)) continue;
    const model = chatModel(candidate, true);
    // The admin's own choice stays selected: a local model is only offered.
    if (input.providerChosenByUser || input.pilot) {
      return { kind: "local-available", providerId: candidate.id, ...(model ? { model } : {}), selectedProviderId: input.activeProviderId };
    }
    return { kind: "local-selected", providerId: candidate.id, ...(model ? { model } : {}) };
  }
  const hosted = providers
    .filter((provider) => !provider.isLocal && isProviderReady(provider))
    .map((provider) => provider.id)
    .sort((a, b) => SCAN_ORDER.indexOf(a) - SCAN_ORDER.indexOf(b));
  return hosted.length > 0 ? { kind: "hosted-detected", providerIds: hosted } : { kind: "nothing" };
}

/** Hosted providers are offered in this order, whatever order their checks finished in. */
const SCAN_ORDER: readonly ProviderId[] = ["ollama", "lm-studio", "apple-foundation", "anthropic", "openai", "copilot", "gemini", "azure-openai"];

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
  extra: { installedOnDisk?: boolean; target?: string } = {},
): ModelScanProbe {
  const base = {
    providerId: provider.id,
    name: SCAN_NAMES[provider.id] ?? provider.name,
    where: provider.isLocal ? ("local" as const) : ("hosted" as const),
    target: extra.target ?? SCAN_TARGETS[provider.id] ?? provider.name,
    models: provider.models,
  };
  const ready = isProviderReady(provider);
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // A check that failed is "could not check" with its reason, for every
  // provider, before any provider-specific negative such as "Not available".
  if (!ready && provider.checkFailed) {
    return { ...base, state: "could-not-check", ready: false, summary: "Could not check", facts: [provider.detail ?? `${base.name} did not answer as expected. Retry to check again.`] };
  }

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
    if (provider.status === "connected") {
      return { ...base, state: "found", ready: false, summary: "Running, no model loaded", facts: [provider.id === "ollama" ? "Pull a model, for example `ollama pull openadminos/openadmin-8b`, then scan again." : "Load a model in LM Studio, then scan again."] };
    }
    if (provider.status === "error") {
      return { ...base, state: "found", ready: false, summary: "Running, no text model", facts: [provider.detail ?? "Install a text-generation model, then scan again."], ...(provider.id === "ollama" ? { hasOpenAdmin8B: false } : {}) };
    }
    // Installed comes from the runtime's own check (also what Settings shows); a test can inject it.
    if (extra.installedOnDisk ?? provider.installed) {
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
  if (cliState === "request-failed") {
    return { ...base, state: "could-not-check", ready: false, summary: "Could not check", facts: [provider.detail ?? `${base.name} did not answer. Retry to check again.`] };
  }
  if (provider.status === "not-installed" || cliState === "not-installed") {
    return { ...base, state: "not-found", ready: false, summary: "Not installed", facts: [] };
  }
  const version = provider.cli?.version ? [`Version ${provider.cli.version}`] : [];
  if (ready) return { ...base, state: "found", ready, summary: "Signed in", facts: version };
  if (cliState === "check-required" && provider.id === "copilot") {
    return { ...base, state: "found", ready: false, summary: "Installed", facts: [...version, "OpenAdminOS checks its sign-in when you select it."] };
  }
  if (cliState === "signed-out") return { ...base, state: "found", ready: false, summary: "Installed, not signed in", facts: [...version, ...(provider.detail ? [provider.detail] : [])] };
  return { ...base, state: "found", ready: false, summary: "Installed, sign-in not confirmed", facts: [...version, ...(provider.detail ? [provider.detail] : [])] };
}

export { installedOnDisk } from "./provider-detail.js";

/**
 * The checks for this device, built on the existing provider detection.
 * `check(providerId)` runs that provider's existing check; endpoints that
 * point off the device are refused here before it runs.
 */
export function buildModelScanChecks(input: {
  catalog: readonly ProviderSummary[];
  check: (providerId: ProviderId, signal: AbortSignal, timeoutMs: number) => Promise<ProviderSummary>;
  platform?: NodeJS.Platform;
  /** Whether Ollama or LM Studio is installed, from local files. Injected in tests. */
  onDisk?: (providerId: "ollama" | "lm-studio") => Promise<boolean>;
}): ModelScanCheck[] {
  const platform = input.platform ?? process.platform;
  return input.catalog
    .filter((provider) => provider.id !== "apple-foundation" || platform === "darwin")
    .map((provider): ModelScanCheck => {
      const endpoint =
        provider.id === "ollama" ? resolveOllamaEndpoint() : provider.id === "lm-studio" ? resolveLmStudioEndpoint() : undefined;
      const meta = {
        providerId: provider.id,
        name: SCAN_NAMES[provider.id] ?? provider.name,
        where: provider.isLocal ? "local" as const : "hosted" as const,
        target: endpoint ? endpointTarget(endpoint) : SCAN_TARGETS[provider.id] ?? provider.name,
      };
      return {
        ...meta,
        async run(signal, timeoutMs) {
          if (provider.id === "ollama" || provider.id === "lm-studio") {
            const trust = provider.id === "ollama" ? classifyOllamaEndpoint(endpoint!) : classifyLmStudioEndpoint(endpoint!);
            if (!trust.isLocal) {
              return {
                ...checkingProbe(meta),
                state: "could-not-check",
                summary: "Endpoint outside this device",
                notContacted: true,
                facts: [`${meta.name} is set to ${endpoint}. The scan only checks this device. Check it in Settings, Providers.`],
              };
            }
            const [summary, onDisk] = await Promise.all([
              input.check(provider.id, signal, timeoutMs),
              input.onDisk ? input.onDisk(provider.id) : Promise.resolve(undefined),
            ]);
            return scanProbeFromProvider(summary, { ...(onDisk !== undefined ? { installedOnDisk: onDisk } : {}), target: meta.target });
          }
          return scanProbeFromProvider(await input.check(provider.id, signal, timeoutMs));
        },
      };
    });
}

/**
 * The scan's check for one provider: the existing check, limited to this
 * device, stoppable through `signal`, and for Copilot its installation
 * only. CLI checks run `--version` and the CLI's own sign-in status only.
 */
export async function scanProviderCheck(
  provider: ProviderSummary,
  options: { signal?: AbortSignal; binaryPath?: string; azure?: () => Promise<ProviderSummary>; timeoutMs?: number } = {},
): Promise<ProviderSummary> {
  const base = { ...(options.signal ? { signal: options.signal } : {}), ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}) };
  switch (provider.id) {
    // HTTP checks get the scan's budget, so their own timeout never fires first and looks like "not running".
    case "ollama":
      return checkOllama(provider, { ...base, localOnly: true, timeoutMs: httpBudget(options.timeoutMs ?? MODEL_SCAN_TIMEOUT_MS) });
    case "lm-studio":
      return checkLmStudio(provider, { ...base, localOnly: true, timeoutMs: httpBudget(options.timeoutMs ?? MODEL_SCAN_TIMEOUT_MS) });
    case "anthropic":
      return checkClaudeCode(provider, base);
    case "openai":
      return checkCodex(provider, base);
    case "copilot":
    case "gemini":
      return checkAdditionalCli(provider, { ...base, scan: true });
    case "apple-foundation":
      return checkAppleFoundation(provider, base);
    case "azure-openai":
      return options.azure ? options.azure() : { ...provider, status: "not-installed", models: [] };
    default:
      return provider;
  }
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds`;
}

/** How to start a local runtime the scan found installed but not running. Fixed commands only. */
export interface RuntimeLaunch {
  command: string;
  args: string[];
  /** The command as the admin would type it, for the failure message. */
  display: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A binary on this device. Windows looks for `.exe` first and then a `.cmd` launcher, as the install check does. */
async function findBinary(name: string, known: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, check: (path: string) => Promise<boolean>): Promise<string | undefined> {
  const files = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const candidate of [...known, ...files.flatMap((file) => pathDirs.map((dir) => join(dir, file)))]) {
    if (await check(candidate)) return candidate;
  }
  return undefined;
}

/** Whether the LM Studio app is installed, from its known app location. */
export async function lmStudioAppInstalled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  check: (path: string) => Promise<boolean> = exists,
): Promise<boolean> {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const app = platform === "darwin"
    ? "/Applications/LM Studio.app"
    : platform === "win32"
      ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "LM Studio", "LM Studio.exe")
      : undefined;
  return app ? check(app) : false;
}

/**
 * The command that starts Ollama or LM Studio on this device: the Ollama
 * app on macOS when it is installed (it runs the server), otherwise
 * `ollama serve`; LM Studio through its `lms server start` command.
 * Undefined when the runtime is not found.
 */
export async function runtimeLaunch(
  providerId: "ollama" | "lm-studio",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  check: (path: string) => Promise<boolean> = exists,
): Promise<RuntimeLaunch | undefined> {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (providerId === "ollama") {
    if (platform === "darwin" && (await check("/Applications/Ollama.app"))) {
      return { command: "open", args: ["-a", "Ollama"], display: "open -a Ollama" };
    }
    const known = platform === "win32"
      ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Ollama", "ollama.exe")]
      : ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"];
    const binary = await findBinary("ollama", known, env, platform, check);
    return binary ? { command: binary, args: ["serve"], display: "ollama serve" } : undefined;
  }
  const binary = await findBinary("lms", [join(home, ".lmstudio", "bin", platform === "win32" ? "lms.exe" : "lms")], env, platform, check);
  return binary ? { command: binary, args: ["server", "start"], display: "lms server start" } : undefined;
}

export const RUNTIME_START_TIMEOUT_MS = 12_000;

/**
 * The loopback address that answers once a started runtime is ready. The
 * LM Studio endpoint already ends in `/v1`, so its models list is
 * `${endpoint}/models`, the same address its probe reads.
 */
export function runtimeReadyUrl(providerId: "ollama" | "lm-studio", endpoint: string): string {
  const base = endpoint.replace(/\/$/, "");
  return providerId === "ollama" ? `${base}/api/tags` : `${base}/models`;
}

/**
 * Starts a local runtime and waits until its loopback endpoint answers.
 * A failure is a designed message that names the command to run by hand.
 */
export async function startLocalRuntime(input: {
  name: string;
  launch: RuntimeLaunch | undefined;
  manualCommand: string;
  /** The app is installed but the command that starts it was not found (LM Studio without `lms`). */
  appWithoutCommand?: boolean;
  spawn: (launch: RuntimeLaunch) => Promise<void>;
  isUp: () => Promise<boolean>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ started: true } | { started: false; message: string }> {
  if (!input.launch && input.appWithoutCommand) {
    return { started: false, message: `${input.name} is installed, but its \`${input.manualCommand.split(" ")[0]}\` command was not found. Start the server in ${input.name}, then scan again.` };
  }
  if (!input.launch) {
    return { started: false, message: `${input.name} was not found on this device. Start it yourself with \`${input.manualCommand}\`, then scan again.` };
  }
  try {
    await input.spawn(input.launch);
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` ${error.message.replace(/\.?$/, ".")}` : "";
    return { started: false, message: `${input.name} did not start.${reason} Start it yourself with \`${input.manualCommand}\`, then scan again.` };
  }
  const deadline = Date.now() + (input.timeoutMs ?? RUNTIME_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await input.isUp()) return { started: true };
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 400));
  }
  return {
    started: false,
    message: `${input.name} did not answer within ${formatSeconds(input.timeoutMs ?? RUNTIME_START_TIMEOUT_MS)}. Start it yourself with \`${input.manualCommand}\`, then scan again.`,
  };
}
