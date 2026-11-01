import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  RunLlmApi,
} from "@openadminos/agent-sdk";

import { PILOT_COPY, type PilotAgentSlug } from "../../src/shared/pilot-mode.js";
import type { SampleClock } from "./graph.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The prepared step a pilot LLM call belongs to. `promptPrefix` is the
 * static start of the step's prompt template in the agent manifest; a test
 * keeps the two in sync.
 */
export interface PilotPreparedStep {
  agentSlug: PilotAgentSlug;
  stepId: string;
  promptPrefix: string;
  render(prompt: ParsedPrompt, now: Date): string;
}

export interface ParsedPrompt {
  /** Prompt text with every tenant data fence replaced by its body. */
  text: string;
  /** Fence bodies keyed by template path, for example `load_policies.output`. */
  values: Map<string, string>;
}

const FENCE =
  /<tenant_data source="template:([^"]*)" nonce="([0-9a-f]+)">\n([\s\S]*?)\n<\/tenant_data nonce="\2">/g;

export function parsePilotPrompt(prompt: string): ParsedPrompt {
  const values = new Map<string, string>();
  const text = prompt.replace(FENCE, (_match, source: string, _nonce: string, body: string) => {
    const decoded = decodeFenceBody(body);
    values.set(source, decoded);
    return decoded;
  });
  return { text, values };
}

function decodeFenceBody(body: string): string {
  return body.replace(/\\u(003c|003e|ff1c|ff1e|fe64|fe65|2329|232a|27e8|27e9|2039|203a)/gi, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function jsonValue(prompt: ParsedPrompt, path: string): unknown {
  const raw = prompt.values.get(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function textValue(prompt: ParsedPrompt, path: string): string {
  const value = jsonValue(prompt, path);
  return value === undefined || value === null ? "" : String(value);
}

function numberAfter(prompt: ParsedPrompt, pattern: RegExp): number {
  const match = pattern.exec(prompt.text);
  return match ? Number(match[1]) : 0;
}

function countRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, count]) => [
      key,
      Array.isArray(count) ? count.length : Number(count) || 0,
    ]),
  );
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function list(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function breakdown(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, count]) => count > 0);
  return entries.length === 0
    ? "none"
    : entries
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([key, count]) => `${count} ${key}`)
        .join(", ");
}

function daysSince(value: unknown, now: Date): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.floor((now.getTime() - parsed) / DAY_MS) : undefined;
}

function shortDate(value: unknown): string {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toISOString().slice(0, 10);
}

function renderInactiveDevicesSummary(prompt: ParsedPrompt): string {
  const total = numberAfter(prompt, /Total managed devices:\s*(\d+)/);
  const warnDays = numberAfter(prompt, /Warn band \(>= (\d+) days\)/);
  const warn = numberAfter(prompt, /Warn band \(>= \d+ days\):\s*(\d+)/);
  const staleDays = numberAfter(prompt, /Stale band \(>= (\d+) days\)/);
  const stale = numberAfter(prompt, /Stale band \(>= \d+ days\):\s*(\d+)/);
  const retireDays = numberAfter(prompt, /Retire band \(>= (\d+) days\)/);
  const retire = numberAfter(prompt, /Retire band \(>= \d+ days\):\s*(\d+)/);
  const staleByCompliance = countRecord(jsonValue(prompt, "stale_by_compliance.output"));
  const retireByCompliance = countRecord(jsonValue(prompt, "retire_by_compliance.output"));
  const warnByOs = countRecord(jsonValue(prompt, "inactive_by_os.output"));
  const retireByOwner = countRecord(jsonValue(prompt, "retire_by_owner_type.output"));
  const oldest = rows(jsonValue(prompt, "oldest_devices.output"));
  const inactive = warn + stale + retire;

  const finding = inactive === 0
    ? `All ${total} managed devices synced within the last ${warnDays} days. No device is in an inactivity band.`
    : `${inactive} of ${total} managed devices have not synced for at least ${warnDays} days: ${warn} in the warn band (${warnDays} to ${staleDays - 1} days), ${stale} in the stale band (${staleDays} to ${retireDays - 1} days), and ${retire} past ${retireDays} days.`;
  const oldestLine = oldest.length > 0
    ? ` The oldest is ${String(oldest[0]!.deviceName)}, last synced ${shortDate(oldest[0]!.lastSyncDateTime)}.`
    : "";
  const concentration = Object.keys(warnByOs).length > 0
    ? `Warn-band devices by platform: ${breakdown(warnByOs)}.`
    : "No platform concentration in the warn band.";

  // Prose paragraphs: run summaries render as plain text, so headings and
  // bullets would run together.
  return paragraphs(
    [PILOT_COPY.preparedPrefix, `${finding}${oldestLine}`],
    [
      "Before cleanup, check each device against replacement and offboarding records, and whether its primary user still works here.",
      `Stale band compliance is ${breakdown(staleByCompliance)}; that is the last state each device reported, not its current state.`,
      retire > 0
        ? `Retirement candidates by compliance: ${breakdown(retireByCompliance)}. By ownership: ${breakdown(retireByOwner)}.`
        : "",
    ],
    [
      concentration,
      retire > 0
        ? `Review the ${plural(retire, "retirement candidate", "retirement candidates")} with their owners before any retire action, and run this agent again after the next sync window.`
        : "No device is past the retire threshold. Keep monitoring the stale band.",
    ],
  );
}

function paragraphs(...blocks: string[][]): string {
  return blocks
    .map((block) => block.filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

interface CaPolicy {
  displayName: string;
  state: string;
  excludeUsers: number;
  excludesGuests: boolean;
  includesGuests: boolean;
  grant: string[];
  clientAppTypes: string[];
  signInRisk: string[];
  sessionControls: boolean;
  includesAllUsers: boolean;
}

function caPolicies(prompt: ParsedPrompt): CaPolicy[] {
  return rows(jsonValue(prompt, "load_policies.output")).map((policy) => {
    const conditions = (policy.conditions ?? {}) as Record<string, unknown>;
    const users = (conditions.users ?? {}) as Record<string, unknown>;
    const grant = (policy.grantControls ?? {}) as Record<string, unknown>;
    return {
      displayName: String(policy.displayName ?? policy.id ?? "Unnamed policy"),
      state: String(policy.state ?? "unknown"),
      excludeUsers: Array.isArray(users.excludeUsers) ? users.excludeUsers.length : 0,
      excludesGuests: Boolean(users.excludeGuestsOrExternalUsers),
      includesGuests: Boolean(users.includeGuestsOrExternalUsers),
      grant: Array.isArray(grant.builtInControls) ? grant.builtInControls.map(String) : [],
      clientAppTypes: Array.isArray(conditions.clientAppTypes) ? conditions.clientAppTypes.map(String) : [],
      signInRisk: Array.isArray(conditions.signInRiskLevels) ? conditions.signInRiskLevels.map(String) : [],
      sessionControls: Boolean(policy.sessionControls),
      includesAllUsers: Array.isArray(users.includeUsers) && users.includeUsers.map(String).includes("All"),
    };
  });
}

function stateLabel(state: string): string {
  return state === "enabledForReportingButNotEnforced"
    ? "report-only"
    : state === "enabled"
      ? "enabled"
      : state;
}

function coverage(label: string, policies: CaPolicy[]): string {
  if (policies.length === 0) return `- ${label}: not proven from this policy set.`;
  const enforced = policies.filter((policy) => policy.state === "enabled");
  const names = policies.map((policy) => `${policy.displayName} (${stateLabel(policy.state)})`);
  return `- ${label}: ${enforced.length > 0 ? (enforced.length === policies.length ? "covered" : "partially covered") : "not enforced"} by ${list(names)}.`;
}

function renderConditionalAccessReview(prompt: ParsedPrompt): string {
  const policies = caPolicies(prompt);
  const total = numberAfter(prompt, /The tenant has\s*(\d+)/) || policies.length;
  const disabled = policies.filter((policy) => policy.state === "disabled");
  const reportOnly = policies.filter((policy) => policy.state === "enabledForReportingButNotEnforced");
  const enforced = policies.filter((policy) => policy.state === "enabled");
  const broadExclusions = policies.filter((policy) => policy.excludeUsers >= 3);
  const guestExclusions = policies.filter((policy) => policy.excludesGuests);
  const byName = (pattern: RegExp) => policies.filter((policy) => pattern.test(policy.displayName));

  const mainFinding = [
    `${enforced.length} of ${total} Conditional Access policies are enforced.`,
    disabled.length + reportOnly.length > 0
      ? `${plural(disabled.length + reportOnly.length, "policy does", "policies do")} not enforce protection today (${list([...disabled, ...reportOnly].map((policy) => `${policy.displayName}, ${stateLabel(policy.state)}`))}).`
      : "Every policy is enforced.",
    broadExclusions.length > 0
      ? `The widest exclusion list is on ${broadExclusions[0]!.displayName} with ${broadExclusions[0]!.excludeUsers} excluded entries.`
      : "",
  ].filter(Boolean).join(" ");

  const interactions = [
    ...broadExclusions.map((policy) =>
      `- ${policy.displayName} excludes ${policy.excludeUsers} users or groups. Confirm each exclusion is still intended and that another policy covers them.`,
    ),
    ...guestExclusions.map((policy) =>
      `- ${policy.displayName} excludes guest and external identities${policies.some((other) => other.includesGuests) ? `, while ${list(policies.filter((other) => other.includesGuests).map((other) => other.displayName))} targets them` : ""}. Check that the two do not leave a gap.`,
    ),
    ...reportOnly.map((policy) =>
      `- ${policy.displayName} is report-only, so it logs results but blocks nothing.`,
    ),
  ];

  const gaps = [
    ...disabled.map((policy) => `- ${policy.displayName} is disabled. Decide whether to retire it or replace it.`),
    ...reportOnly.map((policy) => `- ${policy.displayName} has not been enforced. Review its sign-in impact first.`),
    ...(policies.some((policy) => policy.signInRisk.length > 0)
      ? []
      : ["- No policy uses sign-in risk conditions."]),
  ];

  const strip = (line: string) => line.replace(/^- /, "");
  return paragraphs(
    [PILOT_COPY.preparedPrefix, mainFinding],
    [
      "Coverage.",
      ...[
        coverage("Admin MFA", byName(/admin/i).filter((policy) => policy.grant.includes("mfa"))),
        coverage("All-user MFA", policies.filter((policy) => policy.includesAllUsers && policy.grant.includes("mfa") && !/admin|guest|risk/i.test(policy.displayName))),
        coverage("Legacy authentication block", policies.filter((policy) => policy.grant.includes("block") && policy.clientAppTypes.some((type) => type !== "all"))),
        coverage("Device compliance", policies.filter((policy) => policy.grant.includes("compliantDevice"))),
        coverage("Guest and external access", policies.filter((policy) => policy.includesGuests)),
        coverage("Risky sign-ins", policies.filter((policy) => policy.signInRisk.length > 0)),
        coverage("Session controls", policies.filter((policy) => policy.sessionControls)),
      ].map(strip),
    ],
    [
      "Interactions to watch.",
      ...(interactions.length > 0 ? interactions.slice(0, 5) : ["No overlapping exclusions found in this policy set."]).map(strip),
    ],
    [
      "Gaps.",
      ...(gaps.length > 0 ? gaps.slice(0, 5) : ["No disabled or report-only policies."]).map(strip),
    ],
    [
      "Next action.",
      reportOnly.length > 0
        ? `Open the sign-in logs for ${reportOnly[0]!.displayName} and review its report-only results before proposing enforcement.`
        : "Review the exclusion lists with their owners before changing any policy.",
    ],
  );
}

function renderGuestRationale(prompt: ParsedPrompt, now: Date): string {
  const name = textValue(prompt, "guest.displayName") || "This guest";
  const state = textValue(prompt, "guest.externalUserState");
  const lastSignIn = textValue(prompt, "guest.signInActivity.lastSignInDateTime");
  const idle = daysSince(lastSignIn, now);
  const idleText = idle === undefined ? "has no recorded sign-in" : `has not signed in for ${plural(idle, "day", "days")}`;
  const check = state === "PendingAcceptance"
    ? "the invitation was never accepted, so confirm the sponsor no longer expects it before disabling."
    : "confirm with the sponsoring team that the collaboration has ended before disabling.";
  return `${PILOT_COPY.preparedPrefix} ${name} ${idleText}; ${check}`;
}

export const PILOT_PREPARED_STEPS: readonly PilotPreparedStep[] = [
  {
    agentSlug: "find-inactive-devices",
    stepId: "summarize",
    promptPrefix: "Total managed devices:",
    render: (prompt) => renderInactiveDevicesSummary(prompt),
  },
  {
    agentSlug: "conditional-access-explainer",
    stepId: "explain",
    promptPrefix: "The tenant has",
    render: (prompt) => renderConditionalAccessReview(prompt),
  },
  {
    agentSlug: "stale-guest-cleanup",
    stepId: "reason",
    promptPrefix: "Guest",
    render: (prompt, now) => renderGuestRationale(prompt, now),
  },
];

export function findPilotPreparedStep(
  agentSlug: string,
  prompt: string,
): PilotPreparedStep | undefined {
  const trimmed = prompt.trimStart();
  return PILOT_PREPARED_STEPS.find(
    (step) => step.agentSlug === agentSlug && trimmed.startsWith(step.promptPrefix),
  );
}

/**
 * An LLM stand-in used only for pilot runs. It never contacts a provider: it
 * recognises the agent step from the prompt and returns prepared text built
 * from the same facts the prompt carries. Anything it does not recognise is
 * refused, so a pilot run can never quietly fall back to a real model.
 */
export function createPilotLlm(options: { agentSlug: string; clock?: SampleClock }): RunLlmApi {
  const clock = options.clock ?? (() => new Date());
  const complete = async (input: LlmOptions): Promise<LlmCompletion> => {
    input.signal?.throwIfAborted();
    const step = findPilotPreparedStep(options.agentSlug, input.prompt);
    if (!step) {
      throw new Error(
        `Pilot mode has no prepared text for this step of ${options.agentSlug}. Connect your tenant to run it with a model.`,
      );
    }
    return {
      text: step.render(parsePilotPrompt(input.prompt), clock()),
      model: PILOT_COPY.preparedModel,
    };
  };
  return {
    available: true,
    defaultModel: PILOT_COPY.preparedModel,
    complete,
    async *stream(input: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const completion = await complete(input);
      yield {
        delta: completion.text,
        accumulated: completion.text,
        done: true,
        model: completion.model,
      };
    },
  };
}
