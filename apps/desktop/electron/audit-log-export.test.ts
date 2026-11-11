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
import type { TokenCacheStorage } from "@openadminos/runtime";

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
      extraRuns: [{ ...oldRun(), id: "=HYPERLINK(\"https://example.invalid\")", agentSlug: "-cmd", tenantId: "@tenant" }],
    });
    try {
      const rows = parseCsv((await fixture.store.exportAuditLog({ format: "csv" })).content);
      const header = rows[0] ?? [];
      const row = rows.find((cells) => cells[header.indexOf("runId")]?.includes("HYPERLINK"));
      assert.ok(row);
      assert.equal(row[header.indexOf("runId")], "'=HYPERLINK(\"https://example.invalid\")");
      assert.equal(row[header.indexOf("agentSlug")], "'-cmd");
      assert.equal(row[header.indexOf("tenantId")], "'@tenant");
      assert.ok(rows.slice(1).every((cells) => cells.every((cell) => !/^[=+\-@\t\r]/.test(cell))));
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
