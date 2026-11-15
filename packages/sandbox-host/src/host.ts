import { join } from "node:path";

import type { LlmOptions, RunInitiator, RunLlmApi, RunRecord } from "@openadminos/agent-sdk";
import {
  appendSandboxEvent,
  ApplicationTokenError,
  AuditLogStore,
  createApplicationTokenProvider,
  createGraphAdapter,
  createLmStudioLlm,
  createOllamaLlm,
  createQueuedRun,
  executeRun,
  llmErrorCode,
  graphRequestAuditSink,
  type ApplicationToken,
  type ApplicationTokenProvider,
  type ApplicationTokenProviderOptions,
  type SandboxAuditContext,
} from "@openadminos/runtime";

import {
  deviceFingerprint,
  importDevicePublicKey,
  runRecordDigest as runDigest,
  verifyScheduleAssignment,
  type DeviceIdentity,
  type ScheduleAssignment,
  type SignedScheduleAssignment,
} from "@openadminos/pairing";

import { resolveSandboxAgent, useReleaseAgents, type SandboxAgent } from "./agents.js";
import { SandboxApi, type PairingTimings } from "./api.js";
import { AssignmentError, checkAssignment, effectiveSchedules, type EffectiveSchedule } from "./assignments.js";
import { chooseCertificate } from "./certificates.js";
import type { SandboxAgentConfig, SandboxConfig } from "./config.js";
import { capForConnector, payloadDigest, renderFailureNotice, renderRecoveryNotice, renderSandboxReport, sendDelivery } from "./delivery.js";
import { assertSupportedPlatform, describe, ensurePrivateDirectory } from "./files.js";
import { sandboxGraphFetch } from "./graph-fetch.js";
import { assertAgentPermissions, assertSandboxIdentity } from "./identity.js";
import type { ListenAddress } from "./listen.js";
import { InstanceLock } from "./lock.js";
import { createLineLogger, type SandboxLogger } from "./log.js";
import { checkLocalModel, pinnedModelFetch, type ModelCheck } from "./model.js";
import { isSandboxRefusal, SandboxRefusal, signInRefusal, type RefusalReason } from "./refusal.js";
import {
  loadOrCreateDeviceIdentity,
  PAIRING_FILES,
  readAssignments,
  readPairing,
  removePairingFile,
  removePairingFiles,
  writeAssignments,
  writePairing,
  type StoredPairing,
} from "./pairing-files.js";
import { Scheduler, type ScheduledJob, type SchedulerClock } from "./scheduler.js";
import { loadSandboxSecrets, type SandboxSecrets } from "./secrets.js";
import { HealthStore, RunStore, type HealthFile, type RunPage } from "./store.js";
import { hostVersion } from "./version.js";

/** Seams for tests and for a future key store; production uses the defaults. */
export interface SandboxHostDeps {
  now?: () => Date;
  log?: SandboxLogger;
  /** Transport under the Graph egress wrapper. */
  graphFetch?: typeof fetch;
  /** Transport for Microsoft sign-in, pinned to the sign-in host. */
  signInFetch?: typeof fetch;
  /** Transport for the model checks. */
  modelFetch?: typeof fetch;
  /** Transport for report delivery, pinned to the destination. */
  deliveryFetch?: typeof fetch;
  createLlm?: (model: SandboxConfig["model"], check: ModelCheck) => RunLlmApi;
  createTokenProvider?: (options: ApplicationTokenProviderOptions) => ApplicationTokenProvider;
  /** Graph retry backoff; tests pass 0. */
  graphRetryBackoffMs?: number;
  schedulerClock?: SchedulerClock;
  /** How long one delivery may take, body included; tests pass a short one. */
  deliveryTimeoutMs?: number;
  /** The platform the host refuses or accepts; tests pass one. */
  platform?: NodeJS.Platform;
  /** Milliseconds for pairing code lifetimes; tests move it. */
  pairingClock?: () => number;
  /** Pairing waits and limits; tests shorten them. */
  pairingTimings?: Partial<PairingTimings>;
}

/** A named problem with what to do about it. */
export interface SandboxProblem {
  reason: string;
  message: string;
}

/** What a pairing change leaves for the admin to do in Microsoft Entra. */
export interface RoleChange {
  /** Permissions only the removed assigned agents needed; the identity check refuses runs while the app still holds them. */
  rolesNoLongerNeeded: string[];
  notice?: string;
}

/** What GET /v1/status reports. Never config secrets, keys or tokens. */
export interface SandboxStatus {
  sandbox: { id: string; name: string };
  organizationId: string;
  tenantId: string;
  hostVersion: string;
  paired: boolean;
  pairingId?: string;
  /** The config's organization or tenant changed since pairing. */
  bindingChanged: boolean;
  /** `digest` is "not checked yet" until the first preflight after start. */
  model: { provider: string; model: string; digest: string };
  assignmentVersion?: number;
  /** A stored assignment that no longer passes the checks; its schedules are not run. */
  assignmentProblem?: SandboxProblem;
  /** Pairing problems the host found, such as a changed TLS key. */
  problems: SandboxProblem[];
  schedules: Array<{
    agentId: string;
    source: "config" | "assigned";
    intervalSeconds: number;
    templateSha256: string;
    nextRunAt?: string;
    /** An assigned schedule for an agent the config also lists; the config one runs. */
    status?: "assignment-shadowed";
  }>;
}

export type RunOutcome =
  | { kind: "completed"; run: RunRecord }
  | { kind: "failed"; reason: RefusalReason; message: string; run: RunRecord }
  | { kind: "refused"; reason: RefusalReason; message: string };

/**
 * The headless sandbox host. It runs bundled read-only agents with the
 * sandbox's own app-only identity and a model on this machine, checks
 * everything again before every run, writes every Graph request to the
 * audit log before it is sent, and keeps results in its data folder.
 */
export class SandboxHost {
  private readonly now: () => Date;
  private readonly log: SandboxLogger;
  private readonly lock: InstanceLock;
  private readonly runs: RunStore;
  private healthStore: HealthStore | undefined;
  private audit: AuditLogStore | undefined;
  private readonly inFlight = new Set<string>();
  private readonly running = new Set<Promise<unknown>>();
  private scheduler: Scheduler | undefined;
  private readonly stopController = new AbortController();
  private identityKey: DeviceIdentity | undefined;
  private pairing: StoredPairing | undefined;
  private assignment: ScheduleAssignment | undefined;
  private signedAssignment: SignedScheduleAssignment | undefined;
  /** The version of the stored assignment, also when it was not enabled, so it cannot be replayed. */
  private heldVersion: number | undefined;
  private assignmentProblem: SandboxProblem | undefined;
  /** assignments.json could not be read, so no version floor is known and new assignments are refused. */
  private assignmentFloorUnknown = false;
  private readonly pairingProblems: SandboxProblem[] = [];
  private lastModel: ModelCheck | undefined;
  private readonly onClose: Array<() => Promise<void>> = [];

  constructor(private readonly config: SandboxConfig, private readonly deps: SandboxHostDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? createLineLogger();
    assertSupportedPlatform(deps.platform);
    ensurePrivateDirectory(config.dataDir);
    this.lock = new InstanceLock(join(config.dataDir, "sandbox.lock"));
    this.runs = new RunStore(join(config.dataDir, "runs"), undefined, () => this.now().getTime());
    useReleaseAgents();
  }

  /** health.json, read only once the lock is held, so a second host never moves it aside. */
  private get health(): HealthStore {
    if (!this.healthStore) throw new SandboxRefusal("storage-failed", "health.json is not open. Start the sandbox host again.");
    return this.healthStore;
  }

  /** Takes the instance lock, opens the audit log and marks interrupted runs. */
  open(): void {
    this.lock.acquire();
    try {
      this.healthStore = new HealthStore(join(this.config.dataDir, "health.json"), this.config.sandbox.id);
      this.audit = new AuditLogStore(join(this.config.dataDir, "openadminos.db"), this.now);
      if (this.health.problem) {
        this.log("error", this.health.problem, { reason: "storage-corrupt", file: "health.json" });
      }
      const corrupt = this.runs.unreadableFiles();
      if (corrupt.length > 0) {
        this.log("error", `${corrupt.length === 1 ? "A run record" : `${corrupt.length} run records`} in the data folder cannot be read and ${corrupt.length === 1 ? "is" : "are"} left in place for review: ${corrupt.join(", ")}.`, { reason: "storage-corrupt", count: corrupt.length });
      }
      const interrupted = this.runs.markInterrupted(this.now());
      if (interrupted > 0) this.log("warn", "Runs left running by a stopped host were marked interrupted.", { count: interrupted });
      // Pairing exists only with a pairing section: without it the host
      // reads no pairing file and runs the config schedules alone.
      if (this.config.pairing) {
        this.identityKey = loadOrCreateDeviceIdentity(this.config.dataDir);
        this.pairing = readPairing(this.config.dataDir, this.identityKey);
        // A damaged assignments.json does not stop the config schedules; a
        // damaged pairing.json does (above), since trust starts there.
        let stored: ReturnType<typeof readAssignments>;
        try {
          stored = this.pairing ? readAssignments(this.config.dataDir, this.pairing.record.desktopPublicKey) : undefined;
        } catch (error) {
          // Any read failure (damaged, wrong mode, not a file, unreadable)
          // leaves the assignment state unknown; only pairing.json is fatal.
          stored = undefined;
          this.assignmentFloorUnknown = true;
          const reason = isSandboxRefusal(error) ? error.reason : "pairing-files-invalid";
          const effect = "Assigned schedules are not run and new assignments are refused, because the version they must exceed is unknown; config schedules keep running.";
          // A permission problem is fixed in place; damaged content needs a new pairing.
          const message = reason === "file-permissions"
            ? `${error instanceof Error ? error.message : String(error)} Until then: ${effect}`
            : `${isSandboxRefusal(error) ? error.message.split(". Run openadminos-sandbox")[0].replace(/\.$/, "") : `${PAIRING_FILES.assignments} could not be read: ${describe(error)}`}. ${effect} Unpair and pair again.`;
          this.assignmentProblem = { reason, message };
          this.log("error", this.assignmentProblem.message, { reason, file: PAIRING_FILES.assignments });
        }
        if (this.pairing && this.bindingChanged) {
          this.log("error", "The config's organization or tenant changed since this sandbox was paired. Assigned schedules are not run and the desktop is refused until the sandbox is unpaired and paired again.", { reason: "pairing-binding-changed" });
        }
        if (this.pairing && stored) {
          this.heldVersion = stored.assignment.version;
          this.loadAssignment(this.pairing, stored);
        }
      }
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  /**
   * A stored assignment is checked again on every start like a new one:
   * pairing, organization, tenant, intervals, agents and the bundled
   * manifest hashes. One that no longer passes is kept on disk but not
   * run, and named in the log and in status.
   */
  private loadAssignment(pairing: StoredPairing, stored: { signed: SignedScheduleAssignment; assignment: ScheduleAssignment }): void {
    // Kept whether or not it runs: it is the version floor, and what a failed replacement restores.
    this.signedAssignment = stored.signed;
    if (this.bindingChanged) return;
    try {
      checkAssignment(stored.assignment, { config: this.config, pairingId: pairing.record.pairingId, heldVersion: undefined });
      this.assignment = stored.assignment;
    } catch (error) {
      if (!(error instanceof AssignmentError)) throw error;
      this.assignmentProblem = {
        reason: error.code,
        message: `The stored schedule assignment (version ${stored.assignment.version}) is not run: ${error.message} Send a new assignment from the desktop, or unpair.`,
      };
      this.log("error", this.assignmentProblem.message, { reason: error.code });
    }
  }

  /** Scopes the agents of these schedules declare; an agent that fails its checks adds none. */
  private rolesFor(schedules: readonly EffectiveSchedule[]): Set<string> {
    const roles = new Set<string>();
    for (const { agent } of schedules) {
      try {
        for (const scope of resolveSandboxAgent(agent).agent.scopes) roles.add(scope);
      } catch {
        // Refused on its own run.
      }
    }
    return roles;
  }

  private roleChange(before: Set<string>, after: Set<string>): RoleChange {
    const rolesNoLongerNeeded = [...before].filter((role) => !after.has(role)).sort();
    if (rolesNoLongerNeeded.length === 0) return { rolesNoLongerNeeded };
    const list = rolesNoLongerNeeded.join(", ");
    const notice = this.config.agents.length > 0
      ? `Remove ${list} from the sandbox app registration, or config schedules will be refused: the identity check refuses runs while the app holds a permission no scheduled agent needs.`
      : `Remove ${list} from the sandbox app registration before schedules are assigned again: the identity check refuses runs while the app holds a permission no scheduled agent needs.`;
    return { rolesNoLongerNeeded, notice };
  }

  /** The schedule for an agent id, from the config or an enabled assignment. */
  scheduledAgent(agentId: string): EffectiveSchedule | undefined {
    return this.schedules().schedules.find((schedule) => schedule.agent.id === agentId);
  }

  /** Records a pairing problem for status and health, and logs it. */
  reportPairingProblem(problem: SandboxProblem): void {
    if (!this.pairingProblems.some((existing) => existing.reason === problem.reason)) this.pairingProblems.push(problem);
    this.log("error", problem.message, { reason: problem.reason });
  }

  /**
   * `--unpair` with the service stopped: takes the lock, records the
   * removal in the audit log, removes pairing.json and assignments.json
   * and releases the lock. Works when those files are damaged, too.
   */
  unpairOffline(): { removed: string[] } & RoleChange {
    this.lock.acquire();
    try {
      this.audit = new AuditLogStore(join(this.config.dataDir, "openadminos.db"), this.now);
      let pairingId: string | undefined;
      let assignment: ScheduleAssignment | undefined;
      try {
        const pairing = readPairing(this.config.dataDir, loadOrCreateDeviceIdentity(this.config.dataDir));
        pairingId = pairing?.record.pairingId;
        assignment = pairing ? readAssignments(this.config.dataDir, pairing.record.desktopPublicKey)?.assignment : undefined;
      } catch {
        // Damaged files are removed all the same; their roles cannot be named.
      }
      const change = this.roleChange(this.rolesFor(effectiveSchedules(this.config, assignment).schedules), this.rolesFor(effectiveSchedules(this.config, undefined).schedules));
      this.auditEvent(this.hostContext(), "sandbox.pairing.removed", { ...(pairingId ? { pairingId } : {}), by: "unpair-flag", rolesNoLongerNeeded: change.rolesNoLongerNeeded });
      return { removed: removePairingFiles(this.config.dataDir), ...change };
    } finally {
      this.audit?.close();
      this.audit = undefined;
      this.lock.release();
    }
  }

  /** Stops the schedule, stops runs in progress, closes the audit log and releases the lock. */
  async close(): Promise<void> {
    for (const stop of this.onClose.splice(0)) await stop();
    this.stopController.abort();
    await this.scheduler?.stop();
    // Runs stop on the abort and record themselves before the audit log closes.
    await Promise.allSettled([...this.running]);
    this.audit?.close();
    this.audit = undefined;
    this.lock.release();
  }

  startSchedule(): Scheduler {
    const scheduler = new Scheduler(this.scheduledJobs(), this.deps.schedulerClock);
    this.scheduler = scheduler;
    scheduler.start();
    for (const next of scheduler.nextRuns()) {
      this.log("info", "Scheduled.", { agent: next.id, next: new Date(next.dueAt).toISOString() });
    }
    return scheduler;
  }

  /**
   * Starts the pairing API when the config has a pairing section; without
   * one nothing listens. Stopped by close.
   */
  async startApi(): Promise<ListenAddress | undefined> {
    if (!this.config.pairing) return undefined;
    const api = new SandboxApi(this, this.config.pairing.listen, this.log, this.now, this.deps.pairingClock, this.deps.pairingTimings);
    this.addCloseHook(() => api.close());
    try {
      return await api.start();
    } catch (error) {
      await api.close();
      throw error;
    }
  }

  /** Applies a changed set of schedules without a restart. */
  private refreshSchedule(): void {
    this.scheduler?.replace(this.scheduledJobs());
  }

  private scheduledJobs(): ScheduledJob[] {
    return this.schedules().schedules.map(({ agent }) => {
      const lastStartedAt = this.lastStartedAt(agent.id);
      return {
        id: agent.id,
        intervalMs: agent.intervalSeconds * 1000,
        ...(lastStartedAt !== undefined ? { lastStartedAt } : {}),
        run: async () => {
          await this.runAgent(agent, "schedule");
        },
      };
    });
  }

  /** Config schedules, and assigned ones while the pairing still matches the config. */
  private schedules(): { schedules: EffectiveSchedule[]; shadowed: string[] } {
    return effectiveSchedules(this.config, this.pairing && !this.bindingChanged ? this.assignment : undefined);
  }

  /** The config's organization or tenant is not the one the desktop paired with. */
  get bindingChanged(): boolean {
    const record = this.pairing?.record;
    return record !== undefined && (record.organizationId !== this.config.organizationId || record.tenantId !== this.config.tenantId);
  }

  get sandboxConfig(): SandboxConfig {
    return this.config;
  }

  /** The device key; only with a pairing section, after open. */
  get identity(): DeviceIdentity {
    if (!this.identityKey) throw new SandboxRefusal("pairing-files-invalid", "The sandbox device key is not loaded. The config has no pairing section, or the host is not open.");
    return this.identityKey;
  }

  get currentPairing(): StoredPairing | undefined {
    return this.pairing;
  }

  /** Runs a cleanup when the host closes, before the schedule stops; the pairing API registers its own. */
  addCloseHook(stop: () => Promise<void>): void {
    this.onClose.push(stop);
  }

  status(): SandboxStatus {
    const { schedules, shadowed } = this.schedules();
    const next = new Map((this.scheduler?.nextRuns() ?? []).map((entry) => [entry.id, entry.dueAt]));
    const digest = this.lastModel ? this.lastModel.digest : "not checked yet";
    return {
      sandbox: { ...this.config.sandbox },
      organizationId: this.config.organizationId,
      tenantId: this.config.tenantId,
      hostVersion: hostVersion(),
      paired: this.pairing !== undefined,
      ...(this.pairing ? { pairingId: this.pairing.record.pairingId } : {}),
      bindingChanged: this.bindingChanged,
      model: { provider: this.config.model.provider, model: this.config.model.model, digest },
      ...(this.assignment ? { assignmentVersion: this.assignment.version } : {}),
      ...(this.assignmentProblem ? { assignmentProblem: { ...this.assignmentProblem } } : {}),
      problems: this.pairingProblems.map((problem) => ({ ...problem })),
      schedules: [
        ...schedules.map(({ agent, source }) => {
          const dueAt = next.get(agent.id);
          return {
            agentId: agent.id,
            source,
            intervalSeconds: agent.intervalSeconds,
            templateSha256: agent.templateSha256,
            ...(dueAt !== undefined ? { nextRunAt: new Date(dueAt).toISOString() } : {}),
          };
        }),
        ...shadowed.map((agentId) => {
          const entry = this.assignment?.entries.find((candidate) => candidate.agentId === agentId);
          return {
            agentId,
            source: "assigned" as const,
            intervalSeconds: entry?.intervalSeconds ?? 0,
            templateSha256: entry?.templateSha256 ?? "",
            status: "assignment-shadowed" as const,
          };
        }),
      ],
    };
  }

  healthSnapshot(): HealthFile & { problems: SandboxProblem[] } {
    return { ...this.health.snapshot(), problems: [...this.pairingProblems, ...(this.assignmentProblem ? [this.assignmentProblem] : [])].map((problem) => ({ ...problem })) };
  }

  runsAfter(cursor: number, limit: number): RunPage {
    return this.runs.listAfter(cursor, limit);
  }

  auditLog(): AuditLogStore {
    return this.requireAudit();
  }

  /**
   * Records a successful pairing: pairing.json first, with any earlier
   * assignments.json removed, then the audit event. When the audit log
   * cannot record it, the pairing is taken back.
   */
  completePairing(pairing: StoredPairing): void {
    try {
      writePairing(this.config.dataDir, pairing);
      removePairingFile(this.config.dataDir, PAIRING_FILES.assignments);
      this.auditEvent(this.hostContext(), "sandbox.pairing.created", {
        pairingId: pairing.record.pairingId,
        desktopFingerprint: deviceFingerprint(importDevicePublicKey(pairing.record.desktopPublicKey)),
        desktopTlsSpkiSha256: pairing.desktopTlsSpkiSha256,
      });
    } catch (error) {
      // Any step that fails leaves the sandbox unpaired.
      try {
        removePairingFile(this.config.dataDir, PAIRING_FILES.pairing);
      } catch (cleanup) {
        this.log("error", `pairing.json could not be removed after a failed pairing: ${describe(cleanup)} Run --unpair before pairing again.`, { reason: "storage-failed" });
      }
      throw error;
    }
    this.pairing = pairing;
    this.assignment = undefined;
    this.signedAssignment = undefined;
    this.heldVersion = undefined;
    this.assignmentProblem = undefined;
    this.assignmentFloorUnknown = false;
    this.refreshSchedule();
    this.log("info", "Paired with a desktop.", { pairing: pairing.record.pairingId });
  }

  /**
   * Checks and applies a signed assignment from the paired desktop, then
   * swaps the schedule without a restart. assignments.json is written
   * first and the audit event after; when the audit log cannot record it,
   * the previous file is put back. Throws an AssignmentError.
   */
  applyAssignment(signed: unknown): { version: number; assigned: string[]; shadowed: string[] } & RoleChange {
    const pairing = this.pairing;
    if (!pairing) throw new AssignmentError("assignment-binding-mismatch", "This sandbox is not paired.");
    const verified = verifyScheduleAssignment(signed, pairing.record.desktopPublicKey);
    if (!verified.ok) throw new AssignmentError("assignment-invalid", verified.detail);
    const assignment = verified.value;
    if (this.assignmentFloorUnknown) {
      throw new AssignmentError(
        "assignment-state-unknown",
        "assignments.json on the sandbox could not be read, so the version a new assignment must exceed is unknown. Unpair and pair again, then assign the schedules.",
      );
    }
    checkAssignment(assignment, { config: this.config, pairingId: pairing.record.pairingId, heldVersion: this.heldVersion });
    const rolesBefore = this.rolesFor(this.schedules().schedules);
    const next: SignedScheduleAssignment = { assignment, signature: (signed as { signature: string }).signature };
    const previous = this.signedAssignment;
    writeAssignments(this.config.dataDir, next);
    try {
      this.auditEvent(this.hostContext(), "sandbox.assignment.applied", {
        pairingId: assignment.pairingId,
        version: assignment.version,
        agents: assignment.entries.map((entry) => entry.agentId),
      });
    } catch (error) {
      if (previous) writeAssignments(this.config.dataDir, previous);
      else removePairingFile(this.config.dataDir, PAIRING_FILES.assignments);
      throw error;
    }
    this.assignment = assignment;
    this.signedAssignment = next;
    this.heldVersion = assignment.version;
    this.assignmentProblem = undefined;
    this.refreshSchedule();
    const { schedules, shadowed } = this.schedules();
    const change = this.roleChange(rolesBefore, this.rolesFor(schedules));
    const assigned = schedules.filter((entry) => entry.source === "assigned").map((entry) => entry.agent.id);
    this.log("info", "Schedule assignment applied.", { version: assignment.version, assigned: assigned.length, shadowed: shadowed.length });
    if (change.notice) this.log("warn", change.notice, { reason: "roles-no-longer-needed", roles: change.rolesNoLongerNeeded.join(",") });
    return { version: assignment.version, assigned, shadowed, ...change };
  }

  /**
   * Removes the pairing and the assigned schedules; config schedules stay.
   * Returns the files removed and the permissions only the assigned
   * agents needed, which the admin removes so config runs pass the
   * identity check.
   */
  unpair(): { removed: string[]; auditProblem?: string } & RoleChange {
    const pairingId = this.pairing?.record.pairingId;
    const change = this.roleChange(this.rolesFor(this.schedules().schedules), this.rolesFor(effectiveSchedules(this.config, undefined).schedules));
    // The files go first: an unpair the audit log cannot record still unpairs.
    const removed = removePairingFiles(this.config.dataDir);
    this.pairing = undefined;
    this.assignment = undefined;
    this.signedAssignment = undefined;
    this.heldVersion = undefined;
    this.assignmentProblem = undefined;
    this.assignmentFloorUnknown = false;
    this.refreshSchedule();
    let auditProblem: string | undefined;
    try {
      this.auditEvent(this.hostContext(), "sandbox.pairing.removed", { ...(pairingId ? { pairingId } : {}), rolesNoLongerNeeded: change.rolesNoLongerNeeded });
    } catch (error) {
      auditProblem = `The sandbox was unpaired, but the audit log could not record it: ${describe(error)}`;
      this.log("error", auditProblem, { reason: "audit-failed" });
    }
    this.log(
      change.notice ? "warn" : "info",
      `Unpaired: the pairing and the assigned schedules were removed. ${change.notice ?? "Config schedules keep running."}`,
      { removed: removed.join(",") || "none" },
    );
    return { removed, ...change, ...(auditProblem ? { auditProblem } : {}) };
  }

  private hostContext(): SandboxAuditContext {
    return { tenantId: this.config.tenantId, organizationId: this.config.organizationId, sandboxId: this.config.sandbox.id };
  }

  async runAgent(agentConfig: SandboxAgentConfig, initiator: Extract<RunInitiator, "schedule" | "person">): Promise<RunOutcome> {
    if (this.inFlight.has(agentConfig.id)) {
      const message = `${agentConfig.id} is still running; this start was skipped.`;
      this.log("warn", message, { agent: agentConfig.id, reason: "already-running" });
      return { kind: "refused", reason: "already-running", message };
    }
    this.inFlight.add(agentConfig.id);
    const runNow = this.runAgentNow(agentConfig, initiator);
    this.running.add(runNow);
    try {
      return await runNow;
    } catch (error) {
      // Never dropped: a filesystem error in the data folder is
      // storage-failed, anything else is run-failed with its cause.
      const refusal = isSandboxRefusal(error)
        ? error
        : isFilesystemError(error)
          ? new SandboxRefusal("storage-failed", `${agentConfig.id} stopped: the sandbox data folder could not be written. ${describe(error)} Check free disk space and permissions of ${this.config.dataDir}.`, { cause: error })
          : new SandboxRefusal("run-failed", `${agentConfig.id} stopped: ${describe(error)}`, { cause: error });
      this.log("error", refusal.message, { agent: agentConfig.id, reason: refusal.reason });
      this.safeHealth(agentConfig.id, { lastRefusal: { reason: refusal.reason, message: refusal.message, at: this.now().toISOString() } });
      try {
        await this.sendNotice(agentConfig, this.auditContext(agentConfig.id, initiator), refusal.reason, {});
      } catch (noticeError) {
        this.log("error", `Failure notice not sent: ${describe(noticeError)}`, { agent: agentConfig.id, reason: "delivery-failed" });
      }
      return { kind: "refused", reason: refusal.reason, message: refusal.message };
    } finally {
      this.running.delete(runNow);
      this.inFlight.delete(agentConfig.id);
    }
  }

  private auditContext(agentId: string, initiator: RunInitiator, runId?: string): SandboxAuditContext {
    return {
      tenantId: this.config.tenantId,
      organizationId: this.config.organizationId,
      sandboxId: this.config.sandbox.id,
      agentSlug: agentId,
      initiator,
      ...(runId ? { runId } : {}),
    };
  }

  private requireAudit(): AuditLogStore {
    if (!this.audit) throw new SandboxRefusal("audit-failed", "The audit log is not open. Start the sandbox host again.");
    return this.audit;
  }

  /** The throwing append: a failure becomes the named audit refusal. */
  private auditEvent(context: SandboxAuditContext, type: string, details: Record<string, unknown>): void {
    try {
      appendSandboxEvent(this.requireAudit(), context, type, details, this.now);
    } catch (cause) {
      if (isSandboxRefusal(cause)) throw cause;
      throw new SandboxRefusal(
        "audit-failed",
        `The audit log could not record ${type}: ${describe(cause)} Nothing was sent. Check free disk space and permissions of the sandbox data folder.`,
        { cause },
      );
    }
  }

  private async runAgentNow(agentConfig: SandboxAgentConfig, initiator: Extract<RunInitiator, "schedule" | "person">): Promise<RunOutcome> {
    const agentId = agentConfig.id;
    const context = this.auditContext(agentId, initiator);
    let secrets: SandboxSecrets = {};
    let prepared: Prepared;
    try {
      prepared = await this.preflight(agentConfig, context, (loaded) => {
        secrets = loaded;
      });
    } catch (error) {
      const refusal = isSandboxRefusal(error) ? error : new SandboxRefusal("run-failed", `The preflight of ${agentId} failed: ${describe(error)}`, { cause: error });
      return this.refuse(agentConfig, context, refusal, secrets);
    }
    return this.execute(agentConfig, initiator, prepared, secrets);
  }

  private async preflight(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    setSecrets: (secrets: SandboxSecrets) => void,
  ): Promise<Prepared> {
    const now = this.now();
    const certificate = chooseCertificate(this.config.certificates, now);
    for (const warning of certificate.warnings) this.log("warn", warning, { agent: agentConfig.id });
    const resolved = resolveSandboxAgent(agentConfig);
    const model = await checkLocalModel(this.config.model, this.deps.modelFetch ?? fetch);
    this.lastModel = model;
    if (agentConfig.delivery) {
      setSecrets(loadSandboxSecrets(this.config.secretsPath, new Set([agentConfig.delivery.connector])));
    }
    this.auditEvent(context, "sandbox.run.preflight", {
      templateSha256: resolved.sha256,
      model: model.model,
      modelDigest: model.digest,
      certificateSha256: certificate.signer.thumbprintSha256,
    });

    const allowlist = this.allowedRoles(agentConfig, resolved);
    const expectation = { tenantId: this.config.tenantId, clientId: this.config.clientId, allowedRoles: allowlist.roles, refusedAgents: allowlist.refused };
    // Token events carry the run id once the run exists; a failed record of
    // a sign-in failure is kept and named together with it.
    const tokenAudit: TokenAudit = { context };
    const factory = this.deps.createTokenProvider ?? createApplicationTokenProvider;
    const tokenProvider = factory({
      tenantId: this.config.tenantId,
      clientId: this.config.clientId,
      signer: certificate.signer,
      ...(this.deps.signInFetch ? { fetch: this.deps.signInFetch } : {}),
      onAcquired: (token) => {
        this.auditEvent(tokenAudit.context, "sandbox.token.acquired", {
          roles: token.roles,
          expiresOn: token.expiresOn.toISOString(),
          certificateSha256: certificate.signer.thumbprintSha256,
        });
        assertSandboxIdentity(token, expectation);
      },
      onFailed: (error) => {
        try {
          this.auditEvent(tokenAudit.context, "sandbox.token.failed", { code: error.code, ...(error.aadsts ? { aadsts: error.aadsts } : {}) });
        } catch (auditError) {
          tokenAudit.auditProblem = isSandboxRefusal(auditError) ? auditError : new SandboxRefusal("audit-failed", describe(auditError));
        }
      },
    });
    let token: ApplicationToken;
    try {
      token = await tokenProvider.acquire();
    } catch (error) {
      throw signInFailure(error, tokenAudit);
    }
    assertAgentPermissions(token.roles, resolved.manifest.descriptor.name, resolved.agent.scopes);
    return { resolved, model, tokenProvider, token, tokenAudit };
  }

  private async execute(
    agentConfig: SandboxAgentConfig,
    initiator: Extract<RunInitiator, "schedule" | "person">,
    prepared: Prepared,
    secrets: SandboxSecrets,
  ): Promise<RunOutcome> {
    const { resolved, model, tokenProvider, tokenAudit } = prepared;
    const queued = createQueuedRun({ agent: resolved.agent, providerId: this.config.model.provider, model: model.model });
    let run: RunRecord = {
      ...queued,
      trigger: initiator === "schedule" ? "schedule" : "manual",
      initiator,
      tenantId: this.config.tenantId,
      executedOn: {
        kind: "sandbox",
        sandboxId: this.config.sandbox.id,
        name: this.config.sandbox.name,
        organizationId: this.config.organizationId,
        model: model.model,
        modelDigest: model.digest,
      },
    };
    const context = this.auditContext(agentConfig.id, initiator, run.id);
    tokenAudit.context = context;
    this.runs.write(run);
    this.log("info", "Run started.", { agent: agentConfig.id, run: run.id });

    const controller = new AbortController();
    let stopReason: SandboxRefusal | undefined;
    const stop = (refusal: SandboxRefusal) => {
      stopReason ??= refusal;
      if (!controller.signal.aborted) controller.abort(refusal);
    };
    const onShutdown = () => stop(new SandboxRefusal("run-stopped", "The sandbox host stopped during the run. The next scheduled run starts fresh."));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const statuses: number[] = [];
    let modelFailure: string | undefined;
    try {
      // Set up inside the try, so a throw while building the run cannot
      // leave the deadline timer or the shutdown listener behind.
      this.stopController.signal.addEventListener("abort", onShutdown, { once: true });
      if (this.stopController.signal.aborted) onShutdown();
      deadline = setTimeout(
        () => stop(new SandboxRefusal("run-deadline", `The run did not finish within ${this.config.runDeadlineSeconds} seconds and was stopped. Check the model's speed on this machine, or raise runDeadlineSeconds.`)),
        this.config.runDeadlineSeconds * 1000,
      );
      const sink = graphRequestAuditSink(this.requireAudit(), context, this.now);
      const fetchImpl = sandboxGraphFetch({
        ...(this.deps.graphFetch ? { base: this.deps.graphFetch } : {}),
        sink,
        onStop: stop,
        onStatus: (status) => statuses.push(status),
      });
      const guardedTokens = (async () => {
        try {
          return await tokenProvider();
        } catch (error) {
          const refusal = signInFailure(error, tokenAudit);
          stop(refusal);
          throw refusal;
        }
      });
      const timeoutMs = (this.config.model.timeoutSeconds ?? 300) * 1000;
      // The model client sends only to the endpoint that was checked, and never follows a redirect.
      const modelTransport = pinnedModelFetch(this.config.model.endpoint);
      const baseLlm = this.deps.createLlm?.(this.config.model, model) ??
        (this.config.model.provider === "ollama"
          ? createOllamaLlm({ endpoint: this.config.model.endpoint, defaultModel: model.model, timeoutMs, fetchImpl: modelTransport })
          : createLmStudioLlm({ endpoint: this.config.model.endpoint, defaultModel: model.model, timeoutMs, fetchImpl: modelTransport }));
      const llm = recordModelFailures(baseLlm, (code) => {
        modelFailure ??= code;
      });
      run = await executeRun({
        signal: controller.signal,
        run,
        agent: resolved.agent,
        providerId: this.config.model.provider,
        model: model.model,
        llm,
        realWrites: false,
        module: resolved.module,
        createGraph: (log) =>
          createGraphAdapter({
            tokenProvider: guardedTokens,
            log,
            signal: controller.signal,
            fetchImpl,
            ...(this.deps.graphRetryBackoffMs !== undefined ? { retryBackoffMs: this.deps.graphRetryBackoffMs } : {}),
          }),
        onProgress: (progress) => {
          run = progress;
        },
      });
    } catch (error) {
      if (isSandboxRefusal(error)) stop(error);
      else stop(new SandboxRefusal("run-failed", `The run of ${resolved.manifest.descriptor.name} could not start: ${describe(error)}`, { cause: error }));
      run = { ...run, status: "failed", finishedAt: this.now().toISOString(), error: describe(error), summary: `${resolved.manifest.descriptor.name} failed.` };
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      this.stopController.signal.removeEventListener("abort", onShutdown);
    }

    let outcome: RunOutcome;
    if (run.status === "completed" && !stopReason) {
      outcome = { kind: "completed", run };
    } else {
      const refusal = stopReason ?? failureReason(run, statuses, modelFailure);
      run = {
        ...run,
        status: "failed",
        finishedAt: run.finishedAt ?? this.now().toISOString(),
        error: refusal.message,
        logs: [...run.logs, { id: `${run.id}_reason`, runId: run.id, timestamp: this.now().toISOString(), level: "error", message: refusal.message, metadata: { reason: refusal.reason } }],
      };
      outcome = { kind: "failed", reason: refusal.reason, message: refusal.message, run };
    }
    try {
      // The digest binds the record the desktop will read to this event.
      this.auditEvent(context, "sandbox.run.finished", { status: run.status, runDigest: runDigest(run), ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}) });
    } catch (error) {
      // A run the audit log cannot close is not a success, and nothing is sent for it.
      const refusal = isSandboxRefusal(error) ? error : new SandboxRefusal("audit-failed", describe(error), { cause: error });
      run = this.failRun(run, refusal);
      outcome = { kind: "failed", reason: "audit-failed", message: refusal.message, run };
    }
    this.runs.write(run);
    this.recordLastRun(agentConfig.id, run, outcome);
    this.log(outcome.kind === "completed" ? "info" : "error", outcome.kind === "completed" ? "Run completed." : "Run failed.", {
      agent: agentConfig.id,
      run: run.id,
      reason: outcome.kind === "failed" ? outcome.reason : undefined,
      steps: run.steps.length,
    });

    // Nothing is sent for a run the audit log could not close, or one stopped by a shutdown.
    if (outcome.kind === "failed" && (outcome.reason === "audit-failed" || outcome.reason === "run-stopped")) return outcome;
    const delivered = await this.deliverRun(agentConfig, context, run, resolved, outcome, secrets);
    if (delivered) {
      run = delivered.run;
      outcome = { ...outcome, run };
      if (delivered.auditFailure) {
        run = this.failRun(run, delivered.auditFailure);
        // The audit log just failed, so this event may not be recorded; the desktop then shows the run as not verified.
        this.auditRewrite(context, run);
        this.runs.write(run);
        outcome = { kind: "failed", reason: "audit-failed", message: delivered.auditFailure.message, run };
        this.recordLastRun(agentConfig.id, run, outcome);
      }
    }
    return outcome;
  }

  /**
   * Records that a finished run's record changed, with the digest of the
   * new record, before it is written. Returns the refusal when the audit
   * log cannot record it; the record is then written all the same.
   */
  private auditRewrite(context: SandboxAuditContext, run: RunRecord): SandboxRefusal | undefined {
    try {
      this.auditEvent(context, "sandbox.run.rewritten", { status: run.status, runDigest: runDigest(run) });
      return undefined;
    } catch (error) {
      const refusal = isSandboxRefusal(error) ? error : new SandboxRefusal("audit-failed", describe(error), { cause: error });
      this.log("error", refusal.message, { reason: "audit-failed", run: run.id });
      return refusal;
    }
  }

  private failRun(run: RunRecord, refusal: SandboxRefusal): RunRecord {
    const at = this.now().toISOString();
    return {
      ...run,
      status: "failed",
      finishedAt: run.finishedAt ?? at,
      error: refusal.message,
      logs: [...run.logs, { id: `${run.id}_${refusal.reason}`, runId: run.id, timestamp: at, level: "error", message: refusal.message, metadata: { reason: refusal.reason } }],
    };
  }

  private recordLastRun(agentId: string, run: RunRecord, outcome: RunOutcome): void {
    this.safeHealth(agentId, {
      lastRun: { runId: run.id, status: run.status, ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) },
    });
  }

  /**
   * The only roles the identity may hold: the scopes the configured and
   * assigned agents declare in their hashed manifests, read again on every
   * run. An agent whose own checks fail adds none.
   */
  private allowedRoles(current: SandboxAgentConfig, resolved: SandboxAgent): { roles: Set<string>; refused: Array<{ id: string; reason: string }> } {
    const roles = new Set(resolved.agent.scopes);
    const refused: Array<{ id: string; reason: string }> = [];
    for (const { agent } of this.schedules().schedules) {
      if (agent.id === current.id) continue;
      try {
        for (const scope of resolveSandboxAgent(agent).agent.scopes) roles.add(scope);
      } catch (error) {
        // That agent is refused on its own run; here its scopes are missing from the allowlist.
        refused.push({ id: agent.id, reason: isSandboxRefusal(error) ? error.reason : "run-failed" });
      }
    }
    return { roles, refused };
  }

  /** Sends the report when the config asks for it, once. Records the result on the run. */
  private async deliverRun(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    run: RunRecord,
    resolved: SandboxAgent,
    outcome: RunOutcome,
    secrets: SandboxSecrets,
  ): Promise<{ run: RunRecord; auditFailure?: SandboxRefusal } | undefined> {
    const delivery = agentConfig.delivery;
    if (!delivery) return undefined;
    const completed = outcome.kind === "completed";
    if (!((completed && delivery.notifyOnSuccess) || (!completed && delivery.notifyOnFailure))) {
      await this.sendNotice(agentConfig, context, outcome.kind === "completed" ? undefined : outcome.reason, secrets);
      return undefined;
    }
    const text = renderSandboxReport({
      run,
      agentName: resolved.manifest.descriptor.name,
      sandboxName: this.config.sandbox.name,
      manifest: resolved.manifest,
      ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
    });
    const result = await this.send(agentConfig, context, run.id, delivery, secrets, text);
    if (delivery.failureNotice && result.outcome === "sent") {
      // The report carried the status, so it counts as the notice for it.
      this.safeHealth(agentConfig.id, { lastNoticeReason: outcome.kind === "failed" ? outcome.reason : undefined });
    }
    const at = this.now().toISOString();
    const label = delivery.connector === "slack" ? "Send report to Slack" : "Send report to Discord";
    const updated: RunRecord = {
      ...run,
      steps: [...run.steps, { id: `${run.id}_delivery`, runId: run.id, label, status: result.outcome === "sent" ? "completed" : "failed", detail: result.detail, startedAt: at, finishedAt: at }],
      logs: [...run.logs, { id: `${run.id}_delivery_log`, runId: run.id, timestamp: at, level: result.outcome === "sent" ? "info" : "warn", message: result.outcome === "sent" ? "Report delivered." : `Report not delivered: ${result.detail}`, metadata: { reason: result.outcome === "sent" ? "delivered" : "delivery-failed" } }],
    };
    const rewriteFailure = this.auditRewrite(context, updated);
    this.runs.write(updated);
    const auditFailure = result.auditFailure ?? rewriteFailure;
    return { run: updated, ...(auditFailure ? { auditFailure } : {}) };
  }

  private async send(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    idempotencyKey: string,
    delivery: NonNullable<SandboxAgentConfig["delivery"]>,
    secrets: SandboxSecrets,
    text: string,
  ): Promise<{ outcome: "sent" | "failed"; detail: string; auditFailure?: SandboxRefusal }> {
    text = capForConnector(text, delivery.connector);
    const digest = payloadDigest(text);
    try {
      this.auditEvent(context, "delivery.attempted", { connector: delivery.connector, payloadDigest: digest, idempotencyKey });
    } catch (error) {
      const auditFailure = isSandboxRefusal(error) ? error : new SandboxRefusal("audit-failed", describe(error), { cause: error });
      this.safeHealth(agentConfig.id, { lastDelivery: { runId: idempotencyKey, outcome: "failed", detail: auditFailure.message, at: this.now().toISOString() } });
      this.log("error", "Report not delivered: the audit log could not record it.", { agent: agentConfig.id, reason: "audit-failed" });
      return { outcome: "failed", detail: auditFailure.message, auditFailure };
    }
    const result = await sendDelivery({
      delivery,
      secrets,
      text,
      signal: this.stopController.signal,
      ...(this.deps.deliveryFetch ? { fetch: this.deps.deliveryFetch } : {}),
      ...(this.deps.deliveryTimeoutMs !== undefined ? { timeoutMs: this.deps.deliveryTimeoutMs } : {}),
    });
    let auditFailure: SandboxRefusal | undefined;
    try {
      this.auditEvent(context, "delivery.result", { connector: delivery.connector, payloadDigest: digest, idempotencyKey, outcome: result.outcome });
    } catch (error) {
      auditFailure = isSandboxRefusal(error) ? error : new SandboxRefusal("audit-failed", describe(error), { cause: error });
      this.log("error", auditFailure.message, { agent: agentConfig.id, reason: "audit-failed" });
    }
    this.safeHealth(agentConfig.id, { lastDelivery: { runId: idempotencyKey, outcome: result.outcome, detail: result.detail, at: this.now().toISOString() } });
    this.log(result.outcome === "sent" ? "info" : "warn", result.outcome === "sent" ? "Report delivered." : "Report not delivered.", {
      agent: agentConfig.id,
      connector: delivery.connector,
      reason: result.outcome === "sent" ? undefined : "delivery-failed",
    });
    return { ...result, ...(auditFailure ? { auditFailure } : {}) };
  }

  private async refuse(agentConfig: SandboxAgentConfig, context: SandboxAuditContext, refusal: SandboxRefusal, secrets: SandboxSecrets): Promise<RunOutcome> {
    const at = this.now().toISOString();
    this.log("error", refusal.message, { agent: agentConfig.id, reason: refusal.reason });
    this.safeHealth(agentConfig.id, { lastRefusal: { reason: refusal.reason, message: refusal.message, at } });
    if (refusal.reason !== "audit-failed") {
      try {
        this.auditEvent(context, "sandbox.run.refused", { reason: refusal.reason });
      } catch (error) {
        this.log("error", describe(error), { agent: agentConfig.id, reason: "audit-failed" });
      }
    }
    await this.sendNotice(agentConfig, context, refusal.reason, secrets);
    return { kind: "refused", reason: refusal.reason, message: refusal.message };
  }

  /**
   * Failure notices, metadata only: one when the reason differs from the
   * last notice for this agent, and one when runs complete again. The
   * last reason noticed is kept in health.json, so a restart does not
   * repeat a notice.
   */
  private async sendNotice(agentConfig: SandboxAgentConfig, context: SandboxAuditContext, reason: string | undefined, secrets: SandboxSecrets): Promise<void> {
    const delivery = agentConfig.delivery;
    if (!delivery?.failureNotice) return;
    const previous = this.health.get(agentConfig.id).lastNoticeReason;
    if (reason === previous) return;
    if (!secrets.slack && !secrets.discord) {
      // A refusal before the preflight reached the secrets still gets its notice.
      try {
        secrets = loadSandboxSecrets(this.config.secretsPath, new Set([delivery.connector]));
      } catch (error) {
        this.log("error", `Failure notice not sent: ${describe(error)}`, { agent: agentConfig.id, reason: isSandboxRefusal(error) ? error.reason : "delivery-failed" });
        return;
      }
    }
    const at = this.now().toISOString();
    const text = reason === undefined
      ? renderRecoveryNotice({ agentId: agentConfig.id, sandboxName: this.config.sandbox.name, at })
      : renderFailureNotice({ agentId: agentConfig.id, sandboxName: this.config.sandbox.name, reason, at });
    const result = await this.send(agentConfig, context, `notice:${agentConfig.id}:${at}`, delivery, secrets, text);
    if (result.outcome === "sent") this.safeHealth(agentConfig.id, { lastNoticeReason: reason });
  }

  /** health.json is a convenience for the admin; a failed write is logged and the run goes on. */
  private safeHealth(agentId: string, change: Parameters<HealthStore["update"]>[1]): void {
    try {
      this.health.update(agentId, change, this.now());
    } catch (error) {
      this.log("error", `health.json could not be written: ${describe(error)}`, { agent: agentId, reason: "storage-failed" });
    }
  }

  private lastStartedAt(agentId: string): number | undefined {
    const latest = this.runs.latest(agentId);
    const refusal = this.health.get(agentId).lastRefusal;
    const times = [latest?.queuedAt, refusal?.at].filter((value): value is string => typeof value === "string").map((value) => Date.parse(value)).filter(Number.isFinite);
    return times.length > 0 ? Math.max(...times) : undefined;
  }
}

interface TokenAudit {
  context: SandboxAuditContext;
  /** The audit log could not record a sign-in failure. */
  auditProblem?: SandboxRefusal;
}

interface Prepared {
  resolved: SandboxAgent;
  model: ModelCheck;
  tokenProvider: ApplicationTokenProvider;
  token: ApplicationToken;
  tokenAudit: TokenAudit;
}

/**
 * The named refusal for a failed sign-in, by its AADSTS code. When the
 * audit log could not record that failure either, the message says so,
 * so the admin learns both.
 */
function signInFailure(error: unknown, tokenAudit: TokenAudit): SandboxRefusal {
  let refusal: SandboxRefusal;
  if (isSandboxRefusal(error)) refusal = error;
  else if (error instanceof ApplicationTokenError && error.code === "token-undecodable") {
    refusal = new SandboxRefusal("token-undecodable", "The token from Microsoft sign-in cannot be decoded, so its permissions cannot be checked. Nothing was read.");
  } else if (error instanceof ApplicationTokenError) refusal = signInRefusal(error.aadsts, error.message);
  else refusal = signInRefusal(undefined, describe(error));
  const problem = tokenAudit.auditProblem;
  if (!problem || refusal.reason === "audit-failed") return refusal;
  tokenAudit.auditProblem = undefined;
  return new SandboxRefusal(refusal.reason, `${refusal.message} The audit log could not record this sign-in failure either: ${problem.message}`, { cause: problem });
}

/** The named reason of a run that failed without the sandbox stopping it. */
function failureReason(run: RunRecord, statuses: readonly number[], modelFailure: string | undefined): SandboxRefusal {
  const error = run.error ?? "";
  if (modelFailure === "model-timeout") {
    return new SandboxRefusal("model-timeout", "The local model did not answer in time. Check the load on this machine, use a smaller model, or raise model.timeoutSeconds.");
  }
  // The first fatal status names the failure; a later one is usually its consequence.
  const last = statuses.find((status) => status === 401 || status === 403) ?? (statuses.includes(429) ? 429 : undefined);
  if (last === 401) {
    return new SandboxRefusal("graph-unauthorized", "Microsoft Graph refused the sandbox token (HTTP 401). For Intune this also means the app lacks the permission the request needs. Check the granted permissions and admin consent.");
  }
  if (last === 403 || run.accessDenial) {
    return new SandboxRefusal("graph-forbidden", "Microsoft Graph denied a read (HTTP 403). Grant the Read permission the agent declares, with admin consent, then run again.");
  }
  if (last === 429) {
    return new SandboxRefusal("graph-throttled", "Microsoft Graph kept throttling the sandbox (HTTP 429) after the waits it asked for. The next scheduled run tries again.");
  }
  return new SandboxRefusal("run-failed", `The agent failed: ${error.slice(0, 300) || "no error was recorded."}`);
}

const FILESYSTEM_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EDQUOT", "EIO", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EMFILE", "ENFILE", "EBUSY"]);

function isFilesystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && FILESYSTEM_CODES.has(code);
}

/** Passes every model call through and reports the typed code of a model failure. */
function recordModelFailures(llm: RunLlmApi, report: (code: string) => void): RunLlmApi {
  const note = (error: unknown) => {
    const code = llmErrorCode(error);
    if (code) report(code);
  };
  return {
    available: llm.available,
    ...(llm.defaultModel !== undefined ? { defaultModel: llm.defaultModel } : {}),
    ...(llm.streamsIncrementally !== undefined ? { streamsIncrementally: llm.streamsIncrementally } : {}),
    async complete(options: LlmOptions) {
      try {
        return await llm.complete(options);
      } catch (error) {
        note(error);
        throw error;
      }
    },
    async *stream(options: LlmOptions) {
      try {
        yield* llm.stream(options);
      } catch (error) {
        note(error);
        throw error;
      }
    },
  };
}
