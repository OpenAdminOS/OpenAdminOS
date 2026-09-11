import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve, posix, win32 } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

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
  const result = explicitPath
    ? undefined
    : spawnSync("where.exe", [binary], {
        env,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 5_000,
      });
  const candidates = result?.stdout?.trim().split(/\r?\n/) ?? [];
  const resolved =
    explicitPath ??
    candidates.find((path) => /\.(exe|com)$/i.test(path)) ??
    candidates.find((path) => /\.(cmd|bat)$/i.test(path));
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved))
    return { binary: resolved || binary, args, env };

  const name = basename(resolved, extname(resolved)).toLowerCase();
  const relative =
    name === "claude"
      ? "@anthropic-ai/claude-code/cli.js"
      : name === "codex"
        ? "@openai/codex/bin/codex.js"
        : undefined;
  const folder = dirname(resolved);
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
