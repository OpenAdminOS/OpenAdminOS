import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { IntuneChatMessage, IntuneChatStep } from "../../shared/openAdminOS";
import { AnswerBody, FollowUpChips, SourceCards, StepSummary, StepTimeline } from "./ChatSteps";

const steps: IntuneChatStep[] = [
  { id: "s1", kind: "plan", title: "Read the question", detail: "Documentation question. Sources: Microsoft Learn. Your tenant is not checked.", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 2 },
  { id: "s2", kind: "mcp", title: "Asked Microsoft Learn", detail: "microsoft_docs_search · 2 results", status: "completed", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender for Endpoint on macOS", startedAt: "", durationMs: 1200 },
  { id: "s3", kind: "mcp", title: "Blocked a KQL Search query", detail: "Nothing was sent to www.kqlsearch.com.", status: "blocked", origin: "third-party", originLabel: "www.kqlsearch.com", startedAt: "", durationMs: 1 },
  { id: "s4", kind: "answer", title: "Working on the answer", detail: "gpt-6-sol", status: "active", origin: "model", originLabel: "OpenAI", startedAt: "" },
];

const message: IntuneChatMessage = {
  id: "answer-1", conversationId: "c1", role: "assistant", status: "completed", createdAt: "2026-11-04T09:00:00.000Z",
  content: "Defender for Endpoint on macOS needs full disk access [1]. It runs on the latest macOS releases [2]. [9]",
  steps: steps.map((entry) => (entry.status === "active" ? { ...entry, status: "completed", title: "Wrote the answer", durationMs: 3400 } : entry)),
  toolTrace: [{ id: "t1", tool: "mcp__microsoft-learn__microsoft_docs_search", params: {}, resultSummary: "", durationMs: 1200, createdAt: "", completedAt: "",
    mcpSource: { serverId: "microsoft-learn", serverName: "Microsoft Learn", host: "learn.microsoft.com", tool: "microsoft_docs_search" } }],
  documentationSources: [
    { citation: 1, kind: "mcp", title: "Microsoft Defender for Endpoint on Mac", url: "https://learn.microsoft.com/defender-endpoint/mac", serverName: "Microsoft Learn", host: "learn.microsoft.com" },
    { citation: 2, kind: "docs-index", title: "Deploy Defender on macOS with Intune", file: "defender/mac-intune.md", indexVersion: "2026-08-26" },
  ],
};

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

  it("folds into one summary line that expands to the full timeline", async () => {
    const user = userEvent.setup();
    render(<StepSummary message={message} />);
    const summary = screen.getByRole("button", { name: /4 steps/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveTextContent("Microsoft Learn and docs index");
    expect(summary).toHaveTextContent("Left this device: search text to learn.microsoft.com and answer context to OpenAI");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Steps" })).getByText("Wrote the answer")).toBeInTheDocument();
  });

  it("labels documentation from the trace, links citations to source cards and leaves unknown numbers as text", async () => {
    const user = userEvent.setup();
    render(<><AnswerBody message={message} content={message.content} /><SourceCards message={message} content={message.content} /></>);
    expect(screen.getByRole("region", { name: "Microsoft Learn and Docs index" })).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Source 1: Microsoft Defender for Endpoint on Mac" });
    expect(screen.getByRole("button", { name: "Source 2: Deploy Defender on macOS with Intune" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Source 9/ })).toBeNull();
    expect(screen.getByText(/\[9\]/)).toBeInTheDocument();
    const cards = within(screen.getByRole("region", { name: "Sources" }));
    expect(cards.getByRole("link", { name: "Microsoft Defender for Endpoint on Mac" })).toHaveAttribute("href", "https://learn.microsoft.com/defender-endpoint/mac");
    expect(cards.getByText(/On device · defender\/mac-intune\.md · index from Aug 26, 2026/)).toBeInTheDocument();
    await user.click(chip);
    expect(document.getElementById("source-answer-1-1")).toHaveFocus();
  });

  it("shows uncited MCP results as consulted, without citation numbers", () => {
    const content = "Defender for Endpoint needs full disk access.";
    render(<SourceCards message={{ ...message, content }} content={content} />);
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
    const consulted = screen.getByRole("region", { name: "Consulted" });
    expect(within(consulted).getByText("Microsoft Learn")).toBeInTheDocument();
    expect(within(consulted).queryByText(/^1 ·/)).toBeNull();
    expect(within(consulted).queryByText(/Docs index/)).toBeNull();
  });

  it("fills the composer from a follow-up chip and sends nothing", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<FollowUpChips followUps={["Check our 5 macOS devices for Defender in Intune"]} disabled={false} onPick={onPick} />);
    await user.click(screen.getByRole("button", { name: "Check our 5 macOS devices for Defender in Intune" }));
    expect(onPick).toHaveBeenCalledWith("Check our 5 macOS devices for Defender in Intune");
  });
});
