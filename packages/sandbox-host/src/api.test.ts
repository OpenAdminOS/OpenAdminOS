import assert from "node:assert/strict";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TLSSocket } from "node:tls";

import type { RunLlmApi } from "@openadminos/agent-sdk";
import {
  createTlsCertificate,
  DesktopPairingSession,
  exportDevicePublicKey,
  generateDeviceIdentity,
  parsePairingCode,
  SandboxPairingSession,
  signScheduleAssignment,
  tlsSpkiSha256,
  verifyAuditCheckpoint,
  verifyPairingRecord,
  verifySignedContinuation,
  type DeviceIdentity,
  type ScheduleAssignmentEntry,
} from "@openadminos/pairing";
import type { AuditLogPosition } from "@openadminos/runtime";

import { loadSandboxConfig, type SandboxConfig } from "./config.js";
import type { PairingTimings } from "./api.js";
import { SandboxHost, type SandboxHostDeps } from "./host.js";
import { main } from "./main.js";
import { PAIRING_FILES, writeAssignments } from "./pairing-files.js";
import { SandboxRefusal } from "./refusal.js";
import type { SchedulerClock } from "./scheduler.js";
import { appClaims, bundledHash, fakeTokenProviders, ollamaFetch, tempDir, TENANT, writeConfig } from "./test-support.js";

const READ = "DeviceManagementManagedDevices.Read.All";

const llm: RunLlmApi = {
  available: true,
  defaultModel: "llama3.1:8b",
  async complete() {
    return { text: "Nothing stands out.", model: "llama3.1:8b" };
  },
  async *stream() {
    yield { delta: "Nothing stands out.", accumulated: "Nothing stands out.", done: true, model: "llama3.1:8b" };
  },
};

const graphFetch = (async () => Response.json({ value: [] })) as typeof fetch;

/** A schedule that never fires on its own, so tests see next run times without runs. */
const idleClock: SchedulerClock = { now: () => Date.now(), setTimer: () => 0, clearTimer: () => undefined };

interface Log {
  message: string;
  fields: Record<string, unknown> | undefined;
}

interface Peer {
  key: string;
  cert: string;
  pin: string;
}

function peerTls(): Peer {
  const created = createTlsCertificate({ commonName: "openadminos-desktop" });
  return { key: created.privateKeyPem, cert: created.certificatePem, pin: created.spkiSha256 };
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  serverPin: string;
}

function call(port: number, method: string, path: string, options: { body?: unknown; tls?: Peer | null; raw?: string } = {}): Promise<Reply> {
  const tls = options.tls === undefined ? undefined : options.tls;
  const text = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        ...(tls ? { key: tls.key, cert: tls.cert } : {}),
        headers: text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (res) => {
        const socket = res.socket as TLSSocket;
        const certificate = socket.getPeerX509Certificate();
        const serverPin = certificate ? tlsSpkiSha256(certificate) : "";
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, serverPin });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

const errorCode = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;

interface Harness {
  dir: string;
  config: SandboxConfig;
  host: SandboxHost;
  port: number;
  logs: Log[];
  clock: { now: number };
  desktop: DeviceIdentity;
  tls: Peer;
  close(): Promise<void>;
  code(): string;
}

interface StartOptions {
  roles?: string[];
  configOverrides?: Record<string, unknown>;
  dir?: string;
  timings?: Partial<PairingTimings>;
  now?: () => Date;
}

async function start(options: StartOptions = {}): Promise<Harness> {
  const temp = options.dir ? { dir: options.dir, cleanup: () => undefined } : tempDir();
  const logs: Log[] = [];
  const clock = { now: Date.now() };
  const config = loadSandboxConfig(writeConfig(temp.dir, { pairing: { listen: "127.0.0.1:0" }, ...options.configOverrides }));
  const deps: SandboxHostDeps = {
    log: (_level, message, fields) => logs.push({ message, fields }),
    modelFetch: ollamaFetch(),
    createLlm: () => llm,
    createTokenProvider: fakeTokenProviders(appClaims(options.roles ?? [READ])),
    graphFetch,
    graphRetryBackoffMs: 0,
    schedulerClock: idleClock,
    pairingClock: () => clock.now,
    ...(options.now ? { now: options.now } : {}),
    pairingTimings: { exhaustedWaitMs: 50, retryMs: 50, ...options.timings },
  };
  const host = new SandboxHost(config, deps);
  host.open();
  let address;
  try {
    address = await host.startApi();
  } catch (error) {
    await host.close();
    temp.cleanup();
    throw error;
  }
  assert.ok(address);
  host.startSchedule();
  return {
    dir: temp.dir,
    config,
    host,
    port: address.port,
    logs,
    clock,
    desktop: generateDeviceIdentity(),
    tls: peerTls(),
    async close() {
      await host.close();
      if (!options.dir) temp.cleanup();
    },
    code() {
      const shown = [...logs].reverse().find((entry) => typeof entry.fields?.code === "string");
      assert.ok(shown, "a pairing code was logged");
      return shown.fields!.code as string;
    },
  };
}

/** The desktop side of pairing; returns the reply to POST /v1/pair. */
async function pair(h: Harness, overrides: { organizationId?: string; tenantId?: string; code?: string; tls?: Peer } = {}) {
  const hello = await call(h.port, "GET", "/v1/pair", { tls: overrides.tls ?? h.tls });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(hello.body.tlsSpkiSha256, hello.serverPin, "the sandbox names the TLS key the desktop reached");
  const parsed = parsePairingCode(overrides.code ?? h.code());
  assert.ok(parsed.ok);
  const organizationId = overrides.organizationId ?? "org-1";
  const tenantId = overrides.tenantId ?? TENANT;
  const session = await DesktopPairingSession.create(parsed.code, {
    pairingId: hello.body.pairingId as string,
    organizationId,
    tenantId,
    sandboxPublicKey: hello.body.sandboxPublicKey as string,
    desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey),
    tlsSpkiSha256: hello.serverPin,
  });
  const reply = await call(h.port, "POST", "/v1/pair", {
    tls: overrides.tls ?? h.tls,
    body: { pairingId: hello.body.pairingId, organizationId, tenantId, desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey), proof: session.desktopProof() },
  });
  return { reply, session, hello };
}

async function paired(options: Parameters<typeof start>[0] = {}): Promise<Harness & { pairingId: string; startPin: AuditLogPosition; sandboxKey: string }> {
  const h = await start(options);
  const { reply, hello } = await pair(h);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  const checkpoint = verifyAuditCheckpoint(reply.body.startCheckpoint, hello.body.sandboxPublicKey as string);
  assert.ok(checkpoint.ok);
  return { ...h, pairingId: hello.body.pairingId as string, startPin: { seq: checkpoint.value.seq, sha256: checkpoint.value.sha256 }, sandboxKey: hello.body.sandboxPublicKey as string };
}

function assignment(h: Harness & { pairingId: string }, version: number, entries: ScheduleAssignmentEntry[], overrides: Record<string, unknown> = {}, key = h.desktop.privateKey) {
  return signScheduleAssignment({ pairingId: h.pairingId, version, organizationId: "org-1", tenantId: TENANT, entries, issuedAt: new Date().toISOString(), ...overrides }, key);
}

const entry = (agentId: string, templateSha256 = bundledHash(agentId)): ScheduleAssignmentEntry => ({ agentId, templateSha256, intervalSeconds: 3600 });

describe("sandbox pairing API", () => {
  it("pairs two peers over pinned TLS and keeps the pairing private", async () => {
    const h = await start();
    try {
      const { reply, session, hello } = await pair(h);
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.ok(session.verifySandboxProof(reply.body.sandboxProof), "the sandbox proves the same code");
      const record = verifyPairingRecord(reply.body.pairing, hello.body.sandboxPublicKey as string);
      assert.ok(record.ok);
      assert.equal(record.value.organizationId, "org-1");
      assert.equal(record.value.desktopPublicKey, exportDevicePublicKey(h.desktop.publicKey));
      assert.equal(statSync(join(h.config.dataDir, PAIRING_FILES.pairing)).mode & 0o777, 0o600);
      assert.equal(h.host.currentPairing?.desktopTlsSpkiSha256, h.tls.pin);

      const status = await call(h.port, "GET", "/v1/status", { tls: h.tls });
      assert.equal(status.status, 200);
      assert.equal(status.body.paired, true);
      assert.equal((status.body.sandbox as { id: string }).id, "mini-pc");
      const text = JSON.stringify(status.body);
      assert.ok(!/BEGIN|PRIVATE|secret|token/i.test(text), "status carries no key, secret or token");

      const health = await call(h.port, "GET", "/v1/health", { tls: h.tls });
      assert.equal(health.status, 200);
      assert.equal(health.body.sandboxId, "mini-pc");
      assert.ok(h.logs.some((entry) => entry.message === "Paired with a desktop."));
      // A second desktop cannot pair while one is paired.
      const again = await call(h.port, "POST", "/v1/pair", { tls: peerTls(), body: {} });
      assert.equal(errorCode(again), "already-paired");
    } finally {
      await h.close();
    }
  });

  it("refuses a wrong code, another organization or tenant, an expired code and too many attempts", async () => {
    const h = await start();
    try {
      const wrongSecret = parsePairingCode(h.code());
      assert.ok(wrongSecret.ok);
      // Same fingerprint, another secret: the desktop reached the right sandbox with a mistyped code.
      const mistyped = `${wrongSecret.code.fingerprint}${wrongSecret.code.secret === "000000000000" ? "111111111111" : "000000000000"}`;
      assert.equal(errorCode((await pair(h, { code: mistyped })).reply), "proof-invalid");
      assert.equal(errorCode((await pair(h, { organizationId: "org-2" })).reply), "binding-mismatch");
      assert.equal(errorCode((await pair(h, { tenantId: "33333333-3333-3333-3333-333333333333" })).reply), "binding-mismatch");
      assert.equal(errorCode((await pair(h, { code: mistyped })).reply), "proof-invalid");
      assert.equal(errorCode((await pair(h, { code: mistyped })).reply), "proof-invalid");
      // Five attempts used: the right code is refused too.
      const exhausted = await pair(h);
      assert.equal(exhausted.reply.status, 429);
      assert.equal(errorCode(exhausted.reply), "code-attempts-exhausted");
      assert.equal(h.host.currentPairing, undefined);

      // A new code follows; it expires after 10 minutes.
      await waitFor(() => h.logs.filter((entry) => typeof entry.fields?.code === "string").length >= 2);
      const hello = await call(h.port, "GET", "/v1/pair", { tls: h.tls });
      h.clock.now += 10 * 60_000;
      const parsed = parsePairingCode(h.code());
      assert.ok(parsed.ok);
      const session = await DesktopPairingSession.create(parsed.code, {
        pairingId: hello.body.pairingId as string,
        organizationId: "org-1",
        tenantId: TENANT,
        sandboxPublicKey: hello.body.sandboxPublicKey as string,
        desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey),
        tlsSpkiSha256: hello.serverPin,
      });
      const expired = await call(h.port, "POST", "/v1/pair", {
        tls: h.tls,
        body: { pairingId: hello.body.pairingId, organizationId: "org-1", tenantId: TENANT, desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey), proof: session.desktopProof() },
      });
      assert.equal(expired.status, 410);
      assert.equal(errorCode(expired), "code-expired");
      // Pairing needs the desktop's client certificate.
      assert.equal(errorCode(await call(h.port, "POST", "/v1/pair", { tls: null, body: {} })), "client-certificate-missing");
    } finally {
      await h.close();
    }
  });

  it("refuses to listen on an address that is not private", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir, { pairing: { listen: "127.0.0.1:0" } }));
    const host = new SandboxHost({ ...config, pairing: { listen: { host: "8.8.8.8", port: 0 } } }, { log: () => undefined });
    try {
      host.open();
      await assert.rejects(host.startApi(), (error) => error instanceof SandboxRefusal && error.reason === "listen-address-not-private");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("listens on nothing without a pairing section", async () => {
    const { dir, cleanup } = tempDir();
    const host = new SandboxHost(loadSandboxConfig(writeConfig(dir)), { log: () => undefined });
    try {
      host.open();
      assert.equal(await host.startApi(), undefined);
      assert.equal(host.status().paired, false);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("answers an unpinned client on no route but POST /v1/pair", async () => {
    const h = await paired();
    try {
      for (const tls of [peerTls(), null]) {
        for (const [method, path, body] of [
          ["GET", "/v1/pair"],
          ["GET", "/v1/status"],
          ["GET", "/v1/health"],
          ["GET", "/v1/runs"],
          ["GET", "/v1/audit"],
          ["PUT", "/v1/assignments", {}],
          ["DELETE", "/v1/pairing"],
        ] as Array<[string, string, unknown?]>) {
          const reply = await call(h.port, method, path, { tls, ...(body !== undefined ? { body } : {}) });
          assert.equal(reply.status, 401, `${method} ${path}`);
          assert.equal(errorCode(reply), "client-not-paired", `${method} ${path}`);
        }
      }
      assert.equal(errorCode(await call(h.port, "POST", "/v1/pair", { tls: peerTls(), body: {} })), "already-paired");
      assert.equal(errorCode(await call(h.port, "GET", "/v1/nothing", { tls: h.tls })), "not-found");
      assert.equal(errorCode(await call(h.port, "POST", "/v1/status", { tls: h.tls, body: {} })), "method-not-allowed");
      assert.equal(errorCode(await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, raw: "{" })), "body-invalid");
      assert.equal(errorCode(await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, raw: JSON.stringify({ pad: "x".repeat(70 * 1024) }) })), "body-too-large");
      assert.equal(errorCode(await call(h.port, "GET", "/v1/runs?after=-1", { tls: h.tls })), "query-invalid");
      // POST /v1/pair answers already-paired before it reads a body, however large.
      assert.equal(errorCode(await call(h.port, "POST", "/v1/pair", { tls: peerTls(), raw: JSON.stringify({ pad: "x".repeat(70 * 1024) }) })), "already-paired");
      const refused = h.logs.filter((entry) => entry.fields?.reason === "client-not-paired");
      assert.ok(refused.length > 0 && refused.every((entry) => typeof entry.fields?.peer === "string"), "401s are logged with the peer address");
    } finally {
      await h.close();
    }
  });

  it("pages runs by cursor and audit rows with checkpoints signed at each batch end", async () => {
    const h = await paired();
    try {
      for (let index = 0; index < 2; index += 1) {
        const outcome = await h.host.runAgent(h.config.agents[0]!, "schedule");
        assert.equal(outcome.kind, "completed", outcome.kind === "completed" ? "" : outcome.message);
      }
      const first = await call(h.port, "GET", "/v1/runs?after=0&limit=1", { tls: h.tls });
      assert.deepEqual(first.body.problems, []);
      assert.equal(first.status, 200);
      const firstRuns = first.body.runs as Array<{ cursor: number; run: { status: string } }>;
      assert.equal(firstRuns.length, 1);
      const rest = await call(h.port, "GET", `/v1/runs?after=${first.body.next as number}&limit=1000`, { tls: h.tls });
      const restRuns = rest.body.runs as Array<{ cursor: number; run: { id: string; status: string } }>;
      assert.ok(restRuns.length >= 1);
      assert.ok(restRuns.every((entry) => entry.cursor > firstRuns[0]!.cursor));
      const end = await call(h.port, "GET", `/v1/runs?after=${rest.body.next as number}`, { tls: h.tls });
      assert.deepEqual(end.body.runs, []);

      let pin = h.startPin;
      let batches = 0;
      for (;;) {
        const reply = await call(h.port, "GET", `/v1/audit?after=${pin.seq}&limit=4`, { tls: h.tls });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        const rows = reply.body.rows as Parameters<typeof verifySignedContinuation>[1];
        const result = verifySignedContinuation(pin, rows, reply.body.checkpoint, h.sandboxKey, { pairingId: h.pairingId, sandboxId: "mini-pc" });
        assert.ok(result.ok, JSON.stringify(result));
        if (rows.length === 0) break;
        pin = result.pin;
        batches += 1;
      }
      assert.ok(batches >= 2, "the log was read in several batches");
      assert.deepEqual(pin, h.host.auditLog().tip());
      assert.equal(errorCode(await call(h.port, "GET", `/v1/audit?after=${pin.seq + 10}`, { tls: h.tls })), "audit-position-unknown");
    } finally {
      await h.close();
    }
  });

  it("applies signed assignments: replay, another organization, a template mismatch and a refused agent are refused", async () => {
    const h = await paired();
    try {
      const put = (body: unknown) => call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body });
      const applied = await put(assignment(h, 1, [entry("compliance-overview")]));
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(applied.body.assigned, ["compliance-overview"]);
      assert.equal(statSync(join(h.config.dataDir, PAIRING_FILES.assignments)).mode & 0o777, 0o600);
      const status = h.host.status();
      const assigned = status.schedules.find((schedule) => schedule.agentId === "compliance-overview");
      assert.equal(assigned?.source, "assigned");
      assert.ok(assigned?.nextRunAt, "the schedule took it without a restart");

      assert.equal(errorCode(await put(assignment(h, 1, [entry("os-update-posture")]))), "assignment-replayed");
      assert.equal(errorCode(await put(assignment(h, 2, [], { organizationId: "org-2" }))), "assignment-binding-mismatch");
      assert.equal(errorCode(await put(assignment(h, 2, [], { tenantId: "33333333-3333-3333-3333-333333333333" }))), "assignment-binding-mismatch");
      assert.equal(errorCode(await put(assignment(h, 2, [entry("compliance-overview", "0".repeat(64))]))), "assignment-template-mismatch");
      assert.equal(errorCode(await put(assignment(h, 2, [entry("offboarding-agent")]))), "assignment-agent-refused");
      assert.equal(errorCode(await put(assignment(h, 2, [{ ...entry("compliance-overview"), intervalSeconds: 60 }]))), "assignment-interval-invalid");
      assert.equal(errorCode(await put(assignment(h, 2, [], {}, generateDeviceIdentity().privateKey))), "assignment-invalid");
      assert.equal(h.host.status().assignmentVersion, 1, "nothing refused was applied");

      const audit = new Set(h.host.auditLog().readVerified().events.map((event) => event.type));
      assert.ok(audit.has("sandbox.pairing.created"));
      assert.ok(audit.has("sandbox.assignment.applied"));
    } finally {
      await h.close();
    }
  });

  it("runs a sandbox with no config agents on assigned schedules only", async () => {
    const h = await paired({ configOverrides: { agents: [] } });
    try {
      const before = h.host.status();
      assert.deepEqual(before.schedules, []);
      assert.equal(before.model.digest, "not checked yet");
      const applied = await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("compliance-overview")]) });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      const schedules = h.host.status().schedules;
      assert.deepEqual(schedules.map((schedule) => [schedule.agentId, schedule.source]), [["compliance-overview", "assigned"]]);
      assert.ok(schedules[0]!.nextRunAt);
      const outcome = await h.host.runAgent({ id: "compliance-overview", templateSha256: bundledHash("compliance-overview"), intervalSeconds: 3600 }, "schedule");
      assert.equal(outcome.kind, "completed", outcome.kind === "completed" ? "" : outcome.message);
      assert.equal(h.host.status().model.digest, "sha256:abc", "known after the first preflight");
    } finally {
      await h.close();
    }
  });

  it("lets a config schedule win over an assigned one, and unpairing removes assigned schedules only", async () => {
    const h = await paired();
    try {
      const applied = await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("find-inactive-devices"), entry("os-update-posture")]) });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(applied.body.shadowed, ["find-inactive-devices"]);
      const schedules = h.host.status().schedules;
      assert.deepEqual(
        schedules.map((schedule) => [schedule.agentId, schedule.source, schedule.status ?? ""]),
        [["find-inactive-devices", "config", ""], ["os-update-posture", "assigned", ""], ["find-inactive-devices", "assigned", "assignment-shadowed"]],
      );

      const removed = await call(h.port, "DELETE", "/v1/pairing", { tls: h.tls });
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body.removed, [PAIRING_FILES.assignments, PAIRING_FILES.pairing]);
      const after = h.host.status();
      assert.equal(after.paired, false);
      assert.deepEqual(after.schedules.map((schedule) => [schedule.agentId, schedule.source]), [["find-inactive-devices", "config"]]);
      assert.ok(after.schedules[0]!.nextRunAt, "the config schedule keeps running");
      assert.ok(h.host.auditLog().readVerified().events.some((event) => event.type === "sandbox.pairing.removed"));
      // A new code is shown, and the old desktop is no longer answered.
      assert.equal(errorCode(await call(h.port, "GET", "/v1/status", { tls: h.tls })), "not-paired");
      await waitFor(() => h.logs.filter((entry) => typeof entry.fields?.code === "string").length >= 2);
    } finally {
      await h.close();
    }
  });

  it("allows the scopes of assigned agents in the identity check", async () => {
    // The identity also holds what dormant-app-registrations needs.
    const h = await paired({ roles: [READ, "Application.Read.All"] });
    try {
      const before = await h.host.runAgent(h.config.agents[0]!, "schedule");
      assert.equal(before.kind === "completed" ? "completed" : before.reason, "identity-holds-unneeded-permission");
      const applied = await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("dormant-app-registrations")]) });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      const after = await h.host.runAgent(h.config.agents[0]!, "schedule");
      assert.equal(after.kind, "completed", after.kind === "completed" ? "" : after.message);
    } finally {
      await h.close();
    }
  });

  it("unpairs with --unpair while the service is stopped, and says what it removed", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      const applied = await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("os-update-posture")]) });
      assert.equal(applied.status, 200);
      const lines: string[] = [];
      const log = (_level: string, message: string) => {
        lines.push(message);
      };
      // The running service holds the lock.
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--unpair"], { log }), 3);
      await h.close();
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--unpair"], { log }), 0);
      assert.ok(lines.some((line) => line.startsWith(`Unpaired: removed ${PAIRING_FILES.assignments} and ${PAIRING_FILES.pairing}.`)), lines.join("\n"));
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--unpair"], { log }), 0);
      assert.ok(lines.some((line) => line.startsWith("Nothing to remove")));
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--unpair", "--once", "find-inactive-devices"], { log }), 2);
    } finally {
      cleanup();
    }
  });

  it("refuses the paired desktop when the config's organization changed, but still lets it unpair", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const first = await paired({ dir });
      const tls = first.tls;
      await first.close();
      const second = await start({ dir, configOverrides: { organizationId: "org-2" } });
      try {
        const status = await call(second.port, "GET", "/v1/status", { tls });
        assert.equal(status.status, 409);
        assert.equal(errorCode(status), "pairing-binding-changed");
        assert.equal(second.host.status().bindingChanged, true);
        const removed = await call(second.port, "DELETE", "/v1/pairing", { tls });
        assert.equal(removed.status, 200);
      } finally {
        await second.close();
      }
    } finally {
      cleanup();
    }
  });

  it("waits before the next code after a code is used up, and limits attempts across codes", async () => {
    const h = await start({ timings: { exhaustedWaitMs: 60_000, maxAttemptsPerWindow: 7 } });
    try {
      const wrong = async () => {
        const hello = await call(h.port, "GET", "/v1/pair", { tls: h.tls });
        if (hello.status !== 200) return hello;
        return call(h.port, "POST", "/v1/pair", {
          tls: h.tls,
          body: { pairingId: hello.body.pairingId, organizationId: "org-1", tenantId: TENANT, desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey), proof: "x".repeat(43) },
        });
      };
      for (let index = 0; index < 5; index += 1) assert.equal(errorCode(await wrong()), "proof-invalid");
      assert.equal(errorCode(await wrong()), "code-attempts-exhausted");
      const waiting = await call(h.port, "GET", "/v1/pair", { tls: h.tls });
      assert.equal(waiting.status, 503);
      assert.equal(errorCode(waiting), "pairing-code-not-ready");
      assert.match((waiting.body.error as { message: string }).message, /next one follows in \d+ seconds/);
      const refusals = h.logs.filter((entry) => entry.message.startsWith("A pairing attempt was refused"));
      assert.ok(refusals.length >= 6 && refusals.every((entry) => typeof entry.fields?.peer === "string"), "refusals name the peer");
    } finally {
      await h.close();
    }

    const limited = await start({ timings: { exhaustedWaitMs: 10, maxAttemptsPerWindow: 7 } });
    try {
      const codes: string[] = [];
      let last: Reply | undefined;
      for (let index = 0; index < 12 && errorCode(last ?? { status: 0, body: {}, serverPin: "" }) !== "pairing-rate-limited"; index += 1) {
        let hello = await call(limited.port, "GET", "/v1/pair", { tls: limited.tls });
        for (let tries = 0; hello.status !== 200 && tries < 100; tries += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          hello = await call(limited.port, "GET", "/v1/pair", { tls: limited.tls });
        }
        codes.push(hello.body.pairingId as string);
        last = await call(limited.port, "POST", "/v1/pair", {
          tls: limited.tls,
          body: { pairingId: hello.body.pairingId, organizationId: "org-1", tenantId: TENANT, desktopPublicKey: exportDevicePublicKey(limited.desktop.publicKey), proof: "x".repeat(43) },
        });
      }
      assert.equal(errorCode(last!), "pairing-rate-limited");
      assert.equal(last!.status, 429);
      assert.ok(new Set(codes).size >= 2, "the limit holds across codes");
    } finally {
      await limited.close();
    }
  });

  it("answers DELETE /v1/pairing when the next code fails, and tries the code again", async () => {
    const h = await paired();
    const original = SandboxPairingSession.create;
    try {
      let failures = 1;
      SandboxPairingSession.create = async (options) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("scrypt is out of memory");
        }
        return original.call(SandboxPairingSession, options);
      };
      const codesBefore = h.logs.filter((entry) => typeof entry.fields?.code === "string").length;
      const removed = await call(h.port, "DELETE", "/v1/pairing", { tls: h.tls });
      assert.equal(removed.status, 200);
      await waitFor(() => h.logs.some((entry) => entry.fields?.reason === "pairing-code-failed"));
      await waitFor(() => h.logs.filter((entry) => typeof entry.fields?.code === "string").length > codesBefore);
    } finally {
      SandboxPairingSession.create = original;
      await h.close();
    }
  });

  it("names the permissions that fall away when assigned schedules are removed", async () => {
    const h = await paired();
    try {
      const put = (body: unknown) => call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body });
      const first = await put(assignment(h, 1, [entry("dormant-app-registrations")]));
      assert.deepEqual(first.body.rolesNoLongerNeeded, []);
      const second = await put(assignment(h, 2, []));
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.rolesNoLongerNeeded, ["Application.Read.All"]);
      assert.match(second.body.notice as string, /^Remove Application\.Read\.All from the sandbox app registration, or config schedules will be refused/);
      await put(assignment(h, 3, [entry("dormant-app-registrations")]));
      const removed = await call(h.port, "DELETE", "/v1/pairing", { tls: h.tls });
      assert.deepEqual(removed.body.rolesNoLongerNeeded, ["Application.Read.All"]);
      const line = h.logs.find((entry) => entry.message.startsWith("Unpaired:"));
      assert.ok(line && /Remove Application\.Read\.All/.test(line.message) && !/keep running/.test(line.message), line?.message);
    } finally {
      await h.close();
    }
  });

  it("names the permissions that fall away in the --unpair output", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("dormant-app-registrations")]) });
      await h.close();
      const lines: string[] = [];
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--unpair"], { log: (_level, message) => lines.push(message) }), 0);
      assert.ok(lines.some((line) => /Remove Application\.Read\.All from the sandbox app registration/.test(line) && !/Config schedules are unchanged/.test(line)), lines.join("\n"));
    } finally {
      cleanup();
    }
  });

  it("checks a stored assignment again at start and does not run one that no longer passes", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      const tls = h.tls;
      const desktop = h.desktop;
      // Signed by the paired desktop, but for an agent whose bundled manifest is not the one pinned:
      // what a sandbox update that changed the manifest leaves behind.
      writeAssignments(h.config.dataDir, assignment(h, 4, [entry("compliance-overview", "0".repeat(64))]));
      await h.close();

      const restarted = await start({ dir });
      try {
        const status = restarted.host.status();
        assert.equal(status.assignmentProblem?.reason, "assignment-template-mismatch");
        assert.match(status.assignmentProblem!.message, /Send a new assignment from the desktop, or unpair\./);
        assert.deepEqual(status.schedules.map((schedule) => schedule.source), ["config"]);
        const health = await call(restarted.port, "GET", "/v1/health", { tls });
        assert.ok((health.body.problems as Array<{ reason: string }>).some((problem) => problem.reason === "assignment-template-mismatch"));
        assert.ok(restarted.logs.some((entry) => entry.fields?.reason === "assignment-template-mismatch"));
        // The stored version still counts, so it cannot be replayed below it.
        const replay = await call(restarted.port, "PUT", "/v1/assignments", {
          tls,
          body: signScheduleAssignment({ pairingId: restarted.host.currentPairing!.record.pairingId, version: 4, organizationId: "org-1", tenantId: TENANT, entries: [], issuedAt: new Date().toISOString() }, desktop.privateKey),
        });
        assert.equal(errorCode(replay), "assignment-replayed");
        writeAssignments(restarted.config.dataDir, signScheduleAssignment({ pairingId: "pairing_other", version: 5, organizationId: "org-1", tenantId: TENANT, entries: [], issuedAt: new Date().toISOString() }, desktop.privateKey));
      } finally {
        await restarted.close();
      }
      const again = await start({ dir });
      try {
        assert.equal(again.host.status().assignmentProblem?.reason, "assignment-binding-mismatch");
      } finally {
        await again.close();
      }
    } finally {
      cleanup();
    }
  });

  it("removes a leftover assignments.json when a desktop pairs", async () => {
    const h = await start();
    try {
      writeFileSync(join(h.config.dataDir, PAIRING_FILES.assignments), "{}", { mode: 0o600 });
      const { reply } = await pair(h);
      assert.equal(reply.status, 201);
      assert.equal(existsSync(join(h.config.dataDir, PAIRING_FILES.assignments)), false);
    } finally {
      await h.close();
    }
  });

  it("writes assignments.json before the audit event and takes it back when the audit log fails", async () => {
    const h = await paired();
    const host = h.host as unknown as { auditEvent: (...args: unknown[]) => void };
    const original = host.auditEvent;
    try {
      host.auditEvent = () => {
        assert.ok(existsSync(join(h.config.dataDir, PAIRING_FILES.assignments)), "written before the audit event");
        throw new SandboxRefusal("audit-failed", "The audit log could not record sandbox.assignment.applied: disk full.");
      };
      const reply = await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("os-update-posture")]) });
      assert.equal(errorCode(reply), "audit-failed");
      assert.equal(existsSync(join(h.config.dataDir, PAIRING_FILES.assignments)), false);
      assert.equal(h.host.status().assignmentVersion, undefined);
    } finally {
      host.auditEvent = original;
      await h.close();
    }
  });

  it("reports a TLS key that changed since pairing", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      const tls = h.tls;
      await h.close();
      rmSync(join(h.config.dataDir, PAIRING_FILES.tlsKey));
      rmSync(join(h.config.dataDir, PAIRING_FILES.tlsCertificate));
      const restarted = await start({ dir });
      try {
        assert.ok(restarted.logs.some((entry) => entry.fields?.reason === "pairing-tls-pin-changed"));
        const health = await call(restarted.port, "GET", "/v1/health", { tls });
        const problem = (health.body.problems as Array<{ reason: string; message: string }>).find((entry) => entry.reason === "pairing-tls-pin-changed");
        assert.ok(problem);
        assert.match(problem.message, /unpair and pair again/);
      } finally {
        await restarted.close();
      }
    } finally {
      cleanup();
    }
  });

  it("runs an assigned agent with --once and names both sources for an unknown one", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      await call(h.port, "PUT", "/v1/assignments", { tls: h.tls, body: assignment(h, 1, [entry("compliance-overview")]) });
      await h.close();
      const lines: string[] = [];
      const deps: SandboxHostDeps = {
        modelFetch: ollamaFetch(),
        createLlm: () => llm,
        createTokenProvider: fakeTokenProviders(appClaims([READ])),
        graphFetch,
        graphRetryBackoffMs: 0,
      };
      const log = (_level: string, message: string) => {
        lines.push(message);
      };
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--once", "compliance-overview"], { log, deps }), 0, lines.join("\n"));
      assert.equal(await main(["--config", join(dir, "sandbox.json"), "--once", "no-such-agent"], { log, deps }), 2);
      assert.ok(lines.some((line) => /neither in the sandbox config nor in a schedule the paired desktop assigned/.test(line)));
    } finally {
      cleanup();
    }
  });

  it("keeps a rejected stored assignment as the version floor through a failed replacement and a restart", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      const desktop = h.desktop;
      const tls = h.tls;
      const pairingId = h.pairingId;
      writeAssignments(h.config.dataDir, assignment(h, 4, [entry("compliance-overview", "0".repeat(64))]));
      await h.close();
      const sign = (version: number) =>
        signScheduleAssignment({ pairingId, version, organizationId: "org-1", tenantId: TENANT, entries: [], issuedAt: new Date().toISOString() }, desktop.privateKey);

      const second = await start({ dir });
      const host = second.host as unknown as { auditEvent: (...args: unknown[]) => void };
      const original = host.auditEvent;
      try {
        assert.equal(second.host.status().assignmentProblem?.reason, "assignment-template-mismatch");
        host.auditEvent = () => {
          throw new SandboxRefusal("audit-failed", "The audit log could not record sandbox.assignment.applied: disk full.");
        };
        assert.equal(errorCode(await call(second.port, "PUT", "/v1/assignments", { tls, body: sign(5) })), "audit-failed");
        assert.ok(existsSync(join(second.config.dataDir, PAIRING_FILES.assignments)), "the stored record was restored, not deleted");
      } finally {
        host.auditEvent = original;
        await second.close();
      }

      const third = await start({ dir });
      try {
        assert.equal(third.host.status().assignmentProblem?.reason, "assignment-template-mismatch", "still the version 4 record");
        assert.equal(errorCode(await call(third.port, "PUT", "/v1/assignments", { tls, body: sign(3) })), "assignment-replayed");
        assert.equal(errorCode(await call(third.port, "PUT", "/v1/assignments", { tls, body: sign(4) })), "assignment-replayed");
      } finally {
        await third.close();
      }
    } finally {
      cleanup();
    }
  });

  it("keeps config schedules running with a damaged assignments.json and refuses new assignments", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const h = await paired({ dir });
      const tls = h.tls;
      const later = assignment(h, 9, []);
      await h.close();
      writeFileSync(join(h.config.dataDir, PAIRING_FILES.assignments), "{ damaged", { mode: 0o600 });
      const restarted = await start({ dir });
      try {
        const status = restarted.host.status();
        assert.equal(status.assignmentProblem?.reason, "pairing-files-invalid");
        assert.match(status.assignmentProblem!.message, /Unpair and pair again; config schedules keep running\./);
        assert.deepEqual(status.schedules.map((schedule) => [schedule.agentId, schedule.source]), [["find-inactive-devices", "config"]]);
        const refused = await call(restarted.port, "PUT", "/v1/assignments", { tls, body: later });
        assert.equal(refused.status, 409);
        assert.equal(errorCode(refused), "assignment-state-unknown");
      } finally {
        await restarted.close();
      }
      // A damaged pairing.json still stops the host.
      writeFileSync(join(h.config.dataDir, PAIRING_FILES.pairing), "{ damaged", { mode: 0o600 });
      await assert.rejects(start({ dir }), (error) => error instanceof SandboxRefusal && error.reason === "pairing-files-invalid");
    } finally {
      cleanup();
    }
  });

  it("leaves the sandbox unpaired with a fresh code when pairing cannot be recorded", async () => {
    const h = await start();
    const host = h.host as unknown as { auditEvent: (...args: unknown[]) => void };
    const original = host.auditEvent;
    try {
      host.auditEvent = () => {
        throw new SandboxRefusal("audit-failed", "The audit log could not record sandbox.pairing.created: disk full.");
      };
      const codesBefore = h.logs.filter((entry) => typeof entry.fields?.code === "string").length;
      const { reply } = await pair(h);
      assert.equal(errorCode(reply), "audit-failed");
      assert.equal(h.host.currentPairing, undefined);
      assert.equal(existsSync(join(h.config.dataDir, PAIRING_FILES.pairing)), false);
      await waitFor(() => h.logs.filter((entry) => typeof entry.fields?.code === "string").length > codesBefore);
      host.auditEvent = original;
      const again = await pair(h);
      assert.equal(again.reply.status, 201, JSON.stringify(again.reply.body));
    } finally {
      host.auditEvent = original;
      await h.close();
    }
  });

  it("refuses a pairing whose body arrived after another desktop paired", async () => {
    const h = await start();
    try {
      const hello = await call(h.port, "GET", "/v1/pair", { tls: h.tls });
      const slowTls = peerTls();
      const body = JSON.stringify({ pairingId: hello.body.pairingId, organizationId: "org-1", tenantId: TENANT, desktopPublicKey: exportDevicePublicKey(generateDeviceIdentity().publicKey), proof: "x".repeat(43) });
      const slow = new Promise<Reply>((resolve, reject) => {
        const req = httpsRequest(
          { host: "127.0.0.1", port: h.port, method: "POST", path: "/v1/pair", agent: false, rejectUnauthorized: false, minVersion: "TLSv1.3", key: slowTls.key, cert: slowTls.cert, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, serverPin: "" }));
          },
        );
        req.on("error", reject);
        req.write(body.slice(0, 10));
        // The rest follows once the other desktop has paired.
        void pair(h).then(({ reply }) => {
          assert.equal(reply.status, 201);
          req.end(body.slice(10));
        }, reject);
      });
      assert.equal(errorCode(await slow), "already-paired");
    } finally {
      await h.close();
    }
  });

  it("logs rate-limit refusals at most once a minute per peer, with a count", async () => {
    const h = await start({ timings: { maxAttemptsPerWindow: 1, windowMs: 61_000 } });
    try {
      const attempt = async () => {
        const hello = await call(h.port, "GET", "/v1/pair", { tls: h.tls });
        return call(h.port, "POST", "/v1/pair", {
          tls: h.tls,
          body: { pairingId: hello.body.pairingId, organizationId: "org-1", tenantId: TENANT, desktopPublicKey: exportDevicePublicKey(h.desktop.publicKey), proof: "x".repeat(43) },
        });
      };
      assert.equal(errorCode(await attempt()), "proof-invalid");
      for (let index = 0; index < 4; index += 1) assert.equal(errorCode(await attempt()), "pairing-rate-limited");
      const warnings = h.logs.filter((entry) => entry.fields?.reason === "pairing-rate-limited");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.fields?.count, 1);
      // Past the minute and the attempt window; the code is still valid.
      h.clock.now += 61_000;
      assert.equal(errorCode(await attempt()), "proof-invalid");
      assert.equal(errorCode(await attempt()), "pairing-rate-limited");
      const later = h.logs.filter((entry) => entry.fields?.reason === "pairing-rate-limited");
      assert.equal(later.length, 2);
      assert.equal(later[1]!.fields?.count, 4, "the refusals since the last line");
    } finally {
      await h.close();
    }
  });

  it("unpairs when the audit log cannot record it, and says so", async () => {
    const h = await paired();
    const host = h.host as unknown as { auditEvent: (...args: unknown[]) => void };
    const original = host.auditEvent;
    try {
      host.auditEvent = () => {
        throw new SandboxRefusal("audit-failed", "The audit log could not record sandbox.pairing.removed: disk full.");
      };
      const removed = await call(h.port, "DELETE", "/v1/pairing", { tls: h.tls });
      assert.equal(removed.status, 200);
      assert.match(removed.body.auditProblem as string, /unpaired, but the audit log could not record it/);
      assert.equal(existsSync(join(h.config.dataDir, PAIRING_FILES.pairing)), false);
      assert.equal(h.host.status().paired, false);
    } finally {
      host.auditEvent = original;
      await h.close();
    }
  });

  it("refuses an audit read that starts in entries retention removed", async () => {
    // Past the audit log's retention of 3,650 days.
    const old = new Date(Date.now() - 3_700 * 86_400_000);
    let now = old;
    const h = await paired({ now: () => now });
    try {
      await h.host.runAgent(h.config.agents[0]!, "schedule");
      now = new Date();
      await h.host.runAgent(h.config.agents[0]!, "schedule");
      assert.ok(h.host.auditLog().pruneExpired() > 0);
      const first = h.host.auditLog().readRange(0, 1)[0]!;
      assert.ok(first.seq > 2);
      const stale = await call(h.port, "GET", "/v1/audit?after=1&limit=10", { tls: h.tls });
      assert.equal(stale.status, 409);
      assert.equal(errorCode(stale), "audit-position-unknown");
      const fromKept = await call(h.port, "GET", `/v1/audit?after=${first.seq - 1}&limit=10`, { tls: h.tls });
      assert.equal(fromKept.status, 200);
    } finally {
      await h.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    // Referenced and short: Node 22 cancels tests that wait on unreferenced timers.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
