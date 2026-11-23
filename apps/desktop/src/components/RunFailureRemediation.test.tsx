import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { classifyGraphAccessDenied, contextTooSmallMessage, type ContextTooSmallFailure, type GraphAccessContext, type GraphAccessDenial, type RunRecord } from "@openadminos/agent-sdk";
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

it("gives a prompt that does not fit the model its own recovery from the typed reason", () => {
  const failureReason: ContextTooSmallFailure = {
    code: "context-too-small", promptTokens: 40_120, answerTokens: 1_100, neededTokens: 41_220, limitTokens: 16_384,
    model: "openadminos/openadmin-8b:latest",
  };
  const run: RunRecord = {
    id: "run", agentSlug: "conditional-access-explainer", status: "failed", queuedAt: "2026-11-19T00:00:00Z",
    steps: [], logs: [], error: contextTooSmallMessage(failureReason), failureReason,
  };
  const { container } = render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Prompt larger than the model's context")).toBeInTheDocument();
  expect(container.textContent).toContain("41,220 tokens of context and openadminos/openadmin-8b:latest accepts 16,384");
  expect(container.textContent).toContain("switch to a hosted provider");
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
  expect(container.textContent).not.toContain("!");
});

it("says the model refused a prompt it received, instead of saying nothing was sent", () => {
  const failureReason: ContextTooSmallFailure = {
    code: "context-too-small", promptTokens: 16_600, answerTokens: 1_000, neededTokens: 17_600, limitTokens: 16_384,
    model: "openadminos/openadmin-8b:latest", sentToProvider: true,
  };
  const run: RunRecord = {
    id: "run", agentSlug: "conditional-access-explainer", status: "failed", queuedAt: "2026-11-20T00:00:00Z",
    steps: [], logs: [], error: contextTooSmallMessage(failureReason), failureReason,
  };
  const { container } = render(<RunFailureRemediation run={run} />);
  expect(container.textContent).toContain("the model refused the request or stopped before finishing its answer");
  expect(container.textContent).not.toContain("stopped before sending anything");
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

it.each([
  "Ollama timed out after 180000ms at http://127.0.0.1:11434/api/chat on the retry with a 45,056 token context.",
  "Ollama timed out after 180000ms at http://127.0.0.1:11434/api/chat with the 45,056 token context kept from an earlier request.",
])("gives a timed out request with a raised context the generation timeout playbook: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama generation timed out")).toBeInTheDocument();
  expect(screen.queryByText("Ollama context too small")).not.toBeInTheDocument();
  expect(screen.queryByText("Ollama did not report the model's context limit")).not.toBeInTheDocument();
});

it("does not read a context limit in what Ollama said as a failed lookup", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. The next request starts from Ollama's default context size. Ollama said: out of memory at the requested context limit" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.queryByText("Ollama did not report the model's context limit")).not.toBeInTheDocument();
});

it("does not read a 403 in what Ollama said as a Graph denial", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. The next request starts from Ollama's default context size. Ollama said: cudaMalloc failed: out of memory (403 MiB)" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.queryByText(/Graph/)).not.toBeInTheDocument();
});

it("ignores a Graph denial an older build saved from what Ollama said", () => {
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: "Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. The next request starts from Ollama's default context size. Ollama said: cudaMalloc failed: out of memory (403 MiB)",
    accessDenial: legacyDenial(),
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.queryByText(classifyGraphAccessDenied({}).title)).not.toBeInTheDocument();
});

it("keeps a stored Graph denial whose error only mentions the Ollama marker", () => {
  const denial = classifyGraphAccessDenied({});
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: "Graph responded with HTTP 403 for GET /users: Ollama said: denied",
    accessDenial: denial,
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText(denial.title)).toBeInTheDocument();
});

it("does not pick a playbook from words in what Ollama said", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. The next request starts from Ollama's default context size. Ollama said: CUDA allocation failed: invalid argument" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.queryByText("Manifest validation failed")).not.toBeInTheDocument();
});

it.each([
  "Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. Ollama said: model requires more system memory",
  "Ollama failed partway through an answer from gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. Ollama said: runner terminated",
  "Ollama context size too small: This request did not fit in the 45,056 token context kept from an earlier request. Ollama said: prompt is too long",
  'MXC script agent "test" failed: Error: llm.complete: Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. Ollama said: out of memory',
])("gives a kept context failure only its own playbook: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.getByText(/^Re-run the same request.*default context size.*close other apps to free memory or pick a smaller model/)).toBeInTheDocument();
  expect(screen.queryByText("Ollama context too small")).not.toBeInTheDocument();
  expect(screen.queryByText("Ollama generation timed out")).not.toBeInTheDocument();
});

it("uses the kept context playbook for a typed Ollama overflow", () => {
  const failureReason: ContextTooSmallFailure = {
    code: "context-too-small", promptTokens: 44_033, answerTokens: 1_024, neededTokens: 45_057,
    limitTokens: 45_056, model: "gpt-oss:20b", sentToProvider: true, ollamaKeptContext: true,
  };
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z",
    steps: [], logs: [], error: contextTooSmallMessage(failureReason), failureReason,
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama failed with a kept context size")).toBeInTheDocument();
  expect(screen.queryByText("Prompt larger than the model's context")).not.toBeInTheDocument();
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

it("does not read Graph advice from the text of a failure classified from its typed error", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], graphDenialChecked: true, error: "Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users: forbidden" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.queryByText("Graph access cause unverified")).not.toBeInTheDocument();
});

it.each([
  ["Ollama responded with HTTP 403 at http://127.0.0.1:11434/api/chat: Unauthorized", false],
  ["Anthropic API returned 401 Unauthorized: invalid x-api-key", false],
  ["Ollama responded with HTTP 403: expired token", false],
  ["Graph rejected the access token (HTTP 401). Tenant needs reconnect.", true],
  ["The plan could not be checked against the tenant before applying, so nothing was applied. Graph rejected the access token (HTTP 401). Tenant needs reconnect.", true],
  ["Graph responded with HTTP 401 for https://graph.microsoft.com/v1.0/users: {\"error\":{\"code\":\"InvalidAuthenticationToken\"}}", true],
  ["AADSTS65001 interaction_required: consent is needed", true],
  ["interaction_required: AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.", true],
  ["Microsoft Graph rejected the Teams access token (HTTP 401). Reconnect the tenant.", true],
  ["Graph responded with HTTP 401 for https://gateway.example/v1/messages: unauthorized", false],
  ['Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users/1/authentication/methods: {"error":{"code":"accessDenied","message":"The caller is unauthorized to perform this action."}}', false],
  ["Ollama responded with HTTP 403 at http://gateway.example/api/chat: upstream said AADSTS65001 interaction_required", false],
])("gives tenant sign-in advice only for a tenant sign-in failure: %s", (error, tenant) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  if (tenant) expect(screen.getByText("Tenant token expired")).toBeInTheDocument();
  else expect(screen.queryByText("Tenant token expired")).not.toBeInTheDocument();
});

it("shows Graph advice for a stored write-plan failure that wraps a Graph 403", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: 'The plan could not be checked against the tenant before applying, so nothing was applied. Graph responded with HTTP 403 for https://graph.microsoft.com/beta/users: {"error":{"code":"Forbidden"}}' };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Graph access cause unverified")).toBeInTheDocument();
});

it.each([
  "LM Studio context length too small: This request needs 15,857 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,096. Raise Context Length to at least 20,480 (qwen3-8b supports up to 32,768) in the model's load settings in LM Studio (My Models, or the loaded model in the Developer tab) and reload it, then re-run. If LM Studio refuses the larger size or keeps the smaller one, narrow the request or pick a model with a larger context window. OpenAdminOS does not reload the model itself, because that would replace the model you loaded. LM Studio said: <LM Studio error> Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.",
  "LM Studio context length too small: This request does not fit in the context length qwen3-8b is loaded with in LM Studio. Raise Context Length in the model's load settings in LM Studio (My Models, or the loaded model in the Developer tab) and reload it, then re-run. If LM Studio refuses the larger size or keeps the smaller one, narrow the request or pick a model with a larger context window. OpenAdminOS does not reload the model itself, because that would replace the model you loaded. LM Studio said: The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a",
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

it("shows the sizes and the load settings steps in the LM Studio playbook, which the header cuts off", () => {
  const advice = "This request needs 15,857 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,096. Raise Context Length to at least 20,480 (qwen3-8b supports up to 32,768) in the model's load settings in LM Studio (My Models, or the loaded model in the Developer tab) and reload it, then re-run. If LM Studio refuses the larger size or keeps the smaller one, narrow the request or pick a model with a larger context window. OpenAdminOS does not reload the model itself, because that would replace the model you loaded.";
  const error = `LM Studio context length too small: ${advice} LM Studio said: <LM Studio error> Trying to keep the first 15857 tokens when context the overflows.`;
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  const body = screen.getByText(advice);
  expect(body.textContent).toContain("20,480");
  expect(body.textContent).toContain("32,768");
  expect(body.textContent).toContain("My Models");
  expect(body.textContent).not.toContain("LM Studio said");
});

it("does not give an Ollama context error the LM Studio playbook", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Ollama context size too small: This request needs 40,652 tokens of context, but qwen3:8b supports at most 40,960. Ollama said: Ollama could not load qwen3:8b with the 45,056 token context size kept from an earlier request, usually because free memory ran out." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Ollama context too small")).toBeInTheDocument();
  expect(screen.queryByText("LM Studio context too small")).not.toBeInTheDocument();
  expect(screen.getByText(/Narrow the question or the agent's scope/)).toBeInTheDocument();
  expect(screen.queryByText("Ollama failed with a kept context size")).not.toBeInTheDocument();
});

it("keeps the LM Studio playbook for a model whose name mentions Ollama", () => {
  const error = "LM Studio context length too small: This request does not fit in the 8,192 tokens of context ollama-port/qwen3 is loaded with in LM Studio. Raise Context Length in the model's load settings in LM Studio (My Models, or the loaded model in the Developer tab) and reload it, then re-run. LM Studio said: context limit reached at /api/show: n/a";
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("LM Studio context too small")).toBeInTheDocument();
  expect(screen.queryByText("Ollama did not report the model's context limit")).not.toBeInTheDocument();
});

it("shows Graph advice for a stored required Teams connector failure on a Graph 403", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Connector 'teams' failed its health check: Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Graph access cause unverified")).toBeInTheDocument();
});

it("shows Graph advice for a stored replan failure on a required Teams connector's Graph 403", () => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error: "Nothing was applied: Connector 'teams' failed its health check: Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes." };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Graph access cause unverified")).toBeInTheDocument();
});

it("explains a reasoning-only Ollama reply instead of suggesting a model pull", () => {
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: 'Ollama stopped "gpt-oss:20b" at the token limit while it was still reasoning, so there is no answer. Raise the token limit, shorten the request, or pick a model that answers without reasoning.',
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model reasoned without answering")).toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});

it.each([
  'Ollama returned only reasoning from "gpt-oss:20b" and no answer. Retry, or pick a model that answers without reasoning.',
])("gives the other reasoning-only Ollama reply the same recovery: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model reasoned without answering")).toBeInTheDocument();
});

it("does not read a server body that mentions reasoning as a reasoning-only reply", () => {
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: 'Ollama responded with HTTP 500: proxy note: upstream returned only reasoning from "gpt-oss:20b" and no answer.',
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.queryByText("Model reasoned without answering")).not.toBeInTheDocument();
});

it("shows only the reasoning card for a model whose name matches another playbook", () => {
  const run: RunRecord = {
    id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [],
    error: 'Ollama returned only reasoning from "gpt-oss-timeout" and no answer. Retry, or pick a model that answers without reasoning.',
  };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model reasoned without answering")).toBeInTheDocument();
  expect(screen.queryByText("Ollama generation timed out")).not.toBeInTheDocument();
  expect(screen.queryByText("Request timed out")).not.toBeInTheDocument();
});

it.each([
  'The plan could not be checked against the tenant before applying, so nothing was applied. Ollama stopped "gpt-oss:20b" at the token limit while it was still reasoning, so there is no answer.',
  'MXC script agent "intune-device-posture-auditor" failed: Error: llm.complete: Ollama returned only reasoning from "gpt-oss:20b" and no answer. Retry, or pick a model that answers without reasoning.',
])("gives a wrapped reasoning-only failure its card from the recorded cause: %s", (error) => {
  const run: RunRecord = { id: "run", agentSlug: "test", status: "failed", queuedAt: "2026-11-01T00:00:00Z", steps: [], logs: [], error, failureCause: "reasoning-without-answer" };
  render(<RunFailureRemediation run={run} />);
  expect(screen.getByText("Model reasoned without answering")).toBeInTheDocument();
  expect(screen.queryByText("Model not pulled")).not.toBeInTheDocument();
  expect(screen.queryByText("No matching playbook")).not.toBeInTheDocument();
});
