import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LlmOptions, LlmStreamChunk, RunLlmApi } from "@openadminos/agent-sdk";
import { CliEvents, CliProviderError, cliFailure, cliProviderEnv, discoverCli, requireCliVersion, type CliProbe } from "./cli-provider.js";
import { CliRpc, rpcObject } from "./cli-rpc.js";

export interface CopilotProviderOptions { binaryPath?: string; defaultModel?: string; timeoutMs?: number; }

/**
 * Copilot Fusion tiers as OpenAdminOS model ids. The CLI takes the virtual
 * model `fusion` plus a tier; each tier is offered as its own model so the
 * existing pickers, pins and policy checks work unchanged.
 */
const FUSION_TIERS = {
  "fusion-standard": { tier: "standard", label: "Copilot Fusion Standard", needs: "" },
  "fusion-high": { tier: "high", label: "Copilot Fusion High", needs: " Fusion High needs a Copilot Pro+, Max, Business or Enterprise plan." },
  "fusion-max": { tier: "max", label: "Copilot Fusion Max", needs: " Fusion Max needs a Copilot Max, Business or Enterprise plan." },
} as const;
type FusionModel = keyof typeof FUSION_TIERS;

export function copilotFusionTier(model: string | undefined): "standard" | "high" | "max" | undefined {
  return model && Object.hasOwn(FUSION_TIERS, model) ? FUSION_TIERS[model as FusionModel].tier : undefined;
}

/**
 * The regular models a `models.list` result lists, named as the catalog
 * names them (MAI Code 2 rather than mai-code-2). A model the organization's
 * Copilot policy turns off is listed as unavailable, never as a model.
 */
export function copilotModelsFromCatalog(catalog: Record<string, unknown>): { models: string[]; modelLabels: Record<string, string>; unavailableModels: { id: string; reason: string }[] } {
  const models: string[] = [], modelLabels: Record<string, string> = {}, unavailableModels: { id: string; reason: string }[] = [];
  for (const entry of (Array.isArray(catalog.models) ? catalog.models : []).map(rpcObject)) {
    const id = entry.id;
    if (typeof id !== "string" || !id || id.length >= 150 || models.includes(id)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name && name !== id && name.length <= 80) modelLabels[id] = name;
    if (rpcObject(entry.policy).state === "disabled") unavailableModels.push({ id, reason: "Turned off by your organization's Copilot policy. Ask your GitHub admin to enable it, then refresh providers." });
    else models.push(id);
  }
  return { models, modelLabels, unavailableModels };
}

/** The Fusion tiers a `models.list` result advertises: enabled ones as models, the rest as unavailable with a reason. */
export function fusionModelsFromCatalog(catalog: Record<string, unknown>, regularModels: readonly string[] = []): Pick<CliProbe, "models" | "modelLabels" | "unavailableModels"> {
  const tiers = rpcObject(catalog.auto).tiers;
  const models: string[] = [], modelLabels: Record<string, string> = {}, unavailableModels: { id: string; reason: string }[] = [];
  for (const [id, entry] of Object.entries(FUSION_TIERS) as [FusionModel, (typeof FUSION_TIERS)[FusionModel]][]) {
    if (regularModels.includes(id)) continue;
    const descriptor = (Array.isArray(tiers) ? tiers : []).map(rpcObject).find((tier) => tier.fusionTier === entry.tier);
    if (!descriptor) continue;
    const status = rpcObject(descriptor.status);
    if (status.pickerVisible === false) continue;
    modelLabels[id] = entry.label;
    if (status.enabled === true) models.push(id);
    else unavailableModels.push({
      id,
      reason: status.reason === "user_not_eligible"
        ? `Not included in your Copilot plan.${entry.needs}`
        : "Not available for this account. Check your Copilot plan and organization policy, then refresh providers.",
    });
  }
  return { models, modelLabels, unavailableModels };
}
/**
 * For the first-launch scan: whether the Copilot CLI is installed, from its
 * `--version` only. It never starts the CLI's RPC server, so no sign-in or
 * model catalog request reaches GitHub; the sign-in is checked when the
 * admin selects Copilot.
 */
export async function probeCopilotInstallation(options: { binaryPath?: string; signal?: AbortSignal } = {}): Promise<CliProbe> {
  try {
    const detected = await discoverCli("copilot", cliProviderEnv("copilot"), options.binaryPath, options.signal);
    return { installed: true, ready: false, ...detected, models: [], detail: "Installed. OpenAdminOS checks its sign-in when you select it." };
  } catch (error) {
    const failure = error instanceof CliProviderError ? error.failure : "request-failed";
    return { installed: failure !== "not-installed", ready: false, failure, models: [], detail: error instanceof Error ? error.message : "Copilot could not be checked." };
  }
}

export async function probeCopilotLlm(options: CopilotProviderOptions = {}): Promise<CliProbe> {
  let detected: { binaryPath: string; version: string } | undefined;
  let rpc: CliRpc | undefined;
  const folder = await mkdtemp(join(tmpdir(), "openadminos-copilot-probe-"));
  try {
    const env = cliProviderEnv("copilot");
    detected = await discoverCli("copilot", env, options.binaryPath);
    requireCliVersion(detected.version, "1.0.83", "GitHub Copilot");
    rpc = new CliRpc(detected.binaryPath, env, folder);
    await rpc.request("ping");
    const auth = await rpc.request("auth.getStatus");
    if (auth.isAuthenticated !== true) throw new CliProviderError("signed-out", "Sign in with `copilot login`, then refresh providers.");
    const catalog = await rpc.request("models.list");
    const listed = copilotModelsFromCatalog(catalog);
    // Fusion tiers follow the regular models, so a CLI default stays the first choice. Copilot Free lists only Fusion.
    const fusion = fusionModelsFromCatalog(catalog, [...listed.models, ...listed.unavailableModels.map((m) => m.id)]);
    const models = [...listed.models, ...fusion.models];
    const modelLabels = { ...listed.modelLabels, ...fusion.modelLabels };
    const unavailableModels = [...listed.unavailableModels, ...(fusion.unavailableModels ?? [])];
    const fusionFacts = {
      ...(Object.keys(modelLabels).length ? { modelLabels } : {}),
      ...(unavailableModels.length ? { unavailableModels } : {}),
    };
    // With nothing selectable, the tiers the plan lacks still say why.
    if (!models.length) return { installed: true, ready: false, ...detected, failure: "access-denied", models: [], detail: "Copilot sign-in was detected but no models are available. Check your Copilot access and organization policy.", ...fusionFacts };
    return { installed: true, ready: true, ...detected, models, detail: "Signed in through GitHub Copilot CLI. Use Test to verify a completion.", ...fusionFacts };
  } catch (error) {
    const failure = error instanceof CliProviderError ? error.failure : "request-failed";
    return { installed: failure !== "not-installed", ready: false, ...detected, failure, models: [], detail: error instanceof Error ? error.message : "Copilot could not be checked. Refresh providers to retry." };
  } finally { await rpc?.dispose(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

export function createCopilotLlm(options: CopilotProviderOptions = {}): RunLlmApi {
  return {
    available: true, defaultModel: options.defaultModel, streamsIncrementally: true,
    async complete(input) {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(input)) last = chunk;
      if (!last?.done) throw new Error("Copilot did not return a complete answer.");
      return { text: last.accumulated, model: last.model };
    },
    async *stream(input: LlmOptions) {
      input.signal?.throwIfAborted();
      const env = cliProviderEnv("copilot");
      const detected = await discoverCli("copilot", env, options.binaryPath);
      requireCliVersion(detected.version, "1.0.83", "GitHub Copilot");
      const folder = await mkdtemp(join(tmpdir(), "openadminos-copilot-"));
      const sessionId = randomUUID();
      const rpc = new CliRpc(detected.binaryPath, env, folder);
      const events = new CliEvents<LlmStreamChunk>();
      const model = input.model ?? options.defaultModel;
      const fusionTier = copilotFusionTier(model);
      // Fusion can answer in several root messages (a draft, then a revision): the newest replaces the text,
      // and the message GitHub marks as the selected output is final. High and Max can draft and revise,
      // and GitHub shows only the final response, so their text is held until the session is idle.
      const holdDrafts = fusionTier === "high" || fusionTier === "max";
      let accumulated = "", messageId: string | undefined, done = false, committed = false;
      const stop = (error: Error) => { events.fail(error); rpc.close(error); };
      const abort = () => stop(new Error("Copilot request cancelled."));
      const timer = setTimeout(() => stop(new Error("Copilot timed out. Retry or select another model.")), options.timeoutMs ?? 120_000);
      input.signal?.addEventListener("abort", abort, { once: true });
      rpc.onError = (error) => events.fail(error);
      rpc.onEvent = (method, params) => {
        if (method !== "session.event" || params.sessionId !== sessionId) return;
        const event = rpcObject(params.event), data = rpcObject(event.data);
        if (event.type === "session.error") { stop(cliFailure("GitHub Copilot", String(data.message ?? data.errorType ?? ""))); return; }
        if (event.type === "tool.execution_start") { stop(new Error("Copilot attempted an unavailable tool. OpenAdminOS stopped the request.")); return; }
        if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") {
          if (committed) return;
          if (messageId && messageId !== data.messageId) {
            if (!fusionTier) { stop(new Error("Copilot returned an unexpected additional answer. Retry the request.")); return; }
            accumulated = "";
          }
          messageId = typeof data.messageId === "string" ? data.messageId : undefined;
          accumulated += data.deltaContent;
          if (accumulated.length > 200_000) { stop(new Error("Copilot answer exceeded the output limit. Narrow the question.")); return; }
          if (!holdDrafts) events.push({ delta: data.deltaContent, accumulated, done: false, model: model ?? "copilot-default" });
        }
        if (event.type === "assistant.message" && typeof data.content === "string") {
          if (data.content.length > 200_000) { stop(new Error("Copilot answer exceeded the output limit. Narrow the question.")); return; }
          if (fusionTier) {
            if (committed) return;
            const commitId = rpcObject(data.fusion).commitId;
            committed = typeof commitId === "string" && commitId.length > 0;
            messageId = typeof data.messageId === "string" ? data.messageId : undefined;
            if (data.content !== accumulated) { accumulated = data.content; if (!holdDrafts) events.push({ delta: "", accumulated, done: false, model: model ?? "copilot-default" }); }
          } else if (!accumulated) { accumulated = data.content; events.push({ delta: accumulated, accumulated, done: false, model: model ?? "copilot-default" }); }
        }
        if (event.type === "session.idle") {
          if (holdDrafts && accumulated) events.push({ delta: accumulated, accumulated, done: false, model: model ?? "copilot-default" });
          done = true; events.finish();
        }
      };
      try {
        input.signal?.throwIfAborted();
        await rpc.request("ping");
        const created = await rpc.request("session.create", {
          sessionId, ...(fusionTier ? { model: "fusion", capi: { fusionTier } } : model ? { model } : {}), clientName: "OpenAdminOS", workingDirectory: folder, configDir: folder,
          systemMessage: { mode: "replace", content: input.system ?? "Answer the user's question using only the supplied context. Do not execute actions." },
          availableTools: [], tools: [], customAgents: [], mcpServers: {}, streaming: true,
          enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false, enableHostGitOperations: false,
          enableSessionStore: false, enableSessionTelemetry: false, enableOnDemandInstructionDiscovery: false,
          skillDirectories: [], pluginDirectories: [], instructionDirectories: [], requestPermission: false,
          requestUserInput: false, remoteSession: "off", infiniteSessions: { enabled: false }, memory: { enabled: false },
        });
        // A CLI that ignores the tier would answer with another one; stop rather than mislabel the answer.
        if (fusionTier && rpcObject(created.modelState).fusionTier !== fusionTier) {
          throw new Error(`Copilot did not start ${FUSION_TIERS[model as FusionModel].label}. Update the Copilot CLI with \`copilot update\`, then test again.`);
        }
        await rpc.request("session.send", { sessionId, prompt: input.prompt });
        for await (const chunk of events) yield chunk;
        if (!done || !accumulated.trim()) throw new Error("Copilot finished without an answer. Test the provider in Settings.");
        yield { delta: "", accumulated, done: true, model: model ?? "copilot-default" };
      } finally {
        clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
        // Delete only the session we created, including any CLI session-state files.
        await rpc.request("session.delete", { sessionId }, 1500).catch(() => {});
        await rpc.dispose(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}
