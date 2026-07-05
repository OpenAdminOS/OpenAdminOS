import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createClaudeCodeLlm,
  createClaudeCodeProcessEnv,
  probeClaudeCodeLlm,
} from "./llm-claude-code.js";

describe("createClaudeCodeProcessEnv", () => {
  it("keeps only CLI-required environment fields and Claude config overrides", () => {
    const env = createClaudeCodeProcessEnv({
      source: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/Users/admin",
        HTTPS_PROXY: "http://proxy.example",
        NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "anthropic-token",
        AZURE_CLIENT_SECRET: "tenant-secret",
      },
      overrides: {
        CLAUDE_CONFIG_DIR: "/Users/admin/.claude",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_API_KEY: "sk-ant-override",
      },
    });

    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.HOME, "/Users/admin");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/certs/ca.pem");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/admin/.claude");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.AZURE_CLIENT_SECRET, undefined);
  });
});

describe("probeClaudeCodeLlm", () => {
  it("checks binary version and Claude Code auth without running a completion", async () => {
    const fixture = await createFakeClaudeCodeBinary();
    try {
      const probe = await probeClaudeCodeLlm({
        binaryPath: fixture.binaryPath,
        homePath: fixture.homePath,
      });

      assert.equal(probe.installed, true);
      assert.equal(probe.ready, true);
      assert.equal(probe.version, "2.1.201");
      assert.equal(probe.defaultModel, "claude-sonnet-5");
      assert.deepEqual(await fixture.readCalls(), ["--version", "auth status --text"]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("createClaudeCodeLlm", () => {
  it("runs print mode with tool use disabled and a scrubbed environment", async () => {
    const fixture = await createFakeClaudeCodeBinary();
    try {
      const llm = createClaudeCodeLlm({
        binaryPath: fixture.binaryPath,
        homePath: fixture.homePath,
        defaultModel: "claude-sonnet-5",
      });
      const completion = await llm.complete({
        system: "Use terse output.",
        prompt: "Say hello.",
      });

      assert.equal(completion.text, "Hello");
      assert.equal(completion.model, "claude-sonnet-5");
      const calls = await fixture.readCalls();
      const generation = calls.at(-1) ?? "";
      assert.match(generation, /-p --output-format json/);
      assert.match(generation, /--safe-mode/);
      assert.match(generation, /--no-session-persistence/);
      assert.match(generation, /--permission-mode manual/);
      assert.match(generation, /--tools\s+--disallowed-tools \*/);
      assert.match(generation, /--strict-mcp-config/);
      assert.match(generation, /--append-system-prompt Use terse output\./);

      const env = await fixture.readEnv();
      assert.match(env, /^CLAUDE_CONFIG_DIR=/m);
      assert.match(env, /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m);
      assert.doesNotMatch(env, /^ANTHROPIC_API_KEY=/m);
    } finally {
      await fixture.cleanup();
    }
  });

  it("parses stream-json assistant messages into accumulated chunks", async () => {
    const fixture = await createFakeClaudeCodeBinary();
    try {
      const llm = createClaudeCodeLlm({
        binaryPath: fixture.binaryPath,
        homePath: fixture.homePath,
        defaultModel: "claude-sonnet-5",
      });
      const chunks = [];
      for await (const chunk of llm.stream({ prompt: "Say hello." })) {
        chunks.push(chunk);
      }

      assert.equal(chunks.at(0)?.accumulated, "Hel");
      assert.equal(chunks.at(-1)?.accumulated, "Hello");
      assert.equal(chunks.at(-1)?.done, true);
      assert.deepEqual(chunks.at(-1)?.tokenUsage, {
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFakeClaudeCodeBinary(): Promise<{
  binaryPath: string;
  homePath: string;
  readCalls(): Promise<string[]>;
  readEnv(): Promise<string>;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "openadminos-claude-test-"));
  const binaryPath = join(root, "claude");
  const homePath = join(root, "claude-home");
  const callsPath = join(root, "calls.txt");
  const envPath = join(root, "env.txt");
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
env | sort > ${JSON.stringify(envPath)}
if [[ "$1" == "--version" ]]; then
  printf '2.1.201 (Claude Code)\\n'
  exit 0
fi
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  printf 'Login method: test\\n'
  exit 0
fi
if [[ "$*" == *"stream-json"* ]]; then
  printf '%s\\n' '{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"Hel"}]}}'
  printf '%s\\n' '{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"Hello"}]}}'
  printf '%s\\n' '{"type":"result","subtype":"success","result":"Hello","usage":{"input_tokens":3,"output_tokens":2}}'
  exit 0
fi
printf '%s\\n' '{"type":"result","subtype":"success","result":"Hello","message":{"model":"claude-sonnet-5"},"usage":{"input_tokens":3,"output_tokens":2}}'
`;
  await writeFile(binaryPath, script, "utf8");
  await chmod(binaryPath, 0o755);
  return {
    binaryPath,
    homePath,
    async readCalls() {
      const text = await readFile(callsPath, "utf8");
      return text.trim().split(/\r?\n/).filter(Boolean);
    },
    async readEnv() {
      return await readFile(envPath, "utf8");
    },
    cleanup() {
      return rm(root, { recursive: true, force: true });
    },
  };
}
