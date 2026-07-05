import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AgentSummary,
  ConnectorAuditEntry,
  RunRecord,
  TenantRecord,
  WritePlan,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

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

async function makeStoreFixture(): Promise<{
  store: AppStateStore;
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
        runs: [oldRun(), writeRun()],
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
