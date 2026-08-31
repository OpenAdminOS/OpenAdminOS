import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCodexProcessEnv } from "./llm-codex.js";

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
