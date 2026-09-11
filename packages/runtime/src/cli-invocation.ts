import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** Resolve Windows npm launchers to their Node entry point so prompts never cross cmd.exe. */
export function cliInvocation(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
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
