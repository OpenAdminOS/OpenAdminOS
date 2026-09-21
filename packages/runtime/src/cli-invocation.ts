import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve, posix, win32, delimiter } from "node:path";
import { homedir } from "node:os";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";

/** Desktop launches can miss terminal PATH setup. Add standard install locations
 * without loading shell startup files or unrelated environment variables. */
export function cliProcessEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  if (platform !== "darwin" && platform !== "win32") return env;
  const windows = platform === "win32";
  const pathKeys = Object.keys(env).filter((key) =>
    windows ? key.toLowerCase() === "path" : key === "PATH",
  );
  const separator = windows ? ";" : ":";
  const existing = pathKeys.map((key) => env[key] ?? "").join(separator);
  const defaults = windows
    ? [
        win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "npm"),
        win32.join(home, ".local", "bin"),
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin", posix.join(home, ".local", "bin")];
  const paths = (existing || (windows
    ? win32.join(env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin:/usr/sbin:/sbin")).split(separator).concat(defaults);
  const seen = new Set<string>();
  const result = { ...env };
  for (const key of pathKeys) delete result[key];
  result.PATH = paths.filter((path) => {
    const key = windows ? path.toLowerCase() : path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(separator);
  return result;
}

/** Resolve Windows npm launchers to their Node entry point so prompts never cross cmd.exe. */
export function cliInvocation(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  env = cliProcessEnv(env);
  if (process.platform !== "win32") return { binary, args, env };
  const explicitPath = existsSync(binary) ? resolve(binary) : undefined;
  let result: SpawnSyncReturns<string> | undefined;
  try {
    result = explicitPath
      ? undefined
      : spawnSync("where.exe", [binary], {
          env,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: 5_000,
        });
  } catch {
    // A broken `where.exe` must not escape as a raw spawn error. Treat it
    // like an unresolved lookup and fall back to the name as given.
    result = undefined;
  }
  const candidates = result?.stdout?.trim().split(/\r?\n/) ?? [];
  const resolved =
    explicitPath ??
    candidates.find((path) => /\.(exe|com)$/i.test(path)) ??
    candidates.find((path) => /\.(cmd|bat)$/i.test(path));
  const target = resolved || binary;
  // A batch launcher must be resolved to its Node entry point. Handing a
  // .cmd/.bat file to spawn() without a shell throws a synchronous EINVAL
  // on current Node/Windows, which previously escaped the provider probe and
  // aborted the whole tenant connection. Never return one.
  if (!/\.(cmd|bat)$/i.test(target)) return { binary: target, args, env };

  const name = basename(target, extname(target)).toLowerCase();
  const relative =
    name === "claude"
      ? "@anthropic-ai/claude-code/cli.js"
      : name === "codex"
        ? "@openai/codex/bin/codex.js"
        : name === "copilot"
          ? "@github/copilot/npm-loader.js"
          : name === "gemini"
            ? "@google/gemini-cli/bundle/gemini.js"
            : undefined;
  const folder = dirname(target);
  const roots =
    basename(folder).toLowerCase() === ".bin"
      ? [dirname(folder)]
      : [join(folder, "node_modules")];
  const entry =
    relative && roots.map((root) => join(root, relative)).find(existsSync);
  if (!entry) {
    throw new Error(
      `Cannot launch ${name} through a custom Windows batch file. Install the official CLI or select its native .exe executable.`,
    );
  }
  return {
    binary: process.execPath,
    args: [entry, ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function cliArgs<
  const T extends import("node:child_process").SpawnOptions,
>(
  binary: string,
  args: string[],
  options: T,
): [string, string[], T & { shell: false }] {
  const command = cliInvocation(binary, args, options.env ?? process.env);
  return [
    command.binary,
    command.args,
    { ...options, env: command.env, shell: false },
  ];
}

/**
 * Spawn a provider CLI without letting a synchronous spawn failure escape.
 *
 * On current Node/Windows, `spawn` throws `EINVAL` synchronously when handed a
 * `.cmd`/`.bat` without a shell, and it can also throw for an unresolvable
 * launcher. Because `spawn` is evaluated inside promise executors, that throw
 * used to reject the surrounding probe and abort the whole tenant connection.
 * Returning the error instead lets callers report a normal probe failure.
 */
export function cliSpawn(
  binary: string,
  args: string[],
  options: SpawnOptions,
):
  | { child: ChildProcessWithoutNullStreams; error?: undefined }
  | { child?: undefined; error: Error } {
  let command: [string, string[], SpawnOptions & { shell: false }];
  try {
    command = cliArgs(binary, args, options);
  } catch (error) {
    return { error: toError(error, binary) };
  }
  try {
    return { child: spawn(...command) as ChildProcessWithoutNullStreams };
  } catch (error) {
    return { error: toError(error, binary) };
  }
}

function toError(error: unknown, binary: string): Error {
  if (error instanceof Error && error.message) return error;
  return new Error(`Failed to launch ${binary}.`);
}

export function cliExecutablePath(binary: string, source: NodeJS.ProcessEnv = process.env): string {
  if (existsSync(binary)) return resolve(binary);
  const env = cliProcessEnv(source);
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const candidate = join(directory, binary + suffix);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  return binary;
}
