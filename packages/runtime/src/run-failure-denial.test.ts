import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphAccessDeniedError, type AgentSummary, type RunLlmApi } from "@openadminos/agent-sdk";
import { createQueuedRun, executeRun } from "./index.js";

async function runFailingWith(error: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-denial-runtime-"));
  const agent: AgentSummary = {
    id: "denial-fixture", slug: "denial-fixture", name: "Denial fixture", description: "Denial fixture.",
    mode: "read", category: "devices", tier: "agent", requiresEntraTier: "free", scopes: [],
    author: { name: "OpenAdminOS", verified: true }, version: "1.0.0", installedAt: new Date().toISOString(), registryPath: dir,
  };
  await writeFile(join(dir, "manifest.yaml"), `descriptor:
  id: denial-fixture
  name: Denial fixture
  description: Denial fixture.
  version: 1.0.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
skills:
  - id: only
    format: llm
    label: Only pass
    settings:
      prompt: Only pass.
definition:
  result:
    summary: "{{ only.output.text }}"
`);
  try {
    const llm: RunLlmApi = {
      available: true, defaultModel: "model",
      async complete() { throw error; },
      // eslint-disable-next-line require-yield
      async *stream() { throw error; },
    };
    return await executeRun({
      run: createQueuedRun({ agent, providerId: "ollama", model: "model" }),
      agent, providerId: "ollama", model: "model", llm,
      createGraph: () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => undefined, request: async () => { throw new Error("This fixture does not read tenant data."); } }),
      onProgress: () => undefined,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

it("does not store a Graph denial for an HTTP 403 from a model server, a vendor API, or an MCP server", async () => {
  for (const message of [
    "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden",
    "LM Studio responded with HTTP 403 at http://127.0.0.1:1234/v1/chat/completions: forbidden",
    "Anthropic API returned 403 Forbidden: permission_error",
    "MCP server \"tickets\" responded with HTTP 403: forbidden",
    "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden by the Microsoft Graph lab proxy",
    // A provider that passes a gateway's text through, worded like the Graph adapter.
    "Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users: forbidden",
  ]) {
    const result = await runFailingWith(new Error(message));
    assert.equal(result.status, "failed");
    assert.equal(result.accessDenial, undefined, message);
  }
});

it("stores the Graph denial for a Graph 403", async () => {
  const result = await runFailingWith(new GraphAccessDeniedError({ method: "GET", path: "/users", requiredScopes: ["User.Read.All"], grantedScopes: [], errorCode: "Forbidden" }));
  assert.equal(result.status, "failed");
  assert.equal(result.accessDenial?.cause, "missing-consent");
  assert.equal(result.accessDenial?.title, "Graph consent required");
  assert.equal(result.accessDenial?.source, "microsoft-graph");
});

it("stores the Graph denial when an agent wraps the Graph error as its cause", async () => {
  const cause = new GraphAccessDeniedError({ method: "GET", path: "/users", requiredScopes: ["User.Read.All"], grantedScopes: [] });
  const result = await runFailingWith(new Error("Listing users failed.", { cause }));
  assert.equal(result.error, "Listing users failed.");
  assert.equal(result.accessDenial?.cause, "missing-consent");
  assert.equal(result.accessDenial?.source, "microsoft-graph");
});
