import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { classifyGraphAccessDenied, type RunRecord } from "@openadminos/agent-sdk";
import { RunFailureRemediation } from "./RunFailureRemediation";

vi.mock("./ReportIssueModal", () => ({ useReportIssue: () => vi.fn() }));

describe("Graph run failure recovery", () => {
  const base: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", error: "HTTP 403", steps: [], logs: [] };

  it.each([
    ["missing-consent", { requiredScopes: ["User.Read.All"], grantedScopes: [] }, "Graph consent required"],
    ["missing-role", { requiredScopes: ["User.Read.All"], grantedScopes: ["User.Read.All"] }, "Role access required"],
    ["missing-licence", { path: "/auditLogs/signIns", entraTier: "free" as const }, "Tenant licence required"],
    ["unknown", {}, "Graph access cause unverified"],
  ])("renders %s with its own recovery", (cause, context, title) => {
    const accessDenial = classifyGraphAccessDenied(context);
    const { container } = render(<RunFailureRemediation run={{ ...base, accessDenial }} />);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(container.textContent).toContain(accessDenial.recovery);
    if (cause !== "missing-consent") expect(container.textContent).not.toMatch(/reconnect|re-consent/i);
  });

  it("does not repeat the old consent advice for a legacy 403", () => {
    render(<RunFailureRemediation run={base} />);
    expect(screen.getByText("Graph access cause unverified")).toBeInTheDocument();
    expect(screen.queryByText("Scope or consent issue")).not.toBeInTheDocument();
  });
});

it("gives the organization recovery for a run with no organization with Microsoft 365 (Muse round 4)", () => {
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: "No organization with Microsoft 365 is active. Choose one in the organization switcher, or connect a Microsoft 365 tenant in Connections, before running agents.",
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("No organization with Microsoft 365")).toBeInTheDocument();
  expect(screen.queryByText("No tenant connected")).not.toBeInTheDocument();
});

it.each([
  ["Claude Code stopped sending output for 90 seconds, so OpenAdminOS ended the request. Test the provider in Settings, then retry.", "Provider stopped responding"],
  ["Codex CLI was still working after 15 minutes, the limit for one request, so OpenAdminOS ended it. Narrow the request or split it into smaller steps, then retry.", "Provider time limit reached"],
])("gives a CLI watchdog stop its own recovery: %s", (error, title) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.queryByText("Request timed out")).not.toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});

it.each([
  "Ollama context size too small: This request needs 40,652 tokens of context, but qwen3:8b supports at most 40,960.",
  "Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give gpt-oss:20b 16,384, usually because free memory ran out.",
])("gives an Ollama context overflow its own recovery: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama context too small")).toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});

it("still matches a model that is not pulled", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: 'Ollama model "qwen3:8b" is not pulled. Run `ollama pull qwen3:8b`.' };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model not pulled")).toBeInTheDocument();
  expect(screen.queryByText("Ollama context too small")).not.toBeInTheDocument();
});

it.each([
  "Ollama did not report the model's context limit within 5000ms at http://127.0.0.1:11434/api/show.",
  "Ollama could not report the model's context limit: HTTP 503 at http://127.0.0.1:11434/api/show: busy",
])("gives a failed Ollama context limit lookup its own recovery: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
});
