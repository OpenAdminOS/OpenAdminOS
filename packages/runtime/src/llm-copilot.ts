import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LlmOptions, LlmStreamChunk, RunLlmApi } from "@openadminos/agent-sdk";
import { CliEvents, CliProviderError, cliFailure, cliProviderEnv, discoverCli, requireCliVersion, type CliProbe } from "./cli-provider.js";
import { CliRpc, rpcObject } from "./cli-rpc.js";

export interface CopilotProviderOptions { binaryPath?: string; defaultModel?: string; timeoutMs?: number; }
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
    const models = (Array.isArray(catalog.models) ? catalog.models : []).map((m) => rpcObject(m).id).filter((id): id is string => typeof id === "string" && id.length < 150);
    if (!models.length) throw new CliProviderError("access-denied", "Copilot sign-in was detected but no models are available. Check your Copilot access and organization policy.");
    return { installed: true, ready: true, ...detected, models, detail: "Signed in through GitHub Copilot CLI. Use Test to verify a completion." };
  } catch (error) {
    const failure = error instanceof CliProviderError ? error.failure : "request-failed";
    return { installed: failure !== "not-installed", ready: false, ...detected, failure, models: [], detail: error instanceof Error ? error.message : "Copilot could not be checked. Refresh providers to retry." };
  } finally { await rpc?.dispose(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

export function createCopilotLlm(options: CopilotProviderOptions = {}): RunLlmApi {
  return {
    available: true, defaultModel: options.defaultModel,
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
      let accumulated = "", messageId: string | undefined, done = false;
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
          if (messageId && messageId !== data.messageId) { stop(new Error("Copilot returned an unexpected additional answer. Retry the request.")); return; }
          messageId = typeof data.messageId === "string" ? data.messageId : undefined;
          accumulated += data.deltaContent;
          if (accumulated.length > 200_000) { stop(new Error("Copilot answer exceeded the output limit. Narrow the question.")); return; }
          events.push({ delta: data.deltaContent, accumulated, done: false, model: model ?? "copilot-default" });
        }
        if (event.type === "assistant.message" && typeof data.content === "string") {
          if (data.content.length > 200_000) { stop(new Error("Copilot answer exceeded the output limit. Narrow the question.")); return; }
          if (!accumulated) { accumulated = data.content; events.push({ delta: accumulated, accumulated, done: false, model: model ?? "copilot-default" }); }
        }
        if (event.type === "session.idle") { done = true; events.finish(); }
      };
      try {
        input.signal?.throwIfAborted();
        await rpc.request("ping");
        await rpc.request("session.create", {
          sessionId, ...(model ? { model } : {}), clientName: "OpenAdminOS", workingDirectory: folder, configDir: folder,
          systemMessage: { mode: "replace", content: input.system ?? "Answer the user's question using only the supplied context. Do not execute actions." },
          availableTools: [], tools: [], customAgents: [], mcpServers: {}, streaming: true,
          enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false, enableHostGitOperations: false,
          enableSessionStore: false, enableSessionTelemetry: false, enableOnDemandInstructionDiscovery: false,
          skillDirectories: [], pluginDirectories: [], instructionDirectories: [], requestPermission: false,
          requestUserInput: false, remoteSession: "off", infiniteSessions: { enabled: false }, memory: { enabled: false },
        });
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
