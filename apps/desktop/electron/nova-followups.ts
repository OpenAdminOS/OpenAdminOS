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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NovaFollowUpError";
  }
}

export const NOVA_FOLLOW_UP_TOO_SOON = "A follow-up needs at least 1 minute. Say a later time, for example in 30 minutes.";
export const NOVA_FOLLOW_UP_TOO_LATE = "A follow-up can be at most 7 days ahead. Say an earlier time.";
export const NOVA_FOLLOW_UPS_FULL = `You already have ${NOVA_FOLLOW_UPS_PENDING_MAX} pending follow-ups. Cancel one in Settings, Nova, first.`;
export const NOVA_FOLLOW_UPS_DAILY_LIMIT = `Nova already set ${NOVA_FOLLOW_UPS_PER_DAY} follow-ups in the last 24 hours. Try again later.`;
export const NOVA_FOLLOW_UP_PROVIDER_NOT_ALLOWED = "Your IT department no longer allows this provider or model. Nothing was asked.";
export const NOVA_FOLLOW_UP_PROVIDER_MOVED = "The provider now runs somewhere else than when this follow-up was set, for example off this device. Nothing was asked. Ask Nova again to set it with the current provider.";
export const NOVA_FOLLOW_UP_RUN_MS = 5 * 60_000;
export const NOVA_FOLLOW_UP_TIMED_OUT = "The follow-up did not finish within 5 minutes, so it was stopped. Nothing was sent. Ask Nova again, or ask in Chat.";
/** Said when the follow-up could not be stored on this device. */
export const NOVA_FOLLOW_UP_NOT_STORED =
  "Nova could not store this follow-up on this device, so nothing was set. Check that the app can write its data folder, then ask Nova again.";

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
  provider_local: number | null;
  provider_endpoint: string | null;
  consent_acknowledged_at: string | null;
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
    ...(row.provider_local === null ? {} : { providerLocal: row.provider_local === 1 }),
    ...(row.provider_endpoint ? { providerEndpoint: row.provider_endpoint } : {}),
    ...(row.consent_acknowledged_at ? { consentAcknowledgedAt: row.consent_acknowledged_at } : {}),
  };
}

export interface NovaFollowUpInput {
  tenantId: string;
  organizationId?: string;
  question: string;
  providerId: ProviderId;
  model?: string;
  delayMinutes: number;
  /** Whether the provider ran on this device when the follow-up was set. */
  providerLocal: boolean;
  /** The endpoint of Ollama or LM Studio then. */
  providerEndpoint?: string;
  /** When the admin consented to a hosted provider for this follow-up. */
  consentAcknowledgedAt?: string;
}

export interface NovaFollowUpsOptions {
  /** Records audit events; keeps them when the audit log cannot take them now. Never throws. */
  audit: (events: AuditLogEventSeed[]) => void;
  /** Records audit events that must be on disk before data is deleted; throws when they are not. Defaults to `audit`. */
  auditDurably?: (events: AuditLogEventSeed[]) => void;
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
  /** Whether the active provider runs on this device now. */
  activeProviderLocal?: boolean;
  /** The endpoint of the active Ollama or LM Studio now. */
  activeProviderEndpoint?: string;
  /** The IT policy still allows the follow-up's provider and model. Absent counts as allowed. */
  providerAllowed?: boolean;
}

/**
 * Whether a due follow-up runs: only in the organization it was set in,
 * while that is active and connected, with the same provider and model
 * running where it ran then (on this device or not, at the same endpoint),
 * and within an hour of its time. A follow-up that does not record where
 * its provider ran does not run.
 */
export function novaFollowUpFireDecision(
  followUp: Pick<NovaFollowUp, "tenantId" | "organizationId" | "providerId" | "model" | "dueAt" | "providerLocal" | "providerEndpoint">,
  context: NovaFollowUpFireContext,
): "run" | "missed" | "skipped-organization" | "skipped-provider" {
  if (context.now.getTime() - Date.parse(followUp.dueAt) > NOVA_FOLLOW_UP_LATE_MS) return "missed";
  if (!context.tenantConnected || context.activeTenantId !== followUp.tenantId) return "skipped-organization";
  if (followUp.organizationId && context.activeOrganizationId !== followUp.organizationId) return "skipped-organization";
  if (context.providerAllowed === false) return "skipped-provider";
  if (context.activeProviderId !== followUp.providerId || (context.activeModel ?? undefined) !== (followUp.model ?? undefined)) return "skipped-provider";
  if (followUp.providerLocal === undefined || context.activeProviderLocal !== followUp.providerLocal) return "skipped-provider";
  if ((followUp.providerEndpoint ?? undefined) !== (context.activeProviderEndpoint ?? undefined)) return "skipped-provider";
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
      reason TEXT,
      provider_local INTEGER,
      provider_endpoint TEXT,
      consent_acknowledged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS nova_followups_due ON nova_followups (status, due_at);
    -- When each follow-up was set, for the daily limit. Only times, no
    -- tenant data: kept through pruning and Disconnect, and dropped after a day.
    CREATE TABLE IF NOT EXISTS nova_followup_creations (created_at TEXT NOT NULL);`);
    // Tables from builds before these columns existed get them; their rows run nowhere (see the fire decision).
    const columns = new Set((db.prepare("PRAGMA table_info(nova_followups)").all() as { name: string }[]).map((column) => column.name));
    for (const [name, type] of [["provider_local", "INTEGER"], ["provider_endpoint", "TEXT"], ["consent_acknowledged_at", "TEXT"]] as const)
      if (!columns.has(name)) db.exec(`ALTER TABLE nova_followups ADD COLUMN ${name} ${type}`);
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

  /**
   * `beforeInsert` runs after the limits pass and before anything is
   * stored: when it throws, no follow-up and no creation count is left.
   */
  create(input: NovaFollowUpInput, beforeInsert?: (followUp: NovaFollowUp) => void): NovaFollowUp {
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
      providerLocal: input.providerLocal,
      ...(input.providerEndpoint ? { providerEndpoint: input.providerEndpoint } : {}),
      ...(input.consentAcknowledgedAt ? { consentAcknowledgedAt: input.consentAcknowledgedAt } : {}),
    };
    beforeInsert?.(followUp);
    // The follow-up and its place in the daily count are stored together or
    // not at all; the created event is recorded only once both are.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO nova_followups (id, tenant_id, organization_id, question, provider_id, model, due_at, status, created_at, provider_local, provider_endpoint, consent_acknowledged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(followUp.id, followUp.tenantId, followUp.organizationId ?? null, followUp.question, followUp.providerId, followUp.model ?? null, followUp.dueAt, followUp.createdAt, input.providerLocal ? 1 : 0, input.providerEndpoint ?? null, input.consentAcknowledgedAt ?? null);
      this.db.prepare("INSERT INTO nova_followup_creations (created_at) VALUES (?)").run(followUp.createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new NovaFollowUpError(NOVA_FOLLOW_UP_NOT_STORED, { cause: error });
    }
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

  /** Follow-ups still to come; with `tenantId`, only that organization's, for the panel of the active one. */
  pendingCount(tenantId?: string): number {
    if (tenantId === undefined) return (this.db.prepare("SELECT COUNT(*) AS count FROM nova_followups WHERE status IN ('pending', 'running')").get() as { count: number }).count;
    return (this.db.prepare("SELECT COUNT(*) AS count FROM nova_followups WHERE status IN ('pending', 'running') AND tenant_id = ?").get(tenantId) as { count: number }).count;
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

  /**
   * Deletes every follow-up of a disconnected tenant; pending ones are
   * cancelled in the audit log first, with initiator person (the admin's
   * Disconnect). A running row is deleted too. Disconnect drains the tenant
   * lease a run holds, but only up to a bound, so a run can outlive the
   * drain. What keeps that safe is that the tenant is closed before this
   * runs, which refuses the run's Graph calls and writes, and that a run's
   * own result is written with finish(), which updates only a row that is
   * still there and still running: a row deleted here stays deleted.
   */
  purgeTenant(tenantId: string): number {
    const rows = this.db.prepare("SELECT * FROM nova_followups WHERE tenant_id = ?").all(tenantId) as unknown as FollowUpRow[];
    if (rows.length === 0) return 0;
    const events = rows
      .filter((row) => row.status === "pending" || row.status === "running")
      .map((row) => this.event({ ...followUpOf(row), status: "cancelled", reason: "The organization was disconnected." }, "cancelled"));
    // On disk before the rows go; otherwise this throws and Disconnect retries the cleanup.
    if (events.length > 0) (this.options.auditDurably ?? this.options.audit)(events);
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
        ...(followUp.providerLocal === undefined ? {} : { providerLocal: followUp.providerLocal }),
        ...(followUp.providerEndpoint ? { providerEndpoint: followUp.providerEndpoint } : {}),
        status: change === "created" ? "pending" : change === "started" ? "running" : change,
        ...(followUp.conversationId ? { conversationId: followUp.conversationId } : {}),
        ...(followUp.reason ? { reason: followUp.reason } : {}),
      },
    };
  }
}
