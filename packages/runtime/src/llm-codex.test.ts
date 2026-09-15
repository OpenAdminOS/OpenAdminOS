import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCodexProcessEnv, createCodexLlm, probeCodexLlm } from "./llm-codex.js";

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
    const response = await createCodexLlm({ binaryPath, homePath: root }).complete({ prompt: 'Review supplied evidence only.' });
    const captured = JSON.parse(response.text) as { args: string[]; home: string };
    assert.equal(captured.home, root);
    for (const arg of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'cli_auth_credentials_store="keyring"', 'project_doc_max_bytes=0', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.shell_tool=false', 'features.multi_agent=false', 'web_search="disabled"']) assert.ok(captured.args.includes(arg), arg);
    assert.ok(!captured.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
