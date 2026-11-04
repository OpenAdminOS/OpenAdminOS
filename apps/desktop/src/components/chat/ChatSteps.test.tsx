import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IntuneChatDocumentationSource, IntuneChatMessage, IntuneChatStep } from "../../shared/openAdminOS";
import { AnswerBody, FollowUpChip, SourceList, StepSummary, StepTimeline } from "./ChatSteps";

const steps: IntuneChatStep[] = [
  { id: "s1", kind: "plan", title: "Read the question", detail: "Documentation question. Sources: Microsoft Learn. Your tenant is not checked.", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 2 },
  { id: "s2", kind: "mcp", title: "Asked Microsoft Learn", detail: "microsoft_docs_search · 2 results", status: "completed", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender for Endpoint on macOS", startedAt: "", durationMs: 1200 },
  { id: "s3", kind: "mcp", title: "Blocked a KQL Search query", detail: "Nothing was sent to www.kqlsearch.com.", status: "blocked", origin: "third-party", originLabel: "www.kqlsearch.com", startedAt: "", durationMs: 1 },
  { id: "s4", kind: "answer", title: "Working on the answer", detail: "gpt-6-sol", status: "active", origin: "model", originLabel: "OpenAI", startedAt: "" },
];

const message: IntuneChatMessage = {
  id: "answer-1", conversationId: "c1", role: "assistant", status: "completed", createdAt: "2026-11-04T09:00:00.000Z",
  content: "Defender for Endpoint on macOS needs full disk access [1]. It runs on the latest macOS releases [2]. [9]",
  questionKind: "docs",
  steps: steps.map((entry) => (entry.status === "active" ? { ...entry, status: "completed", title: "Wrote the answer", durationMs: 3400 } : entry)),
  toolTrace: [{ id: "t1", tool: "mcp__microsoft-learn__microsoft_docs_search", params: {}, resultSummary: "", durationMs: 1200, createdAt: "", completedAt: "",
    mcpSource: { serverId: "microsoft-learn", serverName: "Microsoft Learn", host: "learn.microsoft.com", tool: "microsoft_docs_search" } }],
  documentationSources: [
    { citation: 1, kind: "mcp", title: "Microsoft Defender for Endpoint on Mac", url: "https://learn.microsoft.com/defender-endpoint/mac", serverName: "Microsoft Learn", host: "learn.microsoft.com", excerpt: "Grant full disk access to Microsoft Defender for Endpoint." },
    { citation: 2, kind: "docs-index", title: "Deploy Defender on macOS with Intune", file: "defender/mac-intune.md", indexVersion: "2026-08-26" },
  ],
};

const learnSource = (citation: number, title: string): IntuneChatDocumentationSource => ({
  citation, kind: "mcp", title, url: `https://learn.microsoft.com/defender-endpoint/page-${citation}`, serverName: "Microsoft Learn", host: "learn.microsoft.com",
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "openAdminOS");
});

describe("chat steps", () => {
  it("shows each step with its origin tag, the exact text an MCP call sent, and a blocked call as sending nothing", () => {
    render(<StepTimeline steps={steps} />);
    const rows = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("On device");
    expect(rows[1]).toHaveTextContent("Sent");
    expect(rows[1]).toHaveTextContent("Defender for Endpoint on macOS");
    expect(rows[1]).toHaveTextContent("Nothing else was sent to learn.microsoft.com.");
    expect(rows[1]).toHaveTextContent("learn.microsoft.com");
    expect(rows[1]).toHaveTextContent("1.2 s");
    expect(rows[2]).toHaveTextContent("Blocked a KQL Search query, blocked");
    expect(rows[2]).not.toHaveTextContent("Sent");
    expect(rows[3]).toHaveAttribute("aria-current", "step");
    expect(rows[3]).toHaveTextContent("OpenAI");
  });

  it("wraps the sent text between words, not inside them", () => {
    render(<StepTimeline steps={[{ ...steps[1]!, sent: "How does Defender for Endpoint onboarding work for macOS, including prerequisites?" }]} />);
    const sent = screen.getByText(/including prerequisites/);
    expect(sent.tagName).toBe("CODE");
    // break-all split words such as "prer equisites"; anywhere breaks only a token too long for the line.
    expect(sent.className).not.toMatch(/\bbreak-all\b/);
    expect(sent.className).toMatch(/\[overflow-wrap:anywhere\]/);
  });

  it("folds into one row with origin counts, sources and what was sent, each part expanding on its own", async () => {
    const user = userEvent.setup();
    render(<StepSummary message={message} />);
    const summary = screen.getByRole("button", { name: /4 steps/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveTextContent("Microsoft Learn and docs index · Tenant not used");
    expect(summary).toHaveTextContent("1 on On device, 2 on learn.microsoft.com and www.kqlsearch.com, 1 on OpenAI.");
    // The coloured dots are gone: one icon per origin with its count.
    expect(summary.querySelectorAll("i")).toHaveLength(0);
    const sent = screen.getByRole("button", { name: "Sent: search text to learn.microsoft.com, answer context to OpenAI" });
    expect(sent).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();

    await user.click(sent);
    expect(sent).toHaveAttribute("aria-expanded", "true");
    const egress = document.getElementById(sent.getAttribute("aria-controls")!)!;
    expect(within(egress).getByText("Defender for Endpoint on macOS").tagName).toBe("CODE");
    expect(egress).toHaveTextContent("Nothing else was sent to learn.microsoft.com.");
    expect(egress).toHaveTextContent("OpenAIreceived answer context");
    expect(egress).not.toHaveTextContent("www.kqlsearch.com");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Steps" })).getByText("Wrote the answer")).toBeInTheDocument();
  });

  it("says nothing left the device for a local run, with nothing to expand", () => {
    const local: IntuneChatMessage = { ...message, questionKind: "tenant", toolTrace: [], documentationSources: [], steps: [
      { ...steps[0]! },
      { id: "s5", kind: "tool", title: "Queried cached data", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 3 },
      { id: "s6", kind: "answer", title: "Wrote the answer", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 900 },
    ] };
    render(<StepSummary message={local} />);
    expect(screen.getByText("Nothing left this device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sent/ })).toBeNull();
    expect(screen.getByRole("button", { name: /3 steps/ })).not.toHaveTextContent("Tenant not used");
  });

  it("leaves a docs answer unlabelled, numbers its chips and shows the cited passage on hover or focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AnswerBody message={message} content={message.content} />);
    expect(screen.queryByText("Microsoft Learn", { selector: "div" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    const chip = screen.getByRole("button", { name: "Source 1: Microsoft Defender for Endpoint on Mac" });
    expect(screen.getByRole("button", { name: "Source 2: Deploy Defender on macOS with Intune" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Source 9/ })).toBeNull();
    expect(screen.getByText(/\[9\]/)).toBeInTheDocument();
    // Larger chips on a neutral fill with the soft text colour.
    expect(chip.className).toMatch(/text-xs/);
    expect(chip.className).toMatch(/text-\[var\(--color-text-soft\)\]/);

    // The popover is the chip's description, so a screen reader hears it too.
    const tip = document.getElementById(chip.getAttribute("aria-describedby")!)!;
    expect(tip).toHaveAttribute("role", "tooltip");
    expect(tip).toHaveTextContent("Microsoft Defender for Endpoint on Mac");
    expect(tip).toHaveTextContent("learn.microsoft.com");
    expect(tip).toHaveTextContent("Grant full disk access to Microsoft Defender for Endpoint.");
    await user.hover(chip);
    act(() => { vi.advanceTimersByTime(500); });
    expect(tip.className).toMatch(/\bvisible\b/);
  });

  it("keeps documentation and tenant labels for a mixed answer", () => {
    const mixed: IntuneChatMessage = { ...message, questionKind: "mixed", content: "Grant full disk access [1].\n\n2 of your Macs are noncompliant.", toolTrace: [{ id: "t2", tool: "query_cache", params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "" }] };
    render(<AnswerBody message={mixed} content={mixed.content} />);
    expect(screen.getByRole("region", { name: "Microsoft Learn" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your tenant" })).toBeInTheDocument();
  });

  it("numbers cited sources 1..N in order of first appearance and puts the rest under Also consulted", async () => {
    const user = userEvent.setup();
    const sources = [learnSource(1, "Onboard Windows devices"), learnSource(3, "Get devices onboarded"), learnSource(4, "Configure Defender"), learnSource(5, "Integrate compliance"), learnSource(8, "Deploy EDR policy")];
    const answer: IntuneChatMessage = { ...message, content: "Start with a pilot [3]. Confirm licensing [4][1]. Deploy [8].", documentationSources: sources, steps: [] };
    render(<><AnswerBody message={answer} content={answer.content} /><SourceList message={answer} content={answer.content} /></>);
    expect(screen.getAllByRole("button", { name: /^Source \d/ }).map((chip) => chip.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(screen.getByRole("button", { name: "Source 1: Get devices onboarded" })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Sources" });
    expect(within(list).getByRole("heading")).toHaveTextContent("Sources · learn.microsoft.com, not verified by OpenAdminOS");
    // "third-party content" is said once, not on every row.
    expect(list).not.toHaveTextContent("third-party content");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "1Source 1: Get devices onboardedlearn.microsoft.com",
      "2Source 2: Configure Defenderlearn.microsoft.com",
      "3Source 3: Onboard Windows deviceslearn.microsoft.com",
    ]);
    expect(within(rows[0]!).getByRole("link", { name: "Get devices onboarded" })).toHaveAttribute("href", "https://learn.microsoft.com/defender-endpoint/page-3");
    const more = within(list).getByRole("button", { name: "Show 1 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    const consulted = within(list).getByRole("button", { name: "Also consulted (1)" });
    expect(consulted).toHaveAttribute("aria-expanded", "false");
    expect(within(list).queryByText("Integrate compliance")).toBeNull();
    await user.click(consulted);
    expect(within(list).getByText("Integrate compliance")).toBeInTheDocument();
  });

  it("scrolls to and highlights a source row from its chip, revealing a row under Show more", async () => {
    const user = userEvent.setup();
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const sources = [1, 2, 3, 4, 5].map((n) => learnSource(n, `Article ${n}`));
    const answer: IntuneChatMessage = { ...message, content: "A [1]. B [2]. C [3]. D [4]. E [5].", documentationSources: sources, steps: [] };
    render(<><AnswerBody message={answer} content={answer.content} /><SourceList message={answer} content={answer.content} /></>);
    expect(document.getElementById("source-answer-1-5")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Source 5: Article 5" }));
    const row = document.getElementById("source-answer-1-5")!;
    expect(row).toHaveFocus();
    expect(row.className).toMatch(/color-warning-soft/);
    expect(scrolled).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
    expect(row.className).not.toMatch(/color-warning-soft/);
    scrolled.mockRestore();
  });

  it("links Open in Learn when one Learn page supplies most citations", () => {
    const sources = [learnSource(1, "Onboard Windows devices"), learnSource(2, "Configure Defender")];
    const answer: IntuneChatMessage = { ...message, content: "A [1]. B [1]. C [2].", documentationSources: sources, steps: [] };
    const { rerender } = render(<SourceList message={answer} content={answer.content} />);
    expect(screen.getByRole("link", { name: /Open in Learn/ })).toHaveAttribute("href", "https://learn.microsoft.com/defender-endpoint/page-1");
    rerender(<SourceList message={answer} content="A [1]. C [2]." />);
    expect(screen.queryByRole("link", { name: /Open in Learn/ })).toBeNull();
  });

  it("lists uncited MCP results and local index passages as consulted, without citation numbers", () => {
    const content = "Defender for Endpoint needs full disk access.";
    render(<SourceList message={{ ...message, content }} content={content} />);
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
    const consulted = screen.getByRole("region", { name: "Consulted" });
    expect(within(consulted).getByRole("heading")).toHaveTextContent("Consulted · learn.microsoft.com, not verified by OpenAdminOS · Local docs index on this device");
    const rows = within(consulted).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Microsoft Defender for Endpoint on Maclearn.microsoft.com",
      "Deploy Defender on macOS with IntuneLocal docs index, Aug 26, 2026",
    ]);
    expect(within(rows[0]!).getByRole("link", { name: "Microsoft Defender for Endpoint on Mac" })).toHaveAttribute("href", "https://learn.microsoft.com/defender-endpoint/mac");
    // The local passage has no URL, so no link; its file shows on hover.
    expect(within(rows[1]!).queryByRole("link")).toBeNull();
    expect(within(rows[1]!).getByText("Deploy Defender on macOS with Intune")).toHaveAttribute("title", "Deploy Defender on macOS with Intune (defender/mac-intune.md)");
    expect(within(consulted).queryByText(/Source \d/)).toBeNull();
    expect(within(consulted).queryByRole("button", { name: /Also consulted/ })).toBeNull();
  });

  it("names only the local docs index, not a third-party host, when an uncited answer consulted local passages only", () => {
    const local: IntuneChatDocumentationSource[] = [
      { citation: 1, kind: "docs-index", title: "Compliance policies", file: "intune/compliance.md", indexVersion: "2026-08-26", excerpt: "Compliance policies mark a device." },
      { citation: 2, kind: "docs-index", title: "", file: "intune/grace-period.md" },
    ];
    const answer: IntuneChatMessage = { ...message, content: "A device is marked noncompliant after the grace period.", documentationSources: local, steps: [] };
    render(<SourceList message={answer} content={answer.content} />);
    const consulted = screen.getByRole("region", { name: "Consulted" });
    expect(within(consulted).getByRole("heading")).toHaveTextContent(/^Consulted · Local docs index on this device$/);
    expect(consulted).not.toHaveTextContent(/not verified|third-party/);
    expect(within(consulted).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Compliance policiesLocal docs index, Aug 26, 2026",
      "intune/grace-period.mdLocal docs index",
    ]);
    expect(within(consulted).queryAllByRole("link")).toHaveLength(0);
  });

  it("lists uncited local passages under Also consulted next to uncited MCP results when something is cited", async () => {
    const user = userEvent.setup();
    const kql: IntuneChatDocumentationSource = { citation: 3, kind: "mcp", title: "Failed sign-ins", url: "https://www.kqlsearch.com/query/1", serverName: "KQL Search", host: "www.kqlsearch.com" };
    const answer: IntuneChatMessage = { ...message, content: "Grant full disk access [1].", documentationSources: [...message.documentationSources!, kql], steps: [] };
    render(<SourceList message={answer} content={answer.content} />);
    const list = screen.getByRole("region", { name: "Sources" });
    expect(within(list).getByRole("heading")).toHaveTextContent("Sources · learn.microsoft.com and www.kqlsearch.com, not verified by OpenAdminOS · Local docs index on this device");
    await user.click(within(list).getByRole("button", { name: "Also consulted (2)" }));
    expect(within(screen.getByRole("list", { name: "Also consulted" })).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Deploy Defender on macOS with IntuneLocal docs index, Aug 26, 2026",
      "Failed sign-inswww.kqlsearch.com",
    ]);
  });

  it("names the host of an uncited third-party source in the heading too", () => {
    const kql: IntuneChatDocumentationSource = { citation: 2, kind: "mcp", title: "Failed sign-ins", url: "https://www.kqlsearch.com/query/1", serverName: "KQL Search", host: "www.kqlsearch.com" };
    const answer: IntuneChatMessage = { ...message, content: "A [1].", documentationSources: [learnSource(1, "Article 1"), kql], steps: [] };
    render(<SourceList message={answer} content={answer.content} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Sources · learn.microsoft.com and www.kqlsearch.com, not verified by OpenAdminOS");
  });

  it("names the local index file and date on its row", () => {
    render(<SourceList message={message} content={message.content} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Sources · learn.microsoft.com, not verified by OpenAdminOS · Local docs index on this device");
    expect(screen.getByText("defender/mac-intune.md · index from Aug 26, 2026")).toBeInTheDocument();
  });

  it("copies one numbered step as plain text, with its citations as the numbers shown", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    Object.assign(window, { openAdminOS: { writeClipboardText } });
    // Stored [2] is cited first, so it shows as 1; the sub-item's [1] shows as 2.
    const answer: IntuneChatMessage = { ...message, content: "1. Open **Tenant administration** [2].\n2. Select `Connectors and tokens` [2].\n   - Then Defender for Endpoint [1]" };
    render(<AnswerBody message={answer} content={answer.content} />);
    await user.click(screen.getByRole("button", { name: "Copy step 2" }));
    expect(writeClipboardText).toHaveBeenCalledWith("Select Connectors and tokens [1].\n  - Then Defender for Endpoint [2]");
    expect(screen.getByRole("button", { name: "Copied step 2" })).toBeInTheDocument();
  });
});

describe("follow-up chip", () => {
  it("fills the composer and sends nothing", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<FollowUpChip followUp="How does the system extension profile work?" usesTenant={false} disabled={false} onPick={onPick} />);
    const chip = screen.getByRole("button", { name: "How does the system extension profile work?" });
    expect(chip).not.toHaveTextContent("Uses tenant data");
    await user.click(chip);
    expect(onPick).toHaveBeenCalledWith("How does the system extension profile work?");
  });

  it("says when the follow-up moves from docs to tenant data", () => {
    render(<FollowUpChip followUp="Check our 5 macOS devices for FileVault in Intune" usesTenant disabled={false} onPick={() => {}} />);
    const chip = screen.getByRole("button", { name: /^Check our 5 macOS devices for FileVault in Intune,\s*Uses tenant data$/ });
    expect(chip).toHaveAttribute("title", "Fills the message box. Nothing is sent.");
  });
});
