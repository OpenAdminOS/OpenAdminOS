import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";
import type {
  AgentSummary,
  RunRecord,
  SecretAccessor,
  WhatsAppWebStatus,
} from "@openadminos/agent-sdk";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

const now = "2020-01-01T08:00:00.000Z";

function completedRun(id: string): RunRecord {
  return {
    id,
    agentSlug: "delivery-agent",
    status: "completed",
    queuedAt: now,
    startedAt: now,
    finishedAt: now,
    trigger: "manual",
    summary: "Run completed.",
    steps: [],
    logs: [],
  };
}

function deliveryAgent(
  whatsappWeb: NonNullable<AgentSummary["delivery"]>["whatsappWeb"],
): AgentSummary {
  return deliveryAgentWith({ whatsappWeb });
}

function deliveryAgentWith(
  delivery: NonNullable<AgentSummary["delivery"]>,
): AgentSummary {
  return {
    id: "delivery-agent",
    slug: "delivery-agent",
    name: "Delivery agent",
    description: "Tests delivery routing.",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: [],
    author: { name: "OpenAdminOS" },
    version: "1.0.0",
    installedAt: now,
    delivery,
  };
}

function queueItem(runId: string, nextAttemptAt = now) {
  return {
    id: `${runId}:whatsapp-web`,
    runId,
    connectorId: "whatsapp-web",
    attempts: 0,
    createdAt: now,
    nextAttemptAt,
  };
}

function connectorQueueItem(
  runId: string,
  connectorId: "slack",
  nextAttemptAt = now,
) {
  return {
    id: `${runId}:${connectorId}`,
    runId,
    connectorId,
    attempts: 0,
    createdAt: now,
    nextAttemptAt,
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createStore(input: {
  statePath: string;
  sendMessage: (args: { to?: string; text: string }) => Promise<{ messageId: string }>;
  disconnect?: () => Promise<WhatsAppWebStatus>;
}): AppStateStore {
  const connected: WhatsAppWebStatus = {
    state: "connected",
    message: "Linked and ready.",
  };
  return new AppStateStore({
    filePath: input.statePath,
    tokenStore,
    userDataPath: join(input.statePath, ".."),
    statsApiUrl: "",
    whatsAppWebClientFactory: () => ({
      getStatus: () => connected,
      restoreSession: async () => connected,
      startLogin: async () => connected,
      disconnect:
        input.disconnect ??
        (async () => ({
          state: "not-linked",
          message: "WhatsApp Web was disconnected on this device.",
        })),
      listGroups: async () => [],
      sendMessage: async (args) => ({
        ...(await input.sendMessage(args)),
        to: "My WhatsApp",
        targetType: "self",
      }),
      dispose: () => undefined,
    }),
  });
}

describe("post-run WhatsApp delivery", () => {
  it("sends queued run reports and appends activity plus audit metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-success-"));
    const statePath = join(dir, "state.json");
    const sent: Array<{ to?: string; text: string }> = [];
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgent({ enabled: true, useDefaultRecipient: true }),
      ],
      runs: [completedRun("run-success")],
      tenants: [],
      connectors: {
        "whatsapp-web": {
          config: {
            defaultRecipientType: "self",
            defaultRecipient: "self",
            defaultRecipientLabel: "My WhatsApp",
          },
        },
      },
      runDeliveryQueue: [queueItem("run-success")],
    });
    const store = createStore({
      statePath,
      sendMessage: async (args) => {
        sent.push(args);
        return { messageId: "wa-success" };
      },
    });

    try {
      await store.processPendingRunDeliveries();
      const state = await readJson(statePath);
      const run = (state.runs as RunRecord[])[0];
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, "self");
      assert.equal(state.runDeliveryQueue, undefined);
      assert.equal(run?.steps.at(-1)?.status, "completed");
      assert.match(run?.steps.at(-1)?.label ?? "", /WhatsApp/);
      const audit = run?.logs.at(-1)?.metadata?.connectorAudit as
        | Record<string, unknown>
        | undefined;
      assert.equal(audit?.connector, "whatsapp-web");
      assert.equal(audit?.status, "success");
      assert.equal(audit?.externalId, "wa-success");
      assert.equal(audit?.egressTarget, "whatsapp-web:to=redacted");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses My WhatsApp when no explicit default target was saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-implicit-self-"));
    const statePath = join(dir, "state.json");
    const sent: Array<{ to?: string; text: string }> = [];
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgent({ enabled: true, useDefaultRecipient: true }),
      ],
      runs: [completedRun("run-implicit-self")],
      tenants: [],
      connectors: {
        "whatsapp-web": {
          config: {},
        },
      },
      runDeliveryQueue: [queueItem("run-implicit-self")],
    });
    const store = createStore({
      statePath,
      sendMessage: async (args) => {
        sent.push(args);
        return { messageId: "wa-implicit-self" };
      },
    });

    try {
      await store.processPendingRunDeliveries();
      const state = await readJson(statePath);
      const run = (state.runs as RunRecord[])[0];
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, "self");
      assert.equal(state.runDeliveryQueue, undefined);
      assert.equal(run?.steps.at(-1)?.status, "completed");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records skipped delivery rules without sending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-skip-"));
    const statePath = join(dir, "state.json");
    let sendCount = 0;
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgent({
          enabled: true,
          useDefaultRecipient: true,
          notifyOnSuccess: false,
          notifyOnFailure: true,
        }),
      ],
      runs: [completedRun("run-skip")],
      tenants: [],
      connectors: {
        "whatsapp-web": {
          config: {
            defaultRecipientType: "self",
            defaultRecipient: "self",
            defaultRecipientLabel: "My WhatsApp",
          },
        },
      },
      runDeliveryQueue: [queueItem("run-skip")],
    });
    const store = createStore({
      statePath,
      sendMessage: async () => {
        sendCount += 1;
        return { messageId: "must-not-send" };
      },
    });

    try {
      await store.processPendingRunDeliveries();
      const state = await readJson(statePath);
      const run = (state.runs as RunRecord[])[0];
      assert.equal(sendCount, 0);
      assert.equal(state.runDeliveryQueue, undefined);
      assert.equal(run?.steps.at(-1)?.status, "skipped");
      assert.match(run?.steps.at(-1)?.detail ?? "", /failed runs only/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends queued Slack run reports with connector secrets and audit metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-slack-"));
    const statePath = join(dir, "state.json");
    const posted: Array<{ authorization: string | null; body: Record<string, unknown> }> =
      [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posted.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      return new Response(
        JSON.stringify({ ok: true, channel: body.channel, ts: "123.456" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const secrets: SecretAccessor = {
      get: async (key) => (key === "botToken" ? "xoxb-test" : undefined),
      set: async () => undefined,
      remove: async () => undefined,
    };
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgentWith({
          slack: { enabled: true, useDefaultChannel: true },
        }),
      ],
      runs: [completedRun("run-slack")],
      tenants: [],
      connectors: {
        slack: {
          config: {
            defaultChannel: "C123",
            defaultChannelLabel: "#intune-alerts",
          },
        },
      },
      runDeliveryQueue: [connectorQueueItem("run-slack", "slack")],
    });
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      connectorSecretsFor: (connectorId) =>
        connectorId === "slack"
          ? secrets
          : {
              get: async () => undefined,
              set: async () => undefined,
              remove: async () => undefined,
            },
    });

    try {
      await store.processPendingRunDeliveries();
      const state = await readJson(statePath);
      const run = (state.runs as RunRecord[])[0];
      assert.equal(posted.length, 1);
      assert.equal(posted[0]?.authorization, "Bearer xoxb-test");
      assert.equal(posted[0]?.body.channel, "C123");
      assert.match(String(posted[0]?.body.text), /Run completed/);
      assert.equal(state.runDeliveryQueue, undefined);
      assert.equal(run?.steps.at(-1)?.status, "completed");
      assert.match(run?.steps.at(-1)?.label ?? "", /Slack/);
      const audit = run?.logs.at(-1)?.metadata?.connectorAudit as
        | Record<string, unknown>
        | undefined;
      assert.equal(audit?.connector, "slack");
      assert.equal(audit?.status, "success");
      assert.equal(audit?.externalId, "C123:123.456");
      assert.equal(audit?.egressTarget, "slack:#intune-alerts");
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps transient failures queued and succeeds on a later due retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-retry-"));
    const statePath = join(dir, "state.json");
    let attempts = 0;
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgent({ enabled: true, useDefaultRecipient: true }),
      ],
      runs: [completedRun("run-retry")],
      tenants: [],
      connectors: {
        "whatsapp-web": {
          config: {
            defaultRecipientType: "self",
            defaultRecipient: "self",
            defaultRecipientLabel: "My WhatsApp",
          },
        },
      },
      runDeliveryQueue: [queueItem("run-retry")],
    });
    const store = createStore({
      statePath,
      sendMessage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Temporary WhatsApp failure.");
        return { messageId: "wa-retry" };
      },
    });

    try {
      await store.processPendingRunDeliveries();
      let state = await readJson(statePath);
      let queue = state.runDeliveryQueue as Array<Record<string, unknown>>;
      assert.equal(queue.length, 1);
      assert.equal(queue[0]?.attempts, 1);
      assert.equal(queue[0]?.lastError, "Temporary WhatsApp failure.");

      queue[0] = { ...queue[0], nextAttemptAt: "2020-01-01T07:59:00.000Z" };
      await writeJson(statePath, { ...state, runDeliveryQueue: queue });

      await store.processPendingRunDeliveries();
      state = await readJson(statePath);
      const run = (state.runs as RunRecord[])[0];
      assert.equal(attempts, 2);
      assert.equal(state.runDeliveryQueue, undefined);
      assert.equal(run?.steps.at(-1)?.status, "completed");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears stale WhatsApp targets and queued WhatsApp deliveries on disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-disconnect-"));
    const statePath = join(dir, "state.json");
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [
        deliveryAgent({
          enabled: true,
          useDefaultRecipient: false,
          recipientType: "group",
          recipient: "999999999999@g.us",
          recipientLabel: "Old group",
        }),
      ],
      runs: [completedRun("run-disconnect")],
      tenants: [],
      connectors: {
        "whatsapp-web": {
          config: {
            defaultRecipientType: "group",
            defaultRecipient: "999999999999@g.us",
            defaultRecipientLabel: "Old group",
          },
        },
      },
      runDeliveryQueue: [queueItem("run-disconnect")],
    });
    const store = createStore({
      statePath,
      sendMessage: async () => ({ messageId: "unused" }),
    });

    try {
      await store.disconnectWhatsAppWeb();
      const state = await readJson(statePath);
      const connector = (state.connectors as Record<string, { config: Record<string, unknown> }>)[
        "whatsapp-web"
      ];
      const agent = (state.installedAgents as AgentSummary[])[0];
      assert.equal(connector?.config.defaultRecipientType, "self");
      assert.equal(connector?.config.defaultRecipient, "self");
      assert.equal(agent?.delivery?.whatsappWeb?.useDefaultRecipient, true);
      assert.equal(agent?.delivery?.whatsappWeb?.recipient, undefined);
      assert.equal(state.runDeliveryQueue, undefined);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reports of a run with no organization (review round 1)", () => {
  const customerB = {
    id: "tenant-b",
    displayName: "Customer B",
    username: "admin@customer-b.example",
    homeAccountId: "home-b",
    addedAt: now,
  };

  it("labels a Slack report No organization even when another organization is active now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-noorg-"));
    const statePath = join(dir, "state.json");
    const posted: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posted.push(String(body.text));
      return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: "1.2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [deliveryAgentWith({ slack: { enabled: true, useDefaultChannel: true } })],
      runs: [completedRun("run-noorg")],
      tenants: [customerB],
      activeTenantId: customerB.id,
      connectors: { slack: { config: { defaultChannel: "C123", defaultChannelLabel: "#alerts" } } },
      runDeliveryQueue: [connectorQueueItem("run-noorg", "slack")],
    });
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      connectorSecretsFor: () => ({
        get: async (key) => (key === "botToken" ? "xoxb-test" : undefined),
        set: async () => undefined,
        remove: async () => undefined,
      }),
    });
    try {
      await store.processPendingRunDeliveries();
      assert.equal(posted.length, 1);
      assert.match(posted[0]!, /\*Organization:\* none/);
      assert.doesNotMatch(posted[0]!, /Tenant:/);
      assert.doesNotMatch(posted[0]!, /Customer B/);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const connectorId of ["teams", "outlook"] as const) {
    it(`skips ${connectorId} delivery for a run with no organization and says why`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `openadminos-delivery-noorg-${connectorId}-`));
      const statePath = join(dir, "state.json");
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        throw new Error("No request may be sent.");
      }) as typeof fetch;
      await writeJson(statePath, {
        activeProviderId: "ollama",
        installedAgents: [deliveryAgentWith({ [connectorId]: { enabled: true, useDefaultTarget: true, useDefaultRecipients: true } })],
        runs: [completedRun("run-noorg")],
        tenants: [customerB],
        activeTenantId: customerB.id,
        runDeliveryQueue: [{ id: `run-noorg:${connectorId}`, runId: "run-noorg", connectorId, attempts: 0, createdAt: now, nextAttemptAt: now }],
      });
      const store = new AppStateStore({ filePath: statePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
      try {
        await store.processPendingRunDeliveries();
        const state = await readJson(statePath);
        const run = (state.runs as RunRecord[])[0];
        assert.equal(calls, 0);
        assert.equal(state.runDeliveryQueue, undefined);
        assert.ok(run?.logs.some((log) => log.message.startsWith("Report delivery skipped. This run had no organization")));
      } finally {
        globalThis.fetch = originalFetch;
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("direct Teams and Outlook delivery of a run with no organization (Muse round 2)", () => {
  it("uses the designed skip instead of a failed step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-direct-"));
    const statePath = join(dir, "state.json");
    await writeJson(statePath, {
      activeProviderId: "ollama",
      installedAgents: [deliveryAgentWith({ teams: { enabled: true, useDefaultTarget: true }, outlook: { enabled: true, useDefaultRecipients: true } })],
      runs: [completedRun("run-noorg")],
      tenants: [],
    });
    const store = new AppStateStore({ filePath: statePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    const internal = (store as unknown as { runDeliveryService: {
      deliverRunToTeams(run: RunRecord): Promise<{ retryable: boolean; error?: string }>;
      deliverRunToOutlook(run: RunRecord): Promise<{ retryable: boolean; error?: string }>;
    } }).runDeliveryService;
    try {
      for (const deliver of [internal.deliverRunToTeams.bind(internal), internal.deliverRunToOutlook.bind(internal)]) {
        const result = await deliver(completedRun("run-noorg"));
        assert.equal(result.retryable, false);
        assert.match(result.error ?? "", /^Report delivery skipped\. This run had no organization/);
      }
      const run = ((await readJson(statePath)).runs as RunRecord[])[0];
      assert.equal(run?.steps.some((step) => step.status === "failed"), false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("delivery decision parity with the destination list (review round 4)", () => {
  type Fixture = {
    name: string;
    delivery: NonNullable<AgentSummary["delivery"]>;
    connectorId: "slack" | "discord" | "teams" | "outlook";
    connectorName: string;
    config: Record<string, unknown>;
    /** The health status the renderer shows; the host never reads it. */
    status: "unknown" | "error" | "needs-setup" | "connected";
    tenantless?: boolean;
    /** The run belongs to an organization, so Teams and Outlook reach their own checks. */
    tenantId?: string;
    /** The designed step message when the host refuses before sending. */
    stepDetail?: RegExp;
  };
  const fixtures: Fixture[] = [
    {
      name: "a saved Slack token with no global configuration and a channel on the agent rule",
      delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "C999" } },
      connectorId: "slack", connectorName: "Slack", config: {}, status: "unknown",
    },
    {
      name: "Slack with a stale error status and a default channel",
      delivery: { slack: { enabled: true, useDefaultChannel: true } },
      connectorId: "slack", connectorName: "Slack", config: { defaultChannel: "C123" }, status: "error",
    },
    {
      name: "Slack whose rule uses the default channel when none is saved",
      delivery: { slack: { enabled: true, useDefaultChannel: true } },
      connectorId: "slack", connectorName: "Slack", config: {}, status: "connected",
    },
    {
      name: "Slack whose rule names an empty channel",
      delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "  " } },
      connectorId: "slack", connectorName: "Slack", config: { defaultChannel: "C123" }, status: "connected",
    },
    {
      name: "a Discord webhook saved without a test",
      delivery: { discord: { enabled: true } },
      connectorId: "discord", connectorName: "Discord", config: {}, status: "needs-setup",
    },
    {
      name: "Teams for a run with no organization",
      delivery: { teams: { enabled: true } },
      connectorId: "teams", connectorName: "Microsoft Teams", config: {}, status: "connected", tenantless: true,
    },
    {
      name: "Teams whose rule uses the default target when no team and channel are saved (Muse round 5)",
      delivery: { teams: { enabled: true } },
      connectorId: "teams", connectorName: "Microsoft Teams", config: { defaultTeamId: "team-1" }, status: "connected",
      tenantId: "tenant-parity", stepDetail: /No default Microsoft Teams team and channel are configured\./,
    },
    {
      name: "Teams whose rule names a team but no channel (Muse round 5)",
      delivery: { teams: { enabled: true, useDefaultTarget: false, teamId: "team-1" } },
      connectorId: "teams", connectorName: "Microsoft Teams", config: { defaultTeamId: "team-1", defaultChannelId: "channel-1" }, status: "connected",
      tenantId: "tenant-parity", stepDetail: /No Microsoft Teams team and channel are set on this delivery rule\./,
    },
    {
      name: "Outlook whose rule uses default recipients when none are saved (Muse round 5)",
      delivery: { outlook: { enabled: true } },
      connectorId: "outlook", connectorName: "Outlook", config: { defaultRecipients: " ; " }, status: "connected",
      tenantId: "tenant-parity", stepDetail: /No default Outlook notification recipients are configured\./,
    },
  ];

  for (const fixture of fixtures) {
    it(`sends exactly when the list says it may: ${fixture.name}`, async () => {
      const { manualRunReportDestinations, reportDestinations, resultDestinations } = await import(
        "../src/shared/delivery-destinations.js"
      );
      const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-parity-"));
      const statePath = join(dir, "state.json");
      const requests: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(input instanceof Request ? input.url : input));
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: "1.2", id: "1", channel_id: "2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const agent = deliveryAgentWith(fixture.delivery);
      await writeJson(statePath, {
        activeProviderId: "ollama",
        installedAgents: [agent],
        runs: [{ ...completedRun("run-parity"), ...(fixture.tenantId ? { tenantId: fixture.tenantId } : {}) }],
        tenants: [],
        connectors: { [fixture.connectorId]: { config: fixture.config } },
        runDeliveryQueue: [{ ...connectorQueueItem("run-parity", "slack"), id: `run-parity:${fixture.connectorId}`, connectorId: fixture.connectorId }],
      });
      const store = new AppStateStore({
        filePath: statePath,
        tokenStore,
        userDataPath: dir,
        statsApiUrl: "",
        connectorSecretsFor: () => ({
          get: async (key) =>
            key === "botToken" ? "xoxb-test" : key === "webhookUrl" ? "https://discord.com/api/webhooks/123/abc" : undefined,
          set: async () => undefined,
          remove: async () => undefined,
        }),
      });
      try {
        await store.processPendingRunDeliveries();
        const summary = {
          descriptor: { id: fixture.connectorId, name: fixture.connectorName },
          config: fixture.config,
          status: fixture.status,
        } as never;
        const listed = fixture.tenantless
          ? manualRunReportDestinations(agent, false, [summary]).mayGo.includes(fixture.connectorName)
          : reportDestinations(resultDestinations([agent], [summary])).includes(fixture.connectorName);
        assert.equal(requests.length > 0, listed, `host sent ${requests.length} request(s), list says ${listed ? "may send" : "nothing is sent"}`);
        if (fixture.stepDetail) {
          const stored = (JSON.parse(await readFile(statePath, "utf8")) as { runs: RunRecord[] }).runs[0];
          const step = stored?.steps.at(-1);
          assert.equal(step?.status, "failed");
          assert.match(step?.detail ?? "", fixture.stepDetail);
          assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { runDeliveryQueue?: unknown }).runDeliveryQueue, undefined);
        }
      } finally {
        globalThis.fetch = originalFetch;
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
