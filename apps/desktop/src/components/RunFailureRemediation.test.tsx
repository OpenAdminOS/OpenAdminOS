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

it.each([
  ["Ollama at http://127.0.0.1:11434/api/show answered with a redirect to another address. OpenAdminOS does not follow redirects from a model server on this device, so nothing was sent there."],
  ["Ollama not reachable at http://127.0.0.1:11434/api/show: fetch failed"],
])("gives a failed lookup of the model's context limit its recovery: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});

it("does not read incidental `ollama pull` text as a missing model", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not report the model's context limit: HTTP 503 at http://127.0.0.1:11434/api/show: ollama pull is disabled during maintenance" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
});

it("matches the provider's message when no Ollama model is available", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "No Ollama model available. Pull a model with `ollama pull <model>`." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model not pulled")).toBeInTheDocument();
});

it("treats the overall deadline during the context limit lookup as a lookup failure, not a slow generation", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama timed out after 180000ms at http://127.0.0.1:11434/api/show." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText("Ollama generation timed out")).not.toBeInTheDocument();
  expect(screen.queryByText("Request timed out")).not.toBeInTheDocument();
});

it("gives a memory failure on the context retry the context playbook", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could not load gpt-oss:20b with 45,056, usually because free memory ran out. Ollama said: model requires more system memory (24.1 GiB) than is available (12.0 GiB)" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama context too small")).toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});

it("does not read incidental `is not pulled` text as a missing model", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not report the model's context limit: HTTP 503 at http://127.0.0.1:11434/api/show: maintenance index is not pulled from cache" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
});

it.each([
  "Ollama not reachable at http://127.0.0.1:11434/api/show: fetch failed",
  "Ollama could not report the model's context limit: HTTP 401 at http://127.0.0.1:11434/api/show: unauthorized",
  "Ollama could not report the model's context limit: http://127.0.0.1:11434/api/show answered with an error: invalid model name",
])("shows only the lookup playbook for a failed context limit lookup: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  for (const title of ["Ollama isn't running", "Tenant token expired", "Manifest validation failed", "Request timed out", "Model not pulled"]) {
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  }
});

it("does not show the missing-model playbook for a lookup error that quotes it", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not report the model's context limit: HTTP 502 at http://127.0.0.1:11434/api/show: upstream said Ollama model \"qwen3:8b\" is not pulled. Run `ollama pull qwen3:8b`." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
});

it("shows only the lookup playbook for an HTTP 403 from the lookup, even with a stored Graph denial", () => {
  const error = "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden";
  const accessDenial = classifyGraphAccessDenied({});
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error, accessDenial };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText(accessDenial.title)).not.toBeInTheDocument();
  expect(screen.queryByText("Graph access cause unverified")).not.toBeInTheDocument();
});

it.each([
  "LM Studio context length too small: This request needs 15,857 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,096. Raise Context Length to at least 20,480 (qwen3-8b supports up to 32,768) in the model's load settings in LM Studio and reload it, or run `lms load qwen3-8b --context-length 20480`, then re-run. OpenAdminOS does not reload the model itself, because that would replace the model you loaded. LM Studio said: <LM Studio error> Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.",
  "LM Studio context length too small: This request does not fit in the context length qwen3-8b is loaded with in LM Studio. Raise Context Length in the model's load settings in LM Studio and reload it, or run `lms load qwen3-8b --context-length <tokens>`, then re-run. OpenAdminOS does not reload the model itself, because that would replace the model you loaded. LM Studio said: The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a",
  "LM Studio context length too small: This request needs 40,301 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,030. qwen3-8b supports at most 403,000, so narrow the request or pick a model with a larger context window. LM Studio said: invalid input, request timed out, forbidden",
])("gives an LM Studio context error only its own recovery: %s", (error) => {
  const accessDenial = classifyGraphAccessDenied({});
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error, accessDenial };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("LM Studio context too small")).toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
  for (const title of [accessDenial.title, "Tenant token expired", "Manifest validation failed", "Request timed out", "Ollama context too small"]) {
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  }
});

it("does not give an Ollama context error the LM Studio playbook", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama context size too small: This request needs 40,652 tokens of context, but qwen3:8b supports at most 40,960." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama context too small")).toBeInTheDocument();
  expect(screen.queryByText("LM Studio context too small")).not.toBeInTheDocument();
});
