import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSummary,
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
  providerConfigKey: string;
};
export interface OfficeHost {
  context(): Promise<Context>;
  startRun(slug: string, options: StartRunOptions): Promise<RunRecord>;
  cancelRun(id: string): Promise<RunRecord>;
  changed(): void;
}
type StoredPersona = OfficePersona & { trustKey: string };
type StoredMission = OfficeMission & { trustKey: string };
const active = (run: RunRecord) =>
  ["queued", "running", "awaiting-confirmation"].includes(run.status);

/** Host-owned persistence and bounded coordination. No model or tenant credentials
 * enter the Office renderer; every task uses the existing run service. */
export class OfficeService {
  private db: DatabaseSync;
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
      personas: this.personas().map(({ trustKey: _, ...p }) => p),
      missions: this.missions()
        .filter((mission, index) => index < 100 || mission.status === "running")
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
      throw new Error("Choose an existing Office persona.");
    const p = this.personas().find((p) => p.id === id);
    if (!p)
      throw new Error(
        "This persona no longer exists. Refresh Office and choose another.",
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
          config: c.providerConfigKey,
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
  private validateReady(
    p: Pick<OfficePersona, "tenantId" | "providerId" | "agentSlugs" | "model">,
    c: Context,
  ) {
    if (!c.tenants.some((t) => t.id === p.tenantId))
      throw new Error(
        "The assigned tenant is disconnected. Edit this persona and choose a connected tenant.",
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
        "The assigned provider is unavailable. Connect it in Settings, then run this persona again.",
      );
    if (p.model && provider.models.length && !provider.models.includes(p.model))
      throw new Error(
        "The assigned model is unavailable. Edit this persona and choose an available model.",
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
        throw new Error("Office persona must be an object.");
      const v = input as OfficePersonaInput;
      const bounded = (x: unknown, max: number, label: string) => {
        if (typeof x !== "string" || !x.trim() || x.length > max)
          throw new Error(`${label} must contain 1–${max} characters.`);
        return x.trim();
      };
      const old = v.id === undefined ? undefined : this.persona(v.id);
      if (
        old &&
        this.missions().some(
          (m) => m.personaId === old.id && m.status === "running",
        )
      )
        throw new Error(
          "Stop the current assignment before editing this persona.",
        );
      if (!old && this.personas().length >= 24)
        throw new Error(
          "Office supports up to 24 personas. Remove an unused persona first.",
        );
      if (!["robot", "cat", "fox", "owl"].includes(v.avatar))
        throw new Error("Choose a robot, cat, fox, or owl avatar.");
      if (!["amber", "sage", "blue", "lilac"].includes(v.color))
        throw new Error("Choose one of the available persona colors.");
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
        throw new Error("Choose whether the persona is enabled.");
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
        enabled: v.enabled,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        trustKey: "",
      };
      const provider = this.validateReady(p, c);
      if (!provider.isLocal && v.confirmHosted !== true)
        throw new Error(
          `Confirm that tenant context will be sent to ${provider.name} for this assignment and its scheduled runs.`,
        );
      p.trustKey = this.trustKey(p, c);
      if (p.enabled && p.intervalMinutes !== null)
        p.nextRunAt = new Date(
          this.now() + p.intervalMinutes * 60000,
        ).toISOString();
      this.putPersona(p);
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
  private async begin(p: StoredPersona, trigger: "manual" | "schedule") {
    if (!p.enabled)
      throw new Error("This persona is paused. Edit it to enable assignments.");
    if (
      this.missions().some(
        (m) => m.personaId === p.id && m.status === "running",
      )
    )
      throw new Error("This persona already has an assignment in progress.");
    const c = await this.host.context();
    this.validateReady(p, c);
    if (p.trustKey !== this.trustKey(p, c))
      throw new Error(
        "The provider or assigned workflows changed. Review and save this persona before running it again.",
      );
    const startedAt = new Date(this.now()).toISOString();
    this.putMission({
      id: randomUUID(),
      personaId: p.id,
      personaName: p.name,
      tenantId: p.tenantId,
      providerId: p.providerId,
      ...(p.model ? { model: p.model } : {}),
      agentSlugs: [...p.agentSlugs],
      runIds: [],
      status: "running",
      trigger,
      startedAt,
      deadlineAt: new Date(this.now() + p.maxMinutes * 60000).toISOString(),
      trustKey: p.trustKey,
    });
    this.putPersona({
      ...p,
      lastError: undefined,
      ...(p.intervalMinutes !== null
        ? {
            nextRunAt: new Date(
              this.now() + p.intervalMinutes * 60000,
            ).toISOString(),
          }
        : {}),
    });
    // Bound local briefing retention. Child runs follow the existing run-history policy.
    for (const m of this.missions()
      .filter((m) => m.status !== "running")
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
          this.missions().some(
            (m) => m.personaId === p.id && m.status === "running",
          )
        )
          continue;
        try {
          await this.begin(p, "schedule");
        } catch (e) {
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
      if (this.error) {
        this.error = undefined;
        this.host.changed();
      }
    });
  }
  private async advance() {
    const missions = this.missions()
      .filter((m) => m.status === "running")
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
      const expired = Date.parse(m.deadlineAt) <= this.now();
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
      if (c.runs.some((r) => r.office && active(r))) continue;
      try {
        this.validateReady(m, c);
        if (m.trustKey !== this.trustKey(m, c))
          throw new Error(
            "The provider or assigned workflows changed. Review and save the persona before running again.",
          );
        const step = runs.length;
        const run = await this.host.startRun(m.agentSlugs[step], {
          tenantId: m.tenantId,
          providerId: m.providerId,
          model: m.model,
          trigger: m.trigger,
          office: { missionId: m.id, personaId: m.personaId, step },
        });
        m.runIds = [...m.runIds, run.id];
        this.putMission(m);
        this.host.changed();
        break;
      } catch (e) {
        this.finish(m, "failed", message(e));
      }
    }
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
        (m) => m.personaId === id && m.status === "running",
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
  remove(id: string): Promise<OfficeState> {
    return this.serial(async () => {
      this.persona(id);
      if (
        this.missions().some(
          (m) => m.personaId === id && m.status === "running",
        )
      )
        throw new Error("Stop this persona before removing it.");
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
      this.db.prepare("DELETE FROM office_missions WHERE tenant_id=?").run(id);
      this.db.prepare("DELETE FROM office_personas WHERE tenant_id=?").run(id);
    });
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
