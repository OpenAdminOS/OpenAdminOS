import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  OfficeFinding,
  OfficeHandoff,
  OfficeMessage,
  OfficePersona,
  RunRecord,
} from "@openadminos/agent-sdk";
import { fingerprintRunOutput } from "./run-delivery-format.js";

export class OfficeMemory {
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS office_memory (kind TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))",
    );
  }
  list<T>(kind: "finding" | "handoff" | "message"): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM office_memory WHERE kind=? ORDER BY rowid DESC",
        )
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  put<T extends { id: string; tenantId: string }>(
    kind: "finding" | "handoff" | "message",
    record: T,
  ) {
    this.db
      .prepare(
        "INSERT INTO office_memory VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, record.id, record.tenantId, JSON.stringify(record));
  }
  purgeTenant(id: string) {
    this.db.prepare("DELETE FROM office_memory WHERE tenant_id=?").run(id);
  }
  purgePersona(id: string) {
    for (const kind of ["finding", "handoff", "message"] as const)
      for (const record of this.list<{
        id: string;
        personaId?: string;
        sourcePersonaId?: string;
        targetPersonaId?: string;
      }>(kind)) {
        if (
          [
            record.personaId,
            record.sourcePersonaId,
            record.targetPersonaId,
          ].includes(id)
        )
          this.db
            .prepare("DELETE FROM office_memory WHERE kind=? AND id=?")
            .run(kind, record.id);
      }
  }
  ingest(p: OfficePersona, run: RunRecord, now: string) {
    if (run.tenantId !== p.tenantId || run.status !== "completed")
      throw new Error(
        "Finding evidence must be completed in the assigned tenant.",
      );
    const assessmentKey = run.assessmentKey ?? `${p.id}:${run.agentSlug}`;
    const id = createHash("sha256")
      .update(`${p.tenantId}:${p.id}:${assessmentKey}`)
      .digest("hex");
    const old = this.list<OfficeFinding>("finding").find((f) => f.id === id);
    if (old?.runIds.includes(run.id)) return;
    if (
      !old &&
      this.list<OfficeFinding>("finding").filter((f) => f.personaId === p.id)
        .length >= 100
    ) {
      const resolved = this.list<OfficeFinding>("finding")
        .filter((f) => f.personaId === p.id && f.state === "resolved")
        .at(-1);
      if (!resolved)
        throw new Error(
          "This teammate has 100 retained assessments. Resolve an obsolete finding before collecting a new assessment definition.",
        );
      this.db
        .prepare("DELETE FROM office_memory WHERE kind='finding' AND id=?")
        .run(resolved.id);
    }
    const fingerprint = createHash("sha256")
      .update(fingerprintRunOutput(run))
      .digest("hex");
    const changed = old?.fingerprint !== fingerprint;
    const metricValue = p.assessment?.metricPath
      .split(".")
      .reduce<unknown>(
        (v, k) =>
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined,
        run.result,
      );
    const metric =
      typeof metricValue === "number"
        ? metricValue
        : typeof metricValue === "string" &&
            metricValue.trim() !== "" &&
            Number.isFinite(Number(metricValue))
          ? Number(metricValue)
          : undefined;
    const entities: string[] = [];
    const visit = (v: unknown, depth: number) => {
      if (depth > 6 || entities.length >= 100) return;
      if (Array.isArray(v)) {
        for (const item of v.slice(0, 100)) visit(item, depth + 1);
      } else if (v && typeof v === "object") {
        if (typeof (v as { id?: unknown }).id === "string")
          entities.push((v as { id: string }).id);
        for (const item of Object.values(v)) visit(item, depth + 1);
      }
    };
    visit(run.result, 0);
    const below =
      p.assessment && metric !== undefined && metric < p.assessment.threshold;
    const stillSnoozed =
      old?.state === "snoozed" &&
      Date.parse(old.snoozedUntil ?? "") > Date.parse(now);
    const finding: OfficeFinding = {
      id,
      tenantId: p.tenantId,
      personaId: p.id,
      assessmentKey,
      agentSlug: run.agentSlug,
      title: p.assessment
        ? `${run.agentSlug}: ${metric === undefined ? "metric unavailable" : `${metric} (threshold ${p.assessment.threshold})`}`
        : `${run.agentSlug}: ${old ? (changed ? "findings changed" : "no new change") : "first assessment"}`,
      summary: (
        run.summary ?? "Open the source run to review its evidence."
      ).slice(0, 4000),
      severity:
        p.assessment && metric !== undefined && !below ? "warning" : "info",
      state: below
        ? "resolved"
        : stillSnoozed
          ? "snoozed"
          : changed || !old
            ? "open"
            : old.state,
      firstSeen: old?.firstSeen ?? run.finishedAt ?? now,
      lastSeen: run.finishedAt ?? now,
      changedAt: changed ? (run.finishedAt ?? now) : old.changedAt,
      revision: (old?.revision ?? 0) + (changed ? 1 : 0),
      runIds: [run.id, ...(old?.runIds ?? [])].slice(0, 20),
      entityIds: [...new Set(entities)],
      fingerprint,
      metric,
      previousMetric: changed ? old?.metric : old?.previousMetric,
      ...(stillSnoozed ? { snoozedUntil: old.snoozedUntil } : {}),
      coverage:
        p.assessment && metric === undefined
          ? "Assessment metric is missing. Coverage is incomplete; no clean result inferred."
          : "Coverage is limited to the source workflow. Open its evidence for collection details.",
    };
    this.put("finding", finding);
  }
  review(
    id: string,
    state: OfficeFinding["state"],
    snoozeMinutes: number | undefined,
    now: number,
  ) {
    const f = this.list<OfficeFinding>("finding").find((f) => f.id === id);
    if (!f) throw new Error("This finding no longer exists. Refresh the team.");
    if (!["open", "acknowledged", "snoozed", "resolved"].includes(state))
      throw new Error("Choose a valid finding state.");
    if (
      state === "snoozed" &&
      (!Number.isInteger(snoozeMinutes) ||
        snoozeMinutes! < 5 ||
        snoozeMinutes! > 10080)
    )
      throw new Error("Snooze for 5 minutes to 7 days.");
    this.put("finding", {
      ...f,
      state,
      snoozedUntil:
        state === "snoozed"
          ? new Date(now + snoozeMinutes! * 60000).toISOString()
          : undefined,
    });
  }
  wake(now: number) {
    for (const f of this.list<OfficeFinding>("finding"))
      if (f.state === "snoozed" && Date.parse(f.snoozedUntil ?? "") <= now)
        this.put("finding", { ...f, state: "open", snoozedUntil: undefined });
  }
  message(
    p: OfficePersona,
    role: OfficeMessage["role"],
    content: string,
    runIds: string[],
    now: string,
  ) {
    this.put("message", {
      id: randomUUID(),
      tenantId: p.tenantId,
      personaId: p.id,
      role,
      content,
      runIds,
      providerId: p.providerId,
      createdAt: now,
    } as OfficeMessage);
    for (const m of this.list<OfficeMessage>("message")
      .filter((m) => m.personaId === p.id)
      .slice(100))
      this.db
        .prepare("DELETE FROM office_memory WHERE kind='message' AND id=?")
        .run(m.id);
  }
  handoff(h: OfficeHandoff) {
    this.put("handoff", h);
    // Keep recent deduplication records, including all events still eligible to trigger.
    for (const old of this.list<OfficeHandoff>("handoff")
      .filter((x) => x.targetPersonaId === h.targetPersonaId)
      .slice(1000)) {
      if (Date.parse(h.createdAt) - Date.parse(old.createdAt) > 86400000)
        this.db
          .prepare("DELETE FROM office_memory WHERE kind='handoff' AND id=?")
          .run(old.id);
    }
  }
}
