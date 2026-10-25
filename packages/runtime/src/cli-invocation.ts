import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * without loading shell startup files or unrelated environment variables.
 * Entries already on PATH keep precedence; these are only appended. */
export function cliProcessEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const pathKeys = Object.keys(env).filter((key) =>
    windows ? key.toLowerCase() === "path" : key === "PATH",
  );
  const separator = windows ? ";" : ":";
  const existing = pathKeys.map((key) => env[key] ?? "").join(separator);
  const defaults = windows ? windowsCliFolders(env, home) : posixCliFolders(env, platform, home);
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

/** A Windows app keeps the PATH it started with, so a CLI installed while it
 * runs (winget, scoop, pnpm, Volta, bun) is only found through these folders. */
function windowsCliFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const roaming = env.APPDATA || win32.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
  return [
    win32.join(roaming, "npm"),
    win32.join(home, ".local", "bin"),
    win32.join(local, "Microsoft", "WinGet", "Links"),
    win32.join(local, "pnpm"),
    win32.join(local, "Volta", "bin"),
    win32.join(home, "scoop", "shims"),
    win32.join(home, ".bun", "bin"),
  ];
}

/** Finder and desktop-menu launches get a minimal PATH. Cover package
 * managers and Node version managers that admins use to install the CLIs. */
function posixCliFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const system = platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
  const fnm = platform === "darwin"
    ? posix.join(home, "Library", "Application Support", "fnm")
    : posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "fnm");
  return [
    ...system,
    posix.join(home, ".local", "bin"),
    ...(platform === "darwin" ? ["/opt/local/bin"] : []),
    posix.join(home, ".npm-global", "bin"),
    posix.join(home, ".volta", "bin"),
    posix.join(home, ".bun", "bin"),
    posix.join(home, ".local", "share", "mise", "shims"),
    posix.join(home, ".asdf", "shims"),
    posix.join(fnm, "aliases", "default", "bin"),
    ...nvmNodeFolders(env.NVM_DIR || posix.join(home, ".nvm")),
  ];
}

/** nvm installs each Node version's global CLIs separately; newest first. */
function nvmNodeFolders(nvmDir: string): string[] {
  const versions = posix.join(nvmDir, "versions", "node");
  let names: string[];
  try {
    names = readdirSync(versions);
  } catch {
    return [];
  }
  const parse = (name: string) => name.replace(/^v/, "").split(".").map(Number);
  return names
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)];
      return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!);
    })
    .map((name) => posix.join(versions, name, "bin"));
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
  const entry = npmLauncherEntry(target);
  if (!entry) {
    throw new Error(
      `Cannot launch ${name} through a custom Windows batch file. Install the official CLI or select its native .exe executable.`,
    );
  }
  // Claude Code's npm package ships a native executable, not a Node script.
  if (/\.exe$/i.test(entry)) return { binary: entry, args, env };
  return {
    binary: process.execPath,
    args: [entry, ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** Official npm `bin` targets, relative to `node_modules`. */
const NPM_CLI_ENTRIES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code/bin/claude.exe",
  codex: "@openai/codex/bin/codex.js",
  copilot: "@github/copilot/npm-loader.js",
  gemini: "@google/gemini-cli/bundle/gemini.js",
};

/**
 * Find the official package entry behind an npm-style batch launcher. npm
 * keeps `node_modules` next to the launcher; pnpm and yarn global installs
 * keep it elsewhere, so fall back to the `%~dp0`-relative path the launcher
 * itself references. Only the official entry for that CLI name is accepted.
 */
export function npmLauncherEntry(launcher: string): string | undefined {
  const name = basename(launcher, extname(launcher)).toLowerCase();
  const relative = NPM_CLI_ENTRIES[name];
  if (!relative) return undefined;
  const folder = dirname(launcher);
  const root = basename(folder).toLowerCase() === ".bin" ? dirname(folder) : join(folder, "node_modules");
  const direct = join(root, relative);
  if (existsSync(direct)) return direct;

  let script: string;
  try {
    script = readFileSync(launcher, "utf8");
  } catch {
    return undefined;
  }
  const suffix = `node_modules/${relative}`.toLowerCase();
  for (const match of script.matchAll(/%~?dp0%?[\\/]?([^"%\r\n]+)/gi)) {
    const referenced = match[1]!.trim();
    if (!referenced.replace(/\\/g, "/").toLowerCase().endsWith(suffix)) continue;
    const candidate = resolve(folder, ...referenced.split(/[\\/]+/));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
