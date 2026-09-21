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
        ["claude", "@anthropic-ai/claude-code/cli.js"],
        ["codex", "@openai/codex/bin/codex.js"],
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
  assert.equal(env.PATH, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/admin/.local/bin");
  assert.deepEqual(source, { PATH: "/usr/bin:/bin", HOME: "/Users/admin" });
  assert.equal(cliProcessEnv(env, "darwin", "/Users/admin").PATH, env.PATH);
  assert.equal(cliProcessEnv(source, "linux"), source);
});

it("finds Windows user installs with a stale PATH and preserves redirected AppData", () => {
  const source = { Path: "C:\\Windows\\System32;C:\\Tools", APPDATA: "D:\\Profile\\Roaming" };
  const env = cliProcessEnv(source, "win32", "C:\\Users\\admin");
  assert.equal(env.PATH, "C:\\Windows\\System32;C:\\Tools;D:\\Profile\\Roaming\\npm;C:\\Users\\admin\\.local\\bin");
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
