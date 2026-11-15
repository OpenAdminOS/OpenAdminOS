import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord, SecretAccessor } from "@openadminos/agent-sdk";
import type { EnterpriseOrganization, EnterpriseReadOnlyAgent, EnterpriseResult } from "@openadminos/enterprise";
import { parsePairingCode } from "@openadminos/pairing";
import { canonicalJson, chainHash, type AuditLogEventSeed } from "@openadminos/runtime";
import { bundledHash, startTestSandbox, TEST_SANDBOX_TENANT, type TestSandbox } from "@openadminos/sandbox-host/testing";

import { createSandboxCapabilities } from "./capabilities.js";
import { readOnlyCatalog } from "./catalog.js";
import { SANDBOX_SECRET_KEYS, SandboxService } from "./service.js";
import { tlsSandboxTransport, type SandboxReply, type SandboxRequest, type SandboxTransport } from "./transport.js";

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

interface Desktop {
  service: SandboxService;
  rootDir: string;
  secrets: ReturnType<typeof memorySecrets>;
  runs: Map<string, RunRecord>;
  audit: AuditLogEventSeed[];
  requests: SandboxRequest[];
  organizations: EnterpriseOrganization[];
  intercept: { current: Intercept | undefined };
  close(): Promise<void>;
}

async function desktop(options: { organizations?: EnterpriseOrganization[] } = {}): Promise<Desktop> {
  const rootDir = await mkdtemp(join(tmpdir(), "oaos-desktop-sandboxes-"));
  const secrets = memorySecrets();
  const runs = new Map<string, RunRecord>();
  const audit: AuditLogEventSeed[] = [];
  const requests: SandboxRequest[] = [];
  const organizations = options.organizations ?? [ORG];
  const intercept: { current: Intercept | undefined } = { current: undefined };
  const service = new SandboxService({
    rootDir,
    secrets,
    organizations: async () => organizations,
    catalog: async () => [catalogEntry("compliance-overview"), catalogEntry("dormant-app-registrations"), catalogEntry("os-update-posture")],
    importRuns: async (imported) => {
      for (const run of imported) runs.set(run.id, run);
      return imported.length;
    },
    recordAudit: (events) => {
      audit.push(...events);
    },
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

async function paired(): Promise<{ sandbox: TestSandbox; desk: Desktop; close(): Promise<void> }> {
  const sandbox = await startTestSandbox();
  const desk = await desktop();
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
      assert.deepEqual([...desk.secrets.values.keys()].sort(), Object.values(SANDBOX_SECRET_KEYS).sort());
      // The keys are never written next to the pairing records.
      for (const file of await readdir(desk.rootDir)) {
        const text = await readFile(join(desk.rootDir, file), "utf8").catch(() => "");
        assert.ok(!/PRIVATE KEY/.test(text), `${file} holds no private key`);
      }
      assert.ok(desk.audit.some((event) => event.type === "sandbox.pairing.created" && event.source === "sandbox"));
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
      assert.equal(value(await h.desk.service.sync("mini-pc")).runsImported, 2, "a new generation reads from 0");
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
      assert.notEqual(run.attestedBy?.pairingKeyFingerprint, "X".repeat(52), "the attestation is the desktop's own");
      assert.equal(run.executedOn?.kind === "sandbox" ? run.executedOn.pairingKeyFingerprint : "", run.attestedBy?.pairingKeyFingerprint);
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
          importRuns: async () => 0,
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
