import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSummary } from "@openadminos/agent-sdk";

import { createQueuedRun, executeRun } from "./index.js";
import { createOllamaLlm } from "./llm-ollama.js";

it("an agent run stops with the typed reason when the size check's model lookup failed but the adapter's finds the pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-ollama-run-fit-"));
  const agent: AgentSummary = {
    id: "fit-run", slug: "fit-run", name: "Fit run", description: "Fixture.", mode: "read", category: "devices", tier: "agent",
    requiresEntraTier: "free", scopes: [], author: { name: "OpenAdminOS" }, version: "1.0.0", installedAt: new Date().toISOString(), registryPath: dir,
  };
  await writeFile(join(dir, "manifest.yaml"), `descriptor:
  id: fit-run
  name: Fit run
  description: Fixture.
  version: 1.0.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
skills:
  - id: review
    format: llm
    label: Review
    settings:
      prompt: "${"word ".repeat(18000).trim()}"
      maxTokens: 1000
definition:
  result:
    summary: "{{ review.output.text }}"
`);
  // Mocked Ollama: the first /api/show (the run's size check) is briefly
  // unavailable; later ones report a 16,384 pin. No local model is involved.
  let shows = 0;
  let chats = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/show") {
      shows += 1;
      if (shows === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ parameters: "num_ctx                        16384", model_info: { "general.architecture": "llama", "llama.context_length": 131072 } }), { status: 200 });
    }
    if (path === "/api/ps") return new Response(JSON.stringify({ models: [] }), { status: 200 });
    chats += 1;
    return new Response(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true })}\n`, { status: 200 });
  }) as typeof fetch;
  try {
    const result = await executeRun({
      run: createQueuedRun({ agent, providerId: "ollama" }),
      agent,
      providerId: "ollama",
      llm: createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "pinned-run" }),
      createGraph: () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => undefined, request: async () => ({ value: [] }) }),
      onProgress: () => {},
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureReason?.code, "context-too-small");
    assert.equal(result.failureReason?.limitTokens, 16384);
    assert.equal(chats, 0, "nothing reaches /api/chat");
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});
