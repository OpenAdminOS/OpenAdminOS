import type { AgentMode, WritePlan } from "./index.js";

/** Host-enforced bounds for one write plan, including simulated runs. */
export interface WriteLimits {
  maxActions: number;
  /** Exact WriteAction.kind keys, shared by request-backed and built-in actions. */
  maxActionsPerOperation?: Record<string, number>;
}

export const DEFAULT_WRITE_MAX_ACTIONS = 100;
export const MAX_WRITE_ACTIONS = 1_000;

export function writeLimitsValidationIssue(
  value: unknown,
  mode: AgentMode,
): { path: string; message: string } | undefined {
  const path = "writeLimits";
  if (value === undefined) return;
  if (mode !== "write") return { path, message: "read agents cannot declare write limits" };
  if (!isRecord(value)) return { path, message: "must be an object" };
  for (const key of Object.keys(value)) {
    if (key !== "maxActions" && key !== "maxActionsPerOperation") {
      return { path: `${path}.${key}`, message: "unknown write limit field" };
    }
  }
  const message = `must be a positive integer no greater than ${MAX_WRITE_ACTIONS}`;
  if (!validCount(value.maxActions)) return { path: `${path}.maxActions`, message };
  const perOperation = value.maxActionsPerOperation;
  if (perOperation !== undefined) {
    if (!isRecord(perOperation)) {
      return { path: `${path}.maxActionsPerOperation`, message: "must be an object keyed by action kind" };
    }
    for (const [kind, limit] of Object.entries(perOperation)) {
      if (!kind.trim() || kind !== kind.trim()) {
        return { path: `${path}.maxActionsPerOperation`, message: "keys must be non-empty action kinds without surrounding whitespace" };
      }
      if (!validCount(limit)) return { path: `${path}.maxActionsPerOperation.${kind}`, message };
    }
  }
}

export class WritePlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritePlanLimitError";
  }
}

/** Check the whole plan before confirmation and before dispatching any action. */
export function assertWritePlanLimits(
  plan: Pick<WritePlan, "actions">,
  limits?: WriteLimits,
): void {
  const issue = writeLimitsValidationIssue(limits, "write");
  if (issue) throw new Error(`${issue.path}: ${issue.message}`);
  if (!Array.isArray(plan?.actions)) throw new Error("Write plan must contain an actions array.");
  const maxActions = limits?.maxActions ?? DEFAULT_WRITE_MAX_ACTIONS;
  if (plan.actions.length > maxActions) {
    const source = limits ? "The agent's manifest" : "The host default";
    throw new WritePlanLimitError(
      `This plan has ${count(plan.actions.length)} actions. ${source} allows at most ${count(maxActions)} per run. Nothing was changed. Narrow the selection and run the agent again.`,
    );
  }
  const counts = new Map<string, number>();
  for (const action of plan.actions) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }
  for (const [kind, limit] of Object.entries(limits?.maxActionsPerOperation ?? {})) {
    const total = counts.get(kind) ?? 0;
    if (total > limit) {
      throw new WritePlanLimitError(
        `This plan has ${count(total)} actions of kind "${kind}". The agent's manifest allows at most ${count(limit)} of this kind per run. Nothing was changed. Narrow the selection and run the agent again.`,
      );
    }
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_WRITE_ACTIONS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
