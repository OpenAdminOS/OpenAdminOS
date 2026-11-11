import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type {
  AgentSummary,
  ConnectorAuditEntry,
  RunRecord,
  TenantRecord,
  WritePlan,
} from "@openadminos/agent-sdk";
import { findConnectorFactory, noSecrets, type TokenCacheStorage } from "@openadminos/runtime";

import { AuditLogBehindError, AuditLogIntegrityError } from "./audit-log.js";
import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

const ZERO_HASH = "0".repeat(64);

describe("audit log export", () => {
  it("exports chronological JSON and CSV events with a verifiable hash chain", async () => {
    const fixture = await makeStoreFixture();
    try {
      const exported = await fixture.store.exportAuditLog({ format: "json" });
      const document = JSON.parse(exported.content) as {
        eventCount: number;
        hashChain: { startHash: string; finalHash: string };
        events: Array<Record<string, unknown> & { sha256: string; timestamp: string; type: string }>;
      };

      assert.equal(document.hashChain.startHash, ZERO_HASH);
      assert.equal(document.eventCount, document.events.length);
      assert.equal(exported.eventCount, document.events.length);
      assert.ok(document.events.length > 0);
      assert.ok(!exported.content.includes("RETIRE 2 DEVICES"));

      const timestamps = document.events.map((event) => Date.parse(event.timestamp));
      assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b));

      const eventTypes = document.events.map((event) => event.type);
      assert.ok(eventTypes.includes("run.queued"));
      assert.ok(eventTypes.includes("run.started"));
      assert.ok(eventTypes.includes("run.completed"));
      assert.ok(eventTypes.includes("write.confirmation.requested"));
      assert.ok(eventTypes.includes("write.confirmation.accepted"));
      assert.ok(eventTypes.includes("connector.delivery"));
      assert.ok(eventTypes.includes("hosted-provider.consent"));

      let previousHash = ZERO_HASH;
      for (const event of document.events) {
        const { sha256, ...withoutHash } = event;
        const expected = createHash("sha256")
          .update(previousHash)
          .update(canonicalJson(withoutHash))
          .digest("hex");
        assert.equal(sha256, expected);
        previousHash = sha256;
      }
      assert.equal(document.hashChain.finalHash, previousHash);
      assert.equal(exported.hashChain.finalHash, previousHash);

      const csv = await fixture.store.exportAuditLog({ format: "csv" });
      const rows = parseCsv(csv.content);
      assert.ok(rows[0]?.includes("sha256"));
      assert.equal(rows.length - 1, document.events.length);
    } finally {
      await fixture.cleanup();
    }
  });

  it("filters audit events by inclusive date range", async () => {
    const fixture = await makeStoreFixture();
    try {
      const exported = await fixture.store.exportAuditLog({
        format: "json",
        from: "2026-07-05T10:02:30.000Z",
        to: "2026-07-05T10:05:00.000Z",
      });
      const document = JSON.parse(exported.content) as {
        events: Array<{ timestamp: string; type: string }>;
      };

      assert.ok(document.events.length > 0);
      assert.ok(
        document.events.every((event) => {
          const timestamp = Date.parse(event.timestamp);
          return (
            timestamp >= Date.parse("2026-07-05T10:02:30.000Z") &&
            timestamp <= Date.parse("2026-07-05T10:05:00.000Z")
          );
        }),
      );
      assert.deepEqual(
        document.events.map((event) => event.type),
        ["hosted-provider.consent", "write.confirmation.accepted", "run.completed"],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("append-only audit log in the export", () => {
  it("records events when they happen and keeps a pruned run's events", async () => {
    const fixture = await makeStoreFixture();
    try {
      // A write records what the state shows, without an export.
      await fixture.store.setActiveProvider("openai");
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"), { readOnly: true });
      const recorded = db.prepare("SELECT type FROM audit_log WHERE run_id = 'run-old' ORDER BY seq").all() as Array<{ type: string }>;
      db.close();
      assert.deepEqual(recorded.map((row) => row.type), ["run.queued", "run.started", "run.completed"]);

      await fixture.store.setRunHistoryRetentionSettings({ neverPrune: false, keepLastRuns: 1, keepDays: null });
      const pruned = await fixture.store.pruneRunHistoryNow();
      assert.equal(pruned.prunedCount, 1);
      const state = JSON.parse(await readFile(join(fixture.dir, "state.json"), "utf8")) as { runs: RunRecord[] };
      assert.deepEqual(state.runs.map((run) => run.id), ["run-write"]);

      const document = JSON.parse((await fixture.store.exportAuditLog({ format: "json" })).content) as {
        events: Array<{ runId?: string; type: string }>;
      };
      assert.deepEqual(
        document.events.filter((event) => event.runId === "run-old").map((event) => event.type),
        ["run.queued", "run.started", "run.completed"],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("adds nothing twice across exports and a restart, and an unfiltered export repeats the stored chain", async () => {
    const fixture = await makeStoreFixture();
    try {
      const first = await fixture.store.exportAuditLog({ format: "json" });
      const again = await fixture.store.exportAuditLog({ format: "json" });
      assert.equal(again.eventCount, first.eventCount);
      assert.equal(again.hashChain.finalHash, first.hashChain.finalHash);
      // A second store on the same files, as after a restart.
      const reopened = new AppStateStore({ filePath: join(fixture.dir, "state.json"), tokenStore, userDataPath: fixture.dir, statsApiUrl: "" });
      try {
        const restarted = await reopened.exportAuditLog({ format: "json" });
        assert.equal(restarted.eventCount, first.eventCount);
        assert.equal(restarted.hashChain.finalHash, first.hashChain.finalHash);
        const document = JSON.parse(restarted.content) as { hashChain: { stored: { verified: boolean; rowCount: number; finalHash: string } } };
        assert.deepEqual(
          { verified: document.hashChain.stored.verified, rowCount: document.hashChain.stored.rowCount, finalHash: document.hashChain.stored.finalHash },
          { verified: true, rowCount: first.eventCount, finalHash: first.hashChain.finalHash },
        );
      } finally {
        reopened.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to export a stored chain that fails verification", async () => {
    const fixture = await makeStoreFixture();
    try {
      await fixture.store.exportAuditLog({ format: "json" });
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"));
      db.exec("DROP TRIGGER audit_log_refuse_update");
      db.prepare("UPDATE audit_log SET sha256 = ? WHERE seq = 2").run("f".repeat(64));
      db.close();
      await assert.rejects(fixture.store.exportAuditLog({ format: "csv" }), (error) => {
        assert.ok(error instanceof AuditLogIntegrityError);
        assert.match(error.message, /failed its integrity check at entry 2/);
        return true;
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("carries who started each run, and filters to runs no person started", async () => {
    const fixture = await makeStoreFixture({
      extraRuns: [
        { ...oldRun(), id: "run-scheduled", trigger: "schedule" },
        // Written before runs carried an initiator: a gateway proposal stamped manual.
        { ...oldRun(), id: "run-gateway", agentSlug: "external-proposal", origin: "external-proposal", trigger: "manual" },
      ],
    });
    try {
      const all = JSON.parse((await fixture.store.exportAuditLog({ format: "json" })).content) as {
        events: Array<{ runId?: string; initiator?: string; source: string }>;
      };
      const initiators = new Map(all.events.filter((event) => event.runId).map((event) => [event.runId, event.initiator]));
      assert.deepEqual(Object.fromEntries(initiators), {
        "run-old": "person",
        "run-write": "person",
        "run-scheduled": "schedule",
        "run-gateway": "gateway",
      });

      const exported = await fixture.store.exportAuditLog({ format: "json", notStartedByPerson: true });
      const document = JSON.parse(exported.content) as {
        filters: Record<string, unknown>;
        events: Array<{ runId?: string; initiator?: string }>;
      };
      assert.deepEqual(document.filters, { notStartedByPerson: true });
      assert.ok(document.events.length > 0);
      assert.deepEqual([...new Set(document.events.map((event) => event.runId))].sort(), ["run-gateway", "run-scheduled"]);
      assert.ok(document.events.every((event) => event.initiator === "schedule" || event.initiator === "gateway"));

      const csv = parseCsv((await fixture.store.exportAuditLog({ format: "csv", notStartedByPerson: true })).content);
      const column = csv[0]?.indexOf("initiator") ?? -1;
      assert.ok(column >= 0);
      assert.deepEqual([...new Set(csv.slice(1).map((cells) => cells[column]))].sort(), ["gateway", "schedule"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("neutralizes CSV cells a spreadsheet would run as a formula", async () => {
    const fixture = await makeStoreFixture({
      extraRuns: [
        { ...oldRun(), id: "=HYPERLINK(\"https://example.invalid\")", agentSlug: "-cmd", tenantId: "@tenant" },
        { ...oldRun(), id: "run-spaced", agentSlug: "  +SUM(A1)", tenantId: "\t=1" },
      ],
    });
    try {
      const rows = parseCsv((await fixture.store.exportAuditLog({ format: "csv" })).content);
      const header = rows[0] ?? [];
      const row = rows.find((cells) => cells[header.indexOf("runId")]?.includes("HYPERLINK"));
      assert.ok(row);
      assert.equal(row[header.indexOf("runId")], "'=HYPERLINK(\"https://example.invalid\")");
      assert.equal(row[header.indexOf("agentSlug")], "'-cmd");
      assert.equal(row[header.indexOf("tenantId")], "'@tenant");
      // Leading whitespace does not hide a formula.
      const spaced = rows.find((cells) => cells[header.indexOf("runId")] === "run-spaced");
      assert.ok(spaced);
      assert.equal(spaced[header.indexOf("agentSlug")], "'  +SUM(A1)");
      assert.equal(spaced[header.indexOf("tenantId")], "'\t=1");
      assert.ok(rows.slice(1).every((cells) => cells.every((cell) => !/^[\t\r]|^\s*[=+\-@]/.test(cell))));
      assert.match(rows[1]?.[header.indexOf("retentionNote")] ?? "", /gets a leading apostrophe/);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("audit log behind the state", () => {
  type Internals = {
    auditLog: { append(events: unknown[]): number };
    appendAuditEvents(events: unknown[]): number;
  };

  it("refuses a prune that would remove unrecorded runs while appends fail, and records them on the next attempt", async () => {
    const fixture = await makeStoreFixture();
    const internals = fixture.store as unknown as Internals;
    const append = internals.auditLog.append.bind(internals.auditLog);
    let failing = true;
    internals.auditLog.append = (events) => {
      if (failing) throw new Error("database or disk is full");
      return append(events);
    };
    try {
      await fixture.store.setRunHistoryRetentionSettings({ neverPrune: false, keepLastRuns: 1, keepDays: null });
      const status = await fixture.store.getAuditLogStatus();
      assert.match(status.lastFailure?.message ?? "", /database or disk is full/);

      await assert.rejects(fixture.store.pruneRunHistoryNow(), (error) => {
        assert.ok(error instanceof AuditLogBehindError);
        assert.match(error.message, /^This change was not saved: it removes 3 events the audit log has not recorded yet, and the audit log could not record them now\. database or disk is full Nothing was removed\./);
        return true;
      });
      const kept = JSON.parse(await readFile(join(fixture.dir, "state.json"), "utf8")) as { runs: RunRecord[] };
      assert.deepEqual(kept.runs.map((run) => run.id).sort(), ["run-old", "run-write"]);

      failing = false;
      const pruned = await fixture.store.pruneRunHistoryNow();
      assert.equal(pruned.prunedCount, 1);
      assert.deepEqual(await fixture.store.getAuditLogStatus(), {});
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"), { readOnly: true });
      const recorded = db.prepare("SELECT type FROM audit_log WHERE run_id = 'run-old' ORDER BY seq").all() as Array<{ type: string }>;
      const consents = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE type = 'hosted-provider.consent'").get() as { count: number };
      db.close();
      assert.deepEqual(recorded.map((row) => row.type), ["run.queued", "run.started", "run.completed"]);
      assert.equal(consents.count, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves events of no run out of the filter for runs no person started", async () => {
    const fixture = await makeStoreFixture({ extraRuns: [{ ...oldRun(), id: "run-scheduled", trigger: "schedule" }] });
    try {
      await fixture.store.getAppState();
      const internals = fixture.store as unknown as Internals;
      internals.appendAuditEvents([{
        id: "gateway:refused-1",
        timestamp: "2026-07-05T11:00:00.000Z",
        type: "gateway.request.refused",
        source: "gateway",
        tenantId: tenant.id,
        agentSlug: "external-proposal",
        initiator: "gateway",
        details: { reason: "unknown client" },
      }]);
      const all = JSON.parse((await fixture.store.exportAuditLog({ format: "json" })).content) as { events: Array<{ id: string }> };
      assert.ok(all.events.some((event) => event.id === "gateway:refused-1"));
      const filtered = JSON.parse((await fixture.store.exportAuditLog({ format: "json", notStartedByPerson: true })).content) as {
        events: Array<{ id: string; runId?: string }>;
      };
      assert.ok(filtered.events.length > 0);
      assert.ok(filtered.events.every((event) => event.runId === "run-scheduled"));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("audit log records the latest state", () => {
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  }

  it("does not let an export of an older state clear a newer failed append, so a later prune records the run first", async () => {
    const live: RunRecord = {
      id: "run-live",
      agentSlug: agent.slug,
      status: "running",
      queuedAt: "2026-07-05T08:00:00.000Z",
      startedAt: "2026-07-05T08:00:05.000Z",
      providerId: "ollama",
      model: "test-model",
      tenantId: tenant.id,
      steps: [],
      logs: [],
    };
    const fixture = await makeStoreFixture({ extraRuns: [live] });
    type Internals = {
      auditLog: { append(events: Array<{ id: string }>): number };
      read(): Promise<{ runs: RunRecord[] }>;
      write(state: unknown): Promise<void>;
      serialize<T>(task: () => Promise<T>): Promise<T>;
    };
    const internals = fixture.store as unknown as Internals;
    try {
      // Only the newest run is kept, so the next prune removes the live run once it finished.
      await fixture.store.setRunHistoryRetentionSettings({ neverPrune: false, keepLastRuns: 1, keepDays: null });
      const append = internals.auditLog.append.bind(internals.auditLog);
      let failCompletion = true;
      internals.auditLog.append = (events) => {
        if (failCompletion && events.some((event) => event.id === "run:run-live:finished")) throw new Error("database or disk is full");
        return append(events);
      };
      const serialize = internals.serialize.bind(fixture.store);
      let locked = 0;
      internals.serialize = (task) => serialize(async () => {
        locked += 1;
        try {
          return await task();
        } finally {
          locked -= 1;
        }
      });
      // The export's read is held after it read the state that shows the run running.
      const read = internals.read.bind(fixture.store);
      const reached = gate();
      const release = gate();
      let holdNext = true;
      let readInsideLock = false;
      internals.read = async () => {
        const state = await read();
        if (holdNext) {
          holdNext = false;
          readInsideLock = locked > 0;
          reached.open();
          await release.opened;
        }
        return state;
      };
      const exporting = fixture.store.exportAuditLog({ format: "json" });
      await reached.opened;
      // The run completes, and the append of its completion fails.
      const completing = internals.serialize(async () => {
        const state = await internals.read();
        await internals.write({
          ...state,
          runs: state.runs.map((run) => run.id === "run-live" ? { ...run, status: "completed", finishedAt: "2026-07-05T08:00:15.000Z" } : run),
        });
      });
      // An export outside the state lock lets the completion land while it
      // holds the older state; under the lock the completion waits for it.
      if (!readInsideLock) await completing;
      release.open();
      await exporting;
      await completing;
      assert.equal(readInsideLock, true, "the export reads and records under the state lock");
      assert.match((await fixture.store.getAuditLogStatus()).lastFailure?.message ?? "", /database or disk is full/);

      failCompletion = false;
      const pruned = await fixture.store.pruneRunHistoryNow();
      assert.equal(pruned.prunedCount, 2);
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"), { readOnly: true });
      const recorded = db.prepare("SELECT type FROM audit_log WHERE run_id = 'run-live' ORDER BY seq").all() as Array<{ type: string }>;
      db.close();
      assert.deepEqual(recorded.map((row) => row.type), ["run.queued", "run.started", "run.completed"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a newer failed append when an older state is recorded", async () => {
    const fixture = await makeStoreFixture();
    type Internals = {
      auditLog: { append(events: unknown[]): number };
      read(): Promise<{ runs: RunRecord[] }>;
      recordAuditLog(state: unknown): void;
    };
    const internals = fixture.store as unknown as Internals;
    try {
      await fixture.store.setActiveProvider("openai");
      const older = await internals.read();
      const append = internals.auditLog.append.bind(internals.auditLog);
      let failing = true;
      internals.auditLog.append = (events) => {
        if (failing) throw new Error("database or disk is full");
        return append(events);
      };
      await fixture.store.setActiveProvider("ollama");
      failing = false;
      internals.recordAuditLog(older);
      assert.ok((await fixture.store.getAuditLogStatus()).lastFailure, "the older state does not clear it");
      internals.recordAuditLog(await internals.read());
      assert.deepEqual(await fixture.store.getAuditLogStatus(), {});
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("connector Graph writes in the audit log", () => {
  type Internals = {
    auditLog: { close(): void; append(events: Array<{ type: string }>): number };
    serialize<T>(task: () => Promise<T>): Promise<T>;
    connectorTransport(
      tenantId: string,
      audit?: { runId: string; agentSlug: string; initiator: string },
    ): { fetch: typeof fetch; assertEgress(): void };
  };

  async function sendOutlookMail(transport: { fetch: typeof fetch; assertEgress(): void }): Promise<void> {
    const factory = findConnectorFactory("outlook");
    assert.ok(factory);
    const instance = await factory.build({
      tenant: { tenantId: tenant.id, username: tenant.username, acquireTokenForScopes: async () => "token" },
      config: {},
      secrets: noSecrets,
      ...transport,
      log: () => undefined,
      idempotencyKeyFor: () => "run-write:step-mail:0",
    });
    const capabilities = instance.capabilities as { sendMail(args: Record<string, unknown>): Promise<unknown> };
    await capabilities.sendMail({ to: ["admin@contoso.example"], subject: "Report", text: "Done." });
  }

  function stubGraph(): { sent: Array<{ url: string; method: string }>; restore(): void } {
    const original = globalThis.fetch;
    const sent: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      // Local provider probes are not a service.
      if (url.startsWith("http://127.0.0.1")) return new Response("{}", { status: 503 });
      sent.push({ url, method: init?.method ?? "GET" });
      return new Response(null, { status: 202, headers: { "request-id": "graph-request-1" } });
    }) as typeof fetch;
    return { sent, restore: () => { globalThis.fetch = original; } };
  }

  it("refuses an Outlook send while the audit log cannot record it, and sends nothing", async () => {
    const fixture = await makeStoreFixture();
    const graph = stubGraph();
    try {
      await fixture.store.getAppState();
      const internals = fixture.store as unknown as Internals;
      internals.auditLog.close();
      await assert.rejects(sendOutlookMail(internals.connectorTransport(tenant.id)), /POST \/me\/sendMail was not sent: the audit log could not record it\./);
      assert.deepEqual(graph.sent, []);
    } finally {
      graph.restore();
      await fixture.cleanup();
    }
  });

  it("records an Outlook send before it leaves and its result after, with tenant and run", async () => {
    const fixture = await makeStoreFixture();
    const graph = stubGraph();
    try {
      await fixture.store.getAppState();
      const internals = fixture.store as unknown as Internals;
      await sendOutlookMail(internals.connectorTransport(tenant.id, { runId: "run-write", agentSlug: agent.slug, initiator: "schedule" }));
      assert.deepEqual(graph.sent, [{ url: "https://graph.microsoft.com/beta/me/sendMail", method: "POST" }]);
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"), { readOnly: true });
      const rows = db.prepare("SELECT type, run_id, tenant_id, initiator, event_json FROM audit_log WHERE source = 'graph-write' ORDER BY seq").all() as Array<{
        type: string; run_id: string; tenant_id: string; initiator: string; event_json: string;
      }>;
      db.close();
      assert.deepEqual(rows.map((row) => [row.type, row.run_id, row.tenant_id, row.initiator]), [
        ["graph.write.attempted", "run-write", tenant.id, "schedule"],
        ["graph.write.result", "run-write", tenant.id, "schedule"],
      ]);
      const attempted = JSON.parse(rows[0]!.event_json) as { details: Record<string, unknown>; actor: { username?: string } };
      const result = JSON.parse(rows[1]!.event_json) as { details: Record<string, unknown> };
      assert.equal(attempted.details.method, "POST");
      assert.equal(attempted.details.path, "/me/sendMail");
      assert.equal(typeof attempted.details.bodyDigest, "string");
      assert.equal(attempted.actor.username, tenant.username);
      assert.equal(result.details.attemptId, attempted.details.attemptId);
      assert.equal(result.details.outcome, "ok");
      assert.equal(result.details.status, 202);
      assert.equal(result.details.requestId, "graph-request-1");
    } finally {
      graph.restore();
      await fixture.cleanup();
    }
  });
});

async function makeStoreFixture(options: { extraRuns?: RunRecord[] } = {}): Promise<{
  store: AppStateStore;
  dir: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-audit-export-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        activeProviderId: "ollama",
        installedAgents: [agent],
        runs: [oldRun(), writeRun(), ...(options.extraRuns ?? [])],
        tenants: [tenant],
        activeTenantId: tenant.id,
        runHistoryRetention: {
          neverPrune: false,
          keepLastRuns: 250,
          keepDays: 90,
          updatedAt: "2026-07-05T09:00:00.000Z",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const intelligenceStore = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  intelligenceStore.recordHostedProviderConsentAuditEvent({
    id: "event-hosted-consent",
    tenantId: tenant.id,
    source: "single-tenant-chat",
    payload: {
      tenantIds: [tenant.id],
      providerId: "anthropic",
      providerName: "Anthropic",
      model: "claude-test",
      acknowledgedAt: "2026-07-05T10:02:30.000Z",
      remember: true,
    },
    createdAt: "2026-07-05T10:02:30.000Z",
  });
  intelligenceStore.close();

  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
  });

  return {
    store,
    dir,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-1",
  addedAt: "2026-07-05T00:00:00.000Z",
  lastUsedAt: "2026-07-05T00:00:00.000Z",
  entraTier: "p1",
};

const agent: AgentSummary = {
  id: "audit-agent",
  slug: "audit-agent",
  name: "Audit Agent",
  description: "Audit export fixture.",
  mode: "write",
  category: "devices",
  tier: "agent",
  requiresEntraTier: "free",
  scopes: [],
  author: { name: "OpenAdminOS", verified: true },
  version: "1.0.0",
  installedAt: "2026-07-05T00:00:00.000Z",
};

function oldRun(): RunRecord {
  return {
    id: "run-old",
    agentSlug: agent.slug,
    status: "completed",
    queuedAt: "2026-07-05T09:00:00.000Z",
    startedAt: "2026-07-05T09:00:05.000Z",
    finishedAt: "2026-07-05T09:00:15.000Z",
    providerId: "ollama",
    model: "test-model",
    tenantId: tenant.id,
    summary: "Old run summary.",
    steps: [],
    logs: [],
  };
}

function writeRun(): RunRecord {
  return {
    id: "run-write",
    agentSlug: agent.slug,
    status: "completed",
    queuedAt: "2026-07-05T10:00:00.000Z",
    startedAt: "2026-07-05T10:01:00.000Z",
    confirmedAt: "2026-07-05T10:03:00.000Z",
    finishedAt: "2026-07-05T10:04:00.000Z",
    providerId: "ollama",
    model: "test-model",
    tenantId: tenant.id,
    summary: "Write run completed.",
    result: { total: 2, successCount: 2 },
    steps: [],
    logs: [
      {
        id: "log-plan",
        runId: "run-write",
        timestamp: "2026-07-05T10:02:00.000Z",
        level: "info",
        message: "Plan ready (2 actions). Awaiting typed confirmation.",
      },
      {
        id: "log-connector",
        runId: "run-write",
        timestamp: "2026-07-05T10:06:00.000Z",
        level: "info",
        message: "Connector teams.post-channel-message@1 success",
        metadata: {
          connectorAudit: connectorAudit(),
        },
      },
    ],
    plan: writePlan(),
  };
}

function writePlan(): WritePlan {
  return {
    summary: "Retire two devices.",
    confirmationPhrase: "RETIRE 2 DEVICES",
    actions: [
      {
        id: "retire-managed-device:0",
        kind: "retire-managed-device",
        label: "Retire device 1",
        severity: "destructive",
        metadata: { deviceId: "device-1" },
      },
      {
        id: "retire-managed-device:1",
        kind: "retire-managed-device",
        label: "Retire device 2",
        severity: "destructive",
        metadata: { deviceId: "device-2" },
      },
    ],
  };
}

function connectorAudit(): ConnectorAuditEntry {
  return {
    runId: "run-write",
    stepId: "step-teams",
    connector: "teams",
    capability: "post-channel-message@1",
    kind: "notify",
    idempotencyKey: "run-write:step-teams:0",
    egressTarget: "teams:contoso:#it-ops",
    argsDigest: "abc123",
    status: "success",
    durationMs: 123,
    externalId: "message-1",
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
