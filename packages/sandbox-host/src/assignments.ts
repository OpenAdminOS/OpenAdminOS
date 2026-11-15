import type { ScheduleAssignment } from "@openadminos/pairing";

import { resolveSandboxAgent } from "./agents.js";
import { MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, type SandboxAgentConfig, type SandboxConfig } from "./config.js";
import { isSandboxRefusal } from "./refusal.js";

export type AssignmentFailure =
  /** The record is malformed or its signature does not verify with the paired desktop's key. */
  | "assignment-invalid"
  /** The version is not higher than the one the sandbox holds. */
  | "assignment-replayed"
  /** Another pairing, organization or tenant than this sandbox's. */
  | "assignment-binding-mismatch"
  /** The entry's templateSha256 is not the hash of the manifest bundled with this sandbox. */
  | "assignment-template-mismatch"
  /** The agent fails the checks every sandbox agent passes. */
  | "assignment-agent-refused"
  /** The interval is outside 15 minutes to 31 days. */
  | "assignment-interval-invalid"
  /** The stored assignment could not be read, so no version floor is known. */
  | "assignment-state-unknown";

export class AssignmentError extends Error {
  constructor(readonly code: AssignmentFailure, message: string) {
    super(message);
    this.name = "AssignmentError";
  }
}

/** Where a schedule comes from; a config entry wins over an assigned one for the same agent. */
export interface EffectiveSchedule {
  agent: SandboxAgentConfig;
  source: "config" | "assigned";
}

/**
 * Checks a verified assignment against this sandbox: the pairing,
 * organization and tenant, a version above the held one, and for each
 * entry the interval, the bundled manifest hash and the static agent
 * checks. Throws an AssignmentError naming the first problem.
 */
export function checkAssignment(
  assignment: ScheduleAssignment,
  context: { config: SandboxConfig; pairingId: string; heldVersion: number | undefined },
): void {
  const { config, pairingId, heldVersion } = context;
  if (assignment.pairingId !== pairingId || assignment.organizationId !== config.organizationId || assignment.tenantId !== config.tenantId) {
    throw new AssignmentError(
      "assignment-binding-mismatch",
      `The assignment is for pairing ${assignment.pairingId}, organization ${assignment.organizationId} and tenant ${assignment.tenantId}; this sandbox is paired as ${pairingId} for organization ${config.organizationId} and tenant ${config.tenantId}.`,
    );
  }
  if (heldVersion !== undefined && assignment.version <= heldVersion) {
    throw new AssignmentError("assignment-replayed", `The assignment has version ${assignment.version}; this sandbox already holds version ${heldVersion}. Send a newer assignment.`);
  }
  for (const entry of assignment.entries) {
    if (entry.intervalSeconds < MIN_INTERVAL_SECONDS || entry.intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new AssignmentError(
        "assignment-interval-invalid",
        `${entry.agentId} has an interval of ${entry.intervalSeconds} seconds; a sandbox schedule runs every 900 seconds (15 minutes) to ${MAX_INTERVAL_SECONDS} seconds (31 days).`,
      );
    }
    try {
      resolveSandboxAgent({ id: entry.agentId, templateSha256: entry.templateSha256, intervalSeconds: entry.intervalSeconds });
    } catch (error) {
      if (isSandboxRefusal(error) && error.reason === "agent-hash-mismatch") {
        throw new AssignmentError(
          "assignment-template-mismatch",
          `The manifest of ${entry.agentId} bundled with this sandbox is not the one the desktop assigned (templateSha256 ${entry.templateSha256}). Update the sandbox or the desktop so both run the same release.`,
        );
      }
      const reason = isSandboxRefusal(error) ? error.reason : "run-failed";
      throw new AssignmentError("assignment-agent-refused", `${entry.agentId} cannot run in a sandbox (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The union of config and assigned schedules, keyed by agent id. A config
 * entry wins on a clash; the assigned entry is reported as shadowed.
 */
export function effectiveSchedules(config: SandboxConfig, assignment: ScheduleAssignment | undefined): { schedules: EffectiveSchedule[]; shadowed: string[] } {
  const schedules: EffectiveSchedule[] = config.agents.map((agent) => ({ agent, source: "config" }));
  const configured = new Set(config.agents.map((agent) => agent.id));
  const shadowed: string[] = [];
  for (const entry of assignment?.entries ?? []) {
    if (configured.has(entry.agentId)) {
      shadowed.push(entry.agentId);
      continue;
    }
    schedules.push({ agent: { id: entry.agentId, templateSha256: entry.templateSha256, intervalSeconds: entry.intervalSeconds }, source: "assigned" });
  }
  return { schedules, shadowed };
}
