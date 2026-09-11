import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSummary,
  RunLlmApi,
  RunGraphApi,
} from "@openadminos/agent-sdk";
import { createQueuedRun, executeRun } from "./index.js";
for (const slug of ["team-evidence-review", "team-script-draft"])
  test(`${slug} uses bounded host evidence without Graph access`, async () => {
    const agent: AgentSummary = {
      id: slug,
      slug,
      name: slug,
      description: "Evidence test",
      mode: "read",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: [],
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      author: { name: "Test", verified: false },
      registryPath: resolve(
        fileURLToPath(new URL("../../../agents/", import.meta.url)),
        slug,
      ),
    };
    let prompt = "";
    const llm: RunLlmApi = {
      available: true,
      complete: async (p) => {
        prompt = p.prompt;
        return { text: "Evidence reviewed.", model: "test" };
      },
      async *stream(p) {
        prompt = p.prompt;
        yield {
          delta: "Evidence reviewed.",
          accumulated: "Evidence reviewed.",
          done: true,
          model: "test",
        };
      },
    };
    const graph: RunGraphApi = {
      request: async () => {
        throw new Error("Evidence tasks must not collect Graph data.");
      },
      listManagedDevices: async () => {
        throw new Error("No Graph reads.");
      },
      retireManagedDevice: async () => {
        throw new Error("No writes.");
      },
    };
    const run = createQueuedRun({ agent, providerId: "ollama" });
    run.tenantId = "tenant-a";
    run.officeContext = {
      tenantId: "tenant-a",
      question: "Explain the change.",
      instructions: "Cite the source.",
      evidence: [
        {
          runId: "source-1",
          agentSlug: "compliance-overview",
          finishedAt: "2026-09-11T10:00:00Z",
          summary: "One noncompliant device.",
          result: { counts: { noncompliant: 1 } },
        },
      ],
    };
    const completed = await executeRun({
      run,
      agent,
      providerId: "ollama",
      llm,
      createGraph: () => graph,
      onProgress: () => {},
    });
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.summary, "Evidence reviewed.");
    assert.match(prompt, /source-1/);
    assert.match(prompt, /noncompliant/);
    assert.match(prompt, /Cite the source/);
  });
