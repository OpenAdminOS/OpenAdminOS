import { describe, expect, it } from "vitest";

import type { IntuneChatDocumentationSource, IntuneChatStep, IntuneChatToolTraceEntry } from "./openAdminOS";
import { sourcesForCards, splitAnswerBlocks, summarizeSteps, usedTenantEvidence } from "./chat-steps";

const step = (overrides: Partial<IntuneChatStep>): IntuneChatStep => ({
  id: overrides.id ?? Math.random().toString(36), kind: "tool", title: "Step", status: "completed", origin: "device",
  originLabel: "On device", startedAt: "2026-11-04T09:00:00.000Z", durationMs: 100, ...overrides,
});

const learn: IntuneChatDocumentationSource = { citation: 1, kind: "mcp", title: "Microsoft Defender for Endpoint on Mac", url: "https://learn.microsoft.com/mac", serverName: "Microsoft Learn", host: "learn.microsoft.com" };
const index: IntuneChatDocumentationSource = { citation: 2, kind: "docs-index", title: "Deploy on macOS", file: "defender/mac.md", indexVersion: "2026-08-26" };
const mcpTrace = (serverName: string): IntuneChatToolTraceEntry => ({
  id: "t1", tool: "mcp__microsoft-learn__microsoft_docs_search", params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "",
  mcpSource: { serverId: "microsoft-learn", serverName, host: "learn.microsoft.com", tool: "microsoft_docs_search" },
});
const cacheTrace: IntuneChatToolTraceEntry = { id: "t2", tool: "query_cache", params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "" };

describe("step summary", () => {
  it("names what left the device and where, from the steps", () => {
    const summary = summarizeSteps({
      steps: [
        step({ kind: "plan", durationMs: 2 }),
        step({ kind: "mcp", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender on macOS", durationMs: 1200 }),
        step({ kind: "mcp", origin: "third-party", originLabel: "www.kqlsearch.com", sent: "tenant name", status: "blocked" }),
        // Failed before sending: the host cleared its sent text.
        step({ kind: "mcp", origin: "third-party", originLabel: "www.intuneautomation.com", status: "failed" }),
        step({ kind: "answer", origin: "model", originLabel: "OpenAI", durationMs: 3400 }),
      ],
      documentationSources: [learn, index],
      toolTrace: [mcpTrace("Microsoft Learn")],
    });
    expect(summary.count).toBe(5);
    expect(summary.totalMs).toBe(4802);
    expect(summary.sources).toBe("Microsoft Learn and docs index");
    expect(summary.egress).toBe("Left this device: search text to learn.microsoft.com and answer context to OpenAI");
  });

  it("says nothing left the device for a local model with no MCP call", () => {
    const summary = summarizeSteps({ steps: [step({ kind: "graph-refresh", origin: "graph", originLabel: "Microsoft Graph" }), step({ kind: "answer" })], toolTrace: [cacheTrace] });
    expect(summary.egress).toBe("Nothing left this device");
    expect(summary.sources).toBe("your tenant");
    expect(usedTenantEvidence({ toolTrace: [{ ...cacheTrace, error: "failed" }] })).toBe(false);
  });
});

describe("answer blocks", () => {
  it("labels a docs answer from its cited sources, never from model text", () => {
    expect(splitAnswerBlocks("Microsoft Learn says X [2].", { documentationSources: [learn, index], tenantEvidence: false }))
      .toEqual([{ kind: "docs", label: "Docs index", text: "Microsoft Learn says X [2]." }]);
    expect(splitAnswerBlocks("X [1] and Y [2].", { documentationSources: [learn, index], tenantEvidence: false })[0]!.label).toBe("Microsoft Learn and Docs index");
  });

  it("separates documentation and tenant blocks and keeps code with its paragraph", () => {
    const content = "Defender needs full disk access [1].\n\n```bash\nsudo mdatp health\n```\n\n5 of your 9 devices run macOS.";
    expect(splitAnswerBlocks(content, { documentationSources: [learn], tenantEvidence: true })).toEqual([
      { kind: "docs", label: "Microsoft Learn", text: "Defender needs full disk access [1].\n\n```bash\nsudo mdatp health\n```" },
      { kind: "tenant", label: "Your tenant", text: "5 of your 9 devices run macOS." },
    ]);
  });

  it("treats a deterministic answer built on cached tenant rows as tenant evidence", () => {
    expect(usedTenantEvidence({ tenantContext: true })).toBe(true);
    const content = "Defender needs full disk access [2].\n\n5 of your 9 devices run macOS.";
    const blocks = splitAnswerBlocks(content, { documentationSources: [index], tenantEvidence: usedTenantEvidence({ tenantContext: true }) });
    expect(blocks.map((block) => [block.kind, block.label])).toEqual([["docs", "Docs index"], ["tenant", "Your tenant"]]);
  });

  it("leaves an answer without documentation sources as one unlabelled block", () => {
    expect(splitAnswerBlocks("Two devices [9] need review.", { documentationSources: [], tenantEvidence: true })).toEqual([{ kind: "plain", text: "Two devices [9] need review." }]);
    expect(splitAnswerBlocks("Two devices need review.", { documentationSources: [learn], tenantEvidence: true })).toEqual([{ kind: "plain", text: "Two devices need review." }]);
  });

  it("shows cards for cited sources only, and MCP results when nothing is cited", () => {
    expect(sourcesForCards("X [2] and [9].", [learn, index])).toEqual({ cited: true, sources: [index] });
    expect(sourcesForCards("No citations.", [learn, index])).toEqual({ cited: false, sources: [learn] });
  });
});
