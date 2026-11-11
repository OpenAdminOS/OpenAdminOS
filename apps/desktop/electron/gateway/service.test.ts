import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunRecord, WritePlan } from "@openadminos/agent-sdk";

import { GatewayProposalRefusedError } from "../runs.js";
import {
  GATEWAY_LEGACY_TOKEN_COPY,
  GATEWAY_OFF_COPY,
  GATEWAY_OTHER_ORGANIZATION_COPY,
  GATEWAY_UNKNOWN_TOKEN_COPY,
} from "./server.js";
import {
  buildProposalPlan,
  GatewayService,
  type GatewayAuditEvent,
  type GatewayConfig,
  type GatewayServiceHost,
} from "./service.js";

/** Lets other queued work run, so overlapping calls interleave at every await. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeGateway(options: {
  config?: Partial<GatewayConfig>;
  legacyToken?: string;
  queue?: GatewayServiceHost["queueExternalProposal"];
} = {}) {
  let config: GatewayConfig = { enabled: false, port: 0, clients: [], ...options.config };
  let legacyToken = options.legacyToken;
  const queued: Array<Parameters<GatewayServiceHost["queueExternalProposal"]>[0]> = [];
  const audit: GatewayAuditEvent[] = [];
  const host: GatewayServiceHost = {
    readConfig: async () => {
      const snapshot = structuredClone(config);
      await yieldTurn();
      return snapshot;
    },
    // Like the host, the read, change and write happen under one lock.
    updateConfig: async (change) => {
      await yieldTurn();
      config = structuredClone(change(structuredClone(config)));
      return structuredClone(config);
    },
    readLegacyToken: async () => {
      await yieldTurn();
      return legacyToken;
    },
    clearLegacyToken: async () => {
      await yieldTurn();
      legacyToken = undefined;
    },
    tenantName: async () => "Contoso",
    executeReadTool: async () => ({}),
    queueExternalProposal:
      options.queue ??
      (async (input) => {
        queued.push(input);
        return {
          run: { id: `run-${queued.length}`, plan: input.plan } as RunRecord,
          alreadyWaiting: false,
        };
      }),
    getRun: async () => undefined,
    recordAudit: (event) => audit.push(event),
    log: () => undefined,
  };
  const service = new GatewayService(host);
  /** Writes the config as another writer of the state file would, such as Disconnect. */
  const writeConfig = (change: (current: GatewayConfig) => GatewayConfig) => {
    config = structuredClone(change(structuredClone(config)));
  };
  return { service, queued, audit, config: () => config, writeConfig, legacyToken: () => legacyToken };
}

/** Disconnect's change to the gateway config: off, unbound, no clients. */
const disconnected = ({ boundTenantId: _removed, ...config }: GatewayConfig): GatewayConfig =>
  ({ ...config, enabled: false, clients: [] });

/** Sends one MCP request with `token` to a listener on `port`. */
async function gatewayRequest(port: number | undefined, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return { status: response.status, body: await response.json() as unknown };
}

const proposalInput = {
  title: "Rename policy",
  actions: [{
    method: "PATCH" as const,
    path: "/deviceManagement/deviceCompliancePolicies/policy-1",
    body: { displayName: "Renamed" },
    label: "Rename compliance policy",
  }],
};

describe("gateway client pairing", () => {
  it("gives each client its own token, keeps only its hash, and revokes it at once", async () => {
    const { service, config } = makeGateway();
    await service.enable({ boundTenantId: "tenant-1", port: 0 });
    try {
      const claude = await service.pairClient({ name: "  Claude Code " });
      const codex = await service.pairClient({ name: "Codex" });
      assert.equal(claude.client.name, "Claude Code");
      assert.notEqual(claude.token, codex.token);
      assert.ok(!JSON.stringify(config()).includes(claude.token), "the raw token is never stored");
      assert.ok(!JSON.stringify(claude.status).includes("tokenHash"), "hashes stay out of the public status");
      assert.deepEqual(await service.authenticate(claude.token, "tenant-1"), {
        kind: "client",
        client: { id: claude.client.id, name: "Claude Code" },
      });
      assert.deepEqual(await service.authenticate(codex.token, "tenant-1"), {
        kind: "client",
        client: { id: codex.client.id, name: "Codex" },
      });
      assert.deepEqual(await service.authenticate("not-a-paired-token", "tenant-1"), { kind: "unknown" });

      await service.revokeClient(claude.client.id);
      assert.deepEqual(await service.authenticate(claude.token, "tenant-1"), { kind: "unknown" });
      assert.equal((await service.authenticate(codex.token, "tenant-1")).kind, "client");

      await assert.rejects(service.pairClient({ name: "codex" }), /A client named codex is already paired/);
      await assert.rejects(service.pairClient({ name: "   " }), /Enter a client name/);
    } finally {
      await service.stop();
    }
  });

  it("refuses the shared token of earlier versions with a pair-again message", async () => {
    const legacy = "legacy-shared-token-from-0.7-abcdefghijkl";
    const { service, config, legacyToken } = makeGateway({
      legacyToken: legacy,
      config: {
        enabled: true,
        boundTenantId: "tenant-1",
        clients: [{ id: "client_old", name: "Claude Code", createdAt: "2026-08-28T10:00:00.000Z" }],
      },
    });
    await service.startIfEnabled();
    try {
      assert.equal(legacyToken(), undefined, "the raw shared token leaves safeStorage");
      assert.match(config().legacyTokenHash ?? "", /^[0-9a-f]{64}$/);
      assert.deepEqual(await service.authenticate(legacy, "tenant-1"), { kind: "legacy-token" });
      const status = await service.getStatus();
      assert.deepEqual(status.clients, [
        { id: "client_old", name: "Claude Code", createdAt: "2026-08-28T10:00:00.000Z", needsPairing: true },
      ]);

      // Pairing again under the same name replaces the old record.
      const paired = await service.pairClient({ name: "Claude Code" });
      assert.equal((await service.getStatus()).clients.length, 1);
      assert.equal((await service.authenticate(paired.token, "tenant-1")).kind, "client");

      const port = (await service.getStatus()).listeningPort;
      for (const [token, code, copy] of [
        [legacy, "legacy-shared-token", GATEWAY_LEGACY_TOKEN_COPY],
        ["never-issued", "unpaired-token", GATEWAY_UNKNOWN_TOKEN_COPY],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: copy, code });
      }
    } finally {
      await service.stop();
    }
  });

  it("takes the proposing client's name from its record and records refusals in the audit log", async () => {
    let refuse = false;
    const queued: Array<{ clientId: string; clientName: string; plan: WritePlan }> = [];
    const { service, audit } = makeGateway({
      queue: async (input) => {
        if (refuse) {
          throw new GatewayProposalRefusedError("pending-limit", "Claude Code already has 5 proposals waiting.", { planDigest: "d".repeat(64) });
        }
        queued.push(input);
        return { run: { id: "run-1", plan: input.plan } as RunRecord, alreadyWaiting: false };
      },
    });
    const client = { id: "client_1", name: "Claude Code" };
    const accepted = await service.propose("tenant-1", client, proposalInput);
    assert.deepEqual(accepted, { outcome: "queued", runId: "run-1", confirmationPhrase: "APPLY 1 CHANGE" });
    assert.equal(queued[0]?.clientId, "client_1");
    assert.match(queued[0]!.plan.summary, /^Claude Code proposes 1 change/);
    assert.equal(audit.length, 0);

    refuse = true;
    const refused = await service.propose("tenant-1", client, proposalInput);
    assert.equal(refused.outcome, "refused");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.type, "gateway.proposal.refused");
    assert.deepEqual(
      { clientId: audit[0]?.details.clientId, reason: audit[0]?.details.reason },
      { clientId: "client_1", reason: "pending-limit" },
    );
  });

  it("keeps a revoke and a pairing that overlap", async () => {
    const { service, config } = makeGateway();
    await service.enable({ boundTenantId: "tenant-1", port: 0 });
    try {
      const first = await service.pairClient({ name: "Claude Code" });
      const [, second] = await Promise.all([
        service.revokeClient(first.client.id),
        service.pairClient({ name: "Codex" }),
      ]);
      assert.deepEqual(config().clients.map((client) => client.name), ["Codex"]);
      assert.deepEqual(await service.authenticate(first.token, "tenant-1"), { kind: "unknown" });
      assert.equal((await service.authenticate(second.token, "tenant-1")).kind, "client");

      const paired = await Promise.all(["Intune helper", "Splunk", "Copilot"].map((name) => service.pairClient({ name })));
      assert.deepEqual(config().clients.map((client) => client.name).sort(), ["Codex", "Copilot", "Intune helper", "Splunk"]);
      for (const { token } of paired) assert.equal((await service.authenticate(token, "tenant-1")).kind, "client");
    } finally {
      await service.stop();
    }
  });

  it("does not let the move of an earlier shared token undo a pairing made at the same time", async () => {
    const legacy = "legacy-shared-token-from-0.7-abcdefghijkl";
    // Start the pairing at each point of the move, so one of them lands
    // between the move's read and its write.
    for (let turns = 0; turns < 6; turns += 1) {
      const { service, config, legacyToken } = makeGateway({
        legacyToken: legacy,
        config: { enabled: true, boundTenantId: "tenant-1" },
      });
      const pairLater = async () => {
        for (let turn = 0; turn < turns; turn += 1) await yieldTurn();
        return service.pairClient({ name: "Claude Code" });
      };
      const [, paired] = await Promise.all([service.getStatus(), pairLater()]);
      assert.equal(legacyToken(), undefined);
      assert.match(config().legacyTokenHash ?? "", /^[0-9a-f]{64}$/);
      assert.deepEqual(config().clients.map((client) => client.name), ["Claude Code"], `pairing after ${turns} turns`);
      assert.equal((await service.authenticate(paired.token, "tenant-1")).kind, "client");
    }
  });

  it("refuses the earlier shared token as such before anything else read the config", async () => {
    const legacy = "legacy-shared-token-from-0.7-abcdefghijkl";
    const { service, legacyToken } = makeGateway({ legacyToken: legacy, config: { enabled: true, boundTenantId: "tenant-1" } });
    assert.deepEqual(await service.authenticate(legacy, "tenant-1"), { kind: "legacy-token" });
    assert.equal(legacyToken(), undefined);
  });

  it("revokes every client when the gateway is disabled", async () => {
    const { service } = makeGateway();
    await service.enable({ boundTenantId: "tenant-1", port: 0 });
    const paired = await service.pairClient({ name: "Claude Code" });
    const status = await service.disable();
    assert.deepEqual(status.clients, []);
    assert.deepEqual(await service.authenticate(paired.token, "tenant-1"), { kind: "gateway-off" });
  });

  it("refuses a token that was valid once the listener's gateway is off, unbound or bound elsewhere", async () => {
    for (const [change, kind, status, code, copy] of [
      [(config: GatewayConfig) => ({ ...config, enabled: false }), "gateway-off", 403, "gateway-off", GATEWAY_OFF_COPY],
      [({ boundTenantId: _removed, ...config }: GatewayConfig) => config, "gateway-off", 403, "gateway-off", GATEWAY_OFF_COPY],
      [(config: GatewayConfig) => ({ ...config, boundTenantId: "tenant-2" }), "other-organization", 403, "gateway-other-organization", GATEWAY_OTHER_ORGANIZATION_COPY],
    ] as const) {
      const { service, writeConfig } = makeGateway();
      await service.enable({ boundTenantId: "tenant-1", port: 0 });
      try {
        const paired = await service.pairClient({ name: "Claude Code" });
        const port = (await service.getStatus()).listeningPort;
        const before = await gatewayRequest(port, paired.token);
        assert.equal(before.status, 200, JSON.stringify(before.body));

        // The change lands behind the service, as a Disconnect writes it,
        // and leaves the paired record and the listener in place.
        writeConfig(change);
        assert.deepEqual(await service.authenticate(paired.token, "tenant-1"), { kind });
        assert.deepEqual(await gatewayRequest(port, paired.token), { status, body: { error: copy, code } });
      } finally {
        await service.stop();
      }
    }
  });

  it("starts no listener when a Disconnect lands while the gateway is being enabled", async () => {
    // Land the Disconnect at each point of the enable, so one of them falls
    // between the enable's write and its listener start.
    for (let turns = 0; turns < 12; turns += 1) {
      const { service, config, writeConfig } = makeGateway();
      const disconnectLater = async () => {
        for (let turn = 0; turn < turns; turn += 1) await yieldTurn();
        writeConfig(disconnected);
        await service.stop();
      };
      try {
        await Promise.all([service.enable({ boundTenantId: "tenant-1", port: 0 }), disconnectLater()]);
        const status = await service.getStatus();
        assert.equal(status.running, config().enabled, `Disconnect after ${turns} turns`);
      } finally {
        await service.stop();
      }
    }
  });
});

describe("gateway proposal plan builder", () => {
  it("validates paths against the Graph catalog and marks deletes destructive", () => {
    const { plan, requiredScopes } = buildProposalPlan({
      title: "Tighten compliance",
      clientName: "Claude Code",
      actions: [
        {
          method: "PATCH",
          path: "/deviceManagement/deviceCompliancePolicies/policy-1",
          body: { displayName: "Renamed" },
          label: "Rename compliance policy",
        },
        {
          method: "DELETE",
          path: "/deviceManagement/deviceCompliancePolicies/policy-2",
          label: "Delete stale policy",
        },
      ],
    });

    assert.equal(plan.actions.length, 2);
    assert.equal(plan.confirmationPhrase, "APPLY 2 CHANGES");
    assert.match(plan.summary, /Claude Code proposes 2 changes/);
    const del = plan.actions.find((action) => action.request?.method === "DELETE");
    assert.equal(del?.severity, "destructive");
    assert.ok(
      requiredScopes.some((scope) => /ReadWrite/.test(scope)),
      "should collect write scopes from the catalog",
    );
  });

  it("rejects unknown Graph endpoints instead of forwarding them", () => {
    assert.throws(
      () =>
        buildProposalPlan({
          title: "Sneaky",
          clientName: "Unknown client",
          actions: [
            {
              method: "POST",
              path: "/not/a/real/graph/path",
              label: "Do something undocumented",
            },
          ],
        }),
      /not a known Microsoft Graph endpoint/,
    );
  });

  it("uses singular confirmation copy for a single change", () => {
    const { plan } = buildProposalPlan({
      title: "One change",
      clientName: "Codex",
      actions: [
        {
          method: "PATCH",
          path: "/deviceManagement/deviceCompliancePolicies/policy-1",
          label: "Update policy",
        },
      ],
    });
    assert.equal(plan.confirmationPhrase, "APPLY 1 CHANGE");
  });
});
