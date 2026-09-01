import type {
  GraphCacheResourceKind,
  IntuneChatAgentSuggestion,
  IntuneChatInvestigationToolName,
  IntuneChatToolTraceEntry,
  ProviderId,
  RunLlmApi,
  TenantRecord,
} from "@openadminos/agent-sdk";

import { buildIntuneChatSystemPrompt } from "../state-helpers.js";
import {
  executeIntuneChatTool,
  summarizeToolCallForProgress,
  toolDefinitionsForPrompt,
  type IntuneChatToolContext,
} from "./tools.js";

/**
 * Tool calls allowed per question. Six was reached by questions that
 * genuinely need cross-referencing, for example matching installed apps
 * against what was deployed, and those fell back rather than finishing.
 * Most questions use two or three, so the higher ceiling costs latency
 * only on the questions that were failing at the old one.
 */
export const MAX_AGENTIC_ITERATIONS = 10;

/**
 * How many malformed replies to coach through before giving up. One
 * retry was too few for local models: a single slip ended investigative
 * mode and dropped the question back to keyword-planned context.
 */
const MAX_MALFORMED_RETRIES = 3;
const DEFAULT_OBSERVATION_CHAR_BUDGET = 36_000;

export const AGENTIC_TOOL_PROTOCOL = [
  "Use one tool call per iteration.",
  "To call a tool, respond with only a fenced JSON block:",
  '```json\n{"tool":"query_cache","params":{"resource":"managedDevices","where":{"complianceState":"noncompliant"},"limit":25}}\n```',
  "Every brace and bracket you open must be closed.",
  "If you do not know the Graph path for something, call find_graph_endpoint first rather than guessing a path.",
  "Do not call write tools. No write tools exist.",
  "When you have enough evidence, either answer in plain prose or return:",
  '```json\n{"final":true,"answer":"..."}\n```',
].join("\n");

export interface RunAgenticChatInput {
  question: string;
  /**
   * Documentation passages retrieved for this question. Empty when no
   * index is installed. Included so investigative answers are grounded
   * in product behaviour the same way deterministic answers are.
   */
  documentation?: ReadonlyArray<{ file: string; title?: string; text: string }>;
  tenant: TenantRecord;
  providerId: ProviderId;
  providerIsLocal: boolean;
  model?: string;
  llm: RunLlmApi;
  tools: IntuneChatToolContext;
  plannedResources: GraphCacheResourceKind[];
  agentSuggestions: IntuneChatAgentSuggestion[];
  generatedAt: string;
  maxTokens: number;
  observationCharBudget?: number;
  signal?: AbortSignal;
  onToolStart?: (event: {
    tool: IntuneChatInvestigationToolName;
    params: unknown;
    message: string;
    startedAt: string;
  }) => void;
  onToolFinish?: (event: {
    traceEntry: IntuneChatToolTraceEntry;
    message: string;
  }) => void;
}

export type RunAgenticChatResult =
  | {
      ok: true;
      answer: string;
      toolTrace: IntuneChatToolTraceEntry[];
      iterations: number;
      model?: string;
    }
  | {
      ok: false;
      reason: "malformed-output" | "iteration-cap" | "provider-unavailable";
      fallbackNotice: string;
      toolTrace: IntuneChatToolTraceEntry[];
      iterations: number;
      model?: string;
    };

type LoopTurn =
  | { role: "assistant"; content: string }
  | { role: "observation"; content: string }
  | { role: "repair"; content: string };

type ParsedModelAction =
  | { kind: "tool"; tool: IntuneChatInvestigationToolName; params: unknown }
  | { kind: "final"; answer: string }
  | { kind: "malformed"; reason: string };

export async function runAgenticChat(
  input: RunAgenticChatInput,
): Promise<RunAgenticChatResult> {
  if (!input.llm.available) {
    return {
      ok: false,
      reason: "provider-unavailable",
      fallbackNotice:
        "Deterministic retrieval — the selected model is not available for investigative mode.",
      toolTrace: [],
      iterations: 0,
    };
  }

  const turns: LoopTurn[] = [];
  const toolTrace: IntuneChatToolTraceEntry[] = [];
  let malformedCount = 0;
  let responseModel = input.model;

  // Turns spent coaching the model back into valid JSON must not eat
  // the investigation budget: a model that slips twice and then works
  // correctly was reaching the tool-call cap with only three or four
  // actual tool calls made, and losing the investigation to a fallback.
  let iteration = 0;
  let attempts = 0;
  const maxAttempts = MAX_AGENTIC_ITERATIONS + MAX_MALFORMED_RETRIES + 1;
  while (iteration < MAX_AGENTIC_ITERATIONS && attempts < maxAttempts) {
    attempts += 1;
    assertNotCancelled(input.signal);
    const completion = await input.llm.complete({
      system: buildAgenticSystemPrompt(input),
      prompt: buildLoopPrompt(input, turns),
      ...(input.model ? { model: input.model } : {}),
      temperature: 0.1,
      maxTokens: Math.max(500, input.maxTokens),
      signal: input.signal,
    });
    responseModel = completion.model;
    const assistantText = completion.text.trim();
    turns.push({ role: "assistant", content: assistantText });

    const action = parseModelAction(assistantText);
    if (action.kind === "malformed") {
      malformedCount += 1;
      if (malformedCount > MAX_MALFORMED_RETRIES) {
        return {
          ok: false,
          reason: "malformed-output",
          fallbackNotice: `Investigative mode returned malformed tool JSON ${malformedCount} times. Deterministic retrieval was used instead.`,
          toolTrace,
          iterations: iteration,
          ...(responseModel ? { model: responseModel } : {}),
        };
      }
      turns.push({
        role: "repair",
        content: [
          "That was not valid tool JSON. Reply with exactly one fenced JSON block and nothing else.",
          "To read cached rows:",
          '```json\n{"tool":"query_cache","params":{"resource":"managedDevices","limit":25}}\n```',
          "To find a Graph path when you do not know it:",
          '```json\n{"tool":"find_graph_endpoint","params":{"query":"conditional access named locations"}}\n```',
          "To finish:",
          '```json\n{"final":true,"answer":"..."}\n```',
          "Every brace and bracket you open must be closed.",
        ].join("\n"),
      });
      continue;
    }

    malformedCount = 0;
    iteration += 1;
    if (action.kind === "final") {
      return {
        ok: true,
        answer: action.answer.trim(),
        toolTrace,
        iterations: iteration,
        ...(responseModel ? { model: responseModel } : {}),
      };
    }

    const startedAt = new Date().toISOString();
    input.onToolStart?.({
      tool: action.tool,
      params: action.params,
      message: summarizeToolCallForProgress(action.tool, action.params),
      startedAt,
    });
    const execution = await executeIntuneChatTool(input.tools, action.tool, action.params);
    toolTrace.push(execution.trace);
    input.onToolFinish?.({
      traceEntry: execution.trace,
      message: execution.trace.error
        ? `${action.tool} failed.`
        : execution.trace.resultSummary,
    });
    turns.push({
      role: "observation",
      content: trimObservation(
        JSON.stringify(
          {
            tool: action.tool,
            params: action.params,
            result: execution.result,
            trace: execution.trace,
          },
          null,
          2,
        ),
        input.observationCharBudget ?? DEFAULT_OBSERVATION_CHAR_BUDGET,
      ),
    });
    trimTurns(turns, input.observationCharBudget ?? DEFAULT_OBSERVATION_CHAR_BUDGET);
  }

  return {
    ok: false,
    reason: "iteration-cap",
    fallbackNotice:
      "Investigative mode reached the tool-call limit before a final answer. Deterministic retrieval was used instead.",
    toolTrace,
    iterations: MAX_AGENTIC_ITERATIONS,
    ...(responseModel ? { model: responseModel } : {}),
  };
}

function buildAgenticSystemPrompt(input: RunAgenticChatInput): string {
  const tenantName = input.tenant.displayName || "Active tenant";
  return [
    buildIntuneChatSystemPrompt(input.providerIsLocal),
    "",
    "You can investigate read-only tenant data by asking the host to run tools.",
    "Every tool call is visible to the admin and recorded with the final answer.",
    "STRICT READ-ONLY: never request writes, deletes, creates, updates, retirements, wipes, assignments, or connector sends.",
    "If the admin asks for a change, say chat cannot perform changes and point them to installed write agents.",
    "",
    `Tenant: ${tenantName}`,
    `Provider: ${input.providerId}${input.model ? ` · ${input.model}` : ""}`,
    `Generated at: ${input.generatedAt}`,
    `Planner prefetch hints: ${input.plannedResources.join(", ") || "none"}`,
    input.agentSuggestions.length > 0
      ? `Installed agent hints: ${input.agentSuggestions
          .slice(0, 3)
          .map((agent) => `${agent.agentName} (${agent.mode})`)
          .join(", ")}`
      : "Installed agent hints: none",
    "",
    "Available tools:",
    toolDefinitionsForPrompt(),
    "",
    "JSON protocol:",
    AGENTIC_TOOL_PROTOCOL,
    "",
    "Answer style: concise admin-facing prose, cite caveats and stale or missing data, no hype, no exclamation marks.",
  ].join("\n");
}

function buildLoopPrompt(input: RunAgenticChatInput, turns: LoopTurn[]): string {
  const transcript = turns
    .map((turn) => {
      if (turn.role === "observation") {
        return `Observation:\n${turn.content}`;
      }
      if (turn.role === "repair") {
        return `Repair instruction:\n${turn.content}`;
      }
      return `Assistant:\n${turn.content}`;
    })
    .join("\n\n");
  const documentation = (input.documentation ?? [])
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.title ? `${chunk.title} - ` : ""}${chunk.file}\n${chunk.text.trim()}`,
    )
    .join("\n\n");
  return [
    documentation
      ? `Microsoft documentation retrieved locally. It describes general product behaviour, not this tenant's state. Cite it as [1], [2] when you rely on it.\n\n${documentation}`
      : "",
    `Admin question:\n${input.question}`,
    transcript ? `Conversation so far:\n${transcript}` : "",
    "Next response:",
  ].filter(Boolean).join("\n\n");
}

function parseModelAction(text: string): ParsedModelAction {
  const extraction = extractLastJsonObject(text);
  if (!extraction.found) {
    return { kind: "final", answer: text };
  }
  if (!extraction.valid) {
    return { kind: "malformed", reason: extraction.reason };
  }
  const value = extraction.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", reason: "Tool JSON must be an object." };
  }
  const record = value as Record<string, unknown>;
  if (record.final === true) {
    const answer =
      typeof record.answer === "string"
        ? record.answer
        : typeof record.content === "string"
          ? record.content
          : "";
    return { kind: "final", answer };
  }
  if (typeof record.tool === "string") {
    if (!isToolName(record.tool)) {
      return { kind: "malformed", reason: `Unknown tool: ${record.tool}` };
    }
    const params =
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? record.params
        : {};
    return { kind: "tool", tool: record.tool, params };
  }
  return { kind: "malformed", reason: "Tool JSON must include tool or final." };
}

function extractLastJsonObject(text: string):
  | { found: false }
  | { found: true; valid: true; value: unknown }
  | { found: true; valid: false; reason: string } {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (fenced.length > 0) {
    for (const block of fenced.slice().reverse()) {
      const parsed = parseLenient(block);
      if (parsed.ok) return { found: true, valid: true, value: parsed.value };
    }
    return { found: true, valid: false, reason: "Fenced JSON did not parse." };
  }

  const candidates = findBalancedJsonCandidates(text);
  if (candidates.length === 0) {
    return text.includes("{")
      ? { found: true, valid: false, reason: "JSON object was not balanced." }
      : { found: false };
  }
  for (const candidate of candidates.slice().reverse()) {
    const parsed = parseLenient(candidate);
    if (parsed.ok) return { found: true, valid: true, value: parsed.value };
  }
  return { found: true, valid: false, reason: "JSON object did not parse." };
}

/**
 * Parse a model's JSON, repairing the small mistakes local models make.
 *
 * An 8B model reliably picks the right tool but often drops a closing
 * brace or leaves a trailing comma. Treating that as a protocol failure
 * threw away a correct tool call and, after two strikes, abandoned
 * investigative mode altogether, which is the difference between a
 * small model being able to answer an unanticipated question and not.
 * Repairs are structural only: no key, value, or tool name is invented.
 */
function parseLenient(block: string): { ok: true; value: unknown } | { ok: false } {
  const attempts = [block, repairJsonText(block)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return { ok: true, value: JSON.parse(attempt) as unknown };
    } catch {
      // Fall through to the repaired form.
    }
  }
  return { ok: false };
}

function repairJsonText(block: string): string | undefined {
  let text = block.trim();
  if (!text.startsWith("{")) return undefined;
  // Drop a trailing comma before the end, then close any structures the
  // model left open, innermost first.
  text = text.replace(/,\s*$/, "");
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  if (inString) text += '"';
  if (stack.length === 0) return undefined;
  text = text.replace(/,\s*$/, "");
  while (stack.length > 0) {
    text += stack.pop() === "{" ? "}" : "]";
  }
  return text;
}

function findBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function isToolName(value: string): value is IntuneChatInvestigationToolName {
  return (
    value === "list_cached_resources" ||
    value === "query_cache" ||
    value === "find_graph_endpoint" ||
    value === "graph_get" ||
    value === "refresh_resource" ||
    value === "query_drift"
  );
}

function trimObservation(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 120))}\n... observation truncated by host ...`;
}

function trimTurns(turns: LoopTurn[], maxObservationChars: number): void {
  let observationChars = turns
    .filter((turn) => turn.role === "observation")
    .reduce((sum, turn) => sum + turn.content.length, 0);
  while (observationChars > maxObservationChars && turns.length > 0) {
    const index = turns.findIndex((turn) => turn.role === "observation");
    if (index < 0) return;
    observationChars -= turns[index]!.content.length;
    turns.splice(index, 1, {
      role: "observation",
      content: "... older tool observation omitted by host budget ...",
    });
    observationChars += turns[index]!.content.length;
    if (observationChars <= maxObservationChars) return;
    turns.splice(index, 1);
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Agentic chat stopped by user.");
  error.name = "AbortError";
  throw error;
}
