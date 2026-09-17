import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmOptions, LlmStreamChunk, RunLlmApi } from "@openadminos/agent-sdk";
import { CliEvents, CliProviderError, cliFailure, cliProviderEnv, discoverCli, requireCliVersion, spawnProvider, terminateCli, type CliProbe } from "./cli-provider.js";
import { rpcObject } from "./cli-rpc.js";

export interface GeminiProviderOptions { binaryPath?: string; defaultModel?: string; timeoutMs?: number; }
// Gemini has no non-interactive auth-status command. Only an actual successful
// request marks it connected; discovering files is never proof of authentication.
const verified = new Map<string, { model: string } | CliProviderError>();
const keyFor = (binary: string, version: string) => `${binary}\0${version}\0${process.env.GEMINI_CLI_HOME ?? ""}`;
export async function probeGeminiLlm(options: GeminiProviderOptions = {}): Promise<CliProbe> {
  let detected: { binaryPath: string; version: string } | undefined;
  try {
    detected = await discoverCli("gemini", cliProviderEnv("gemini"), options.binaryPath);
    requireCliVersion(detected.version, "0.59.0", "Gemini CLI");
    const state = verified.get(keyFor(detected.binaryPath, detected.version));
    return { installed: true, ready: Boolean(state && !(state instanceof Error)), ...detected,
      models: [], ...(state instanceof CliProviderError ? { failure: state.failure } : {}),
      detail: state instanceof Error ? state.message : state ? "Last Gemini CLI request succeeded. The CLI selects its configured model." : "Gemini CLI is installed. Use Test to verify its existing sign-in and model access. To sign in, run `gemini` in a terminal." };
  } catch (error) {
    return { installed: !(error instanceof CliProviderError && error.failure === "not-installed"), ready: false, ...detected, models: [], failure: error instanceof CliProviderError ? error.failure : "request-failed", detail: error instanceof Error ? error.message : "Gemini could not be checked. Refresh providers to retry." };
  }
}

/** Highest-precedence local settings apply only to this temporary provider process. */
export const GEMINI_PROVIDER_SETTINGS = {
  tools: { core: ["__openadminos_no_tools__"], discoveryCommand: "", callCommand: "" },
  mcp: { serverCommand: "", allowed: ["__openadminos_no_servers__"] },
  admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
  hooksConfig: { enabled: false },
  context: { fileName: "__openadminos_no_context__.md", includeDirectories: [], loadMemoryFromIncludeDirectories: false },
  privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false, logPrompts: false },
  general: { maxAttempts: 1, retryFetchErrors: false },
  model: { maxSessionTurns: 1, skipNextSpeakerCheck: true },
  advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
};

export function createGeminiLlm(options: GeminiProviderOptions = {}): RunLlmApi {
  return {
    available: true, defaultModel: options.defaultModel,
    async complete(input) {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(input)) last = chunk;
      if (!last?.done) throw new Error("Gemini did not return a complete answer.");
      return { text: last.accumulated, model: last.model };
    },
    async *stream(input: LlmOptions) {
      input.signal?.throwIfAborted();
      const env = cliProviderEnv("gemini");
      const detected = await discoverCli("gemini", env, options.binaryPath);
      requireCliVersion(detected.version, "0.59.0", "Gemini CLI");
      const key = keyFor(detected.binaryPath, detected.version);
      const folder = await mkdtemp(join(tmpdir(), "openadminos-gemini-"));
      const settingsPath = join(folder, "settings.json"), systemPath = join(folder, "system.md"), policyPath = join(folder, "deny-tools.toml");
      let child: ReturnType<typeof spawnProvider> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        await writeFile(settingsPath, JSON.stringify(GEMINI_PROVIDER_SETTINGS), { mode: 0o600 });
        await writeFile(systemPath, input.system ?? "Answer only from the supplied context. Do not execute actions.", { mode: 0o600 });
        await writeFile(policyPath, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', { mode: 0o600 });
        let model = input.model ?? options.defaultModel ?? "gemini-default";
        const args = ["--prompt", "Answer the supplied request.", "--output-format", "stream-json", "--extensions", "none", "--allowed-mcp-server-names", "__openadminos_no_servers__", "--admin-policy", policyPath];
        if (input.model ?? options.defaultModel) args.push("--model", model);
        input.signal?.throwIfAborted();
        child = spawnProvider(detected.binaryPath, args, { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath, GEMINI_SYSTEM_MD: systemPath }, folder);
        const events = new CliEvents<LlmStreamChunk>();
        let buffer = "", accumulated = "", stderr = "", resultSeen = false, outputBytes = 0;
        const stop = (error: Error) => { events.fail(error); if (child) terminateCli(child); };
        abort = () => stop(new Error("Gemini request cancelled."));
        input.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => stop(new Error("Gemini timed out. Retry or select another model.")), options.timeoutMs ?? 120_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data: string) => {
          outputBytes += Buffer.byteLength(data);
          if (outputBytes > 1_000_000) { stop(new Error("Gemini exceeded its output limit. Narrow the question.")); return; }
          buffer += data;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              const event = rpcObject(JSON.parse(line));
              if (event.type === "init" && typeof event.model === "string") model = event.model;
              if (event.type === "tool_use") { stop(new Error("Gemini attempted an unavailable tool. OpenAdminOS stopped the request.")); return; }
              if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
                accumulated += event.content;
                events.push({ delta: event.content, accumulated, done: false, model });
              }
              if (event.type === "error" || (event.type === "result" && event.status !== "success")) {
                stop(cliFailure("Gemini CLI", JSON.stringify(event))); return;
              }
              if (event.type === "result") resultSeen = true;
            } catch { stop(new Error("Gemini returned an invalid response. Update the CLI and test again.")); return; }
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-16_384); });
        child.stdin.on("error", () => stop(new Error("Gemini input closed. Test the provider in Settings.")));
        child.on("error", () => stop(new Error("Gemini could not start. Check its executable and runtime.")));
        child.on("close", (code) => {
          if (code !== 0) events.fail(cliFailure("Gemini CLI", stderr));
          else if (!resultSeen || buffer.trim() || !accumulated.trim()) events.fail(new Error("Gemini exited without a complete answer. Test the provider in Settings."));
          else events.finish();
        });
        child.stdin.end(input.prompt);
        for await (const chunk of events) yield chunk;
        verified.set(key, { model });
        yield { delta: "", accumulated, done: true, model };
      } catch (error) {
        if (!input.signal?.aborted) verified.set(key, error instanceof CliProviderError ? error : new CliProviderError("request-failed", error instanceof Error ? error.message : "Gemini request failed. Test again."));
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) input.signal?.removeEventListener("abort", abort);
        if (child) terminateCli(child);
        await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}
