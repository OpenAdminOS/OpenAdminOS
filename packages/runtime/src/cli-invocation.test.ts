import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { cliArgs, cliInvocation } from "./cli-invocation.js";

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
