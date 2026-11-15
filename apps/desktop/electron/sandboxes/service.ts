// The desktop side of sandbox pairing and sync. This code holds the keys
// and verifies everything a sandbox sends, so it is public; the optional
// team features module only decides when to call it (through the
// `sandboxes` capability of the extension point) and draws the UI.
//
// Nothing here runs on its own. There is no timer and no listener: without
// a paired sandbox and a call, no connection is opened.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord, SecretAccessor } from "@openadminos/agent-sdk";
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
import type { AuditLogEventSeed, AuditLogPosition, AuditLogRangeRow } from "@openadminos/runtime";

import { SandboxAuditStore, SandboxStateStore, type StoredSandbox } from "./store.js";
import { SandboxTransportError, tlsSandboxTransport, type ClientCredentials, type SandboxReply, type SandboxTransport } from "./transport.js";

/** Secret store keys. The values never leave the main process. */
export const SANDBOX_SECRET_KEYS = Object.freeze({
  identity: "device-identity",
  tlsKey: "tls-key",
  tlsCertificate: "tls-certificate",
});

const RUNS_PAGE = 100;
const AUDIT_BATCH = 500;
/** Per sync call; a sandbox with more pages is read further by the next sync. */
const MAX_RUN_PAGES = 100;
const MAX_AUDIT_BATCHES = 200;
const MIN_INTERVAL_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 31 * 86_400;
const MAX_MESSAGE = 300;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
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

export interface SandboxServiceOptions {
  /** `<userData>/sandboxes`. */
  rootDir: string;
  /** The desktop's device key and TLS client certificate. */
  secrets: SecretAccessor;
  /** Organizations whose Microsoft 365 tenant is connected now. */
  organizations(): Promise<readonly EnterpriseOrganization[]>;
  /** Bundled read-only agents with their manifest hashes. */
  catalog(): Promise<readonly EnterpriseReadOnlyAgent[]>;
  /** Adds sandbox runs to run history; a desktop run with the same id is never replaced. */
  importRuns(runs: readonly RunRecord[]): Promise<number>;
  /** Appends to the desktop's audit log; throws when it cannot. */
  recordAudit(events: readonly AuditLogEventSeed[]): void;
  now?: () => Date;
  transport?: SandboxTransport;
  /** The verified audit rows; `<rootDir>/audit.db` when left out. */
  auditDbPath?: string;
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

const PAIR_AGAIN = "Unpair the sandbox here and on the sandbox (openadminos-sandbox --unpair), then pair it again with a new code.";

export class SandboxService implements EnterpriseSandboxes {
  private readonly state: SandboxStateStore;
  private readonly now: () => Date;
  private readonly transport: SandboxTransport;
  private audit: SandboxAuditStore | undefined;
  /** One operation at a time, so the state file is never written from two at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SandboxServiceOptions) {
    this.state = new SandboxStateStore(join(options.rootDir, "sandboxes.json"));
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? tlsSandboxTransport;
  }

  list(): Promise<readonly EnterpriseSandbox[]> {
    return this.serial(async () => (await this.state.read()).map(summary));
  }

  pair(input: EnterpriseSandboxPairInput): Promise<EnterpriseResult<EnterpriseSandbox>> {
    return this.operation(() => this.pairNow(input));
  }

  sync(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxSyncResult>> {
    return this.operation(() => this.syncNow(sandboxId));
  }

  assign(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseResult<EnterpriseSandboxAssignResult>> {
    return this.operation(() => this.assignNow(sandboxId, entries));
  }

  unpair(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxUnpairResult>> {
    return this.operation(() => this.unpairNow(sandboxId));
  }

  status(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxStatus>> {
    return this.operation(() => this.statusNow(sandboxId));
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
    const credentials = await this.credentials(true);
    const where = formatSandboxAddress(address);

    const hello = await this.request(address, credentials, (pin) => pairingCodeMatches(parsed.code, pin), "GET", "/v1/pair").catch((error: unknown) => {
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
    // Sandboxes are kept by organization and sandbox id; one id belongs to one organization at a time.
    const held = (await this.state.read()).find((entry) => entry.sandboxId === sandboxId);
    if (held && held.organizationId !== organization.id) {
      throw new Refusal("sandbox-paired-for-another-organization", `A sandbox named ${sandboxId} is paired with this desktop for another organization. Unpair it first, then pair again.`);
    }
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

    const pairedAt = this.now().toISOString();
    const stored: StoredSandbox = {
      sandboxId,
      name: value.sandboxName,
      address: where,
      organizationId: organization.id,
      tenantId,
      pairing: { record: value, signature: (reply.pairing as { signature: string }).signature },
      pairedAt,
      auditPin: { seq: start.value.seq, sha256: start.value.sha256 },
      runCursor: { after: 0 },
      assignmentVersion: 0,
    };
    this.options.recordAudit([
      this.event(stored, `sandbox-pairing:${pairingId}:created`, "sandbox.pairing.created", {
        address: where,
        pairingKeyFingerprint: fingerprintOf(value),
        auditSeq: start.value.seq,
      }),
    ]);
    const others = (await this.state.read()).filter((entry) => !(entry.sandboxId === sandboxId && entry.organizationId === organization.id));
    await this.state.write([...others, stored]);
    return summary(stored);
  }

  // ---- sync ----

  private async syncNow(sandboxId: string): Promise<EnterpriseSandboxSyncResult> {
    const sandbox = await this.usable(sandboxId);
    const credentials = await this.credentials(false);
    const address = addressOf(sandbox);
    const record = sandbox.pairing.record;
    const problems: string[] = [];
    try {
      // Runs first: the sandbox records a run's finished event before it
      // writes the run, so the audit rows read after cover every run read.
      const { runs, cursor } = await this.readRuns(sandbox, address, credentials, problems);

      let pin: AuditLogPosition = sandbox.auditPin;
      let accepted = 0;
      let batches = 0;
      for (let batch = 0; batch < MAX_AUDIT_BATCHES; batch += 1) {
        const reply = await this.pinned(sandbox, address, credentials, "GET", `/v1/audit?after=${pin.seq}&limit=${AUDIT_BATCH}`);
        if (reply.status === 409 && errorCode(reply.body) === "audit-position-unknown") {
          throw new IntegrityStop("audit-position-unknown", `The sandbox no longer holds the audit entries after ${pin.seq}, so what happened there cannot be checked. ${PAIR_AGAIN}`);
        }
        const body = sandboxBody(reply);
        const rows = Array.isArray(body.rows) ? (body.rows as AuditLogRangeRow[]) : undefined;
        if (!rows) throw new Refusal("sandbox-reply-invalid", "The sandbox sent audit rows in a form this desktop does not read.");
        const result = verifySignedContinuation(pin, rows, body.checkpoint, record.sandboxPublicKey, { pairingId: record.pairingId, sandboxId: record.sandboxId });
        if (!result.ok) {
          throw new IntegrityStop(result.failure, `${result.detail} Sync is stopped for this sandbox. ${PAIR_AGAIN}`);
        }
        if (rows.length === 0) break;
        const verifiedAt = this.now().toISOString();
        this.auditStore().addBatch(record.pairingId, record.sandboxId, rows, result.pin.seq, verifiedAt);
        this.options.recordAudit([
          this.event(sandbox, `sandbox-audit:${record.pairingId}:${result.pin.seq}`, "sandbox.audit.accepted", {
            fromSeq: rows[0]!.seq,
            toSeq: result.pin.seq,
            rows: rows.length,
            finalSha256: result.pin.sha256,
          }),
        ]);
        pin = result.pin;
        accepted += rows.length;
        batches += 1;
        await this.update(sandboxId, (entry) => ({ ...entry, auditPin: pin }));
        if (batch === MAX_AUDIT_BATCHES - 1) problems.push("More audit entries remain on the sandbox; sync again to read them.");
      }

      const imported: RunRecord[] = [];
      let verified = 0;
      for (const run of runs) {
        const finish = this.auditStore().finished(record.pairingId, run.id);
        if (finish) {
          verified += 1;
          imported.push({
            ...run,
            attestedBy: { sandboxId: record.sandboxId, pairingKeyFingerprint: fingerprintOf(record), checkpointSeq: finish.checkpointSeq, verifiedAt: finish.verifiedAt },
          });
        } else {
          imported.push(run);
        }
      }
      const count = imported.length > 0 ? await this.options.importRuns(imported) : 0;
      const lastSyncAt = this.now().toISOString();
      const next = await this.update(sandboxId, (entry) => ({ ...entry, runCursor: cursor, lastSyncAt }));
      return {
        sandbox: summary(next),
        runsImported: count,
        runsVerified: verified,
        runsUnverified: imported.length - verified,
        auditRowsAccepted: accepted,
        auditBatches: batches,
        problems,
      };
    } catch (error) {
      if (error instanceof IntegrityStop) await this.stop(sandbox, error);
      throw error;
    }
  }

  /** Reads run pages after the cursor; a new generation or a cursor reset reads again from 0, once. */
  private async readRuns(sandbox: StoredSandbox, address: SandboxAddress, credentials: Credentials, problems: string[]) {
    let cursor = { ...sandbox.runCursor };
    const byId = new Map<string, RunRecord>();
    let restarted = false;
    for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
      const body = sandboxBody(await this.pinned(sandbox, address, credentials, "GET", `/v1/runs?after=${cursor.after}&limit=${RUNS_PAGE}`));
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
        if (isObject(problem)) problems.push(`Run ${text(problem.runId) ?? "unknown"} could not be read on the sandbox: ${clip(text(problem.message) ?? "no reason given")}`);
      }
      for (const entry of body.runs) {
        const checked = sandboxRun(isObject(entry) ? entry.run : undefined, sandbox);
        if (checked.kind === "run") byId.set(checked.run.id, checked.run);
        else if (checked.kind === "problem") problems.push(checked.message);
      }
      if (next === cursor.after) break;
      cursor.after = next;
      if (page === MAX_RUN_PAGES - 1) problems.push("More runs remain on the sandbox; sync again to read them.");
    }
    return { runs: [...byId.values()], cursor };
  }

  // ---- assignments ----

  private async assignNow(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseSandboxAssignResult> {
    const sandbox = await this.usable(sandboxId);
    const catalog = new Map((await this.options.catalog()).map((agent) => [agent.id, agent]));
    const seen = new Set<string>();
    const signedEntries = entries.map((entry) => {
      if (seen.has(entry.agentId)) throw new Refusal("assignment-duplicate-agent", `${entry.agentId} is listed twice; assign each agent once.`);
      seen.add(entry.agentId);
      const agent = catalog.get(entry.agentId);
      if (!agent) {
        throw new Refusal("agent-not-read-only", `${entry.agentId} is not a bundled read-only agent. A sandbox runs read-only agents only; changes stay on the desktop with diff confirmation.`);
      }
      if (!Number.isSafeInteger(entry.intervalSeconds) || entry.intervalSeconds < MIN_INTERVAL_SECONDS || entry.intervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Refusal("assignment-interval-invalid", `The interval for ${entry.agentId} is ${entry.intervalSeconds} seconds; it is 15 minutes to 31 days.`);
      }
      return { agentId: agent.id, templateSha256: agent.manifestSha256, intervalSeconds: entry.intervalSeconds };
    });
    const credentials = await this.credentials(false);
    const record = sandbox.pairing.record;
    const version = sandbox.assignmentVersion + 1;
    const signed = signScheduleAssignment(
      { pairingId: record.pairingId, version, organizationId: record.organizationId, tenantId: record.tenantId, entries: signedEntries, issuedAt: this.now().toISOString() },
      credentials.identity.privateKey,
    );
    try {
      const body = sandboxBody(await this.pinned(sandbox, addressOf(sandbox), credentials, "PUT", "/v1/assignments", signed));
      await this.update(sandboxId, (entry) => ({ ...entry, assignmentVersion: version }));
      const result: EnterpriseSandboxAssignResult = {
        version,
        assigned: strings(body.assigned),
        shadowed: strings(body.shadowed),
        rolesNoLongerNeeded: strings(body.rolesNoLongerNeeded),
        ...(text(body.notice) ? { notice: clip(text(body.notice)!) } : {}),
      };
      this.options.recordAudit([
        this.event(sandbox, `sandbox-assignment:${record.pairingId}:${version}`, "sandbox.assignment.sent", {
          version,
          agents: signedEntries.map((entry) => entry.agentId),
          rolesNoLongerNeeded: [...result.rolesNoLongerNeeded],
        }),
      ]);
      return result;
    } catch (error) {
      if (error instanceof IntegrityStop) await this.stop(sandbox, error);
      throw error;
    }
  }

  // ---- unpairing and status ----

  private async unpairNow(sandboxId: string): Promise<EnterpriseSandboxUnpairResult> {
    const sandbox = (await this.state.read()).find((entry) => entry.sandboxId === sandboxId);
    if (!sandbox) throw new Refusal("sandbox-not-paired", `No sandbox ${sandboxId} is paired with this desktop.`);
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
        reason = clip((error as Error).message);
      }
    } else {
      reason = "This desktop's device key is gone, so the sandbox cannot be asked.";
    }
    await this.state.write((await this.state.read()).filter((entry) => entry.sandboxId !== sandboxId));
    this.options.recordAudit([
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
    if (sandbox.failure) return { sandbox: summary(sandbox) };
    await this.connectedOrganization(sandbox);
    const credentials = await this.credentials(false);
    try {
      const body = sandboxBody(await this.pinned(sandbox, addressOf(sandbox), credentials, "GET", "/v1/status"));
      return { sandbox: summary(sandbox), remote: remoteStatus(body) };
    } catch (error) {
      if (error instanceof IntegrityStop) await this.stop(sandbox, error);
      throw error;
    }
  }

  // ---- helpers ----

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
    if (!sandbox) throw new Refusal("sandbox-not-paired", `No sandbox ${sandboxId} is paired with this desktop.`);
    return sandbox;
  }

  /** Hard constraint: a sandbox of an organization that is not connected is not contacted. */
  private async connectedOrganization(sandbox: StoredSandbox): Promise<void> {
    const organization = (await this.options.organizations()).find((entry) => entry.id === sandbox.organizationId);
    if (!organization || organization.tenantId.toLowerCase() !== sandbox.tenantId) {
      throw new Refusal("organization-not-connected", `The organization ${sandbox.name} is paired for is not connected in OpenAdminOS. Connect it again, then sync.`);
    }
  }

  /** A request to a paired sandbox: the pin must be the paired one, and pairing answers become integrity stops. */
  private async pinned(sandbox: StoredSandbox, address: SandboxAddress, credentials: Credentials, method: "GET" | "PUT", path: string, body?: unknown): Promise<SandboxReply> {
    let reply: SandboxReply;
    try {
      reply = await this.request(address, credentials, (pin) => pin === sandbox.pairing.record.tlsSpkiSha256, method, path, body);
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

  private async request(address: SandboxAddress, credentials: Credentials, acceptPin: (pin: string) => boolean, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<SandboxReply> {
    try {
      return await this.transport({ address, credentials: credentials.tls, acceptPin, method, path, ...(body === undefined ? {} : { body }) });
    } catch (error) {
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
    } catch {
      // The failure is kept in the sandbox's state either way.
    }
  }

  private async update(sandboxId: string, change: (entry: StoredSandbox) => StoredSandbox): Promise<StoredSandbox> {
    const all = await this.state.read();
    const index = all.findIndex((entry) => entry.sandboxId === sandboxId);
    if (index < 0) throw new Refusal("sandbox-not-paired", `No sandbox ${sandboxId} is paired with this desktop.`);
    const next = change(all[index]!);
    all[index] = next;
    await this.state.write(all);
    return next;
  }

  private auditStore(): SandboxAuditStore {
    if (!this.audit) {
      mkdirSync(this.options.rootDir, { recursive: true, mode: 0o700 });
      this.audit = new SandboxAuditStore(this.options.auditDbPath ?? join(this.options.rootDir, "audit.db"));
    }
    return this.audit;
  }

  /** The desktop's device key and TLS client certificate; made on first pairing only. */
  private async credentials(create: boolean): Promise<Credentials> {
    const secrets = this.options.secrets;
    const [identityPem, keyPem, certificatePem] = await Promise.all([
      secrets.get(SANDBOX_SECRET_KEYS.identity),
      secrets.get(SANDBOX_SECRET_KEYS.tlsKey),
      secrets.get(SANDBOX_SECRET_KEYS.tlsCertificate),
    ]);
    if (identityPem && keyPem && certificatePem) {
      return { identity: importDevicePrivateKey(identityPem), tls: { keyPem, certificatePem, pin: tlsSpkiSha256(certificatePem) } };
    }
    if (!create) {
      throw new Refusal("desktop-identity-missing", `This desktop's sandbox key is gone from the system keychain, so paired sandboxes no longer know it. ${PAIR_AGAIN}`);
    }
    const identity = generateDeviceIdentity();
    // Sandboxes trust the key by its pin, not the certificate dates.
    const tls = createTlsCertificate({ commonName: "openadminos-desktop", validityDays: 3650 });
    await secrets.set(SANDBOX_SECRET_KEYS.identity, exportDevicePrivateKey(identity));
    await secrets.set(SANDBOX_SECRET_KEYS.tlsKey, tls.privateKeyPem);
    await secrets.set(SANDBOX_SECRET_KEYS.tlsCertificate, tls.certificatePem);
    return { identity, tls: { keyPem: tls.privateKeyPem, certificatePem: tls.certificatePem, pin: tls.spkiSha256 } };
  }

  private event(sandbox: StoredSandbox, id: string, type: string, details: Record<string, unknown>): AuditLogEventSeed {
    return {
      id,
      timestamp: this.now().toISOString(),
      type,
      source: "sandbox",
      tenantId: sandbox.tenantId,
      organizationId: sandbox.organizationId,
      details: { sandboxId: sandbox.sandboxId, pairingId: sandbox.pairing.record.pairingId, ...details },
    };
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Runs an operation in turn and turns every failure into a named error. */
  private operation<T>(task: () => Promise<T>): Promise<EnterpriseResult<T>> {
    return this.serial(async () => {
      try {
        return { ok: true as const, value: await task() };
      } catch (error) {
        if (error instanceof Refusal || error instanceof IntegrityStop) return { ok: false as const, error: { code: error.code, message: clip(error.message) } };
        return { ok: false as const, error: { code: "sandbox-failed", message: clip(`The sandbox request failed: ${(error as Error).message}`) } };
      }
    });
  }
}

type CheckedRun = { kind: "run"; run: RunRecord } | { kind: "pending" } | { kind: "problem"; message: string };

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
  return { kind: "run", run };
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

function summary(sandbox: StoredSandbox): EnterpriseSandbox {
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
    auditSeq: sandbox.auditPin.seq,
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
