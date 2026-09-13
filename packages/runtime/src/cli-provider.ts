import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { cliArgs, cliProcessEnv } from "./cli-invocation.js";

export type CliFailure = "not-installed" | "signed-out" | "access-denied" | "unsupported-version" | "request-failed";
export interface CliProbe {
  installed: boolean;
  ready: boolean;
  binaryPath?: string;
  version?: string;
  detail: string;
  failure?: CliFailure;
  models: string[];
  defaultModel?: string;
}

/** Retain OS authentication plumbing, never arbitrary shell hooks or provider overrides. */
export function cliProviderEnv(provider: "copilot" | "gemini", source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  names.push(...(provider === "copilot" ? ["COPILOT_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "COPILOT_GH_HOST"] : ["GEMINI_CLI_HOME", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]));
  const env = Object.fromEntries(names.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return cliProcessEnv({ ...env, NO_COLOR: "1", CI: "1", COPILOT_AUTO_UPDATE: "false", COPILOT_OTEL_ENABLED: "false", OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false", GEMINI_CLI_NO_RELAUNCH: "1" });
}

export class CliProviderError extends Error {
  constructor(public readonly failure: CliFailure, message: string) { super(message); }
}

export function cliFailure(provider: string, raw: string): CliProviderError {
  // Return designed copy, not CLI stderr which may include prompts, credentials or URLs.
  if (/unauthenticated|not (?:logged|signed) in|authentication required|no authentication|login required|invalid.*(?:credential|token|api.key)|401|please.*(?:login|authenticate)|set an auth method|configure.*auth/i.test(raw))
    return new CliProviderError("signed-out", `${provider} is signed out or its credentials expired. Sign in with the CLI, then test again.`);
  if (/403|forbidden|permission.denied|policy.denied|subscription|license|quota|rate.limit|429|billing|exhausted/i.test(raw))
    return new CliProviderError("access-denied", `${provider} denied this request. Check account access, organization policy, and usage limits, then test again.`);
  return new CliProviderError("request-failed", `${provider} could not complete the request. Check its connection in Settings and retry. If the CLI was updated, check that its version is supported.`);
}

export async function discoverCli(name: "copilot" | "gemini", env: NodeJS.ProcessEnv, preferred?: string): Promise<{ binaryPath: string; version: string }> {
  const override = preferred ?? process.env[`OPENADMINOS_${name.toUpperCase()}_BINARY`];
  const candidates: string[] = override ? [override] : [];
  if (!override) {
    const folders = [...(env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
    for (const folder of folders.filter(Boolean)) {
      for (const suffix of process.platform === "win32" ? [".exe", ".cmd"] : [""]) candidates.push(join(folder, name + suffix));
    }
  }
  let found = false;
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    found = true;
    const binaryPath = isAbsolute(candidate) ? candidate : resolve(candidate);
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawnProvider(binaryPath, ["--version"], env, homedir());
      let output = "", settled = false;
      const finish = (status: number | null) => {
        if (settled) return; settled = true; clearTimeout(timer);
        terminateCli(child); done({ status, stdout: output, stderr: "" });
      };
      const timer = setTimeout(() => finish(null), 8000);
      const append = (data: Buffer) => { output += data.toString(); if (output.length > 32_768) finish(null); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      child.on("error", () => finish(null)); child.stdin.on("error", () => finish(null));
      child.on("close", finish); child.stdin.end();
    });
    const version = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(`${result.stdout ?? ""} ${result.stderr ?? ""}`)?.[1];
    if (result.status === 0 && version) return { binaryPath, version };
  }
  throw new CliProviderError(found ? "request-failed" : "not-installed", found ? `${name} was found but could not start. Check the executable and its runtime, then retry.` : `${name} CLI was not found. Install the official CLI and refresh providers.`);
}

export function requireCliVersion(version: string, minimum: string, name: string) {
  const a = version.split(/[.-]/).slice(0, 3).map(Number), b = minimum.split(".").map(Number);
  const comparison = a.reduce((result, value, index) => result || Math.sign(value - b[index]!), 0);
  if (comparison < 0 || version.includes("-")) throw new CliProviderError("unsupported-version", `${name} ${minimum} or newer (stable) is required. Update the CLI, then refresh providers.`);
}

export function spawnProvider(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcessWithoutNullStreams {
  return spawn(...cliArgs(binary, args, { env, cwd, windowsHide: true, stdio: "pipe" }));
}

/** Async events with a bounded queue; used for actual streaming rather than a buffered final answer. */
export class CliEvents<T> {
  private queue: T[] = [];
  private wake?: () => void;
  private error?: Error;
  private ended = false;
  push(value: T) { if (this.ended) return; if (this.queue.length >= 4096) { this.fail(new Error("CLI output exceeded its event limit.")); return; } this.queue.push(value); this.wake?.(); }
  finish() { this.ended = true; this.wake?.(); }
  fail(error: Error) { if (this.ended) return; this.error = error; this.finish(); }
  async *[Symbol.asyncIterator]() { while (true) { if (this.error) throw this.error; if (this.queue.length) { yield this.queue.shift()!; continue; } if (this.ended) return; await new Promise<void>((r) => { this.wake = r; }); this.wake = undefined; } }
}

export function terminateCli(child: ChildProcessWithoutNullStreams) {
  child.stdin.destroy();
  if (child.exitCode !== null) return;
  child.kill();
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
