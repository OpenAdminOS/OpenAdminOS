import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OfficeMemory } from "./office-memory.js";
import {
  nextOfficeRun,
  officeQuiet,
  validateOfficeSchedule,
} from "./office-schedule.js";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSummary,
  OfficeFinding,
  OfficeHandoff,
  OfficeMessage,
  OfficeTaskContext,
  OfficeMission,
  OfficePersona,
  OfficePersonaInput,
  OfficeState,
  ProviderSummary,
  RunRecord,
  StartRunOptions,
  TenantRecord,
} from "@openadminos/agent-sdk";

type Context = {
  tenants: TenantRecord[];
  providers: ProviderSummary[];
  agents: AgentSummary[];
  runs: RunRecord[];
  providerConfigKey?: string;
  providerConfigKeys?: Record<string, string>;
};
export interface OfficeHost {
  context(): Promise<Context>;
  startRun(slug: string, options: StartRunOptions): Promise<RunRecord>;
  cancelRun(id: string): Promise<RunRecord>;
  changed(): void;
  complete?(
    p: OfficePersona,
    question: string,
    context: OfficeTaskContext,
    planning?: boolean,
  ): Promise<string>;
}
type StoredPersona = OfficePersona & {
  trustKey: string;
  reviewed?: { provider: string; agents: Record<string, string> };
};
type StoredMission = OfficeMission & { trustKey: string };
const missionActive = (m: OfficeMission) =>
  ["queued", "running", "executing", "awaiting-review"].includes(m.status);
const active = (run: RunRecord) =>
  ["queued", "running", "awaiting-confirmation"].includes(run.status);

/** Host-owned persistence and bounded coordination. No model or tenant credentials
 * enter the Office renderer; every task uses the existing run service. */
export class OfficeService {
  private db: DatabaseSync;
  private memory: OfficeMemory;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private error?: string;
  reportError(error: unknown) {
    this.error = `Office could not advance assignments. ${message(error)} Reopen the app or review provider settings.`;
    this.host.changed();
  }
  constructor(
    path: string,
    private host: OfficeHost,
    private now = () => Date.now(),
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS office_personas (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS office_missions (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, tenant_id TEXT NOT NULL, data TEXT NOT NULL);`);
    this.memory = new OfficeMemory(this.db);
    for (const sidecar of [`${path}-wal`, `${path}-shm`])
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.pending.then(() => {
      if (this.closed) throw new Error("Office is closed.");
      return fn();
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
  private personas(): StoredPersona[] {
    return (
      this.db
        .prepare("SELECT data FROM office_personas ORDER BY rowid")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  private missions(): StoredMission[] {
    return (
      this.db
        .prepare("SELECT data FROM office_missions ORDER BY rowid DESC")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  state(): OfficeState {
    return {
      ...(this.error ? { error: this.error } : {}),
      personas: this.personas().map(
        ({ trustKey: _, reviewed: _reviewed, ...p }) => p,
      ),
      findings: this.memory.list<OfficeFinding>("finding"),
      handoffs: this.memory.list<OfficeHandoff>("handoff"),
      messages: this.memory.list<OfficeMessage>("message"),
      missions: this.missions()
        .filter((mission, index) => index < 100 || missionActive(mission))
        .map(({ trustKey: _, ...m }) => m),
    };
  }
  private putPersona(p: StoredPersona) {
    this.db
      .prepare(
        "INSERT INTO office_personas VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, tenant_id=excluded.tenant_id",
      )
      .run(p.id, p.tenantId, JSON.stringify(p));
  }
  private putMission(m: StoredMission) {
    this.db
      .prepare(
        "INSERT INTO office_missions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(m.id, m.personaId, m.tenantId, JSON.stringify(m));
  }
  private persona(id: unknown): StoredPersona {
    if (typeof id !== "string" || id.length > 128)
      throw new Error("Choose an existing Office teammate.");
    const p = this.personas().find((p) => p.id === id);
    if (!p)
      throw new Error(
        "This teammate no longer exists. Refresh Office and choose another.",
      );
    return p;
  }
  private trustKey(
    p: Pick<OfficePersona, "providerId" | "agentSlugs">,
    c: Context,
  ) {
    const provider = c.providers.find((x) => x.id === p.providerId);
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: [provider?.id, provider?.isLocal],
          config: c.providerConfigKeys?.[p.providerId] ?? c.providerConfigKey,
          policy: [
            (p as OfficePersona).instructions,
            (p as OfficePersona).watch,
            (p as OfficePersona).assessment,
            (p as OfficePersona).planning,
          ],
          agents: p.agentSlugs.map((slug) => {
            const a = c.agents.find((a) => a.slug === slug);
            return a
              ? [
                  a.slug,
                  a.version,
                  a.mode,
                  a.scopes,
                  a.settings,
                  a.provenance?.manifestSha256,
                ]
              : null;
          }),
        }),
      )
      .digest("hex");
  }
  private reviewed(p: OfficePersona, c: Context) {
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return {
      provider: digest([
        p.providerId,
        c.providers.find((x) => x.id === p.providerId)?.isLocal,
        c.providerConfigKeys?.[p.providerId] ?? c.providerConfigKey,
      ]),
      agents: Object.fromEntries(
        p.agentSlugs.map((slug) => {
          const a = c.agents.find((a) => a.slug === slug);
          return [
            slug,
            digest(
              a
                ? [
                    a.version,
                    a.mode,
                    a.scopes,
                    a.settings,
                    a.provenance?.manifestSha256,
                  ]
                : null,
            ),
          ];
        }),
      ),
    };
  }
  private reviewProblem(p: StoredPersona, c: Context) {
    const current = this.reviewed(p, c);
    const changed = !p.reviewed
      ? "the saved review predates this trust policy"
      : p.reviewed.provider !== current.provider
        ? "the assigned provider destination or data boundary changed"
        : `changed workflows: ${p.agentSlugs.filter((slug) => p.reviewed!.agents[slug] !== current.agents[slug]).join(", ") || "assignment policy"}`;
    return `The provider or assigned workflows changed: ${changed}. Review and save this teammate before running it again.`;
  }
  private validateReady(
    p: Pick<OfficePersona, "tenantId" | "providerId" | "agentSlugs" | "model">,
    c: Context,
  ) {
    if (!c.tenants.some((t) => t.id === p.tenantId))
      throw new Error(
        "The assigned tenant is disconnected. Edit this teammate and choose a connected tenant.",
      );
    const provider = c.providers.find((x) => x.id === p.providerId);
    if (
      !provider ||
      !(
        provider.status === "connected" ||
        (provider.id === "azure-openai" && provider.status === "available")
      )
    )
      throw new Error(
        "The assigned provider is unavailable. Connect it in Settings, then run this teammate again.",
      );
    if (p.model && provider.models.length && !provider.models.includes(p.model))
      throw new Error(
        "The assigned model is unavailable. Edit this teammate and choose an available model.",
      );
    for (const slug of p.agentSlugs)
      if (!c.agents.some((a) => a.slug === slug))
        throw new Error(
          `Assigned agent ${slug} is not installed. Install it or edit the assignment.`,
        );
    return provider;
  }
  save(input: unknown): Promise<OfficeState> {
    return this.serial(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Office teammate must be an object.");
      const v = input as OfficePersonaInput;
      const bounded = (x: unknown, max: number, label: string) => {
        if (typeof x !== "string" || !x.trim() || x.length > max)
          throw new Error(`${label} must contain 1–${max} characters.`);
        return x.trim();
      };
      const old = v.id === undefined ? undefined : this.persona(v.id);
      if (
        old &&
        this.missions().some((m) => m.personaId === old.id && missionActive(m))
      )
        throw new Error(
          "Stop the current assignment before editing this teammate.",
        );
      if (!old && this.personas().length >= 24)
        throw new Error(
          "Office supports up to 24 teammates. Remove an unused teammate first.",
        );
      if (!["robot", "cat", "fox", "owl"].includes(v.avatar))
        throw new Error("Choose a robot, cat, fox, or owl avatar.");
      if (!["amber", "sage", "blue", "lilac"].includes(v.color))
        throw new Error("Choose one of the available teammate colors.");
      if (
        !Array.isArray(v.agentSlugs) ||
        !v.agentSlugs.length ||
        v.agentSlugs.length > 8 ||
        new Set(v.agentSlugs).size !== v.agentSlugs.length
      )
        throw new Error(
          "Assign between one and eight different installed agents.",
        );
      if (
        v.intervalMinutes !== null &&
        (!Number.isInteger(v.intervalMinutes) ||
          v.intervalMinutes < 5 ||
          v.intervalMinutes > 10080)
      )
        throw new Error(
          "Choose a schedule between 5 minutes and 7 days, or manual only.",
        );
      if (
        !Number.isInteger(v.maxMinutes) ||
        v.maxMinutes < 5 ||
        v.maxMinutes > 120
      )
        throw new Error("The run budget must be between 5 and 120 minutes.");
      if (typeof v.enabled !== "boolean")
        throw new Error("Choose whether the teammate is enabled.");
      if (
        v.approvalMinutes !== undefined &&
        (!Number.isInteger(v.approvalMinutes) ||
          v.approvalMinutes < 10 ||
          v.approvalMinutes > 10080)
      )
        throw new Error(
          "Choose an approval expiry between 10 minutes and 7 days.",
        );
      validateOfficeSchedule(v);
      if (
        v.instructions !== undefined &&
        (typeof v.instructions !== "string" || v.instructions.length > 2000)
      )
        throw new Error(
          "Standing instructions must be at most 2000 characters.",
        );
      if (
        v.planning !== undefined &&
        !["ordered", "on-change", "model"].includes(v.planning)
      )
        throw new Error("Choose a supported planning mode.");
      if (
        v.assessment &&
        (!/^[a-zA-Z0-9_.]{1,120}$/.test(v.assessment.metricPath) ||
          !Number.isFinite(v.assessment.threshold))
      )
        throw new Error(
          "Choose a numeric assessment threshold and a valid result field path.",
        );
      if (v.watch) {
        const source = this.persona(v.watch.personaId);
        if (source.id === old?.id || source.tenantId !== v.tenantId)
          throw new Error("Watch another teammate in the same tenant.");
        if (
          !["new", "changed", "threshold"].includes(v.watch.event) ||
          !Number.isInteger(v.watch.cooldownMinutes) ||
          v.watch.cooldownMinutes < 5 ||
          v.watch.cooldownMinutes > 10080 ||
          (v.watch.event === "threshold" && !Number.isFinite(v.watch.threshold))
        )
          throw new Error(
            "Choose a valid watch condition and cooldown of 5 minutes to 7 days.",
          );
        let cursor: OfficePersona | undefined = source;
        const visited = new Set([old?.id]);
        for (let depth = 0; cursor; depth++) {
          if (visited.has(cursor.id) || depth >= 3)
            throw new Error(
              "Watch chains must be acyclic and no deeper than four teammates.",
            );
          visited.add(cursor.id);
          cursor = cursor.watch
            ? this.personas().find((p) => p.id === cursor!.watch!.personaId)
            : undefined;
        }
      }
      if (
        old &&
        old.tenantId !== v.tenantId &&
        this.hasDependentMission(old.id)
      )
        throw new Error(
          "Stop dependent assignments before changing this teammate's tenant.",
        );
      const c = await this.host.context();
      const now = new Date(this.now()).toISOString();
      const p: StoredPersona = {
        id: old?.id ?? randomUUID(),
        name: bounded(v.name, 60, "Name"),
        responsibility: bounded(v.responsibility, 400, "Responsibility"),
        avatar: v.avatar,
        color: v.color,
        tenantId: bounded(v.tenantId, 256, "Tenant"),
        providerId: v.providerId,
        ...(v.model ? { model: bounded(v.model, 256, "Model") } : {}),
        agentSlugs: v.agentSlugs.map((s) => bounded(s, 128, "Agent")),
        intervalMinutes: v.intervalMinutes,
        maxMinutes: v.maxMinutes,
        approvalMinutes: v.approvalMinutes ?? 1440,
        instructions: v.instructions?.trim(),
        planning: v.planning ?? "ordered",
        watch: v.watch
          ? {
              personaId: v.watch.personaId,
              event: v.watch.event,
              cooldownMinutes: v.watch.cooldownMinutes,
              ...(v.watch.threshold !== undefined
                ? { threshold: v.watch.threshold }
                : {}),
            }
          : undefined,
        assessment: v.assessment
          ? {
              metricPath: v.assessment.metricPath,
              threshold: v.assessment.threshold,
            }
          : undefined,
        calendar: v.calendar
          ? {
              time: v.calendar.time,
              timeZone: v.calendar.timeZone,
              weekdays: [...new Set(v.calendar.weekdays)].sort((a, b) => a - b),
            }
          : undefined,
        quietHours: v.quietHours
          ? {
              start: v.quietHours.start,
              end: v.quietHours.end,
              timeZone: v.quietHours.timeZone,
            }
          : undefined,
        enabled: v.enabled,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        trustKey: "",
      };
      const proposed = [
        ...this.personas().filter((item) => item.id !== p.id),
        p,
      ];
      for (const owner of proposed) {
        const seen = new Set<string>();
        let cursor: OfficePersona | undefined = owner;
        while (cursor) {
          if (seen.has(cursor.id) || seen.size >= 4)
            throw new Error(
              "Watch chains must be acyclic and no deeper than four teammates.",
            );
          seen.add(cursor.id);
          cursor = cursor.watch
            ? proposed.find((item) => item.id === cursor!.watch!.personaId)
            : undefined;
        }
      }
      const execution = (value: OfficePersona) =>
        JSON.stringify([
          value.tenantId,
          value.providerId,
          value.model,
          value.agentSlugs,
          value.intervalMinutes,
          value.maxMinutes,
          value.enabled,
          value.approvalMinutes ?? 1440,
          value.instructions ?? "",
          value.planning ?? "ordered",
          value.watch,
          value.assessment,
          value.calendar,
          value.quietHours,
        ]);
      if (
        old &&
        execution(old) === execution(p) &&
        ["name", "responsibility", "avatar", "color"].some(
          (k) => old[k as keyof OfficePersona] !== p[k as keyof OfficePersona],
        )
      ) {
        this.putPersona({
          ...old,
          name: p.name,
          responsibility: p.responsibility,
          avatar: p.avatar,
          color: p.color,
          updatedAt: now,
        });
        this.host.changed();
        return this.state();
      }
      const provider = this.validateReady(p, c);
      if (!provider.isLocal && v.confirmHosted !== true)
        throw new Error(
          `Confirm that tenant context will be sent to ${provider.name} for this assignment and its scheduled runs.`,
        );
      p.trustKey = this.trustKey(p, c);
      p.reviewed = this.reviewed(p, c);
      if (p.enabled) p.nextRunAt = nextOfficeRun(p, this.now());
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (old && old.tenantId !== p.tenantId) {
          this.memory.purgePersona(old.id);
          for (const watcher of this.personas().filter(
            (w) => w.watch?.personaId === old.id,
          ))
            this.putPersona({
              ...watcher,
              enabled: false,
              nextRunAt: undefined,
              lastError:
                "The watched teammate changed tenant. Choose an evidence source in this tenant before enabling it.",
            });
        }
        this.putPersona(p);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.host.changed();
      return this.state();
    });
  }
  start(id: string): Promise<OfficeState> {
    return this.serial(async () => {
      await this.begin(this.persona(id), "manual");
      await this.advance();
      this.host.changed();
      return this.state();
    });
  }
  private async begin(
    p: StoredPersona,
    trigger: "manual" | "schedule",
    handoff?: OfficeHandoff,
  ) {
    if (!p.enabled)
      throw new Error("This teammate is paused. Edit it to enable assignments.");
    if (this.missions().some((m) => m.personaId === p.id && missionActive(m)))
      throw new Error("This teammate already has an assignment in progress.");
    const c = await this.host.context();
    this.validateReady(p, c);
    if (p.trustKey !== this.trustKey(p, c))
      throw new Error(this.reviewProblem(p, c));
    const planningStarted = this.now();
    let agentSlugs = [...p.agentSlugs];
    let planningReason = handoff
      ? handoff.reason
      : "Run the assigned work order.";
    if (p.planning === "model" && handoff) {
      try {
        if (!this.host.complete)
          throw new Error("Planning provider is unavailable.");
        const context = this.taskContext(p, [], c, handoff);
        const answer = await this.host.complete(
          p,
          `Select only relevant assigned workflows. Return JSON {"agentSlugs":[...],"reason":"..."}. Allowed workflows: ${JSON.stringify(
            p.agentSlugs.map((slug) => {
              const a = c.agents.find((a) => a.slug === slug)!;
              return { slug, description: a.description };
            }),
          )}`,
          context,
          true,
        );
        const parsed = JSON.parse(
          answer.replace(/^```(?:json)?\s*|\s*```$/g, ""),
        );
        if (
          !Array.isArray(parsed.agentSlugs) ||
          parsed.agentSlugs.length > p.agentSlugs.length ||
          new Set(parsed.agentSlugs).size !== parsed.agentSlugs.length ||
          parsed.agentSlugs.some(
            (slug: unknown) =>
              typeof slug !== "string" || !p.agentSlugs.includes(slug),
          ) ||
          typeof parsed.reason !== "string"
        )
          throw new Error("Planner returned an invalid work order.");
        agentSlugs = parsed.agentSlugs;
        planningReason = parsed.reason.slice(0, 1000);
      } catch (e) {
        planningReason = `Planner unavailable or invalid: ${message(e)} Using the approved ordered work list.`;
      }
    }
    const fresh = await this.host.context();
    this.validateReady(p, fresh);
    if (p.trustKey !== this.trustKey(p, fresh))
      throw new Error(this.reviewProblem(p, fresh));
    const missionId = randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.putMission({
        id: missionId,
        personaId: p.id,
        personaName: p.name,
        tenantId: p.tenantId,
        providerId: p.providerId,
        ...(p.model ? { model: p.model } : {}),
        agentSlugs,
        handoffId: handoff?.id,
        planningReason,
        skippedAgentSlugs: p.agentSlugs.filter(
          (slug) => !agentSlugs.includes(slug),
        ),
        runIds: [],
        status: "queued",
        executionMs:
          p.planning === "model" && handoff
            ? Math.max(0, this.now() - planningStarted)
            : 0,
        executionBudgetMs: p.maxMinutes * 60000,
        trigger,
        startedAt,
        deadlineAt: new Date(this.now() + p.maxMinutes * 60000).toISOString(),
        trustKey: p.trustKey,
      });
      this.putPersona({
        ...p,
        lastError: undefined,
        nextRunAt: nextOfficeRun(p, this.now()),
        retryAttempt: 0,
      });
      if (handoff) this.memory.handoff({ ...handoff, missionId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Bound local briefing retention. Child runs follow the existing run-history policy.
    for (const m of this.missions()
      .filter((m) => !missionActive(m))
      .slice(99))
      this.db.prepare("DELETE FROM office_missions WHERE id=?").run(m.id);
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const p of this.personas()) {
        if (
          !p.enabled ||
          !p.nextRunAt ||
          Date.parse(p.nextRunAt) > this.now() ||
          officeQuiet(p, this.now()) ||
          this.missions().some((m) => m.personaId === p.id && missionActive(m))
        )
          continue;
        try {
          if (this.now() - Date.parse(p.nextRunAt) > 300000)
            p.lastMissedAt = p.nextRunAt;
          await this.begin(p, "schedule");
        } catch (e) {
          const transient =
            /unavailable|timeout|temporar|not reachable|429|503|502|504/i.test(
              message(e),
            );
          const retryAttempt = (p.retryAttempt ?? 0) + 1;
          if (transient && retryAttempt <= 3) {
            this.putPersona({
              ...p,
              retryAttempt,
              nextRunAt: new Date(
                this.now() + Math.pow(2, retryAttempt) * 60000,
              ).toISOString(),
              lastError: `${message(e)} Retry ${retryAttempt}/3 is scheduled.`,
            });
            this.host.changed();
            continue;
          }
          this.putPersona({
            ...p,
            enabled: false,
            nextRunAt: undefined,
            lastError: message(e),
          });
          this.host.changed();
        }
      }
      await this.advance();
      await this.observe();
      if (this.error) {
        this.error = undefined;
        this.host.changed();
      }
    });
  }
  private async advance() {
    const missions = this.missions()
      .filter((m) => missionActive(m))
      .reverse();
    if (!missions.length) return;
    const c = await this.host.context();
    // Every mission is reconciled, but only one child run may execute at a time.
    for (const m of missions) {
      const runs = c.runs
        .filter((r) => r.office?.missionId === m.id)
        .sort((a, b) => a.office!.step - b.office!.step);
      if (m.runIds.some((id) => !runs.some((r) => r.id === id))) {
        this.finish(
          m,
          "failed",
          "Run history is missing. Review the assignment before running again.",
        );
        continue;
      }
      m.runIds = runs.map((r) => r.id);
      const current = runs.find(active);
      const failed = runs.find((r) =>
        ["failed", "cancelled", "rejected"].includes(r.status),
      );
      // A pending human decision releases the compute slot and has its own lease.
      const now = this.now();
      m.executionBudgetMs ??= Math.max(
        300000,
        Date.parse(m.deadlineAt) - Date.parse(m.startedAt),
      );
      m.executionMs ??= 0;
      if (m.status === "executing" && m.accountedAt) {
        const last = runs.at(-1);
        const end =
          current?.status === "awaiting-confirmation"
            ? Date.parse(
                [...current.logs]
                  .reverse()
                  .find((l) =>
                    l.message.includes("Awaiting typed confirmation"),
                  )?.timestamp ?? m.accountedAt,
              )
            : Date.parse(last?.finishedAt ?? new Date(now).toISOString());
        m.executionMs += Math.max(
          0,
          Math.min(now, end) - Date.parse(m.accountedAt),
        );
      }
      if (current?.status === "awaiting-confirmation") {
        m.status = "awaiting-review";
        m.approvalSince ??= new Date(now).toISOString();
        m.approvalExpiresAt ??= new Date(
          Date.parse(m.approvalSince) +
            (this.personas().find((p) => p.id === m.personaId)
              ?.approvalMinutes ?? 1440) *
              60000,
        ).toISOString();
        if (now >= Date.parse(m.approvalExpiresAt)) {
          await this.host.cancelRun(current.id);
          this.finish(
            m,
            "failed",
            "Approval expired. Run the assignment again to prepare a fresh proposal.",
          );
          continue;
        }
      } else {
        if (current?.status === "running") {
          m.status = "executing";
        } else m.status = "queued";
        m.approvalSince = undefined;
        m.approvalExpiresAt = undefined;
      }
      m.accountedAt = new Date(now).toISOString();
      const expired = m.executionMs >= m.executionBudgetMs;
      if (expired || failed) {
        if (current) await this.host.cancelRun(current.id);
        this.finish(
          m,
          "failed",
          expired
            ? "Assignment time budget reached. Review the completed work before running again."
            : `${failed!.agentSlug}: ${failed!.error ?? failed!.summary ?? failed!.status}`,
        );
        continue;
      }
      if (
        runs.length === m.agentSlugs.length &&
        runs.every((r) => r.status === "completed")
      ) {
        this.finish(m, "completed");
        continue;
      }
      this.putMission(m);
      if (current) continue;
      // A retained mission must never replay a child whose run was removed.
      if (
        c.runs.some((r) => r.office && ["queued", "running"].includes(r.status))
      )
        continue;
      try {
        this.validateReady(m, c);
        if (m.trustKey !== this.trustKey(this.persona(m.personaId), c))
          throw new Error(this.reviewProblem(this.persona(m.personaId), c));
        const owner = this.persona(m.personaId);
        if (
          owner.planning === "on-change" &&
          runs.length > 0 &&
          runs.at(-1)?.changeState === "unchanged"
        ) {
          m.skippedAgentSlugs = m.agentSlugs.slice(runs.length);
          m.agentSlugs = m.agentSlugs.slice(0, runs.length);
          m.planningReason =
            "The latest scheduled assessment is unchanged; dependent investigations were skipped.";
          this.finish(m, "completed");
          continue;
        }
        const handoff = this.memory
          .list<OfficeHandoff>("handoff")
          .find((h) => h.id === m.handoffId);
        const step = runs.length;
        const run = await this.host.startRun(m.agentSlugs[step], {
          tenantId: m.tenantId,
          providerId: m.providerId,
          model: m.model,
          trigger: m.trigger,
          office: { missionId: m.id, personaId: m.personaId, step },
          officeContext: this.taskContext(owner, runs, c, handoff),
        });
        m.status = "executing";
        m.accountedAt = new Date(this.now()).toISOString();
        m.runIds = [...m.runIds, run.id];
        this.putMission(m);
        this.host.changed();
        break;
      } catch (e) {
        if (message(e).includes("Team compute slot is occupied")) {
          m.status = "queued";
          this.putMission(m);
          continue;
        }
        this.finish(m, "failed", message(e));
      }
    }
  }
  private taskContext(
    p: OfficePersona,
    runs: RunRecord[],
    c: Context,
    handoff?: OfficeHandoff,
  ): OfficeTaskContext {
    const ids = [...(handoff?.sourceRunIds ?? []), ...runs.map((r) => r.id)];
    const evidence = [...new Set(ids)].slice(-8).map((id) => {
      const run = c.runs.find((r) => r.id === id);
      if (!run || run.tenantId !== p.tenantId || run.status !== "completed")
        throw new Error(
          "Handoff evidence is missing or belongs to another tenant. Review the source assignment.",
        );
      return {
        runId: run.id,
        agentSlug: run.agentSlug,
        finishedAt: run.finishedAt,
        summary: (run.summary ?? "").slice(0, 2000),
        result: run.result,
      };
    });
    const context: OfficeTaskContext = {
      tenantId: p.tenantId,
      question:
        handoff?.question ??
        "Review the supplied evidence under the saved standing instructions.",
      assessmentKey: createHash("sha256")
        .update(
          JSON.stringify([
            1,
            p.agentSlugs,
            p.assessment,
            p.instructions,
            p.planning,
            p.watch,
          ]),
        )
        .digest("hex"),
      instructions: p.instructions,
      evidence,
    };
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > 36000) {
      context.evidence = evidence.map((e) => ({
        ...e,
        result: undefined,
        summary: `${e.summary.slice(0, 1000)} [Result omitted because the handoff exceeds the context budget; use the source run for full evidence.]`,
      }));
    }
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > 36000)
      throw new Error("Handoff metadata exceeds the context budget. Shorten the standing instructions and review the source assignment.");
    return context;
  }
  private async observe() {
    const c = await this.host.context();
    this.memory.wake(this.now());
    for (const m of this.missions().filter(
      (m) => m.status === "completed" && !m.assessedAt,
    )) {
      const p = this.personas().find((p) => p.id === m.personaId);
      if (!p) continue;
      if (p.tenantId !== m.tenantId) {
        this.putMission({
          ...m,
          assessedAt: new Date(this.now()).toISOString(),
        });
        continue;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of m.runIds) {
          const run = c.runs.find((r) => r.id === id);
          if (
            run &&
            c.agents.find((a) => a.slug === run.agentSlug)?.mode === "read"
          )
            this.memory.ingest(
              {
                ...p,
                assessment:
                  run.agentSlug === p.agentSlugs[0] ? p.assessment : undefined,
              },
              run,
              new Date(this.now()).toISOString(),
            );
        }
        this.putMission({
          ...m,
          assessedAt: new Date(this.now()).toISOString(),
        });
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.host.changed();
    }
    for (const p of this.personas().filter((p) => p.enabled && p.watch)) {
      if (
        officeQuiet(p, this.now()) ||
        this.missions().some((m) => m.personaId === p.id && missionActive(m))
      )
        continue;
      if (
        p.planning === "model" &&
        c.runs.some((r) => r.office && ["running", "queued"].includes(r.status))
      )
        continue;
      const watch = p.watch!;
      const history = this.memory
        .list<OfficeHandoff>("handoff")
        .filter((h) => h.targetPersonaId === p.id);
      if (
        history.some(
          (h) =>
            this.now() - Date.parse(h.createdAt) <
            watch.cooldownMinutes * 60000,
        )
      )
        continue;
      const f = this.memory
        .list<OfficeFinding>("finding")
        .find(
          (f) =>
            f.tenantId === p.tenantId &&
            f.personaId === watch.personaId &&
            f.state === "open" &&
            this.now() - Date.parse(f.lastSeen) < 86400000 &&
            (watch.event === "new"
              ? f.revision === 1
              : watch.event === "changed"
                ? f.revision > 1
                : f.metric !== undefined &&
                  f.metric >= watch.threshold! &&
                  (f.previousMetric === undefined ||
                    f.previousMetric < watch.threshold!)) &&
            !history.some(
              (h) => h.findingId === f.id && h.revision === f.revision,
            ),
        );
      if (!f) continue;
      const handoff: OfficeHandoff = {
        id: randomUUID(),
        tenantId: p.tenantId,
        sourcePersonaId: f.personaId,
        targetPersonaId: p.id,
        findingId: f.id,
        revision: f.revision,
        sourceRunIds: f.runIds.slice(0, 2),
        question: `Investigate ${f.title}. Explain the change and recommend the next step using the supplied evidence.`,
        reason: `${watch.event} finding from ${this.persona(f.personaId).name}, revision ${f.revision}.`,
        createdAt: new Date(this.now()).toISOString(),
      };
      try {
        await this.begin(p, "schedule", handoff);
        this.host.changed();
      } catch (e) {
        this.putPersona({
          ...p,
          enabled: false,
          lastError: message(e),
          nextRunAt: undefined,
        });
        this.host.changed();
      }
    }
  }
  reviewFinding(input: {
    id: string;
    state: OfficeFinding["state"];
    snoozeMinutes?: number;
  }) {
    return this.serial(async () => {
      this.memory.review(
        input.id,
        input.state,
        input.snoozeMinutes,
        this.now(),
      );
      this.host.changed();
      return this.state();
    });
  }
  private answering = new Set<string>();
  async ask(input: { id: string; question: string }) {
    const snapshot = await this.serial(async () => {
      const p = this.persona(input.id);
      if (this.answering.has(p.id))
        throw new Error(
          "This teammate is answering a question. Wait for its response before asking another.",
        );
      if (
        typeof input.question !== "string" ||
        !input.question.trim() ||
        input.question.length > 2000
      )
        throw new Error("Ask a question of 1–2000 characters.");
      const c = await this.host.context();
      this.validateReady(p, c);
      if (p.trustKey !== this.trustKey(p, c))
        throw new Error(
          "The assigned provider or workflows changed. Review and save the teammate before asking.",
        );
      const runs = c.runs
        .filter(
          (r) =>
            r.office?.personaId === p.id &&
            r.tenantId === p.tenantId &&
            r.status === "completed",
        )
        .slice(0, 4);
      const m = this.missions().find(
        (m) => m.personaId === p.id && m.handoffId,
      );
      const h = this.memory
        .list<OfficeHandoff>("handoff")
        .find((h) => h.id === m?.handoffId);
      const context = this.taskContext(p, runs, c, h);
      context.conversation = this.memory
        .list<OfficeMessage>("message")
        .filter((m) => m.personaId === p.id && m.tenantId === p.tenantId)
        .slice(0, 6)
        .reverse()
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
      this.answering.add(p.id);
      return { p, context };
    });
    try {
      const { p, context } = snapshot;
      const ids = context.evidence.map((e) => e.runId);
      let answer: string;
      if (!ids.length)
        answer =
          "There is no completed evidence for this teammate yet. Run its assignment first. I cannot infer a clean result from an empty history.";
      else if (!this.host.complete)
        throw new Error(
          "The assigned provider cannot answer questions. Check provider settings.",
        );
      else answer = await this.host.complete(p, input.question, context);
      return await this.serial(async () => {
        const current = this.persona(p.id);
        const c = await this.host.context();
        if (
          current.updatedAt !== p.updatedAt ||
          current.trustKey !== this.trustKey(current, c) ||
          !c.tenants.some((t) => t.id === p.tenantId)
        )
          throw new Error(
            "This teammate's scope changed while answering. Ask again with its current configuration.",
          );
        this.memory.message(
          p,
          "user",
          input.question,
          [],
          new Date(this.now()).toISOString(),
        );
        this.memory.message(
          p,
          "assistant",
          answer.slice(0, 16000),
          ids,
          new Date(this.now()).toISOString(),
        );
        this.host.changed();
        return this.state();
      });
    } finally {
      this.answering.delete(snapshot.p.id);
    }
  }
  protectedRunIds(): string[] {
    const activeMissions = new Set(
      this.missions()
        .filter(missionActive)
        .map((m) => m.id),
    );
    return [
      ...new Set([
        ...this.memory
          .list<OfficeFinding>("finding")
          .filter((f) => f.state !== "resolved")
          .flatMap((f) => f.runIds.slice(0, 2)),
        ...this.memory
          .list<OfficeHandoff>("handoff")
          .filter((h) => h.missionId && activeMissions.has(h.missionId))
          .flatMap((h) => h.sourceRunIds),
      ]),
    ];
  }
  /** Called inside the run-state lock; never acquire Office's serial lock here. */
  async validateApproval(run: RunRecord) {
    const m = this.missions().find((m) => m.id === run.office?.missionId);
    if (!m || !missionActive(m) || m.tenantId !== run.tenantId)
      throw new Error(
        "This assignment is no longer active. Prepare a new proposal.",
      );
    const expiry =
      m.approvalExpiresAt ??
      new Date(
        Date.parse(run.queuedAt) +
          (this.personas().find((p) => p.id === m.personaId)?.approvalMinutes ??
            1440) *
            60000,
      ).toISOString();
    if (Date.parse(expiry) <= this.now())
      throw new Error(
        "Approval expired. Run the assignment again to prepare a fresh proposal.",
      );
    const c = await this.host.context();
    this.validateReady(m, c);
    if (m.trustKey !== this.trustKey(this.persona(m.personaId), c))
      throw new Error(
        "The assigned provider or workflow changed. Stop and review this assignment before preparing a new proposal.",
      );
    if (
      c.runs.some(
        (r) =>
          r.id !== run.id &&
          r.office &&
          ["queued", "running"].includes(r.status),
      )
    )
      throw new Error(
        "Another team task is executing. Retry approval when its execution slot is free.",
      );
  }
  private finish(
    m: StoredMission,
    status: OfficeMission["status"],
    error?: string,
  ) {
    this.putMission({
      ...m,
      status,
      finishedAt: new Date(this.now()).toISOString(),
      ...(error ? { error } : {}),
    });
    if (status === "failed") {
      const p = this.personas().find((p) => p.id === m.personaId);
      if (p)
        this.putPersona({
          ...p,
          enabled: false,
          nextRunAt: undefined,
          lastError: error,
        });
    }
    this.host.changed();
  }
  stop(id: string): Promise<OfficeState> {
    return this.serial(async () => {
      const p = this.persona(id);
      this.putPersona({
        ...p,
        enabled: false,
        nextRunAt: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      });
      const c = await this.host.context();
      for (const m of this.missions().filter(
        (m) => m.personaId === id && missionActive(m),
      )) {
        for (const r of c.runs.filter(
          (r) => r.office?.missionId === m.id && active(r),
        ))
          await this.host.cancelRun(r.id);
        this.finish(m, "cancelled");
      }
      this.host.changed();
      return this.state();
    });
  }
  private hasDependentMission(id: string) {
    const missions = new Set(
      this.missions()
        .filter(missionActive)
        .map((m) => m.id),
    );
    return this.memory
      .list<OfficeHandoff>("handoff")
      .some(
        (h) =>
          (h.sourcePersonaId === id || h.targetPersonaId === id) &&
          h.missionId &&
          missions.has(h.missionId),
      );
  }
  remove(id: string): Promise<OfficeState> {
    return this.serial(async () => {
      this.persona(id);
      if (this.hasDependentMission(id))
        throw new Error(
          "Stop dependent assignments before removing their evidence source teammate.",
        );
      if (this.missions().some((m) => m.personaId === id && missionActive(m)))
        throw new Error("Stop this teammate before removing it.");
      for (const watcher of this.personas().filter(
        (p) => p.watch?.personaId === id,
      ))
        this.putPersona({
          ...watcher,
          enabled: false,
          nextRunAt: undefined,
          lastError:
            "The watched teammate was removed. Edit this assignment and choose another evidence source.",
        });
      this.memory.purgePersona(id);
      this.db.prepare("DELETE FROM office_missions WHERE persona_id=?").run(id);
      this.db.prepare("DELETE FROM office_personas WHERE id=?").run(id);
      this.host.changed();
      return this.state();
    });
  }
  async purgeTenant(id: string) {
    // Stop outside the host's state lock: cancelling a run takes that same lock.
    for (const p of this.personas().filter((p) => p.tenantId === id))
      await this.stop(p.id);
    await this.serial(async () => {
      this.memory.purgeTenant(id);
      this.db.prepare("DELETE FROM office_missions WHERE tenant_id=?").run(id);
      this.db.prepare("DELETE FROM office_personas WHERE tenant_id=?").run(id);
    });
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
