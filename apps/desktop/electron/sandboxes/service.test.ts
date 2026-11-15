import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord, SecretAccessor } from "@openadminos/agent-sdk";
import type { EnterpriseOrganization, EnterpriseReadOnlyAgent, EnterpriseResult } from "@openadminos/enterprise";
import { parsePairingCode } from "@openadminos/pairing";
import { canonicalJson, chainHash, type AuditLogEventSeed } from "@openadminos/runtime";
import { bundledHash, startTestSandbox, TEST_SANDBOX_TENANT, type TestSandbox } from "@openadminos/sandbox-host/testing";

import { TenantClosedError, TenantLifecycle } from "../tenant-lifecycle.js";
import { createSandboxCapabilities } from "./capabilities.js";
import { readOnlyCatalog } from "./catalog.js";
import { SANDBOX_IDENTITY_SECRET, SandboxService, type SandboxServiceOptions } from "./service.js";
import { SandboxAuditStore } from "./store.js";
import { SandboxTransportError, tlsSandboxTransport, type SandboxReply, type SandboxRequest, type SandboxTransport } from "./transport.js";

const ORG: EnterpriseOrganization = { id: "org-1", name: "Contoso", tenantId: TEST_SANDBOX_TENANT };

type Intercept = (next: SandboxTransport, request: SandboxRequest) => Promise<SandboxReply>;

function memorySecrets(): SecretAccessor & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

function catalogEntry(id: string): EnterpriseReadOnlyAgent {
  return { id, name: id, scopes: [], manifestSha256: bundledHash(id) };
}

/** An audit store that fails once before its commit, as a crash between rows and pin would. */
class CrashingAuditStore extends SandboxAuditStore {
  crashes = 0;
  protected override beforeCommit(): void {
    if (this.crashes > 0) {
      this.crashes -= 1;
      throw new Error("crashed before commit");
    }
  }
}

interface Desktop {
  service: SandboxService;
  rootDir: string;
  secrets: ReturnType<typeof memorySecrets>;
  runs: Map<string, RunRecord>;
  audit: AuditLogEventSeed[];
  requests: SandboxRequest[];
  organizations: EnterpriseOrganization[];
  intercept: { current: Intercept | undefined };
  lifecycle: TenantLifecycle;
  store: CrashingAuditStore;
  close(): Promise<void>;
}

async function desktop(options: { organizations?: EnterpriseOrganization[]; limits?: SandboxServiceOptions["limits"] } = {}): Promise<Desktop> {
  const rootDir = await mkdtemp(join(tmpdir(), "oaos-desktop-sandboxes-"));
  const secrets = memorySecrets();
  const runs = new Map<string, RunRecord>();
  const audit: AuditLogEventSeed[] = [];
  const requests: SandboxRequest[] = [];
  const organizations = options.organizations ?? [ORG];
  const intercept: { current: Intercept | undefined } = { current: undefined };
  const lifecycle = new TenantLifecycle();
  let store: CrashingAuditStore | undefined;
  const openStore = () => (store ??= new CrashingAuditStore(join(rootDir, "audit.db")));
  const assertOpen = (tenantId: string) => {
    if (lifecycle.phase(tenantId) !== "open" || !lifecycle.isWritable(tenantId)) throw new TenantClosedError(tenantId, "test import");
  };
  const service = new SandboxService({
    rootDir,
    secrets,
    organizations: async () => organizations,
    catalog: async () => [catalogEntry("compliance-overview"), catalogEntry("dormant-app-registrations"), catalogEntry("os-update-posture")],
    withTenantLease: (tenantId, work) => lifecycle.withTenantLease(tenantId, (lease) => work({ signal: lease.signal })),
    // The same replace rule as AppStateStore.importSandboxRuns.
    importRuns: async (imported) => {
      let changed = 0;
      for (const run of imported) {
        assertOpen(run.tenantId!);
        const existing = runs.get(run.id);
        if (existing && !(run.attestedBy && (!existing.attestedBy || run.attestedBy.checkpointSeq > existing.attestedBy.checkpointSeq))) continue;
        runs.set(run.id, run);
        changed += 1;
      }
      return changed;
    },
    attestRuns: async (entries) => {
      let changed = 0;
      for (const entry of entries) {
        assertOpen(entry.tenantId);
        const run = runs.get(entry.runId);
        if (!run || run.attestedBy) continue;
        runs.set(entry.runId, { ...run, attestedBy: entry.attestedBy });
        changed += 1;
      }
      return changed;
    },
    recordAudit: (events) => {
      for (const event of events) if (!audit.some((existing) => existing.id === event.id)) audit.push(event);
    },
    log: () => undefined,
    auditStore: openStore,
    ...(options.limits ? { limits: options.limits } : {}),
    transport: (request) => {
      requests.push(request);
      return intercept.current ? intercept.current(tlsSandboxTransport, request) : tlsSandboxTransport(request);
    },
  });
  return {
    service,
    rootDir,
    secrets,
    runs,
    audit,
    requests,
    organizations,
    intercept,
    lifecycle,
    get store() {
      return openStore();
    },
    async close() {
      service.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

function value<T>(result: EnterpriseResult<T>): T {
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  return result.value;
}

function code<T>(result: EnterpriseResult<T>): string {
  assert.equal(result.ok, false, "the call was refused");
  return result.ok ? "" : result.error.code;
}

/** Waits for a condition with a referenced timer that is always cleared. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 20);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A pairing code the sandbox logs after the one given, for pairing again. */
async function nextCode(sandbox: TestSandbox, after: string): Promise<string> {
  await waitFor(() => {
    try {
      return sandbox.code() !== after;
    } catch {
      return false;
    }
  });
  return sandbox.code();
}

async function paired(options: Parameters<typeof desktop>[0] = {}): Promise<{ sandbox: TestSandbox; desk: Desktop; close(): Promise<void> }> {
  const sandbox = await startTestSandbox();
  const desk = await desktop(options);
  const result = await desk.service.pair({ address: sandbox.address, code: sandbox.code(), organizationId: "org-1" });
  value(result);
  return {
    sandbox,
    desk,
    async close() {
      await desk.close();
      await sandbox.close();
    },
  };
}

/** Rewrites page sizes so a small log is read in several batches. */
function smallPages(next: SandboxTransport, request: SandboxRequest): Promise<SandboxReply> {
  return next({ ...request, path: request.path.replace("limit=500", "limit=4").replace("limit=100", "limit=1") });
}

function onAudit(change: (body: { rows: Array<Record<string, unknown>>; checkpoint: Record<string, unknown> }) => void): Intercept {
  return async (next, request) => {
    const reply = await next(request);
    if (request.path.startsWith("/v1/audit") && reply.status === 200) {
      const body = structuredClone(reply.body) as { rows: Array<Record<string, unknown>>; checkpoint: Record<string, unknown> };
      change(body);
      return { ...reply, body };
    }
    return reply;
  };
}

describe("SandboxService pairing", () => {
  it("pairs over pinned TLS, verifies the record and keeps the keys in the secret store", async () => {
    const sandbox = await startTestSandbox();
    const desk = await desktop();
    try {
      const sandboxed = value(await desk.service.pair({ address: sandbox.address, code: sandbox.code(), organizationId: "org-1" }));
      assert.equal(sandboxed.sandboxId, "mini-pc");
      assert.equal(sandboxed.name, "Office mini PC");
      assert.equal(sandboxed.state, "paired");
      assert.equal(sandboxed.organizationId, "org-1");
      assert.equal(sandboxed.tenantId, TEST_SANDBOX_TENANT);
      assert.equal(sandboxed.pairingKeyFingerprint.length, 52);
      assert.equal(sandbox.host.currentPairing?.record.organizationId, "org-1");
      assert.deepEqual((await desk.service.list()).map((entry) => entry.sandboxId), ["mini-pc"]);
      assert.deepEqual([...desk.secrets.values.keys()], [SANDBOX_IDENTITY_SECRET]);
      // The keys are never written next to the pairing records.
      for (const file of await readdir(desk.rootDir)) {
        const text = await readFile(join(desk.rootDir, file), "utf8").catch(() => "");
        assert.ok(!/PRIVATE KEY/.test(text), `${file} holds no private key`);
      }
      assert.ok(desk.audit.some((event) => event.type === "sandbox.pairing.created" && event.source === "sandbox-link"));
    } finally {
      await desk.close();
      await sandbox.close();
    }
  });

  it("refuses a wrong code, an organization that is not connected and another tenant", async () => {
    const sandbox = await startTestSandbox();
    const desk = await desktop({ organizations: [ORG, { id: "org-2", name: "Fabrikam", tenantId: TEST_SANDBOX_TENANT }] });
    try {
      const right = sandbox.code();
      const parsed = parsePairingCode(right);
      assert.ok(parsed.ok);
      const mistyped = `${parsed.code.fingerprint}${parsed.code.secret === "000000000000" ? "111111111111" : "000000000000"}`;
      const wrongKey = `${"0".repeat(16)}${parsed.code.secret}`;
      const pair = (input: { code?: string; organizationId?: string; address?: string }) =>
        desk.service.pair({ address: input.address ?? sandbox.address, code: input.code ?? right, organizationId: input.organizationId ?? "org-1" });

      // Refused before any connection.
      assert.equal(code(await pair({ code: "not a code" })), "code-malformed");
      assert.equal(code(await pair({ organizationId: "org-9" })), "organization-not-connected");
      assert.equal(code(await pair({ address: "8.8.8.8:7443" })), "address-not-private");
      assert.equal(code(await pair({ address: "sandbox.local:7443" })), "address-invalid");
      assert.equal(desk.requests.length, 0);

      // The code names another TLS key: stopped right after the handshake.
      assert.equal(code(await pair({ code: wrongKey })), "fingerprint-mismatch");
      assert.equal(desk.requests.length, 1);
      // The right sandbox, a mistyped secret.
      assert.equal(code(await pair({ code: mistyped })), "proof-invalid");
      // Another organization than the sandbox's config.
      assert.equal(code(await pair({ organizationId: "org-2" })), "binding-mismatch");
      assert.equal(sandbox.host.currentPairing, undefined);
      assert.deepEqual(await desk.service.list(), []);
    } finally {
      await desk.close();
      await sandbox.close();
    }
  });

  it("refuses a connected organization whose tenant is not the sandbox's", async () => {
    const sandbox = await startTestSandbox();
    const desk = await desktop({ organizations: [{ ...ORG, tenantId: "33333333-3333-3333-3333-333333333333" }] });
    try {
      assert.equal(code(await desk.service.pair({ address: sandbox.address, code: sandbox.code(), organizationId: "org-1" })), "binding-mismatch");
      assert.equal(sandbox.host.currentPairing, undefined);
    } finally {
      await desk.close();
      await sandbox.close();
    }
  });
});

describe("SandboxService sync", () => {
  it("imports runs and verifies audit rows across several batches", async () => {
    const h = await paired();
    try {
      for (let index = 0; index < 3; index += 1) {
        const outcome = await h.sandbox.runAgent();
        assert.equal(outcome.kind, "completed");
      }
      h.desk.intercept.current = smallPages;
      const first = value(await h.desk.service.sync("mini-pc"));
      assert.equal(first.runsImported, 3);
      assert.equal(first.runsVerified, 3);
      assert.equal(first.runsUnverified, 0);
      assert.ok(first.auditBatches >= 2, `read in ${first.auditBatches} batches`);
      assert.deepEqual(first.problems, []);
      assert.equal(first.sandbox.auditSeq, h.sandbox.host.auditLog().tip().seq);

      const fingerprint = first.sandbox.pairingKeyFingerprint;
      for (const run of h.desk.runs.values()) {
        assert.equal(run.executedOn?.kind, "sandbox");
        assert.equal(run.status, "completed");
        assert.equal(run.attestedBy?.sandboxId, "mini-pc");
        assert.equal(run.attestedBy?.pairingKeyFingerprint, fingerprint);
        assert.ok((run.attestedBy?.checkpointSeq ?? 0) > 0);
      }

      // One desktop audit event per accepted batch, with contiguous seq ranges.
      const batches = h.desk.audit.filter((event) => event.type === "sandbox.audit.accepted");
      assert.equal(batches.length, first.auditBatches);
      for (let index = 1; index < batches.length; index += 1) {
        assert.equal(batches[index]!.details.fromSeq, (batches[index - 1]!.details.toSeq as number) + 1);
      }
      assert.equal(typeof batches.at(-1)!.details.finalSha256, "string");

      // Nothing new: nothing imported, nothing accepted.
      const again = value(await h.desk.service.sync("mini-pc"));
      assert.equal(again.runsImported, 0);
      assert.equal(again.auditRowsAccepted, 0);

      // A run whose finished event is not in the verified rows is imported as unverified.
      await h.sandbox.runAgent();
      h.desk.intercept.current = onAudit((body) => {
        const position = h.desk.audit.filter((event) => event.type === "sandbox.audit.accepted").at(-1)!.details;
        body.rows = [];
        body.checkpoint = h.sandbox.signCheckpoint({ pairingId: h.sandbox.host.currentPairing!.record.pairingId, sandboxId: "mini-pc", seq: position.toSeq as number, sha256: position.finalSha256 as string, rowCount: 1, at: new Date().toISOString() }) as unknown as Record<string, unknown>;
      });
      const unverified = value(await h.desk.service.sync("mini-pc"));
      assert.equal(unverified.runsImported, 1);
      assert.equal(unverified.runsUnverified, 1);
      assert.equal([...h.desk.runs.values()].filter((run) => !run.attestedBy).length, 1);
      // The next sync reads the event and verifies the waiting run.
      h.desk.intercept.current = undefined;
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsVerified, 1);
      assert.equal([...h.desk.runs.values()].filter((run) => !run.attestedBy).length, 0);
    } finally {
      await h.close();
    }
  });

  it("reads runs again from 0 after a cursor reset or a new generation, once", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      await h.sandbox.runAgent();
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsImported, 2);
      h.desk.runs.clear();

      const runsPaths: string[] = [];
      // A reset under a new generation: every run is read again from 0.
      h.desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (!request.path.startsWith("/v1/runs")) return reply;
        runsPaths.push(request.path);
        return { ...reply, body: { ...(reply.body as object), generation: "reset-generation", condition: { code: "cursor-reset", message: "Cursors started over." } } };
      };
      const reset = value(await h.desk.service.sync("mini-pc"));
      assert.equal(reset.runsImported, 2, "every run was read again");
      assert.ok(runsPaths.some((path) => path.startsWith("/v1/runs?after=0&")));
      // The same reset is handled once, though every page still carries it.
      runsPaths.length = 0;
      h.desk.runs.clear();
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsImported, 0);
      assert.ok(runsPaths.every((path) => !path.startsWith("/v1/runs?after=0&")));

      // A reset not seen yet, under the same generation, reads from 0 too.
      const file = join(h.desk.rootDir, "sandboxes.json");
      const stored = JSON.parse(await readFile(file, "utf8")) as { sandboxes: Array<{ runCursor: { resetSeen?: string } }> };
      stored.sandboxes[0]!.runCursor.resetSeen = "an-older-generation";
      await writeFile(file, JSON.stringify(stored));
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsImported, 2, "an unseen reset reads from 0");

      h.desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (!request.path.startsWith("/v1/runs")) return reply;
        return { ...reply, body: { ...(reply.body as object), generation: "another-generation" } };
      };
      const reread = value(await h.desk.service.sync("mini-pc"));
      // Read again from 0, but a reread never replaces the verified records.
      assert.equal(reread.runsImported, 0, "a new generation reads from 0");
      assert.equal(reread.runsSkipped, 2);
    } finally {
      await h.close();
    }
  });

  it("keeps only the allowlisted run fields and sets where, trigger, initiator and tenant itself", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      h.desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (!request.path.startsWith("/v1/runs")) return reply;
        const body = structuredClone(reply.body) as { runs: Array<{ run: Record<string, unknown> }> };
        for (const entry of body.runs) {
          Object.assign(entry.run, {
            assessmentKey: "forged",
            accessDenial: { scope: "x" },
            usage: { calls: 1 },
            tokens: { input: 1, output: 1 },
            initiator: "gateway",
            trigger: "manual",
            changeState: "unchanged",
            plan: { actions: [] },
            attestedBy: { sandboxId: "mini-pc", pairingKeyFingerprint: "X".repeat(52), checkpointSeq: 1, verifiedAt: "2026-01-01T00:00:00.000Z" },
            tenantId: TEST_SANDBOX_TENANT.toUpperCase(),
          });
          (entry.run.executedOn as Record<string, unknown>).name = "Renamed by the sandbox";
          (entry.run.executedOn as Record<string, unknown>).extra = "dropped";
        }
        return { ...reply, body };
      };
      value(await h.desk.service.sync("mini-pc"));
      const [run] = [...h.desk.runs.values()];
      assert.ok(run);
      for (const field of ["assessmentKey", "accessDenial", "usage", "tokens", "changeState", "plan", "providerId"]) {
        assert.equal(field in run, false, `${field} is dropped`);
      }
      assert.equal(run.initiator, "schedule");
      assert.equal(run.trigger, "schedule");
      assert.equal(run.tenantId, TEST_SANDBOX_TENANT);
      assert.equal(run.executedOn?.kind === "sandbox" ? run.executedOn.name : "", "Office mini PC", "the name is the paired one");
      assert.equal("extra" in (run.executedOn ?? {}), false);
      // The record differs from the one the audit event names, so the sandbox's own attestation is not taken and none is set.
      assert.equal(run.attestedBy, undefined);
      assert.equal(run.executedOn?.kind === "sandbox" ? run.executedOn.pairingKeyFingerprint?.length : 0, 52);
    } finally {
      await h.close();
    }
  });

  it("refuses to pair a sandbox id already paired for another organization", async () => {
    const h = await paired();
    const other = await startTestSandbox({ organizationId: "org-2" });
    try {
      h.desk.organizations.push({ id: "org-2", name: "Fabrikam", tenantId: TEST_SANDBOX_TENANT });
      assert.equal(code(await h.desk.service.pair({ address: other.address, code: other.code(), organizationId: "org-2" })), "sandbox-paired-for-another-organization");
      assert.equal(other.host.currentPairing, undefined, "refused before the proof was sent");
      assert.deepEqual((await h.desk.service.list()).map((entry) => entry.organizationId), ["org-1"]);
    } finally {
      await other.close();
      await h.close();
    }
  });

  it("refuses to contact a sandbox whose organization is no longer connected", async () => {
    const h = await paired();
    try {
      h.desk.organizations.length = 0;
      const before = h.desk.requests.length;
      assert.equal(code(await h.desk.service.sync("mini-pc")), "organization-not-connected");
      assert.equal(code(await h.desk.service.status("mini-pc")), "organization-not-connected");
      assert.equal(code(await h.desk.service.assign("mini-pc", [])), "organization-not-connected");
      assert.equal(h.desk.requests.length, before);
    } finally {
      await h.close();
    }
  });
});

describe("SandboxService integrity failures", () => {
  async function expectStop(h: Awaited<ReturnType<typeof paired>>, expected: string): Promise<void> {
    assert.equal(code(await h.desk.service.sync("mini-pc")), expected);
    const [entry] = await h.desk.service.list();
    assert.equal(entry?.state, "stopped");
    assert.equal(entry?.failure?.code, expected);
    assert.ok(h.desk.audit.some((event) => event.type === "sandbox.sync.stopped" && event.details.reason === expected));
    // Kept as the sandbox's state: the next sync stops without a connection.
    const before = h.desk.requests.length;
    h.desk.intercept.current = undefined;
    assert.equal(code(await h.desk.service.sync("mini-pc")), expected);
    assert.equal(code(await h.desk.service.assign("mini-pc", [])), expected);
    assert.equal(h.desk.requests.length, before);
    assert.deepEqual(h.desk.runs.size, 0, "no run was imported");
  }

  it("stops on a chain gap", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      h.desk.intercept.current = onAudit((body) => {
        assert.ok(body.rows.length >= 3);
        body.rows.splice(1, 1);
      });
      await expectStop(h, "chain-gap");
    } finally {
      await h.close();
    }
  });

  it("stops on a chain fork", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      const pairingId = h.sandbox.host.currentPairing!.record.pairingId;
      h.desk.intercept.current = onAudit((body) => {
        const seq = (body.rows[0]!.seq as number);
        const previous = "f".repeat(64);
        const eventJson = canonicalJson({ id: "forged", type: "sandbox.run.finished" });
        const sha256 = chainHash(previous, eventJson);
        body.rows = [{ seq, previous_sha256: previous, sha256, event_json: eventJson }];
        body.checkpoint = h.sandbox.signCheckpoint({ pairingId, sandboxId: "mini-pc", seq, sha256, rowCount: seq, at: new Date().toISOString() }) as unknown as Record<string, unknown>;
      });
      await expectStop(h, "chain-fork");
    } finally {
      await h.close();
    }
  });

  it("stops on a rollback", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      // The first sync moves the pin; nothing is imported by the stop later.
      value(await h.desk.service.sync("mini-pc"));
      h.desk.runs.clear();
      const pairingId = h.sandbox.host.currentPairing!.record.pairingId;
      const earlier = h.sandbox.host.auditLog().readRange(0, 1)[0]!;
      h.desk.intercept.current = onAudit((body) => {
        body.rows = [];
        body.checkpoint = h.sandbox.signCheckpoint({ pairingId, sandboxId: "mini-pc", seq: earlier.seq, sha256: earlier.sha256, rowCount: 1, at: new Date().toISOString() }) as unknown as Record<string, unknown>;
      });
      await expectStop(h, "chain-rollback");
    } finally {
      await h.close();
    }
  });

  it("stops on a checkpoint whose signature does not verify, and recovers by pairing again", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      h.desk.intercept.current = onAudit((body) => {
        const signature = body.checkpoint.signature as string;
        body.checkpoint.signature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      });
      await expectStop(h, "checkpoint-signature-invalid");

      const shown = h.sandbox.code();
      const unpaired = value(await h.desk.service.unpair("mini-pc"));
      assert.equal(unpaired.sandboxConfirmed, true);
      const repaired = value(await h.desk.service.pair({ address: h.sandbox.address, code: await nextCode(h.sandbox, shown), organizationId: "org-1" }));
      assert.equal(repaired.state, "paired");
      assert.equal(repaired.failure, undefined);
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsVerified, 1);
    } finally {
      await h.close();
    }
  });

  it("stops on a run reported for another organization", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      h.desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (!request.path.startsWith("/v1/runs")) return reply;
        const body = structuredClone(reply.body) as { runs: Array<{ run: RunRecord }> };
        for (const entry of body.runs) entry.run.executedOn = { ...(entry.run.executedOn as Extract<RunRecord["executedOn"], { kind: "sandbox" }>), organizationId: "org-2" };
        return { ...reply, body };
      };
      await expectStop(h, "binding-mismatch");
    } finally {
      await h.close();
    }
  });

  it("stops when the sandbox presents another TLS key than the paired one", async () => {
    const h = await paired();
    const impostor = await startTestSandbox();
    try {
      const file = join(h.desk.rootDir, "sandboxes.json");
      const stored = JSON.parse(await readFile(file, "utf8")) as { sandboxes: Array<{ address: string }> };
      stored.sandboxes[0]!.address = impostor.address;
      await writeFile(file, JSON.stringify(stored));
      await expectStop(h, "tls-pin-changed");
      // An unpair does not talk to the key it does not know, and still unpairs here.
      const unpaired = value(await h.desk.service.unpair("mini-pc"));
      assert.equal(unpaired.sandboxConfirmed, false);
      assert.match(unpaired.message, /openadminos-sandbox --unpair/);
      assert.deepEqual(await h.desk.service.list(), []);
    } finally {
      await impostor.close();
      await h.close();
    }
  });
});

describe("SandboxService assignments and unpairing", () => {
  it("assigns read-only agents with a rising version and reports roles that fall away", async () => {
    const h = await paired();
    try {
      const first = value(await h.desk.service.assign("mini-pc", [{ agentId: "dormant-app-registrations", intervalSeconds: 3600 }]));
      assert.equal(first.version, 1);
      assert.deepEqual(first.assigned, ["dormant-app-registrations"]);
      assert.equal(h.sandbox.host.status().assignmentVersion, 1);
      assert.ok(h.desk.audit.some((event) => event.type === "sandbox.assignment.sent" && event.details.version === 1));

      const before = h.desk.requests.length;
      assert.equal(code(await h.desk.service.assign("mini-pc", [{ agentId: "offboarding-agent", intervalSeconds: 3600 }])), "agent-not-read-only");
      assert.equal(code(await h.desk.service.assign("mini-pc", [{ agentId: "os-update-posture", intervalSeconds: 60 }])), "assignment-interval-invalid");
      assert.equal(code(await h.desk.service.assign("mini-pc", [{ agentId: "os-update-posture", intervalSeconds: 3600 }, { agentId: "os-update-posture", intervalSeconds: 3600 }])), "assignment-duplicate-agent");
      assert.equal(h.desk.requests.length, before, "refused before anything was sent");

      const cleared = value(await h.desk.service.assign("mini-pc", []));
      assert.equal(cleared.version, 2);
      assert.deepEqual(cleared.assigned, []);
      assert.ok(cleared.rolesNoLongerNeeded.includes("Application.Read.All"), JSON.stringify(cleared));
      assert.equal((await h.desk.service.list())[0]?.assignmentVersion, 2);

      const status = value(await h.desk.service.status("mini-pc"));
      assert.equal(status.remote?.assignmentVersion, 2);
      assert.deepEqual(status.remote?.schedules.map((schedule) => schedule.source), ["config"]);
      assert.ok(!/PRIVATE|BEGIN/.test(JSON.stringify(status)));
    } finally {
      await h.close();
    }
  });

  it("unpairs on both sides, and here alone when the sandbox cannot be reached", async () => {
    const h = await paired();
    try {
      value(await h.desk.service.assign("mini-pc", [{ agentId: "os-update-posture", intervalSeconds: 3600 }]));
      const shown = h.sandbox.code();
      const unpaired = value(await h.desk.service.unpair("mini-pc"));
      assert.equal(unpaired.sandboxConfirmed, true);
      assert.equal(h.sandbox.host.currentPairing, undefined);
      assert.deepEqual(await h.desk.service.list(), []);
      assert.ok(h.desk.audit.some((event) => event.type === "sandbox.pairing.removed" && event.details.sandboxConfirmed === true));
      assert.equal(code(await h.desk.service.unpair("mini-pc")), "sandbox-not-paired");

      const code2 = await nextCode(h.sandbox, shown);
      value(await h.desk.service.pair({ address: h.sandbox.address, code: code2, organizationId: "org-1" }));
      await h.sandbox.close();
      const offline = value(await h.desk.service.unpair("mini-pc"));
      assert.equal(offline.sandboxConfirmed, false);
      assert.deepEqual(await h.desk.service.list(), []);
    } finally {
      await h.desk.close();
      await h.sandbox.close().catch(() => undefined);
    }
  });
});

describe("SandboxService without a paired sandbox", () => {
  it("opens no connection and writes no file", async () => {
    const desk = await desktop();
    try {
      assert.deepEqual(await desk.service.list(), []);
      assert.equal(code(await desk.service.sync("mini-pc")), "sandbox-not-paired");
      assert.equal(code(await desk.service.status("mini-pc")), "sandbox-not-paired");
      assert.equal(code(await desk.service.assign("mini-pc", [])), "sandbox-not-paired");
      assert.equal(code(await desk.service.unpair("mini-pc")), "sandbox-not-paired");
      assert.equal(desk.requests.length, 0);
      assert.deepEqual(await readdir(desk.rootDir), []);
      assert.equal(desk.secrets.values.size, 0, "no key is made before a pairing");
    } finally {
      await desk.close();
    }
  });

  it("creates the service on the first sandbox call only", async () => {
    let created = 0;
    const capabilities = createSandboxCapabilities({
      organizations: async () => [ORG],
      catalog: async () => [],
      createService: () => {
        created += 1;
        return new SandboxService({
          rootDir: join(tmpdir(), "oaos-never-written"),
          secrets: memorySecrets(),
          organizations: async () => [ORG],
          catalog: async () => [],
          withTenantLease: (_tenantId, work) => work({ signal: new AbortController().signal }),
          importRuns: async () => 0,
          attestRuns: async () => 0,
          recordAudit: () => undefined,
          transport: () => Promise.reject(new Error("no connection is expected")),
        });
      },
    });
    assert.deepEqual(await capabilities.capabilities.organizations!.list(), [ORG]);
    assert.deepEqual(await capabilities.capabilities.agents!.readOnlyCatalog(), []);
    assert.equal(created, 0);
    assert.equal(code(await capabilities.capabilities.sandboxes!.sync("mini-pc")), "sandbox-not-paired");
    assert.equal(created, 1);
    capabilities.close();
  });
});

describe("readOnlyCatalog", () => {
  it("lists bundled read-only agents with the hash a sandbox pins", () => {
    const catalog = readOnlyCatalog();
    const inactive = catalog.find((agent) => agent.id === "find-inactive-devices");
    assert.ok(inactive);
    assert.equal(inactive.manifestSha256, bundledHash("find-inactive-devices"));
    assert.ok(inactive.scopes.includes("DeviceManagementManagedDevices.Read.All"));
    assert.equal(catalog.find((agent) => agent.id === "offboarding-agent"), undefined, "a write agent is not offered");
  });
});

/** Changes every run the sandbox lists, as a sandbox that lies about a record would. */
function onRuns(change: (run: Record<string, unknown>) => void, extra: (body: Record<string, unknown>) => void = () => undefined): Intercept {
  return async (next, request) => {
    const reply = await next(request);
    if (!request.path.startsWith("/v1/runs") || reply.status !== 200) return reply;
    const body = structuredClone(reply.body) as { runs: Array<{ run: Record<string, unknown> }> } & Record<string, unknown>;
    for (const entry of body.runs) change(entry.run);
    extra(body);
    return { ...reply, body };
  };
}

describe("SandboxService run verification binds content", () => {
  for (const [name, change, reason] of [
    ["a tampered result", (run: Record<string, unknown>) => {
      run.result = { forged: true };
    }, "the record differs"],
    ["a tampered status", (run: Record<string, unknown>) => {
      run.status = "failed";
    }, "another status"],
    ["a tampered agent", (run: Record<string, unknown>) => {
      run.agentSlug = "compliance-overview";
    }, "another agent"],
  ] as const) {
    it(`imports a run with ${name} as unverified, with the reason`, async () => {
      const h = await paired();
      try {
        await h.sandbox.runAgent();
        h.desk.intercept.current = onRuns(change);
        const result = value(await h.desk.service.sync("mini-pc"));
        assert.equal(result.runsVerified, 0);
        assert.equal(result.runsUnverified, 1);
        assert.ok(result.problems.some((line) => line.includes("imported unverified") && line.includes(reason)), JSON.stringify(result.problems));
        assert.equal([...h.desk.runs.values()][0]?.attestedBy, undefined);
        // Checked again on every sync, and still not verified: the record differs.
        h.desk.intercept.current = undefined;
        assert.equal(value(await h.desk.service.sync("mini-pc")).runsVerified, 0);
      } finally {
        await h.close();
      }
    });
  }

  it("takes an honest rewrite verified against the newer event, and never a reread that differs", async () => {
    const h = await paired();
    try {
      const outcome = await h.sandbox.runAgent();
      assert.equal(outcome.kind, "completed");
      const runId = outcome.kind === "completed" ? outcome.run.id : "";
      const first = value(await h.desk.service.sync("mini-pc"));
      assert.equal(first.runsVerified, 1);
      const before = h.desk.runs.get(runId)!;

      h.sandbox.rewriteRun(runId, (run) => ({ ...run, status: "failed", error: "The report could not be recorded." }));
      const rewritten = value(await h.desk.service.sync("mini-pc"));
      assert.equal(rewritten.runsImported, 1);
      assert.equal(rewritten.runsVerified, 1);
      const after = h.desk.runs.get(runId)!;
      assert.equal(after.status, "failed");
      assert.ok(after.attestedBy!.checkpointSeq > before.attestedBy!.checkpointSeq);

      // A cursor reset rereads the run with a tampered result: it stays as verified, not replaced.
      h.desk.intercept.current = onRuns(
        (run) => {
          run.result = { forged: true };
        },
        (body) => {
          body.generation = "after-reset";
          body.condition = { code: "cursor-reset", message: "Cursors started over." };
        },
      );
      const reread = value(await h.desk.service.sync("mini-pc"));
      assert.equal(reread.runsImported, 0);
      assert.equal(reread.runsSkipped, 1);
      assert.deepEqual(h.desk.runs.get(runId), after);
    } finally {
      await h.close();
    }
  });

  it("verifies a run on a later sync when a capped audit read left its event for later", async () => {
    const h = await paired({ limits: { auditBatches: 1 } });
    try {
      await h.sandbox.runAgent();
      h.desk.intercept.current = smallPages;
      const first = value(await h.desk.service.sync("mini-pc"));
      assert.equal(first.runsUnverified, 1);
      assert.ok(first.problems.some((line) => line.includes("More audit entries remain")));
      let verified = 0;
      for (let round = 0; round < 20 && verified === 0; round += 1) verified = value(await h.desk.service.sync("mini-pc")).runsVerified;
      assert.equal(verified, 1, "the waiting run was verified once its event was read");
      assert.ok([...h.desk.runs.values()][0]?.attestedBy);
    } finally {
      await h.close();
    }
  });
});

describe("SandboxService under the tenant lease", () => {
  it("stops a pending sync on Disconnect, takes nothing and settles for the drain", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      h.desk.intercept.current = async (next, request) => {
        if (request.path.startsWith("/v1/runs")) {
          reached();
          await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        return next(request);
      };
      const pending = h.desk.service.sync("mini-pc");
      await waiting;
      h.desk.lifecycle.close(TEST_SANDBOX_TENANT);
      assert.equal(code(await pending), "organization-disconnected");
      assert.equal((await h.desk.lifecycle.drain(TEST_SANDBOX_TENANT, 1000)).drained, true);
      assert.equal(h.desk.runs.size, 0);
      // While it is closed nothing starts.
      const before = h.desk.requests.length;
      assert.equal(code(await h.desk.service.sync("mini-pc")), "organization-not-connected");
      assert.equal(h.desk.requests.length, before);
      assert.equal((await h.desk.service.list())[0]?.state, "paired", "a disconnect is not an integrity failure");
    } finally {
      await h.close();
    }
  });
});

describe("SandboxService assignment versions", () => {
  it("reserves the version before sending and reconciles after a lost answer", async () => {
    const h = await paired();
    try {
      h.desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (request.method === "PUT") throw new SandboxTransportError("unreachable", "The connection broke before the answer.");
        return reply;
      };
      assert.equal(code(await h.desk.service.assign("mini-pc", [{ agentId: "os-update-posture", intervalSeconds: 3600 }])), "assignment-outcome-unknown");
      assert.equal(h.sandbox.host.status().assignmentVersion, 1, "the sandbox took it");
      assert.equal((await h.desk.service.list())[0]?.assignmentVersion, 1, "the version was reserved");

      h.desk.intercept.current = undefined;
      const mark = h.desk.requests.length;
      const next = value(await h.desk.service.assign("mini-pc", [{ agentId: "compliance-overview", intervalSeconds: 3600 }]));
      assert.equal(next.version, 2);
      assert.deepEqual(h.desk.requests.slice(mark).map((request) => `${request.method} ${request.path}`), ["GET /v1/status", "PUT /v1/assignments"]);
      assert.equal(h.sandbox.host.status().assignmentVersion, 2);
    } finally {
      await h.close();
    }
  });
});

describe("SandboxService keys and storage", () => {
  it("keeps the identity as one bundle and never makes a new one while a sandbox is paired", async () => {
    const h = await paired();
    const other = await startTestSandbox({ sandboxId: "other-pc" });
    try {
      const bundle = JSON.parse(h.desk.secrets.values.get(SANDBOX_IDENTITY_SECRET)!) as Record<string, unknown>;
      assert.deepEqual(Object.keys(bundle).sort(), ["identityPem", "tlsCertificatePem", "tlsKeyPem", "version"]);
      h.desk.secrets.values.clear();
      assert.equal(code(await h.desk.service.sync("mini-pc")), "desktop-identity-missing");
      assert.equal(code(await h.desk.service.pair({ address: other.address, code: other.code(), organizationId: "org-1" })), "desktop-identity-missing");
      assert.equal(h.desk.secrets.values.size, 0, "no new key was made");
      assert.equal(other.host.currentPairing, undefined);
    } finally {
      await other.close();
      await h.close();
    }
  });

  it("moves audit rows and the pin together: a crash before the commit leaves both as they were", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      const pairingId = h.sandbox.host.currentPairing!.record.pairingId;
      const seqBefore = (await h.desk.service.list())[0]!.auditSeq;
      h.desk.store.crashes = 1;
      assert.equal(code(await h.desk.service.sync("mini-pc")), "sandbox-audit-store-failed");
      assert.equal((await h.desk.service.list())[0]!.auditSeq, seqBefore);
      assert.equal(h.desk.store.count(pairingId), 0);
      const recovered = value(await h.desk.service.sync("mini-pc"));
      assert.equal(recovered.runsVerified, 1);
      assert.equal(h.desk.store.count(pairingId), recovered.auditRowsAccepted);
      const ids = h.desk.audit.filter((event) => event.type === "sandbox.audit.accepted").map((event) => event.id);
      assert.equal(new Set(ids).size, ids.length, "each accepted batch is recorded once");
    } finally {
      await h.close();
    }
  });

  it("refuses a stored seq with another hash as a fork", () => {
    const store = new SandboxAuditStore(":memory:");
    try {
      const row = { seq: 1, previous_sha256: "0".repeat(64), sha256: "a".repeat(64), event_json: "{}" };
      store.start("pairing-1", { seq: 0, sha256: "0".repeat(64) });
      store.acceptBatch("pairing-1", "mini-pc", [row], { seq: 1, sha256: row.sha256 }, new Date().toISOString());
      store.acceptBatch("pairing-1", "mini-pc", [row], { seq: 1, sha256: row.sha256 }, new Date().toISOString());
      assert.throws(() => store.acceptBatch("pairing-1", "mini-pc", [{ ...row, sha256: "b".repeat(64) }], { seq: 1, sha256: "b".repeat(64) }, new Date().toISOString()), /another hash/);
      assert.deepEqual(store.pin("pairing-1"), { seq: 1, sha256: "a".repeat(64) });
      assert.equal(store.count("pairing-1"), 1);
    } finally {
      store.close();
    }
  });

  it("keeps its folder 0700 and audit.db 0600, and removes a pairing's rows on unpair", async () => {
    const h = await paired();
    try {
      await h.sandbox.runAgent();
      value(await h.desk.service.sync("mini-pc"));
      assert.equal((await stat(h.desk.rootDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(h.desk.rootDir, "audit.db"))).mode & 0o777, 0o600);
      const pairingId = h.sandbox.host.currentPairing!.record.pairingId;
      assert.ok(h.desk.store.count(pairingId) > 0);
      value(await h.desk.service.unpair("mini-pc"));
      assert.equal(h.desk.store.count(pairingId), 0);
      assert.equal(h.desk.store.pin(pairingId), undefined);
    } finally {
      await h.close();
    }
  });
});

describe("SandboxService bounds and checks", () => {
  it("caps runs per sync, saves the cursor page by page and lists at most 20 problems", async () => {
    const h = await paired({ limits: { runs: 2 } });
    try {
      for (let index = 0; index < 3; index += 1) await h.sandbox.runAgent();
      h.desk.intercept.current = onRuns(() => undefined, (body) => {
        body.problems = Array.from({ length: 30 }, (_, index) => ({ runId: `run-${"x".repeat(100)}-${index}`, message: "unreadable" }));
      });
      const first = value(await h.desk.service.sync("mini-pc"));
      assert.equal(first.runsImported, 2);
      assert.ok(first.problems.length <= 21);
      assert.match(first.problems.at(-1)!, /more not listed/);
      assert.ok(first.problems.some((line) => line.includes("More runs remain")));
      assert.ok(first.problems.every((line) => line.length <= 300));
      h.desk.intercept.current = undefined;
      const second = value(await h.desk.service.sync("mini-pc"));
      assert.equal(second.runsImported, 1, "the next sync takes the rest");
      assert.equal(h.desk.runs.size, 3);
    } finally {
      await h.close();
    }
  });

  it("refuses a sandbox id the host does not allow, and probes without a client certificate", async () => {
    const sandbox = await startTestSandbox();
    const desk = await desktop();
    try {
      desk.intercept.current = async (next, request) => {
        const reply = await next(request);
        if (request.method === "GET" && request.path === "/v1/pair") return { ...reply, body: { ...(reply.body as object), sandboxId: "bad id!" } };
        return reply;
      };
      assert.equal(code(await desk.service.pair({ address: sandbox.address, code: sandbox.code(), organizationId: "org-1" })), "sandbox-id-invalid");
      assert.equal(desk.requests[0]?.credentials, undefined, "the probe carries no client certificate");
      desk.intercept.current = undefined;
      value(await desk.service.pair({ address: sandbox.address, code: sandbox.code(), organizationId: "org-1" }));
      const post = desk.requests.find((request) => request.method === "POST");
      assert.ok(post?.credentials, "the proof is sent with the client certificate");
    } finally {
      await desk.close();
      await sandbox.close();
    }
  });
});
