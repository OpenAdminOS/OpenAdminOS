import { describe, expect, it } from "vitest";

import type { IntuneChatDocumentationSource, IntuneChatStep, IntuneChatToolTraceEntry } from "./openAdminOS";
import {
  egressEntries,
  mainLearnPage,
  normalizeSourceUrl,
  numberCitations,
  orderCitationRuns,
  originCounts,
  renumberCitations,
  sourcesHeadingDetail,
  splitAnswerBlocks,
  summarizeSteps,
  tenantNotUsed,
  usedTenantEvidence,
} from "./chat-steps";

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
    // All five started at once here, so the run took as long as the longest.
    expect(summary.totalMs).toBe(3400);
    expect(summary.sources).toBe("Microsoft Learn and docs index");
    expect(summary.egress).toBe("Sent: search text to learn.microsoft.com, answer context to OpenAI");
    expect(summary.sent.map((entry) => [entry.where, entry.items])).toEqual([
      ["learn.microsoft.com", ["Defender on macOS"]],
      ["OpenAI", ["The question, recent turns of this chat, and the results of the steps that ran for this answer."]],
    ]);
  });

  it("names Microsoft Learn from its source cards when no trace was stored, and times the run by wall clock", () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 11, 39, seconds)).toISOString();
    const summary = summarizeSteps({
      steps: [
        step({ kind: "plan", startedAt: at(0), durationMs: 40 }),
        // An older model step that spanned the Learn call.
        step({ kind: "answer", origin: "model", originLabel: "OpenAI Codex", startedAt: at(1), durationMs: 26_000 }),
        step({ kind: "mcp", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender on macOS", startedAt: at(10), durationMs: 1_200 }),
      ],
      documentationSources: [learn, { ...learn, citation: 2, url: "https://learn.microsoft.com/other" }],
    });
    expect(summary.sources).toBe("Microsoft Learn");
    expect(summary.totalMs).toBe(27_000);
  });

  it("lists requests to Microsoft Graph, and says nothing left the device only when nothing did", () => {
    const summary = summarizeSteps({ steps: [step({ kind: "graph-refresh", origin: "graph", originLabel: "Microsoft Graph" }), step({ kind: "answer" })], toolTrace: [cacheTrace] });
    expect(summary.egress).toBe("Sent: requests to Microsoft Graph");
    const hosted = summarizeSteps({ steps: [step({ kind: "tool", origin: "graph", originLabel: "Microsoft Graph" }), step({ kind: "answer", origin: "model", originLabel: "OpenAI Codex" })] });
    expect(hosted.egress).toBe("Sent: requests to Microsoft Graph, answer context to OpenAI Codex");
    expect(summarizeSteps({ steps: [step({ kind: "tool" }), step({ kind: "answer" })] }).egress).toBe("Nothing left this device");
    expect(summary.sources).toBe("your tenant");
    expect(usedTenantEvidence({ toolTrace: [{ ...cacheTrace, error: "failed" }] })).toBe(false);
  });
});

describe("folded line", () => {
  it("counts steps per origin, naming the MCP hosts and the model provider", () => {
    expect(originCounts([
      step({ kind: "plan" }),
      step({ kind: "answer", origin: "model", originLabel: "OpenAI Codex" }),
      step({ kind: "mcp", origin: "third-party", originLabel: "learn.microsoft.com" }),
      step({ kind: "graph-refresh", origin: "graph", originLabel: "Microsoft Graph" }),
      step({ kind: "mcp", origin: "third-party", originLabel: "www.kqlsearch.com" }),
      step({ kind: "answer", origin: "model", originLabel: "OpenAI Codex" }),
    ])).toEqual([
      { origin: "device", label: "On device", count: 1 },
      { origin: "graph", label: "Microsoft Graph", count: 1 },
      { origin: "third-party", label: "learn.microsoft.com and www.kqlsearch.com", count: 2 },
      { origin: "model", label: "OpenAI Codex", count: 2 },
    ]);
  });

  it("lists exactly what each place received, and nothing for a local model", () => {
    expect(egressEntries([
      step({ kind: "graph-refresh", origin: "graph", originLabel: "Microsoft Graph", title: "Refreshed tenant data", detail: "Managed devices" }),
      step({ kind: "mcp", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender on macOS" }),
      step({ kind: "mcp", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender prerequisites" }),
    ]).map((entry) => [entry.where, entry.what, entry.items])).toEqual([
      ["Microsoft Graph", ["requests"], ["Refreshed tenant data: Managed devices"]],
      ["learn.microsoft.com", ["search text"], ["Defender on macOS", "Defender prerequisites"]],
    ]);
    expect(egressEntries([step({ kind: "answer", origin: "device", originLabel: "On device" })])).toEqual([]);
  });

  it("says the tenant was not used only for a docs answer that read no tenant data", () => {
    expect(tenantNotUsed({ questionKind: "docs" })).toBe(true);
    expect(tenantNotUsed({ questionKind: "docs", toolTrace: [cacheTrace] })).toBe(false);
    expect(tenantNotUsed({ questionKind: "docs", tenantContext: true })).toBe(false);
    expect(tenantNotUsed({ questionKind: "mixed" })).toBe(false);
    expect(tenantNotUsed({})).toBe(false);
  });
});

describe("answer blocks", () => {
  it("leaves a docs answer unlabelled: the step summary names its source", () => {
    expect(splitAnswerBlocks("Microsoft Learn says X [2].", { documentationSources: [learn, index], tenantEvidence: false }))
      .toEqual([{ kind: "docs", text: "Microsoft Learn says X [2]." }]);
  });

  it("labels blocks only when an answer has both documentation and tenant blocks", () => {
    expect(splitAnswerBlocks("X [1].\n\nY [1].", { documentationSources: [learn], tenantEvidence: true })).toEqual([{ kind: "docs", text: "X [1].\n\nY [1]." }]);
    const mixed = splitAnswerBlocks("X [1].\n\n5 devices run macOS.", { documentationSources: [learn], tenantEvidence: true });
    expect(mixed.map((block) => block.label)).toEqual(["Microsoft Learn", "Your tenant"]);
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

  it("merges chunks of one article into one card that every one of their numbers points at", () => {
    const article = (citation: number, url: string): IntuneChatDocumentationSource => ({ ...learn, citation, title: "Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune", url });
    const sources = [
      article(2, "https://learn.microsoft.com/defender-endpoint/mac-install-with-intune#create-system-configuration-profiles"),
      article(4, "https://learn.microsoft.com/en-us/defender-endpoint/mac-install-with-intune/#deploy"),
      { ...learn, citation: 6, title: "Onboard devices to Microsoft Defender for Business", url: "https://learn.microsoft.com/defender-business/mdb-onboard-devices#mac" },
    ];
    const numbering = numberCitations("Deploy the profiles [4] and onboard [6], see also [2].", sources);
    expect(numbering.cited.map((card) => [card.display, card.citation, card.citations, card.uses])).toEqual([[1, 2, [2, 4], 2], [2, 6, [6], 1]]);
    expect(normalizeSourceUrl("https://Learn.Microsoft.com/en-us/Intune/x/#y")).toBe("https://learn.microsoft.com/intune/x");
  });
});

describe("citation numbering", () => {
  const source = (citation: number, title = `Article ${citation}`): IntuneChatDocumentationSource => ({ ...learn, citation, title, url: `https://learn.microsoft.com/a${citation}` });
  const sources = [1, 3, 4, 5, 6, 8].map((n) => source(n));

  it("numbers only cited sources, 1..N in order of first appearance, and lists the rest as consulted", () => {
    const content = "Start with a pilot [3]. Confirm licensing [4][1]. Go to the connector [8]. Again [3]. `[5]` is code. [9] is unknown.";
    const numbering = numberCitations(content, sources);
    expect(numbering.cited.map((card) => [card.citation, card.display])).toEqual([[3, 1], [4, 2], [1, 3], [8, 4]]);
    expect(numbering.consulted.map((card) => card.citation)).toEqual([5, 6]);
    expect(numbering.displayFor(4)).toBe(2);
    expect(numbering.displayFor(9)).toBeUndefined();
  });

  it("orders adjacent chips by shown number and copies the text with shown numbers", () => {
    const content = "Licensing [4][1] and the pilot [1]. Unknown [9]. Code `[4]`.";
    expect(orderCitationRuns(content, sources)).toBe("Licensing [4][1] and the pilot [1]. Unknown [9]. Code `[4]`.");
    expect(renumberCitations(content, sources)).toBe("Licensing [1][2] and the pilot [2]. Unknown [9]. Code `[4]`.");
    expect(renumberCitations("Later [6] first [1][6].", sources)).toBe("Later [1] first [1][2].");
  });

  it("numbers the same after a reload, since it reads only the stored answer and its sources", () => {
    const content = "A [5]. B [3]. C [5].";
    expect(numberCitations(content, sources).cited.map((card) => card.display)).toEqual(numberCitations(content, JSON.parse(JSON.stringify(sources))).cited.map((card) => card.display));
  });

  it("names the third-party hosts once as not verified, and the local index", () => {
    expect(sourcesHeadingDetail([learn, { ...learn, citation: 3 }])).toBe("learn.microsoft.com, not verified by OpenAdminOS");
    expect(sourcesHeadingDetail([learn, { ...learn, citation: 3, host: "www.kqlsearch.com" }, index])).toBe("learn.microsoft.com and www.kqlsearch.com, not verified by OpenAdminOS · local docs index on this device");
  });

  it("offers Open in Learn when one Learn page supplies more than half of the citations", () => {
    expect(mainLearnPage(numberCitations("A [1]. B [1]. C [3].", sources))?.citation).toBe(1);
    expect(mainLearnPage(numberCitations("A [1]. B [3].", sources))).toBeUndefined();
    expect(mainLearnPage(numberCitations("A [2]. B [2]. C [1].", [index, { ...index, citation: 1, file: "x.md" }]))).toBeUndefined();
  });
});
