import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import {
  cliArgs,
  cliInvocation,
  cliProcessEnv,
  cliSpawn,
  npmLauncherEntry,
} from "./cli-invocation.js";
import { CliProviderError, spawnProvider } from "./cli-provider.js";

it("passes native executable arguments without a shell", () => {
  const payload = '"A & B" | (C) %PATH% ! ^ < >';
  const command = cliArgs(
    process.execPath,
    ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", payload],
    { env: process.env, encoding: "utf8" as const },
  );
  const result = spawnSync(...command);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [payload]);
  assert.equal(command[2].shell, false);
});

it(
  "launches official Windows npm entry points directly and refuses unknown batch files",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "provider launch test "));
    try {
      for (const [name, entry] of [
        ["codex", "@openai/codex/bin/codex.js"],
        ["gemini", "@google/gemini-cli/bundle/gemini.js"],
      ]) {
        const launcher = join(root, `${name}.cmd`);
        const script = join(root, "node_modules", entry!);
        await mkdir(dirname(script), { recursive: true });
        // If a command shell ever runs the shim, the fixture must fail.
        await writeFile(launcher, "@exit /b 99\r\n");
        await writeFile(
          script,
          "console.log(JSON.stringify(process.argv.slice(2)))",
        );
        const payload = [
          '"quotes" & pipes | (brackets) %PATH% ! ^ < >',
          "",
          "line one\nline two",
        ];
        const command = cliArgs(launcher, payload, {
          env: process.env,
          encoding: "utf8" as const,
        });
        const result = spawnSync(...command);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), payload);
      }
      const unknown = join(root, "custom.cmd");
      await writeFile(unknown, "@exit /b 99\r\n");
      assert.throws(
        () => cliInvocation(unknown, [], process.env),
        /custom Windows batch file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("adds macOS CLI and Node locations to a Finder PATH without loading shell configuration", () => {
  const source = { PATH: "/usr/bin:/bin", HOME: "/Users/admin" };
  const env = cliProcessEnv(source, "darwin", "/Users/admin");
  assert.deepEqual(env.PATH!.split(":"), [
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Users/admin/.local/bin",
    "/opt/local/bin",
    "/Users/admin/.npm-global/bin",
    "/Users/admin/.volta/bin",
    "/Users/admin/.bun/bin",
    "/Users/admin/.local/share/mise/shims",
    "/Users/admin/.asdf/shims",
    "/Users/admin/Library/Application Support/fnm/aliases/default/bin",
  ]);
  assert.deepEqual(source, { PATH: "/usr/bin:/bin", HOME: "/Users/admin" });
  assert.equal(cliProcessEnv(env, "darwin", "/Users/admin").PATH, env.PATH);
});

it("adds Linux desktop-launch locations and every nvm Node version, newest first", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider path test "));
  try {
    for (const version of ["v18.20.4", "v22.11.0", "v20.18.1", "system"]) {
      await mkdir(join(home, ".nvm", "versions", "node", version, "bin"), { recursive: true });
    }
    const env = cliProcessEnv({ PATH: "/usr/bin:/bin" }, "linux", home);
    const path = env.PATH!.split(":");
    assert.deepEqual(path.slice(0, 6), ["/usr/bin", "/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin", join(home, ".local", "bin")]);
    assert.ok(path.includes(join(home, ".local", "share", "fnm", "aliases", "default", "bin")));
    assert.deepEqual(path.filter((entry) => entry.includes(".nvm")), [
      join(home, ".nvm", "versions", "node", "v22.11.0", "bin"),
      join(home, ".nvm", "versions", "node", "v20.18.1", "bin"),
      join(home, ".nvm", "versions", "node", "v18.20.4", "bin"),
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("finds Windows user installs with a stale PATH and preserves redirected AppData", () => {
  const source = { Path: "C:\\Windows\\System32;C:\\Tools", APPDATA: "D:\\Profile\\Roaming", LOCALAPPDATA: "D:\\Profile\\Local" };
  const env = cliProcessEnv(source, "win32", "C:\\Users\\admin");
  assert.deepEqual(env.PATH!.split(";"), [
    "C:\\Windows\\System32",
    "C:\\Tools",
    "D:\\Profile\\Roaming\\npm",
    "C:\\Users\\admin\\.local\\bin",
    "D:\\Profile\\Local\\Microsoft\\WinGet\\Links",
    "D:\\Profile\\Local\\pnpm",
    "D:\\Profile\\Local\\Volta\\bin",
    "C:\\Users\\admin\\scoop\\shims",
    "C:\\Users\\admin\\.bun\\bin",
  ]);
  assert.equal(env.Path, undefined);
  assert.equal(source.Path, "C:\\Windows\\System32;C:\\Tools");
  assert.deepEqual(cliProcessEnv(env, "win32", "C:\\Users\\admin"), env);
});

it("returns a synchronous spawn failure instead of throwing out of a probe", () => {
  // `spawn("")` throws synchronously (ERR_INVALID_ARG_VALUE). The helper must
  // surface it as a value so a provider probe cannot reject mid-flight, which
  // previously aborted the whole tenant connection.
  const spawned = cliSpawn("", [], { env: {} });
  assert.ok(spawned.error instanceof Error);
  assert.equal(spawned.child, undefined);
});

it("reports an unrunnable provider CLI as a designed error, never a raw spawn error", () => {
  assert.throws(
    () => spawnProvider("", ["--version"], {}, process.cwd()),
    (error: unknown) =>
      error instanceof CliProviderError &&
      error.failure === "request-failed" &&
      /could not be started/.test(error.message),
  );
});

it(
  "never hands a Windows batch launcher to spawn, resolved or not",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "provider batch guard "));
    try {
      // A .cmd path that does not exist used to be returned as-is, and
      // spawn(.cmd, …, { shell: false }) throws EINVAL synchronously on
      // current Windows/Node.
      assert.throws(
        () => cliInvocation(join(root, "ghost.cmd"), [], process.env),
        /custom Windows batch file/,
      );
      // An existing .cmd with no matching official Node entry point must fail
      // with the designed message too.
      const launcher = join(root, "codex.cmd");
      await writeFile(launcher, "@exit /b 99\r\n");
      assert.throws(
        () => cliInvocation(launcher, [], process.env),
        /custom Windows batch file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("maps npm launchers to the official entry, including Claude Code's native executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider shim test "));
  try {
    const native = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await mkdir(dirname(native), { recursive: true });
    await writeFile(native, "");
    await writeFile(join(root, "claude.cmd"), "@exit /b 99\r\n");
    assert.equal(npmLauncherEntry(join(root, "claude.cmd")), native);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("follows a pnpm or yarn global launcher to the official entry it references", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider shim test "));
  try {
    const entry = join(root, "global", "5", "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "");
    await writeFile(
      join(root, "codex.cmd"),
      '@SETLOCAL\r\n@"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    assert.equal(npmLauncherEntry(join(root, "codex.cmd")), entry);

    // A launcher that references anything other than the official entry is refused.
    const other = join(root, "global", "5", "node_modules", "evil", "codex.js");
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, "");
    await writeFile(join(root, "gemini.cmd"), '@"%~dp0\\global\\5\\node_modules\\evil\\codex.js" %*\r\n');
    assert.equal(npmLauncherEntry(join(root, "gemini.cmd")), undefined);
    assert.equal(npmLauncherEntry(join(root, "custom.cmd")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
