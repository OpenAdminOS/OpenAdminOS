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
    });
  });
});
