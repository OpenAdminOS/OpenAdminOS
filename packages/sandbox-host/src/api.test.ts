import assert from "node:assert/strict";
import { statSync } from "node:fs";
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
import { SandboxHost, type SandboxHostDeps } from "./host.js";
import { main } from "./main.js";
import { PAIRING_FILES } from "./pairing-files.js";
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

async function start(options: { roles?: string[]; configOverrides?: Record<string, unknown>; dir?: string } = {}): Promise<Harness> {
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
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    // Referenced and short: Node 22 cancels tests that wait on unreferenced timers.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
