import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCodexProcessEnv, createCodexLlm, probeCodexLlm } from "./llm-codex.js";
import { CliWatchdogError } from "./cli-watchdog.js";

describe("createCodexProcessEnv", () => {
  it("keeps only CLI-required environment fields and CODEX_HOME", () => {
    const env = createCodexProcessEnv({
      source: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/Users/admin",
        HTTPS_PROXY: "http://proxy.example",
        NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
        OPENAI_API_KEY: "sk-secret",
        AZURE_CLIENT_SECRET: "tenant-secret",
        OPENADMINOS_OLLAMA_URL: "http://192.168.1.10:11434",
      },
      overrides: {
        CODEX_HOME: "/Users/admin/.codex",
        OPENAI_API_KEY: "sk-override",
      },
    });

    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.HOME, "/Users/admin");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/certs/ca.pem");
    assert.equal(env.CODEX_HOME, "/Users/admin/.codex");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AZURE_CLIENT_SECRET, undefined);
    assert.equal(env.OPENADMINOS_OLLAMA_URL, undefined);
  });

  it("allows proxy, certificate, temp, and locale overrides", () => {
    const env = createCodexProcessEnv({
      source: {},
      overrides: {
        HTTP_PROXY: "http://proxy.example",
        SSL_CERT_FILE: "/certs/root.pem",
        TMPDIR: "/tmp/openadminos",
        LANG: "en_US.UTF-8",
      },
    });

    assert.deepEqual(env, {
      HTTP_PROXY: "http://proxy.example",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/certs/root.pem",
      TMPDIR: "/tmp/openadminos",
      // Forced so the headless CLI can never open a GUI editor.
      EDITOR: process.platform === "win32" ? "cmd /c exit 0" : "/usr/bin/true",
      VISUAL: process.platform === "win32" ? "cmd /c exit 0" : "/usr/bin/true",
      CI: "1",
    });
  });
});

describe("codex child environment", () => {
  it("never lets the CLI open a GUI editor in front of the user", () => {
    const env = createCodexProcessEnv({ source: { PATH: "/usr/bin" } });
    // Without these the CLI falls back to the OS default handler, which on
    // Windows opens instructions.md in Notepad over the app.
    assert.ok(env.EDITOR && env.EDITOR.length > 0);
    assert.equal(env.VISUAL, env.EDITOR);
    assert.equal(env.CI, "1");
  });

  it("does not inherit an editor the user happens to have configured", () => {
    const env = createCodexProcessEnv({
      source: { PATH: "/usr/bin", EDITOR: "code --wait", VISUAL: "code --wait" },
    });
    assert.notEqual(env.EDITOR, "code --wait");
    assert.notEqual(env.VISUAL, "code --wait");
  });
});

describe("Codex sign-in detection", () => {
  for (const loggedIn of [true, false]) {
    it(loggedIn ? "accepts a CLI login without auth.json" : "rejects a stale auth.json when the CLI is signed out", async () => {
      const root = await mkdtemp(join(tmpdir(), "codex-auth-probe-"));
      try {
        const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.100.0'); }
else if (process.argv.slice(2).join(' ') === 'login status') { process.exit(${loggedIn ? 0 : 1}); }
else { process.exit(99); }
`;
        let binaryPath = join(root, "codex");
        if (process.platform === "win32") {
          binaryPath += ".cmd";
          const folder = join(root, "node_modules/@openai/codex/bin");
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, "codex.js"), script);
          await writeFile(binaryPath, "@exit /b 99\r\n");
        } else {
          await writeFile(binaryPath, script);
          await chmod(binaryPath, 0o755);
        }
        if (!loggedIn) await writeFile(join(root, "auth.json"), "{}");
        const probe = await probeCodexLlm({ binaryPath, homePath: root });
        assert.equal(probe.installed, true);
        assert.equal(probe.ready, loggedIn);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});


it("isolates app completions from user hooks and tools while preserving the auth backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-isolation-"));
  try {
    const script = `#!/usr/bin/env node
const text=JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME});
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}));
`;
    let binaryPath = join(root, "codex");
    if (process.platform === "win32") {
      binaryPath += ".cmd";
      const folder = join(root, "node_modules/@openai/codex/bin");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "codex.js"), script);
      await writeFile(binaryPath, "@exit /b 99\r\n");
    } else { await writeFile(binaryPath, script); await chmod(binaryPath, 0o755); }
    await writeFile(join(root, "config.toml"), 'cli_auth_credentials_store = "keyring"\n[mcp_servers.private]\ncommand = "must-not-run"\n');
    const llm = createCodexLlm({ binaryPath, homePath: root });
    // codex exec --json sends the reply as one item.completed event, so callers do not stream it live.
    assert.equal(llm.streamsIncrementally, undefined);
    const response = await llm.complete({ prompt: 'Review supplied evidence only.' });
    assert.deepEqual(response.tokenUsage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    const chunks = [];
    for await (const chunk of llm.stream({ prompt: 'Review supplied evidence only.' })) chunks.push(chunk);
    assert.deepEqual(chunks.at(-1)?.tokenUsage, response.tokenUsage);
    const captured = JSON.parse(response.text) as { args: string[]; home: string };
    assert.equal(captured.home, root);
    for (const arg of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'cli_auth_credentials_store="keyring"', 'project_doc_max_bytes=0', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.shell_tool=false', 'features.multi_agent=false', 'web_search="disabled"']) assert.ok(captured.args.includes(arg), arg);
    assert.ok(!captured.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("Codex CLI watchdog", () => {
  for (const [mode, limits, stop] of [
    ["silent", { idleTimeoutMs: 500, timeoutMs: 60_000 }, "stalled"],
    ["chatty", { idleTimeoutMs: 60_000, timeoutMs: 1_000 }, "time-limit"],
    // No output at all, with the idle limit from the environment.
    ["quiet", { timeoutMs: 60_000 }, "stalled"],
  ] as const) {
    it(`ends a ${mode} CLI that never finishes with the ${stop} error and stops its process`, async () => {
      const root = await mkdtemp(join(tmpdir(), "codex-watchdog-"));
      const previous = process.env.OPENADMINOS_CODEX_IDLE_TIMEOUT_MS;
      if (mode === "quiet") process.env.OPENADMINOS_CODEX_IDLE_TIMEOUT_MS = "500";
      try {
        const pidsPath = join(root, "pids.txt");
        const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv[2] === "--version") { console.log("codex-cli 0.200.0"); process.exit(0); }
appendFileSync(${JSON.stringify(pidsPath)}, process.pid + "\\n");
if (${JSON.stringify(mode)} !== "quiet") console.log(JSON.stringify({type: "thread.started"}));
setInterval(() => {
  if (${JSON.stringify(mode)} === "chatty") console.log(JSON.stringify({type: "item.updated", item: {type: "reasoning"}}));
}, 5);
// Never outlive a broken test run.
setTimeout(() => process.exit(3), 30_000);
`;
        const binaryPath = await writeFakeCodex(root, script);
        const llm = createCodexLlm({ binaryPath, homePath: root, ...limits });
        await assert.rejects(
          llm.complete({ prompt: "Review supplied evidence only." }),
          (error: unknown) =>
            error instanceof CliWatchdogError &&
            error.stop === stop &&
            error.message.startsWith("Codex CLI ") &&
            error.message.includes(stop === "stalled" ? "OPENADMINOS_CODEX_IDLE_TIMEOUT_MS" : "OPENADMINOS_CODEX_TIMEOUT_MS"),
        );
        const pids = (await readFile(pidsPath, "utf8")).trim().split(/\r?\n/).map(Number);
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (previous === undefined) delete process.env.OPENADMINOS_CODEX_IDLE_TIMEOUT_MS;
        else process.env.OPENADMINOS_CODEX_IDLE_TIMEOUT_MS = previous;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("Codex CLI watchdog and a slow consumer", () => {
  it("does not count a stream consumer's pause as silence while the CLI keeps producing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-slow-consumer-"));
    try {
      // 100 agent messages 10 ms apart, then a clean exit.
      const script = `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("codex-cli 0.200.0"); process.exit(0); }
let parts = 0;
setInterval(() => {
  parts += 1;
  const line = JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "x".repeat(parts)}}) + "\\n";
  if (parts < 100) process.stdout.write(line);
  else process.stdout.write(line, () => process.exit(0));
}, 10);
setTimeout(() => process.exit(3), 30_000);
`;
      const binaryPath = await writeFakeCodex(root, script);
      const llm = createCodexLlm({ binaryPath, homePath: root, idleTimeoutMs: 200, timeoutMs: 60_000 });
      const chunks: Array<{ accumulated: string; done: boolean }> = [];
      for await (const chunk of llm.stream({ prompt: "Review supplied evidence only." })) {
        // Hold the first chunk three times the idle limit while the CLI keeps writing.
        if (chunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 600));
        chunks.push(chunk);
      }
      assert.equal(chunks.at(-1)?.done, true);
      assert.equal(chunks.at(-1)?.accumulated, "x".repeat(100));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFakeCodex(root: string, script: string): Promise<string> {
  let binaryPath = join(root, "codex");
  if (process.platform === "win32") {
    binaryPath += ".cmd";
    const folder = join(root, "node_modules/@openai/codex/bin");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "codex.js"), script);
    await writeFile(binaryPath, "@exit /b 99\r\n");
  } else { await writeFile(binaryPath, script); await chmod(binaryPath, 0o755); }
  return binaryPath;
}
