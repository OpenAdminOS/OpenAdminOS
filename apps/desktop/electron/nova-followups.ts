import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { NovaFollowUp, NovaFollowUpStatus, ProviderId } from "@openadminos/agent-sdk";

import type { AuditLogEventSeed } from "./audit-log.js";

/**
 * Nova follow-ups: one read-only question asked again once, later, in the
 * organization it was set in. Created only by a click on a Nova card.
 * Kept in openadminos.db on this device. The answer goes to Chat and is
 * never sent anywhere.
 */

export const NOVA_FOLLOW_UP_MIN_MINUTES = 1;
export const NOVA_FOLLOW_UP_MAX_MINUTES = 7 * 24 * 60;
export const NOVA_FOLLOW_UPS_PENDING_MAX = 5;
export const NOVA_FOLLOW_UPS_PER_DAY = 20;
/** A follow-up that could not run within this long after its time is marked missed. */
export const NOVA_FOLLOW_UP_LATE_MS = 60 * 60 * 1000;
export const NOVA_FOLLOW_UP_QUESTION_MAX_LENGTH = 600;
/** Follow-ups kept for Settings after they finished, per tenant. */
const FINISHED_KEPT = 20;

const DAY_MS = 86_400_000;

export class NovaFollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovaFollowUpError";
  }
}

export const NOVA_FOLLOW_UP_TOO_SOON = "A follow-up needs at least 1 minute. Say a later time, for example in 30 minutes.";
export const NOVA_FOLLOW_UP_TOO_LATE = "A follow-up can be at most 7 days ahead. Say an earlier time.";
export const NOVA_FOLLOW_UPS_FULL = `You already have ${NOVA_FOLLOW_UPS_PENDING_MAX} pending follow-ups. Cancel one in Settings, Nova, first.`;
export const NOVA_FOLLOW_UPS_DAILY_LIMIT = `Nova already set ${NOVA_FOLLOW_UPS_PER_DAY} follow-ups in the last 24 hours. Try again later.`;
export const NOVA_FOLLOW_UP_PROVIDER_NOT_ALLOWED = "Your IT department no longer allows this provider or model. Nothing was asked.";
export const NOVA_FOLLOW_UP_NOT_FOUND = "That follow-up is no longer on this device. Reopen Settings, Nova, to see the current ones.";

/** The question as stored: one trimmed line within the limit. Throws the designed refusal otherwise. */
export function novaFollowUpQuestion(value: unknown): string {
  const question = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!question) throw new NovaFollowUpError("A follow-up needs a question.");
  if (question.length > NOVA_FOLLOW_UP_QUESTION_MAX_LENGTH) throw new NovaFollowUpError(`A follow-up question can have at most ${NOVA_FOLLOW_UP_QUESTION_MAX_LENGTH} characters. Shorten it and ask again.`);
  return question;
}

/** Throws the designed refusal for a delay outside 1 minute to 7 days. */
export function checkFollowUpDelay(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < NOVA_FOLLOW_UP_MIN_MINUTES) throw new NovaFollowUpError(NOVA_FOLLOW_UP_TOO_SOON);
  if (minutes > NOVA_FOLLOW_UP_MAX_MINUTES) throw new NovaFollowUpError(NOVA_FOLLOW_UP_TOO_LATE);
}

interface FollowUpRow {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  question: string;
  provider_id: string;
  model: string | null;
  due_at: string;
  status: NovaFollowUpStatus;
  created_at: string;
  finished_at: string | null;
  conversation_id: string | null;
  reason: string | null;
}

function followUpOf(row: FollowUpRow): NovaFollowUp {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    question: row.question,
    providerId: row.provider_id as ProviderId,
    ...(row.model ? { model: row.model } : {}),
    dueAt: row.due_at,
    status: row.status,
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

export interface NovaFollowUpInput {
  tenantId: string;
  organizationId?: string;
  question: string;
  providerId: ProviderId;
  model?: string;
  delayMinutes: number;
}

export interface NovaFollowUpsOptions {
  /** Records audit events; keeps them when the audit log cannot take them now. Never throws. */
  audit: (events: AuditLogEventSeed[]) => void;
  assertWritable?: (tenantId: string, what: string) => void;
  clock?: () => Date;
}

const AUDIT_TYPE: Record<NovaFollowUpStatus | "created" | "started", string> = {
  created: "nova.followup.created",
  started: "nova.followup.started",
  pending: "nova.followup.created",
  running: "nova.followup.started",
  completed: "nova.followup.completed",
  cancelled: "nova.followup.cancelled",
  "skipped-organization": "nova.followup.skipped",
  "skipped-provider": "nova.followup.skipped",
  missed: "nova.followup.missed",
  failed: "nova.followup.failed",
};

/** What the app looks like when a follow-up's time comes. */
export interface NovaFollowUpFireContext {
  now: Date;
  activeTenantId?: string;
  activeOrganizationId?: string;
  /** The tenant is still connected and not being disconnected. */
  tenantConnected: boolean;
  activeProviderId: ProviderId;
  activeModel?: string;
  /** The IT policy still allows the follow-up's provider and model. Absent counts as allowed. */
  providerAllowed?: boolean;
}

/**
 * Whether a due follow-up runs: only in the organization it was set in,
 * while that is active and connected, with the same provider and model,
 * and within an hour of its time.
 */
export function novaFollowUpFireDecision(
  followUp: Pick<NovaFollowUp, "tenantId" | "organizationId" | "providerId" | "model" | "dueAt">,
  context: NovaFollowUpFireContext,
): "run" | "missed" | "skipped-organization" | "skipped-provider" {
  if (context.now.getTime() - Date.parse(followUp.dueAt) > NOVA_FOLLOW_UP_LATE_MS) return "missed";
  if (!context.tenantConnected || context.activeTenantId !== followUp.tenantId) return "skipped-organization";
  if (followUp.organizationId && context.activeOrganizationId !== followUp.organizationId) return "skipped-organization";
  if (context.providerAllowed === false) return "skipped-provider";
  if (context.activeProviderId !== followUp.providerId || (context.activeModel ?? undefined) !== (followUp.model ?? undefined)) return "skipped-provider";
  return "run";
}

export class NovaFollowUps {
  private readonly clock: () => Date;

  constructor(private readonly db: DatabaseSync, private readonly options: NovaFollowUpsOptions) {
    this.clock = options.clock ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS nova_followups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT,
      question TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'skipped-organization', 'skipped-provider', 'missed', 'failed')),
      created_at TEXT NOT NULL,
      finished_at TEXT,
      conversation_id TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS nova_followups_due ON nova_followups (status, due_at);
    -- When each follow-up was set, for the daily limit. Only times, no
    -- tenant data: kept through pruning and Disconnect, and dropped after a day.
    CREATE TABLE IF NOT EXISTS nova_followup_creations (created_at TEXT NOT NULL);`);
  }

  /** Throws the designed refusal when a new follow-up with this delay would be over a limit. */
  checkLimits(delayMinutes: number): void {
    checkFollowUpDelay(delayMinutes);
    const pending = (this.db.prepare("SELECT COUNT(*) AS count FROM nova_followups WHERE status IN ('pending', 'running')").get() as { count: number }).count;
    if (pending >= NOVA_FOLLOW_UPS_PENDING_MAX) throw new NovaFollowUpError(NOVA_FOLLOW_UPS_FULL);
    const since = new Date(this.clock().getTime() - DAY_MS).toISOString();
    this.db.prepare("DELETE FROM nova_followup_creations WHERE created_at <= ?").run(since);
    const today = (this.db.prepare("SELECT COUNT(*) AS count FROM nova_followup_creations WHERE created_at > ?").get(since) as { count: number }).count;
    if (today >= NOVA_FOLLOW_UPS_PER_DAY) throw new NovaFollowUpError(NOVA_FOLLOW_UPS_DAILY_LIMIT);
  }

  create(input: NovaFollowUpInput): NovaFollowUp {
    const question = novaFollowUpQuestion(input.question);
    this.options.assertWritable?.(input.tenantId, "Nova follow-up");
    this.checkLimits(input.delayMinutes);
    const now = this.clock();
    const followUp: NovaFollowUp = {
      id: `followup_${randomUUID()}`,
      tenantId: input.tenantId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      question,
      providerId: input.providerId,
      ...(input.model ? { model: input.model } : {}),
      dueAt: new Date(now.getTime() + Math.round(input.delayMinutes) * 60_000).toISOString(),
      status: "pending",
      createdAt: now.toISOString(),
    };
    this.db
      .prepare(`INSERT INTO nova_followups (id, tenant_id, organization_id, question, provider_id, model, due_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(followUp.id, followUp.tenantId, followUp.organizationId ?? null, followUp.question, followUp.providerId, followUp.model ?? null, followUp.dueAt, followUp.createdAt);
    this.db.prepare("INSERT INTO nova_followup_creations (created_at) VALUES (?)").run(followUp.createdAt);
    this.record(followUp, "created");
    this.prune(followUp.tenantId);
    return followUp;
  }

  get(id: string): NovaFollowUp | undefined {
    const row = this.db.prepare("SELECT * FROM nova_followups WHERE id = ?").get(id) as unknown as FollowUpRow | undefined;
    return row ? followUpOf(row) : undefined;
  }

  /** Follow-ups of one tenant: pending first by due time, then the finished ones, newest first. */
  list(tenantId: string): NovaFollowUp[] {
    return (this.db
      .prepare("SELECT * FROM nova_followups WHERE tenant_id = ? ORDER BY CASE WHEN status IN ('pending', 'running') THEN 0 ELSE 1 END, CASE WHEN status IN ('pending', 'running') THEN due_at END ASC, COALESCE(finished_at, created_at) DESC")
      .all(tenantId) as unknown as FollowUpRow[]).map(followUpOf);
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM nova_followups WHERE status IN ('pending', 'running')").get() as { count: number }).count;
  }

  cancel(id: string): NovaFollowUp {
    const followUp = typeof id === "string" ? this.get(id) : undefined;
    if (!followUp) throw new NovaFollowUpError(NOVA_FOLLOW_UP_NOT_FOUND);
    if (followUp.status !== "pending") throw new NovaFollowUpError(followUp.status === "running" ? "This follow-up is running now. Its answer appears in Chat." : "This follow-up already finished.");
    return this.finish(id, "cancelled", { from: "pending" }) ?? followUp;
  }

  /** Pending follow-ups whose time has come, oldest first. */
  due(): NovaFollowUp[] {
    return (this.db
      .prepare("SELECT * FROM nova_followups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC")
      .all(this.clock().toISOString()) as unknown as FollowUpRow[]).map(followUpOf);
  }

  /** Marks a due follow-up running. False when another tick or a cancel took it first. */
  claim(id: string): boolean {
    const changed = this.db.prepare("UPDATE nova_followups SET status = 'running' WHERE id = ? AND status = 'pending'").run(id).changes;
    if (Number(changed) !== 1) return false;
    const followUp = this.get(id);
    if (followUp) this.record(followUp, "started");
    return true;
  }

  /** Ends a follow-up once; a second call for the same one changes nothing. */
  finish(
    id: string,
    status: Exclude<NovaFollowUpStatus, "pending" | "running">,
    detail: { conversationId?: string; reason?: string; from?: "pending" | "running" } = {},
  ): NovaFollowUp | undefined {
    const from = detail.from ? [detail.from] : ["pending", "running"];
    const changed = this.db
      .prepare(`UPDATE nova_followups SET status = ?, finished_at = ?, conversation_id = COALESCE(?, conversation_id), reason = ?
        WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
      .run(status, this.clock().toISOString(), detail.conversationId ?? null, detail.reason ?? null, id, ...from).changes;
    if (Number(changed) !== 1) return undefined;
    const followUp = this.get(id);
    if (followUp) this.record(followUp, status);
    return followUp;
  }

  /** Follow-ups left running by a quit: they did not finish. */
  recoverInterrupted(): number {
    const rows = this.db.prepare("SELECT id FROM nova_followups WHERE status = 'running'").all() as { id: string }[];
    for (const row of rows) this.finish(row.id, "failed", { reason: "OpenAdminOS closed while it ran.", from: "running" });
    return rows.length;
  }

  /** Deletes every follow-up of a disconnected tenant; pending ones are cancelled in the audit log first. */
  purgeTenant(tenantId: string): number {
    const rows = this.db.prepare("SELECT * FROM nova_followups WHERE tenant_id = ?").all(tenantId) as unknown as FollowUpRow[];
    if (rows.length === 0) return 0;
    const events = rows
      .filter((row) => row.status === "pending" || row.status === "running")
      .map((row) => this.event({ ...followUpOf(row), status: "cancelled", reason: "The organization was disconnected." }, "cancelled"));
    if (events.length > 0) this.options.audit(events);
    this.db.prepare("DELETE FROM nova_followups WHERE tenant_id = ?").run(tenantId);
    return rows.length;
  }

  private prune(tenantId: string): void {
    this.db
      .prepare(`DELETE FROM nova_followups WHERE tenant_id = ? AND status NOT IN ('pending', 'running') AND id NOT IN (
        SELECT id FROM nova_followups WHERE tenant_id = ? AND status NOT IN ('pending', 'running') ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ${FINISHED_KEPT})`)
      .run(tenantId, tenantId);
  }

  private record(followUp: NovaFollowUp, change: NovaFollowUpStatus | "created" | "started"): void {
    this.options.audit([this.event(followUp, change)]);
  }

  private event(followUp: NovaFollowUp, change: NovaFollowUpStatus | "created" | "started"): AuditLogEventSeed {
    return {
      id: `nova-followup:${followUp.id}:${change}`,
      timestamp: this.clock().toISOString(),
      type: AUDIT_TYPE[change],
      source: "nova",
      tenantId: followUp.tenantId,
      // The admin sets and cancels a follow-up with a click; it runs on its own time, like a schedule.
      initiator: change === "created" || change === "cancelled" ? "person" : "schedule",
      details: {
        followUpId: followUp.id,
        ...(followUp.organizationId ? { organizationId: followUp.organizationId } : {}),
        question: followUp.question,
        dueAt: followUp.dueAt,
        providerId: followUp.providerId,
        ...(followUp.model ? { model: followUp.model } : {}),
        status: change === "created" ? "pending" : change === "started" ? "running" : change,
        ...(followUp.conversationId ? { conversationId: followUp.conversationId } : {}),
        ...(followUp.reason ? { reason: followUp.reason } : {}),
      },
    };
  }
}
