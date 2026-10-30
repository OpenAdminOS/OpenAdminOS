import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { RunContext } from "@openadminos/agent-sdk";
import { parseAgentTemplate, runAgentTemplate } from "@openadminos/runtime";

import { createSampleGraph } from "./graph.js";

describe("bundled read agents on the sample tenant", () => {
  it("runs every Graph-backed read manifest to completion", async () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const agentsRoot = join(repoRoot, "agents");
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const completed: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = await readFile(
        join(agentsRoot, entry.name, "manifest.yaml"),
        "utf8",
      ).catch(() => undefined);
      if (!source) continue;
      const manifest = parseAgentTemplate(source);
      if (
        manifest.descriptor.mode !== "read" ||
        !manifest.skills.some((skill) => skill.format === "graph")
      ) {
        continue;
      }

      const context: RunContext = {
        agent: {
          id: manifest.descriptor.id,
          slug: manifest.descriptor.id,
          name: manifest.descriptor.name,
          description: manifest.descriptor.description,
          mode: "read",
          category: manifest.descriptor.category,
          tier: manifest.descriptor.tier ?? "agent",
          requiresEntraTier: manifest.descriptor.requiresEntraTier ?? "free",
          scopes: [],
          author: manifest.descriptor.author,
          version: manifest.descriptor.version,
        },
        providerId: "ollama",
        graph: createSampleGraph({
          now: new Date("2026-10-26T12:00:00.000Z"),
        }),
        llm: {
          available: true,
          defaultModel: "sample-test-model",
          async complete() {
            return {
              text: "Sample evidence reviewed. The result is based only on the supplied fictional tenant rows.",
              model: "sample-test-model",
            };
          },
          async *stream() {
            yield {
              delta: "Sample evidence reviewed.",
              accumulated: "Sample evidence reviewed.",
              done: true,
              model: "sample-test-model",
            };
          },
        },
        realWrites: false,
        log: () => undefined,
        step: async (_label, _detail, task) => await task(),
      };
      const result = await runAgentTemplate(manifest, context);
      assert.ok(result.summary.trim().length > 0, manifest.descriptor.id);
      completed.push(manifest.descriptor.id);
    }

    assert.deepEqual(completed.sort(), [
      "compliance-overview",
      "conditional-access-explainer",
      "dormant-app-registrations",
      "find-inactive-devices",
      "intune-device-posture-auditor",
      "os-update-posture",
      "risky-sign-in-triage",
      "secure-score-prioritizer",
      "sign-in-failure-explainer",
      "tenant-change-audit",
      "tenant-health-report",
      "user-license-overview",
    ]);
  });
});
