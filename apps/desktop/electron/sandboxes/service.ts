// The desktop side of sandbox pairing and sync. This code holds the keys
// and verifies everything a sandbox sends, so it is public; the optional
// team features module only decides when to call it (through the
// `sandboxes` capability of the extension point) and draws the UI.
//
// Nothing here runs on its own. There is no timer and no listener: without
// a paired sandbox and a call, no connection is opened. Sync, assignments
// and status run under the organization's tenant lease, so Disconnect
// stops them and waits for them.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { RunAttestation, RunRecord, SecretAccessor } from "@openadminos/agent-sdk";
import type {
  EnterpriseOrganization,
  EnterpriseReadOnlyAgent,
  EnterpriseResult,
  EnterpriseSandbox,
  EnterpriseSandboxAssignmentEntry,
  EnterpriseSandboxAssignResult,
  EnterpriseSandboxes,
  EnterpriseSandboxPairInput,
  EnterpriseSandboxRemoteStatus,
  EnterpriseSandboxStatus,
  EnterpriseSandboxSyncResult,
  EnterpriseSandboxUnpairResult,
} from "@openadminos/enterprise";
import {
  createTlsCertificate,
  DesktopPairingSession,
  deviceFingerprint,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  formatSandboxAddress,
  generateDeviceIdentity,
  importDevicePrivateKey,
  importDevicePublicKey,
  isPrivateAddress,
  PairingError,
  pairingCodeMatchesSpki,
  parsePairingCode,
  parseSandboxAddress,
  runRecordDigest,
  signScheduleAssignment,
  tlsSpkiSha256,
  verifyAuditCheckpoint,
  verifyPairingRecord,
  verifySignedContinuation,
  type DeviceIdentity,
  type PairingCode,
  type PairingRecord,
  type SandboxAddress,
} from "@openadminos/pairing";
import type { AuditLogEventSeed, AuditLogRangeRow } from "@openadminos/runtime";

import { TenantClosedError } from "../tenant-lifecycle.js";
import { AuditSeqConflictError, SandboxAuditStore, SandboxStateError, SandboxStateStore, type StoredSandbox, type UnverifiedRun } from "./store.js";
import { SandboxTransportError, tlsSandboxTransport, type ClientCredentials, type SandboxReply, type SandboxTransport } from "./transport.js";

/** The secret store key of the desktop's sandbox identity: one bundle, so it is never half written. */
export const SANDBOX_IDENTITY_SECRET = "sandbox-identity";

/** Bounds of one sync call; what is left is read by the next sync. */
export const SYNC_LIMITS = Object.freeze({
  runs: 500,
  runBytes: 64 * 1024 * 1024,
  auditBatches: 50,
  problems: 20,
});
export type SyncLimits = { readonly [K in keyof typeof SYNC_LIMITS]: number };
const RUNS_PAGE = 100;
const AUDIT_BATCH = 500;
const UNVERIFIED_RECHECK = 500;
const MIN_INTERVAL_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 31 * 86_400;
const MAX_MESSAGE = 300;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The sandbox host's own rule for sandbox ids. */
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STEP_STATUSES = new Set(["pending", "running", "completed", "failed", "skipped", "cancelled"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Bounds on what one imported run may hold. */
const RUN_LIMITS = Object.freeze({
  steps: 500,
  logs: 2000,
  short: 200,
  text: 8 * 1024,
  summary: 64 * 1024,
  resultBytes: 512 * 1024,
  metadataBytes: 4 * 1024,
});

/**
 * Integrity failures stop sync and stay the sandbox's state until it is
 * paired again. The chain and checkpoint names are those of
 * `verifySignedContinuation`.
 */
export type SandboxIntegrityFailure =
  | "chain-gap"
  | "chain-fork"
  | "chain-rollback"
  | "chain-row-invalid"
  | "chain-position-invalid"
  | "checkpoint-signature-invalid"
  | "checkpoint-pairing-mismatch"
  | "checkpoint-not-reached"
  | "expectation-invalid"
  | "audit-position-unknown"
  | "binding-mismatch"
  | "tls-pin-changed"
  | "sandbox-unpaired";

/** Why an imported run is not verified. */
export type UnverifiedReason = "no-verified-event" | "digest-mismatch" | "status-mismatch" | "agent-mismatch";

export interface SandboxTenantLease {
  readonly signal: AbortSignal;
}

/**
 * A run imported unverified that the verified audit rows now cover. It is
 * attested only when the run in history is still the record imported then:
 * same binding, agent and status, and `storedDigest` equal to the digest
 * of the stored record.
 */
export interface SandboxRunAttestation {
  runId: string;
  sandboxId: string;
  organizationId: string;
  tenantId: string;
  pairingKeyFingerprint: string;
  agentSlug: string;
  status: string;
  storedDigest: string;
  attestedBy: RunAttestation;
}

export interface SandboxServiceOptions {
  /** `<userData>/sandboxes`. */
  rootDir: string;
  /** The desktop's device key and TLS client certificate, one bundle. */
  secrets: SecretAccessor;
  /** Organizations whose Microsoft 365 tenant is connected now. */
  organizations(): Promise<readonly EnterpriseOrganization[]>;
  /** Bundled read-only agents with their manifest hashes. */
  catalog(): Promise<readonly EnterpriseReadOnlyAgent[]>;
  /**
   * Runs work under the tenant's lifecycle lease. It refuses when the
   * tenant is not open (TenantClosedError), and Disconnect aborts the
   * lease's signal and waits for the work.
   */
  withTenantLease<T>(tenantId: string, work: (lease: SandboxTenantLease) => Promise<T>): Promise<T>;
  /**
   * Adds sandbox runs to run history and returns the ids it wrote (added
   * or replaced). Called inside the lease; it checks again that the
   * organization is connected and the lease current before it writes.
   */
  importRuns(runs: readonly RunRecord[]): Promise<readonly string[]>;
  /** Sets the attestation of runs imported unverified; returns how many it set. */
  attestRuns(entries: readonly SandboxRunAttestation[]): Promise<number>;
  /** Appends to the desktop's audit log; throws when it cannot. */
  recordAudit(events: readonly AuditLogEventSeed[]): void;
  /** Raw failure detail for the app log; never shown to the module. */
  log?: (message: string, fields: Record<string, string>) => void;
  now?: () => Date;
  transport?: SandboxTransport;
  /** The verified audit store; `<rootDir>/audit.db` when left out. */
  auditStore?: () => SandboxAuditStore;
  /** Tighter sync bounds, for tests. */
  limits?: Partial<SyncLimits>;
}

/** Ends an operation with a named error for the caller. */
class Refusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SandboxRefusal";
  }
}

/** An integrity failure: stops sync and is kept as the sandbox's state. */
class IntegrityStop extends Error {
  constructor(readonly code: SandboxIntegrityFailure, message: string) {
    super(message);
    this.name = "SandboxIntegrityStop";
  }
}

interface Credentials {
  identity: DeviceIdentity;
  tls: ClientCredentials & { pin: string };
}

interface IdentityBundle {
  version: 1;
  identityPem: string;
  tlsKeyPem: string;
  tlsCertificatePem: string;
}

/** Problems of one sync: at most `SYNC_LIMITS.problems` lines and a count of the rest. */
class Problems {
  private readonly lines: string[] = [];
  /** What a capped sync left for the next one; always listed, first. */
  private readonly notices = new Set<string>();
  private more = 0;
  constructor(private readonly max: number) {}
  push(line: string): void {
    if (this.lines.length + this.notices.size < this.max) this.lines.push(clip(line));
    else this.more += 1;
  }
  notice(line: string): void {
    this.notices.add(line);
  }
  list(): string[] {
    const lines = [...this.notices, ...this.lines].slice(0, this.max);
    const more = this.more + Math.max(0, this.notices.size + this.lines.length - this.max);
    return more > 0 ? [...lines, `${more} more not listed.`] : lines;
  }
}

interface SyncContext {
  sandbox: StoredSandbox;
  address: SandboxAddress;
  credentials: Credentials;
  signal: AbortSignal;
  problems: Problems;
  runsSeen: number;
  runBytes: number;
  auditBatches: number;
  auditRows: number;
  imported: number;
  verified: number;
  unverified: number;
  skipped: number;
}

const PAIR_AGAIN = "Unpair the sandbox here and on the sandbox (openadminos-sandbox --unpair), then pair it again with a new code.";
const DISCONNECTED = "The organization was disconnected while the sandbox request ran, so nothing more was taken. Connect it again, then try again.";

export class SandboxService implements EnterpriseSandboxes {
  private readonly state: SandboxStateStore;
  private readonly now: () => Date;
  private readonly transport: SandboxTransport;
  private readonly limits: SyncLimits;
  private audit: SandboxAuditStore | undefined;
  /** One operation at a time, so the state file is never written from two at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SandboxServiceOptions) {
    this.state = new SandboxStateStore(join(options.rootDir, "sandboxes.json"));
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? tlsSandboxTransport;
    this.limits = { ...SYNC_LIMITS, ...options.limits };
  }

  list(): Promise<readonly EnterpriseSandbox[]> {
    return this.serial(async () => {
      const sandboxes = await this.state.read();
      return sandboxes.map((sandbox) => this.summary(sandbox));
    });
  }

  pair(input: EnterpriseSandboxPairInput): Promise<EnterpriseResult<EnterpriseSandbox>> {
    return this.operation("pair", () => this.pairNow(input));
  }

  sync(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxSyncResult>> {
    return this.operation("sync", () => this.syncNow(sandboxId));
  }

  assign(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseResult<EnterpriseSandboxAssignResult>> {
    return this.operation("assign", () => this.assignNow(sandboxId, entries));
  }

  unpair(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxUnpairResult>> {
    return this.operation("unpair", () => this.unpairNow(sandboxId));
  }

  status(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxStatus>> {
    return this.operation("status", () => this.statusNow(sandboxId));
  }

  close(): void {
    this.audit?.close();
    this.audit = undefined;
  }

  // ---- pairing ----

  private async pairNow(input: EnterpriseSandboxPairInput): Promise<EnterpriseSandbox> {
    const address = parseSandboxAddress(input.address);
    if (!address || address.port === 0) {
      throw new Refusal("address-invalid", "Enter the sandbox's IP address and port, such as 100.64.0.10:7443 or [fd7a:115c:a1e0::10]:7443. Host names are not used.");
    }
    if (!isPrivateAddress(address.host)) {
      throw new Refusal("address-not-private", `${formatSandboxAddress(address)} is not a private address. A sandbox is paired only on loopback, a private network, link-local, a tailnet or fd00::/8.`);
    }
    const parsed = parsePairingCode(input.code);
    if (!parsed.ok) throw new Refusal("code-malformed", parsed.detail);
    const organization = (await this.options.organizations()).find((entry) => entry.id === input.organizationId);
    if (!organization) {
      throw new Refusal("organization-not-connected", "That organization is not connected in OpenAdminOS. Connect it, then pair the sandbox for it.");
    }
    const tenantId = organization.tenantId.toLowerCase();
    const where = formatSandboxAddress(address);

    // The probe carries no client certificate: the sandbox answers it before pairing.
    const hello = await this.request(address, undefined, (pin) => pairingCodeMatches(parsed.code, pin), "GET", "/v1/pair").catch((error: unknown) => {
      if (error instanceof SandboxTransportError && error.code === "tls-pin-mismatch") {
        throw new Refusal("fingerprint-mismatch", `The sandbox at ${where} presented a TLS key that is not the one the pairing code names. Check the code on the sandbox, and that the address is the sandbox's.`);
      }
      throw error;
    });
    const helloBody = sandboxBody(hello);
    const pin = hello.pin;
    const pairingId = text(helloBody.pairingId);
    const sandboxId = text(helloBody.sandboxId);
    const sandboxPublicKey = text(helloBody.sandboxPublicKey);
    if (!pairingId || !sandboxId || !sandboxPublicKey || helloBody.tlsSpkiSha256 !== pin) {
      throw new Refusal("pairing-reply-invalid", `The sandbox at ${where} answered the pairing request in a form this desktop does not read. Update the sandbox host to this release.`);
    }
    if (!SANDBOX_ID.test(sandboxId)) {
      throw new Refusal("sandbox-id-invalid", `The sandbox at ${where} names itself with an id the sandbox host does not allow. Update the sandbox host to this release.`);
    }
    // Sandboxes are kept by organization and sandbox id; one id belongs to one organization at a time.
    const stored = await this.state.read();
    const held = stored.find((entry) => entry.sandboxId === sandboxId);
    if (held && held.organizationId !== organization.id) {
      throw new Refusal("sandbox-paired-for-another-organization", `A sandbox named ${sandboxId} is paired with this desktop for another organization. Unpair it first, then pair again.`);
    }
    const credentials = await this.credentials(stored.filter((entry) => entry !== held).length === 0);
    const desktopPublicKey = exportDevicePublicKey(credentials.identity.publicKey);
    let session: DesktopPairingSession;
    try {
      session = await DesktopPairingSession.create(parsed.code, { pairingId, organizationId: organization.id, tenantId, sandboxPublicKey, desktopPublicKey, tlsSpkiSha256: pin });
    } catch (error) {
      if (error instanceof PairingError) throw new Refusal(error.reason, error.message);
      throw error;
    }
    const reply = sandboxBody(
      await this.request(address, credentials, (presented) => presented === pin, "POST", "/v1/pair", {
        pairingId,
        organizationId: organization.id,
        tenantId,
        desktopPublicKey,
        proof: session.desktopProof(),
      }),
    );
    const partial = `The sandbox may now count itself paired with this desktop. ${PAIR_AGAIN}`;
    if (!session.verifySandboxProof(reply.sandboxProof)) {
      throw new Refusal("sandbox-proof-invalid", `The sandbox did not prove that it knows the pairing code, so it was not paired. ${partial}`);
    }
    const record = verifyPairingRecord(reply.pairing, sandboxPublicKey);
    if (!record.ok) throw new Refusal("pairing-record-invalid", `The sandbox's signed pairing record does not verify: ${record.detail} ${partial}`);
    const value = record.value;
    if (
      value.pairingId !== pairingId ||
      value.sandboxId !== sandboxId ||
      value.sandboxPublicKey !== sandboxPublicKey ||
      value.tlsSpkiSha256 !== pin ||
      value.desktopPublicKey !== desktopPublicKey
    ) {
      throw new Refusal("pairing-record-invalid", `The sandbox's signed pairing record names other keys than the ones this pairing used. ${partial}`);
    }
    if (value.organizationId !== organization.id || value.tenantId !== tenantId) {
      throw new Refusal("binding-mismatch", `The sandbox is configured for another organization or tenant than ${organization.name}. ${partial}`);
    }
    const start = verifyAuditCheckpoint(reply.startCheckpoint, sandboxPublicKey);
    if (!start.ok || start.value.pairingId !== pairingId || start.value.sandboxId !== sandboxId) {
      throw new Refusal("checkpoint-signature-invalid", `The sandbox's first audit checkpoint does not verify for this pairing. ${partial}`);
    }

    const next: StoredSandbox = {
      sandboxId,
      name: value.sandboxName,
      address: where,
      organizationId: organization.id,
      tenantId,
      pairing: { record: value, signature: (reply.pairing as { signature: string }).signature },
      pairedAt: this.now().toISOString(),
      runCursor: { after: 0 },
      assignmentVersion: 0,
    };
    // State first, then the audit event that records it.
    this.withAuditStore((store) => {
      if (held) store.removePairing(held.pairing.record.pairingId);
      store.start(pairingId, { seq: start.value.seq, sha256: start.value.sha256 });
    });
    await this.state.write([...stored.filter((entry) => entry !== held), next]);
    this.record([
      this.event(next, `sandbox-pairing:${pairingId}:created`, "sandbox.pairing.created", {
        address: where,
        pairingKeyFingerprint: fingerprintOf(value),
        auditSeq: start.value.seq,
      }),
    ]);
    return this.summary(next);
  }

  // ---- sync ----

  private async syncNow(sandboxId: string): Promise<EnterpriseSandboxSyncResult> {
    const sandbox = await this.usable(sandboxId);
    const credentials = await this.credentials(false);
    return this.leased(sandbox, async (signal) => {
      const context: SyncContext = {
        sandbox,
        address: addressOf(sandbox),
        credentials,
        signal,
        problems: new Problems(this.limits.problems),
        runsSeen: 0,
        runBytes: 0,
        auditBatches: 0,
        auditRows: 0,
        imported: 0,
        verified: 0,
        unverified: 0,
        skipped: 0,
      };
      // Audit first, then each page of runs followed by the audit rows
      // written since: the sandbox records a run's finished event before
      // it writes the run, so rows read after a page cover its runs.
      await this.readAudit(context);
      await this.readRuns(context);
      await this.recheckUnverified(context);
      const lastSyncAt = this.now().toISOString();
      const next = await this.update(sandboxId, (entry) => ({ ...entry, lastSyncAt }));
      return {
        sandbox: this.summary(next),
        runsImported: context.imported,
        runsVerified: context.verified,
        runsUnverified: context.unverified,
        runsSkipped: context.skipped,
        auditRowsAccepted: context.auditRows,
        auditBatches: context.auditBatches,
        problems: context.problems.list(),
      };
    });
  }

  /** Reads verified audit batches until the sandbox has no more, or the per sync cap. */
  private async readAudit(context: SyncContext): Promise<void> {
    const { sandbox } = context;
    const record = sandbox.pairing.record;
    for (;;) {
      if (context.auditBatches >= this.limits.auditBatches) {
        context.problems.notice("More audit entries remain on the sandbox; sync again to read them.");
        return;
      }
      const pin = this.withAuditStore((store) => store.pin(record.pairingId));
      if (!pin) throw new Refusal("sandbox-audit-store-failed", `The desktop has no audit position for ${sandbox.name}. ${PAIR_AGAIN}`);
      const reply = await this.pinned(context, "GET", `/v1/audit?after=${pin.seq}&limit=${AUDIT_BATCH}`);
      if (reply.status === 409 && errorCode(reply.body) === "audit-position-unknown") {
        throw new IntegrityStop("audit-position-unknown", `The sandbox no longer holds the audit entries after ${pin.seq}, so what happened there cannot be checked. ${PAIR_AGAIN}`);
      }
      const body = sandboxBody(reply);
      const rows = Array.isArray(body.rows) ? (body.rows as AuditLogRangeRow[]) : undefined;
      if (!rows) throw new Refusal("sandbox-reply-invalid", "The sandbox sent audit rows in a form this desktop does not read.");
      const result = verifySignedContinuation(pin, rows, body.checkpoint, record.sandboxPublicKey, { pairingId: record.pairingId, sandboxId: record.sandboxId });
      if (!result.ok) throw new IntegrityStop(result.failure, `${result.detail} Sync is stopped for this sandbox. ${PAIR_AGAIN}`);
      if (rows.length === 0) return;
      // The desktop's event has a fixed id, so a batch accepted again after a crash records it once.
      this.record([
        this.event(sandbox, `sandbox-audit:${record.pairingId}:${result.pin.seq}`, "sandbox.audit.accepted", {
          fromSeq: rows[0]!.seq,
          toSeq: result.pin.seq,
          rows: rows.length,
          finalSha256: result.pin.sha256,
        }),
      ]);
      try {
        this.withAuditStore((store) => store.acceptBatch(record.pairingId, record.sandboxId, rows, result.pin, this.now().toISOString()));
      } catch (error) {
        if (error instanceof AuditSeqConflictError) throw new IntegrityStop("chain-fork", `${error.message} Sync is stopped for this sandbox. ${PAIR_AGAIN}`);
        throw error;
      }
      context.auditBatches += 1;
      context.auditRows += rows.length;
    }
  }

  /** Reads run pages after the cursor, importing and saving the cursor page by page. */
  private async readRuns(context: SyncContext): Promise<void> {
    const sandboxId = context.sandbox.sandboxId;
    let cursor = { ...context.sandbox.runCursor };
    let restarted = false;
    for (;;) {
      if (context.runsSeen >= this.limits.runs || context.runBytes >= this.limits.runBytes) {
        context.problems.notice("More runs remain on the sandbox; sync again to read them.");
        return;
      }
      const limit = Math.min(RUNS_PAGE, this.limits.runs - context.runsSeen);
      const body = sandboxBody(await this.pinned(context, "GET", `/v1/runs?after=${cursor.after}&limit=${limit}`));
      const generation = text(body.generation);
      const next = body.next;
      if (!generation || typeof next !== "number" || !Number.isSafeInteger(next) || next < 0 || !Array.isArray(body.runs)) {
        throw new Refusal("sandbox-reply-invalid", "The sandbox sent runs in a form this desktop does not read.");
      }
      const reset = isObject(body.condition) && body.condition.code === "cursor-reset" && cursor.resetSeen !== generation;
      const changed = cursor.generation !== undefined && cursor.generation !== generation;
      if ((changed || reset) && cursor.after !== 0) {
        // The cursor no longer means anything on the sandbox: read every run again from 0.
        if (restarted) throw new Refusal("cursor-unstable", "The sandbox's run cursors changed twice during one sync. Sync again.");
        restarted = true;
        cursor = reset ? { after: 0, generation, resetSeen: generation } : { after: 0, generation, ...(cursor.resetSeen ? { resetSeen: cursor.resetSeen } : {}) };
        continue;
      }
      if (reset) cursor.resetSeen = generation;
      cursor.generation = generation;
      for (const problem of Array.isArray(body.problems) ? body.problems : []) {
        if (isObject(problem)) context.problems.push(`Run ${clipId(text(problem.runId))} could not be read on the sandbox: ${text(problem.message) ?? "no reason given"}`);
      }

      const page: Array<{ run: RunRecord; digest: string }> = [];
      // The cursor of the last run taken; a truncated page resumes after it.
      let pageEnd = cursor.after;
      let truncated = false;
      for (const entry of body.runs) {
        if (!isObject(entry)) continue;
        const bytes = Buffer.byteLength(JSON.stringify(entry.run ?? null), "utf8");
        if (context.runBytes + bytes > this.limits.runBytes && context.runsSeen > 0) {
          // Stop before this run; the next sync starts with it.
          truncated = true;
          break;
        }
        context.runBytes += bytes;
        context.runsSeen += 1;
        if (typeof entry.cursor === "number" && Number.isSafeInteger(entry.cursor)) pageEnd = entry.cursor;
        const checked = sandboxRun(entry.run, context.sandbox);
        if (checked.kind === "run") page.push(checked);
        else {
          context.skipped += 1;
          if (checked.kind === "problem") context.problems.push(checked.message);
        }
      }

      await this.readAudit(context);
      await this.importPage(context, page);
      const after = truncated ? pageEnd : next;
      const moved = after !== cursor.after;
      cursor = { ...cursor, after };
      const saved = { ...cursor };
      await this.update(sandboxId, (entry) => ({ ...entry, runCursor: saved }));
      if (truncated) {
        context.problems.notice("More runs remain on the sandbox; sync again to read them.");
        return;
      }
      if (!moved) return;
    }
  }

  /** Verifies each run of a page against the newest verified event for it, then imports the page. */
  private async importPage(context: SyncContext, page: ReadonlyArray<{ run: RunRecord; digest: string }>): Promise<void> {
    if (page.length === 0) return;
    const record = context.sandbox.pairing.record;
    const runs: RunRecord[] = [];
    const pending = new Map<string, UnverifiedRun>();
    const reasons = new Map<string, UnverifiedReason | undefined>();
    for (const { run, digest } of page) {
      const check = this.verifyRun(record, { runId: run.id, digest, storedDigest: "", agentSlug: run.agentSlug, status: run.status });
      if (check.attestedBy) {
        runs.push({ ...run, attestedBy: check.attestedBy });
      } else {
        runs.push(run);
        // The digest of the record as it will be stored, so a later attestation applies to this record only.
        pending.set(run.id, { runId: run.id, digest, storedDigest: runRecordDigest(run), agentSlug: run.agentSlug, status: run.status });
        reasons.set(run.id, check.reason);
      }
    }
    if (context.signal.aborted) throw new TenantClosedError(context.sandbox.tenantId, "sandbox sync");
    const written = new Set(await this.options.importRuns(runs));
    context.imported += written.size;
    context.skipped += runs.length - written.size;
    // Only what was written is counted and tracked: a skipped record is not the one in history.
    this.withAuditStore((store) => {
      for (const run of runs) {
        if (!written.has(run.id)) continue;
        const entry = pending.get(run.id);
        if (entry) {
          context.unverified += 1;
          context.problems.push(`Run ${clipId(run.id)} was imported unverified: ${unverifiedText(reasons.get(run.id))}`);
          store.addUnverified(record.pairingId, entry);
        } else {
          context.verified += 1;
          store.removeUnverified(record.pairingId, run.id);
        }
      }
    });
  }

  /** Runs imported unverified that the audit rows verified since: they get their attestation now. */
  private async recheckUnverified(context: SyncContext): Promise<void> {
    const record = context.sandbox.pairing.record;
    const waiting = this.withAuditStore((store) => store.listUnverified(record.pairingId, UNVERIFIED_RECHECK));
    const attestations: SandboxRunAttestation[] = [];
    for (const entry of waiting) {
      const check = this.verifyRun(record, entry);
      if (!check.attestedBy) continue;
      attestations.push({
        runId: entry.runId,
        sandboxId: context.sandbox.sandboxId,
        organizationId: context.sandbox.organizationId,
        tenantId: context.sandbox.tenantId,
        pairingKeyFingerprint: fingerprintOf(record),
        agentSlug: entry.agentSlug,
        status: entry.status,
        storedDigest: entry.storedDigest,
        attestedBy: check.attestedBy,
      });
    }
    if (attestations.length === 0) return;
    if (context.signal.aborted) throw new TenantClosedError(context.sandbox.tenantId, "sandbox sync");
    const set = await this.options.attestRuns(attestations);
    context.verified += set;
    this.withAuditStore((store) => {
      for (const entry of attestations) store.removeUnverified(record.pairingId, entry.runId);
    });
  }

  /** Verified only when the newest verified event for the run names its agent, status and digest. */
  private verifyRun(record: PairingRecord, run: UnverifiedRun): { attestedBy?: RunAttestation; reason?: UnverifiedReason } {
    const event = this.withAuditStore((store) => store.latestRunEvent(record.pairingId, run.runId));
    if (!event) return { reason: "no-verified-event" };
    if (event.agentSlug !== run.agentSlug) return { reason: "agent-mismatch" };
    if (event.status !== run.status) return { reason: "status-mismatch" };
    if (event.runDigest !== run.digest) return { reason: "digest-mismatch" };
    return {
      attestedBy: { sandboxId: record.sandboxId, pairingKeyFingerprint: fingerprintOf(record), checkpointSeq: event.checkpointSeq, verifiedAt: event.verifiedAt },
    };
  }

  // ---- assignments ----

  private async assignNow(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseSandboxAssignResult> {
    const sandbox = await this.usable(sandboxId);
    const catalog = new Map((await this.options.catalog()).map((agent) => [agent.id, agent]));
    const seen = new Set<string>();
    const signedEntries = entries.map((entry) => {
      if (seen.has(entry.agentId)) throw new Refusal("assignment-duplicate-agent", `${clipId(entry.agentId)} is listed twice; assign each agent once.`);
      seen.add(entry.agentId);
      const agent = catalog.get(entry.agentId);
      if (!agent) {
        throw new Refusal("agent-not-read-only", `${clipId(entry.agentId)} is not a bundled read-only agent. A sandbox runs read-only agents only; changes stay on the desktop with diff confirmation.`);
      }
      if (!Number.isSafeInteger(entry.intervalSeconds) || entry.intervalSeconds < MIN_INTERVAL_SECONDS || entry.intervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Refusal("assignment-interval-invalid", `The interval for ${clipId(entry.agentId)} is ${entry.intervalSeconds} seconds; it is 15 minutes to 31 days.`);
      }
      return { agentId: agent.id, templateSha256: agent.manifestSha256, intervalSeconds: entry.intervalSeconds };
    });
    const credentials = await this.credentials(false);
    return this.leased(sandbox, async (signal) => {
      const context = { sandbox, address: addressOf(sandbox), credentials, signal };
      const record = sandbox.pairing.record;
      let floor = sandbox.assignmentVersion;
      if (sandbox.assignmentPending !== undefined) {
        // The last outcome is not known: ask the sandbox which version it holds.
        const status = sandboxBody(await this.pinned(context, "GET", "/v1/status"));
        const held = typeof status.assignmentVersion === "number" && Number.isSafeInteger(status.assignmentVersion) ? status.assignmentVersion : 0;
        floor = Math.max(floor, held);
      }
      const version = floor + 1;
      // Reserved before it is sent, so a lost answer never leads to the same version twice.
      await this.update(sandboxId, (entry) => ({ ...entry, assignmentVersion: version, assignmentPending: version }));
      const signed = signScheduleAssignment(
        { pairingId: record.pairingId, version, organizationId: record.organizationId, tenantId: record.tenantId, entries: signedEntries, issuedAt: this.now().toISOString() },
        credentials.identity.privateKey,
      );
      let reply: SandboxReply;
      try {
        reply = await this.pinned(context, "PUT", "/v1/assignments", signed);
      } catch (error) {
        if (error instanceof Refusal && (error.code === "sandbox-unreachable" || error.code === "reply-invalid")) {
          throw new Refusal("assignment-outcome-unknown", `The assignment was sent, but no answer came back, so it is not known whether ${sandbox.name} took it. Assign again; the desktop then checks which version the sandbox holds.`);
        }
        throw error;
      }
      if (reply.status >= 500) {
        throw new Refusal("assignment-outcome-unknown", `${sandbox.name} could not answer the assignment. Assign again; the desktop then checks which version the sandbox holds.`);
      }
      // A named refusal means the sandbox did not take it.
      await this.update(sandboxId, (entry) => {
        const { assignmentPending: _pending, ...rest } = entry;
        return rest;
      });
      const body = sandboxBody(reply);
      const result: EnterpriseSandboxAssignResult = {
        version,
        assigned: strings(body.assigned),
        shadowed: strings(body.shadowed),
        rolesNoLongerNeeded: strings(body.rolesNoLongerNeeded),
        ...(text(body.notice) ? { notice: clip(text(body.notice)!) } : {}),
      };
      this.record([
        this.event(sandbox, `sandbox-assignment:${record.pairingId}:${version}`, "sandbox.assignment.sent", {
          version,
          agents: signedEntries.map((entry) => entry.agentId),
          rolesNoLongerNeeded: [...result.rolesNoLongerNeeded],
        }),
      ]);
      return result;
    });
  }

  // ---- unpairing and status ----

  private async unpairNow(sandboxId: string): Promise<EnterpriseSandboxUnpairResult> {
    const sandbox = await this.find(sandboxId);
    let confirmed = false;
    let roles: string[] = [];
    let reason = "";
    const credentials = await this.credentials(false).catch(() => undefined);
    if (credentials) {
      try {
        const reply = await this.request(addressOf(sandbox), credentials, (pin) => pin === sandbox.pairing.record.tlsSpkiSha256, "DELETE", "/v1/pairing");
        if (reply.status === 200 && isObject(reply.body)) {
          confirmed = true;
          roles = strings(reply.body.rolesNoLongerNeeded);
        } else {
          reason = clip(errorMessage(reply.body) ?? `The sandbox answered ${reply.status}.`);
        }
      } catch (error) {
        reason = error instanceof SandboxTransportError && error.code === "tls-pin-mismatch"
          ? "The sandbox presented another TLS key than the one paired, so it was not asked."
          : clip((error as Error).message);
      }
    } else {
      reason = "This desktop's sandbox key is gone, so the sandbox cannot be asked.";
    }
    await this.state.write((await this.state.read()).filter((entry) => entry.sandboxId !== sandboxId));
    // The verified rows of this pairing go with it; imported runs keep their attestation.
    this.withAuditStore((store) => store.removePairing(sandbox.pairing.record.pairingId));
    this.record([
      this.event(sandbox, `sandbox-pairing:${sandbox.pairing.record.pairingId}:removed`, "sandbox.pairing.removed", { sandboxConfirmed: confirmed, rolesNoLongerNeeded: roles }),
    ]);
    const roleNote = roles.length > 0 ? ` Remove ${roles.join(", ")} from the sandbox app registration: only the assigned agents needed them.` : "";
    return {
      sandboxId,
      sandboxConfirmed: confirmed,
      rolesNoLongerNeeded: roles,
      message: confirmed
        ? `Unpaired from ${sandbox.name}. Its assigned schedules were removed; its config schedules keep running.${roleNote}`
        : `Unpaired on this desktop. ${reason} Run openadminos-sandbox --unpair on the sandbox to remove the pairing there.`,
    };
  }

  private async statusNow(sandboxId: string): Promise<EnterpriseSandboxStatus> {
    const sandbox = await this.find(sandboxId);
    if (sandbox.failure) return { sandbox: this.summary(sandbox) };
    await this.connectedOrganization(sandbox);
    const credentials = await this.credentials(false);
    return this.leased(sandbox, async (signal) => {
      const body = sandboxBody(await this.pinned({ sandbox, address: addressOf(sandbox), credentials, signal }, "GET", "/v1/status"));
      return { sandbox: this.summary(sandbox), remote: remoteStatus(body) };
    });
  }

  // ---- helpers ----

  /**
   * Runs work under the tenant lease of the sandbox's organization. An
   * integrity failure inside is kept as the sandbox's state; Disconnect,
   * or a lease that closed, ends it with organization-disconnected.
   */
  private async leased<T>(sandbox: StoredSandbox, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let signal: AbortSignal | undefined;
    try {
      return await this.options.withTenantLease(sandbox.tenantId, (lease) => {
        signal = lease.signal;
        return work(lease.signal);
      });
    } catch (error) {
      if (error instanceof IntegrityStop) {
        await this.stop(sandbox, error);
        throw error;
      }
      if (error instanceof TenantClosedError || signal?.aborted) {
        if (!signal) throw new Refusal("organization-not-connected", `The organization ${sandbox.name} is paired for is not connected in OpenAdminOS. Connect it again, then try again.`);
        throw new Refusal("organization-disconnected", DISCONNECTED);
      }
      throw error;
    }
  }

  /** A paired sandbox whose sync is not stopped, for a connected organization. */
  private async usable(sandboxId: string): Promise<StoredSandbox> {
    const sandbox = await this.find(sandboxId);
    if (sandbox.failure) {
      throw new Refusal(sandbox.failure.code, `Sync is stopped for ${sandbox.name}: ${sandbox.failure.message}`);
    }
    await this.connectedOrganization(sandbox);
    return sandbox;
  }

  private async find(sandboxId: string): Promise<StoredSandbox> {
    const sandbox = (await this.state.read()).find((entry) => entry.sandboxId === sandboxId);
    if (!sandbox) throw new Refusal("sandbox-not-paired", `No sandbox ${clipId(sandboxId)} is paired with this desktop.`);
    return sandbox;
  }

  /**
   * Hard constraint: a sandbox of an organization that is not connected is
   * not contacted. The organization need not be the active one: a sandbox
   * runs while another organization is active, and each call names its own.
   */
  private async connectedOrganization(sandbox: StoredSandbox): Promise<void> {
    const organization = (await this.options.organizations()).find((entry) => entry.id === sandbox.organizationId);
    if (!organization || organization.tenantId.toLowerCase() !== sandbox.tenantId) {
      throw new Refusal("organization-not-connected", `The organization ${sandbox.name} is paired for is not connected in OpenAdminOS. Connect it again, then sync.`);
    }
  }

  /** A request to a paired sandbox: the pin must be the paired one, and pairing answers become integrity stops. */
  private async pinned(
    context: { sandbox: StoredSandbox; address: SandboxAddress; credentials: Credentials; signal: AbortSignal },
    method: "GET" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<SandboxReply> {
    const { sandbox } = context;
    let reply: SandboxReply;
    try {
      reply = await this.request(context.address, context.credentials, (pin) => pin === sandbox.pairing.record.tlsSpkiSha256, method, path, body, context.signal);
    } catch (error) {
      if (error instanceof SandboxTransportError && error.code === "tls-pin-mismatch") {
        throw new IntegrityStop("tls-pin-changed", `The sandbox at ${sandbox.address} presented another TLS key than the one paired (paired pin ${sandbox.pairing.record.tlsSpkiSha256}, now ${error.pin || "none"}). ${PAIR_AGAIN}`);
      }
      throw error;
    }
    const code = errorCode(reply.body);
    if (code === "pairing-binding-changed") {
      throw new IntegrityStop("binding-mismatch", `The sandbox's config now names another organization or tenant than the one paired. ${PAIR_AGAIN}`);
    }
    if (code === "client-not-paired" || code === "not-paired") {
      throw new IntegrityStop("sandbox-unpaired", `The sandbox is no longer paired with this desktop. ${PAIR_AGAIN}`);
    }
    return reply;
  }

  private async request(
    address: SandboxAddress,
    credentials: Credentials | undefined,
    acceptPin: (pin: string) => boolean,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<SandboxReply> {
    try {
      return await this.transport({
        address,
        ...(credentials ? { credentials: credentials.tls } : {}),
        acceptPin,
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof SandboxTransportError && error.code === "aborted") throw new Refusal("organization-disconnected", DISCONNECTED);
      if (error instanceof SandboxTransportError && error.code !== "tls-pin-mismatch") throw new Refusal(error.code === "unreachable" ? "sandbox-unreachable" : error.code, error.message);
      throw error;
    }
  }

  private async stop(sandbox: StoredSandbox, stop: IntegrityStop): Promise<void> {
    const failure = { code: stop.code, message: clip(stop.message), at: this.now().toISOString() };
    await this.update(sandbox.sandboxId, (entry) => ({ ...entry, failure }));
    try {
      this.options.recordAudit([
        this.event(sandbox, `sandbox-sync:${sandbox.pairing.record.pairingId}:stopped:${randomUUID()}`, "sandbox.sync.stopped", { reason: stop.code }),
      ]);
    } catch (error) {
      // The failure is kept in the sandbox's state either way.
      this.log("the desktop audit log could not record a stopped sync", error);
    }
  }

  private async update(sandboxId: string, change: (entry: StoredSandbox) => StoredSandbox): Promise<StoredSandbox> {
    const all = await this.state.read();
    const index = all.findIndex((entry) => entry.sandboxId === sandboxId);
    if (index < 0) throw new Refusal("sandbox-not-paired", `No sandbox ${clipId(sandboxId)} is paired with this desktop.`);
    const next = change(all[index]!);
    all[index] = next;
    await this.state.write(all);
    return next;
  }

  /** Runs a call on the verified audit store; a storage failure becomes a named error. */
  private withAuditStore<T>(call: (store: SandboxAuditStore) => T): T {
    try {
      if (!this.audit) {
        if (this.options.auditStore) {
          this.audit = this.options.auditStore();
        } else {
          mkdirSync(this.options.rootDir, { recursive: true, mode: 0o700 });
          chmodSync(this.options.rootDir, 0o700);
          this.audit = new SandboxAuditStore(join(this.options.rootDir, "audit.db"));
        }
      }
      return call(this.audit);
    } catch (error) {
      if (error instanceof Refusal || error instanceof IntegrityStop || error instanceof AuditSeqConflictError) throw error;
      this.log("the sandbox audit store failed", error);
      throw new Refusal("sandbox-audit-store-failed", "The desktop's record of verified sandbox audit entries could not be read or written. Check free disk space and the permissions of the OpenAdminOS data folder, then try again.");
    }
  }

  private record(events: readonly AuditLogEventSeed[]): void {
    try {
      this.options.recordAudit(events);
    } catch (error) {
      this.log("the desktop audit log could not record a sandbox event", error);
      throw new Refusal("audit-log-failed", "The desktop's audit log could not record this, so it was not done. Check free disk space and the permissions of the OpenAdminOS data folder, then try again.");
    }
  }

  /**
   * The desktop's device key and TLS client certificate, one bundle in the
   * secret store. A new one is made only while no sandbox is paired;
   * otherwise a missing key is refused, because the paired sandboxes know
   * only the old one.
   */
  private async credentials(mayCreate: boolean): Promise<Credentials> {
    let text: string | undefined;
    try {
      text = await this.options.secrets.get(SANDBOX_IDENTITY_SECRET);
    } catch (error) {
      this.log("the sandbox identity could not be read from the secret store", error);
      throw new Refusal("keychain-unavailable", "The system keychain did not answer, so the desktop's sandbox key cannot be read. Unlock the keychain, or check that secure storage is available, then try again.");
    }
    const bundle = parseBundle(text);
    if (bundle) {
      return { identity: importDevicePrivateKey(bundle.identityPem), tls: { keyPem: bundle.tlsKeyPem, certificatePem: bundle.tlsCertificatePem, pin: tlsSpkiSha256(bundle.tlsCertificatePem) } };
    }
    if (!mayCreate) {
      throw new Refusal("desktop-identity-missing", `This desktop's sandbox key is gone from the system keychain, so paired sandboxes no longer know it. ${PAIR_AGAIN}`);
    }
    const identity = generateDeviceIdentity();
    // Sandboxes trust the key by its pin, not the certificate dates.
    const tls = createTlsCertificate({ commonName: "openadminos-desktop", validityDays: 3650 });
    const next: IdentityBundle = { version: 1, identityPem: exportDevicePrivateKey(identity), tlsKeyPem: tls.privateKeyPem, tlsCertificatePem: tls.certificatePem };
    try {
      await this.options.secrets.set(SANDBOX_IDENTITY_SECRET, JSON.stringify(next));
    } catch (error) {
      this.log("the sandbox identity could not be written to the secret store", error);
      throw new Refusal("keychain-unavailable", "The system keychain did not take the desktop's sandbox key. Unlock the keychain, or check that secure storage is available, then pair again.");
    }
    return { identity, tls: { keyPem: tls.privateKeyPem, certificatePem: tls.certificatePem, pin: tls.spkiSha256 } };
  }

  private summary(sandbox: StoredSandbox): EnterpriseSandbox {
    const pin = this.withAuditStore((store) => store.pin(sandbox.pairing.record.pairingId));
    return summary(sandbox, pin?.seq ?? 0);
  }

  private event(sandbox: StoredSandbox, id: string, type: string, details: Record<string, unknown>): AuditLogEventSeed {
    return {
      id,
      timestamp: this.now().toISOString(),
      type,
      source: "sandbox-link",
      tenantId: sandbox.tenantId,
      organizationId: sandbox.organizationId,
      details: { sandboxId: sandbox.sandboxId, pairingId: sandbox.pairing.record.pairingId, ...details },
    };
  }

  private log(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (this.options.log) this.options.log(`[sandboxes] ${message}`, { detail });
    else console.warn(`[sandboxes] ${message}`, { detail });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Runs an operation in turn and turns every failure into a named error with a recovery step. */
  private operation<T>(name: string, task: () => Promise<T>): Promise<EnterpriseResult<T>> {
    return this.serial(async () => {
      try {
        return { ok: true as const, value: await task() };
      } catch (error) {
        if (error instanceof Refusal || error instanceof IntegrityStop) return { ok: false as const, error: { code: error.code, message: clip(error.message) } };
        if (error instanceof TenantClosedError) return { ok: false as const, error: { code: "organization-disconnected", message: DISCONNECTED } };
        if (error instanceof SandboxStateError) {
          this.log("the list of paired sandboxes could not be read", error);
          return {
            ok: false as const,
            error: { code: "sandbox-state-unreadable", message: "The list of paired sandboxes in the OpenAdminOS data folder cannot be read. Restore sandboxes.json from a backup, or remove it and pair the sandboxes again." },
          };
        }
        this.log(`the sandbox ${name} request failed`, error);
        return { ok: false as const, error: { code: "sandbox-failed", message: `The sandbox ${name} request could not be completed. Try again; the app log names the cause.` } };
      }
    });
  }
}

function parseBundle(text: string | undefined): IdentityBundle | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<IdentityBundle>;
    if (value.version !== 1 || typeof value.identityPem !== "string" || typeof value.tlsKeyPem !== "string" || typeof value.tlsCertificatePem !== "string") return undefined;
    importDevicePrivateKey(value.identityPem);
    tlsSpkiSha256(value.tlsCertificatePem);
    return value as IdentityBundle;
  } catch {
    return undefined;
  }
}

function unverifiedText(reason: UnverifiedReason | undefined): string {
  switch (reason) {
    case "agent-mismatch":
      return "the verified audit rows name another agent for it.";
    case "status-mismatch":
      return "the verified audit rows name another status for it.";
    case "digest-mismatch":
      return "the record differs from the one the verified audit rows name.";
    default:
      return "the verified audit rows hold no finished event for it yet.";
  }
}

function clipId(value: string | undefined): string {
  if (!value) return "unknown";
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

type CheckedRun = { kind: "run"; run: RunRecord; digest: string } | { kind: "pending" } | { kind: "problem"; message: string };

/**
 * Builds the desktop's record of a sandbox run from an allowlist of the
 * fields the sandbox sent, each checked for shape and size. The run must
 * have run on this sandbox for its organization and tenant and must have
 * finished. Where it ran, its trigger, initiator and tenant are set here;
 * nothing else the sandbox sent is kept. The change state is left out:
 * the desktop compares its own scheduled runs only.
 */
function sandboxRun(raw: unknown, sandbox: StoredSandbox): CheckedRun {
  if (!isObject(raw) || typeof raw.id !== "string" || !RUN_ID.test(raw.id)) {
    return { kind: "problem", message: "The sandbox sent a run without a valid id; it was not imported." };
  }
  const id = raw.id;
  const executedOn = raw.executedOn;
  const tenantId = typeof raw.tenantId === "string" ? raw.tenantId.toLowerCase() : undefined;
  if (
    !isObject(executedOn) ||
    executedOn.kind !== "sandbox" ||
    executedOn.sandboxId !== sandbox.sandboxId ||
    executedOn.organizationId !== sandbox.organizationId ||
    (tenantId !== undefined && tenantId !== sandbox.tenantId)
  ) {
    throw new IntegrityStop("binding-mismatch", `The sandbox reported run ${id} for another sandbox, organization or tenant than the one paired. ${PAIR_AGAIN}`);
  }
  if (typeof raw.status !== "string" || !TERMINAL.has(raw.status)) return { kind: "pending" };
  const problem = (what: string): CheckedRun => ({ kind: "problem", message: `Run ${id} has ${what}; it was not imported.` });

  const model = shortText(executedOn.model);
  const modelDigest = executedOn.modelDigest === undefined ? undefined : shortText(executedOn.modelDigest);
  if (!model || (executedOn.modelDigest !== undefined && !modelDigest)) return problem("no valid model name");
  if (typeof raw.agentSlug !== "string" || !SLUG.test(raw.agentSlug)) return problem("no valid agent id");
  const queuedAt = isoTime(raw.queuedAt);
  if (!queuedAt) return problem("no valid queue time");
  const startedAt = raw.startedAt === undefined ? undefined : isoTime(raw.startedAt);
  const finishedAt = raw.finishedAt === undefined ? undefined : isoTime(raw.finishedAt);
  if ((raw.startedAt !== undefined && !startedAt) || (raw.finishedAt !== undefined && !finishedAt)) return problem("a start or finish time that is not a time");
  const summary = optionalText(raw.summary, RUN_LIMITS.summary);
  const error = optionalText(raw.error, RUN_LIMITS.text);
  if (summary === null || error === null) return problem("a summary or error that is not text of the allowed size");
  let result: unknown;
  if (raw.result !== undefined) {
    result = plainJson(raw.result, RUN_LIMITS.resultBytes);
    if (result === undefined) return problem(`a result that is not plain JSON of at most ${RUN_LIMITS.resultBytes} bytes`);
  }
  const steps = sandboxSteps(raw.steps, id);
  if (!steps) return problem("steps that are not step records of the allowed size");
  const logs = sandboxLogs(raw.logs, id);
  if (!logs) return problem("logs that are not log records of the allowed size");

  const run: RunRecord = {
    id,
    agentSlug: raw.agentSlug,
    status: raw.status as RunRecord["status"],
    queuedAt,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(raw.result !== undefined ? { result } : {}),
    steps,
    logs,
    model,
    trigger: "schedule",
    initiator: "schedule",
    tenantId: sandbox.tenantId,
    executedOn: {
      kind: "sandbox",
      sandboxId: sandbox.sandboxId,
      name: sandbox.name,
      organizationId: sandbox.organizationId,
      model,
      ...(modelDigest ? { modelDigest } : {}),
      pairingKeyFingerprint: fingerprintOf(sandbox.pairing.record),
    },
  };
  // The digest of the record as received, which the audit event must name.
  return { kind: "run", run, digest: runRecordDigest(raw) };
}

function sandboxSteps(value: unknown, runId: string): RunRecord["steps"] | undefined {
  if (!Array.isArray(value) || value.length > RUN_LIMITS.steps) return undefined;
  const steps: RunRecord["steps"] = [];
  for (const entry of value) {
    if (!isObject(entry)) return undefined;
    const id = shortText(entry.id);
    const label = optionalText(entry.label, RUN_LIMITS.short);
    const detail = optionalText(entry.detail, RUN_LIMITS.text);
    const startedAt = entry.startedAt === undefined ? undefined : isoTime(entry.startedAt);
    const finishedAt = entry.finishedAt === undefined ? undefined : isoTime(entry.finishedAt);
    if (!id || label == null || detail === null || typeof entry.status !== "string" || !STEP_STATUSES.has(entry.status)) return undefined;
    if ((entry.startedAt !== undefined && !startedAt) || (entry.finishedAt !== undefined && !finishedAt)) return undefined;
    steps.push({
      id,
      runId,
      label,
      status: entry.status as RunRecord["steps"][number]["status"],
      ...(detail !== undefined ? { detail } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    });
  }
  return steps;
}

function sandboxLogs(value: unknown, runId: string): RunRecord["logs"] | undefined {
  if (!Array.isArray(value) || value.length > RUN_LIMITS.logs) return undefined;
  const logs: RunRecord["logs"] = [];
  for (const entry of value) {
    if (!isObject(entry)) return undefined;
    const id = shortText(entry.id);
    const timestamp = isoTime(entry.timestamp);
    const message = optionalText(entry.message, RUN_LIMITS.text);
    const stepId = entry.stepId === undefined ? undefined : shortText(entry.stepId);
    if (!id || !timestamp || message == null || typeof entry.level !== "string" || !LOG_LEVELS.has(entry.level)) return undefined;
    if (entry.stepId !== undefined && !stepId) return undefined;
    let metadata: Record<string, unknown> | undefined;
    if (entry.metadata !== undefined) {
      const copied = plainJson(entry.metadata, RUN_LIMITS.metadataBytes);
      if (!isObject(copied)) return undefined;
      metadata = copied;
    }
    logs.push({
      id,
      runId,
      timestamp,
      level: entry.level as RunRecord["logs"][number]["level"],
      message,
      ...(stepId ? { stepId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  return logs;
}

/** Text of 1 to 200 characters without control characters. */
function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= RUN_LIMITS.short && !CONTROL.test(value) ? value : undefined;
}

/** Undefined when absent, null when present but not text of at most `max` characters. */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= max ? value : null;
}

function isoTime(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** A copy that is plain JSON within `maxBytes`, or undefined. */
function plainJson(value: unknown, maxBytes: number): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") > maxBytes) return undefined;
  return JSON.parse(text) as unknown;
}

function remoteStatus(body: Record<string, unknown>): EnterpriseSandboxRemoteStatus {
  const model = isObject(body.model) ? body.model : {};
  const schedules = Array.isArray(body.schedules) ? body.schedules.filter(isObject).slice(0, 100) : [];
  const problems = Array.isArray(body.problems) ? body.problems.filter(isObject).slice(0, 20) : [];
  return {
    hostVersion: clip(text(body.hostVersion) ?? "unknown"),
    bindingChanged: body.bindingChanged === true,
    model: { provider: clip(text(model.provider) ?? "unknown"), model: clip(text(model.model) ?? "unknown"), digest: clip(text(model.digest) ?? "unknown") },
    ...(typeof body.assignmentVersion === "number" && Number.isSafeInteger(body.assignmentVersion) ? { assignmentVersion: body.assignmentVersion } : {}),
    schedules: schedules.map((entry) => ({
      agentId: clip(text(entry.agentId) ?? "unknown"),
      source: entry.source === "assigned" ? ("assigned" as const) : ("config" as const),
      intervalSeconds: typeof entry.intervalSeconds === "number" && Number.isSafeInteger(entry.intervalSeconds) ? entry.intervalSeconds : 0,
      ...(text(entry.nextRunAt) ? { nextRunAt: clip(text(entry.nextRunAt)!) } : {}),
      ...(text(entry.status) ? { status: clip(text(entry.status)!) } : {}),
    })),
    problems: problems.map((entry) => ({ reason: clip(text(entry.reason) ?? "unknown"), message: clip(text(entry.message) ?? "") })),
  };
}

function summary(sandbox: StoredSandbox, auditSeq: number): EnterpriseSandbox {
  return {
    sandboxId: sandbox.sandboxId,
    name: sandbox.name,
    address: sandbox.address,
    organizationId: sandbox.organizationId,
    tenantId: sandbox.tenantId,
    pairedAt: sandbox.pairedAt,
    pairingKeyFingerprint: fingerprintOf(sandbox.pairing.record),
    state: sandbox.failure ? "stopped" : "paired",
    ...(sandbox.failure ? { failure: { ...sandbox.failure } } : {}),
    ...(sandbox.lastSyncAt ? { lastSyncAt: sandbox.lastSyncAt } : {}),
    auditSeq,
    assignmentVersion: sandbox.assignmentVersion,
  };
}

function fingerprintOf(record: PairingRecord): string {
  return deviceFingerprint(importDevicePublicKey(record.sandboxPublicKey), "base32");
}

function addressOf(sandbox: StoredSandbox): SandboxAddress {
  const address = parseSandboxAddress(sandbox.address);
  if (!address) throw new Refusal("address-invalid", `The stored address of ${sandbox.name} is not an IP address and port. ${PAIR_AGAIN}`);
  return address;
}

/** Checked right after the handshake, before any request is sent. */
function pairingCodeMatches(code: PairingCode, pin: string): boolean {
  return pairingCodeMatchesSpki(code, pin);
}

/** The reply body, or the sandbox's named error as a refusal. */
function sandboxBody(reply: SandboxReply): Record<string, unknown> {
  if (reply.status >= 200 && reply.status < 300 && isObject(reply.body)) return reply.body;
  const code = errorCode(reply.body);
  if (code) throw new Refusal(code, clip(errorMessage(reply.body) ?? `The sandbox refused the request (${code}).`));
  throw new Refusal("sandbox-reply-invalid", `The sandbox answered ${reply.status} without a named error.`);
}

function errorCode(body: unknown): string | undefined {
  const error = isObject(body) ? body.error : undefined;
  const code = isObject(error) ? text(error.code) : undefined;
  return code && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : undefined;
}

function errorMessage(body: unknown): string | undefined {
  const error = isObject(body) ? body.error : undefined;
  return isObject(error) ? text(error.message) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 100).map(clip) : [];
}

function clip(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE - 3)}...` : value;
}
