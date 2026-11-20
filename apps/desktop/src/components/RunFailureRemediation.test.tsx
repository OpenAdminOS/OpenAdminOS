import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { classifyGraphAccessDenied, type GraphAccessContext, type GraphAccessDenial, type RunRecord } from "@openadminos/agent-sdk";
import { RunFailureRemediation } from "./RunFailureRemediation";

vi.mock("./ReportIssueModal", () => ({ useReportIssue: () => vi.fn() }));

/** A denial as earlier versions stored it, before denials carried their source. */
function legacyDenial(context: GraphAccessContext = {}): GraphAccessDenial {
  const { source: _source, ...denial } = classifyGraphAccessDenied(context);
  return denial;
}

describe("Graph run failure recovery", () => {
  const base: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", error: 'Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users: {"error":{"code":"Forbidden","message":"You cannot perform the requested operation, required scopes are missing in the token."}}', steps: [], logs: [] };

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

  it("shows the stored denial for a run whose error is the denial text", () => {
    const accessDenial = classifyGraphAccessDenied({ requiredScopes: ["User.Read.All"], grantedScopes: [] });
    render(<RunFailureRemediation run={{ ...base, error: `${accessDenial.message} ${accessDenial.recovery}`, accessDenial }} />);
    expect(screen.getByText("Graph consent required")).toBeInTheDocument();
  });

  it("shows a denial classified from a Graph error that an agent wrapped", () => {
    const accessDenial = classifyGraphAccessDenied({ requiredScopes: ["User.Read.All"], grantedScopes: [] });
    render(<RunFailureRemediation run={{ ...base, error: "Listing users failed.", accessDenial }} />);
    expect(screen.getByText("Graph consent required")).toBeInTheDocument();
  });

  it.each([
    "Ollama responded with HTTP 403 at http://127.0.0.1:11434/api/chat: Forbidden",
    "LM Studio responded with HTTP 403 at http://127.0.0.1:1234/v1/chat/completions: forbidden",
    "Anthropic API returned 403 Forbidden: permission_error",
    "MCP server \"tickets\" responded with HTTP 403: forbidden",
    "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden by the Microsoft Graph lab proxy",
    "HTTP 403",
  ])("ignores a stored Graph denial when the error did not come from Microsoft Graph: %s", (error) => {
    const accessDenial = legacyDenial({ requiredScopes: ["User.Read.All"], grantedScopes: [] });
    render(<RunFailureRemediation run={{ ...base, error, accessDenial }} />);
    for (const title of ["Graph consent required", "Graph access cause unverified", "Role access required", "Tenant licence required"]) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
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

it("gives the overall deadline during a streaming answer the Ollama generation playbook", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama timed out after 180000ms at http://127.0.0.1:11434/api/chat." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama generation timed out")).toBeInTheDocument();
  expect(screen.queryByText("Ollama did not report the model's context limit")).not.toBeInTheDocument();
});

it.each(["/api/showroom", "/api/show.v1", "/api/show-1", "/api/show staging"])("does not read an endpoint prefix %s as the context limit lookup", (prefix) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: `Ollama timed out after 180000ms at http://127.0.0.1:8080${prefix}/api/chat.` };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama generation timed out")).toBeInTheDocument();
  expect(screen.queryByText("Ollama did not report the model's context limit")).not.toBeInTheDocument();
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
  const accessDenial = legacyDenial();
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error, accessDenial };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama did not report the model's context limit")).toBeInTheDocument();
  expect(screen.queryByText(accessDenial.title)).not.toBeInTheDocument();
  expect(screen.queryByText("Graph access cause unverified")).not.toBeInTheDocument();
});
