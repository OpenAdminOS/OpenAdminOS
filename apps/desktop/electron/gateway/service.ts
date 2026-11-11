import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  GatewayClientSummary,
  GatewayPublicStatus,
  RunRecord,
  WriteAction,
  WritePlan,
} from "@openadminos/agent-sdk";

import { lookupEndpoint } from "../graph-catalog.js";
import { GatewayProposalRefusedError } from "../runs.js";
import {
  startGatewayServer,
  type GatewayAuthResult,
  type GatewayClientIdentity,
  type GatewayHost,
  type RunningGatewayServer,
} from "./server.js";

/**
 * A paired client. `tokenHash` is the SHA-256 of the client's own token;
 * the token itself is shown once at pairing and never stored. A record
 * without a hash was written before per-client pairing, from the name
 * the client sent, and authenticates nothing.
 */
export interface GatewayClientRecord {
  id: string;
  name: string;
  createdAt: string;
  tokenHash?: string;
}

export interface GatewayConfig {
  enabled: boolean;
  port: number;
  boundTenantId?: string;
  clients: GatewayClientRecord[];
  /**
   * SHA-256 of the shared token from before per-client pairing. It is
   * kept only so a client still using it is told to pair again.
   */
  legacyTokenHash?: string;
}

const DEFAULT_GATEWAY_PORT = 8092;
const CLIENT_NAME_MAX_LENGTH = 100;

/** A gateway refusal written to the audit log. */
export interface GatewayAuditEvent {
  type: "gateway.proposal.refused";
  tenantId: string;
  timestamp: string;
  details: {
    clientId: string;
    clientName: string;
    reason: "pending-limit" | "rejected-cooldown";
    planDigest: string;
    actionCount: number;
    retryAfter?: string;
  };
}

export interface GatewayServiceHost {
  readConfig(): Promise<GatewayConfig>;
  writeConfig(config: GatewayConfig): Promise<void>;
  /** The shared token an earlier version kept in safeStorage, if any. */
  readLegacyToken(): Promise<string | undefined>;
  clearLegacyToken(): Promise<void>;
  tenantName(tenantId: string): Promise<string | undefined>;
  executeReadTool(
    tenantId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  queueExternalProposal(input: {
    tenantId: string;
    clientId: string;
    clientName: string;
    plan: WritePlan;
    requiredScopes: string[];
  }): Promise<{ run: RunRecord; alreadyWaiting: boolean }>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  recordAudit(event: GatewayAuditEvent): void;
  log(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Owns the MCP gateway lifecycle, the paired client records, and the
 * translation between an external client's proposed actions and a
 * host-validated WritePlan that flows through the standard
 * confirmation gate.
 */
export class GatewayService {
  private server: RunningGatewayServer | undefined;
  /**
   * Every read-modify-write of the config, and every listener start or
   * stop, runs in this queue, so two changes never write snapshots over
   * each other. `writeConfig` takes the host lock for the state file,
   * but a change read before another change wrote would still undo it.
   */
  private configQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: GatewayServiceHost) {}

  async getStatus(): Promise<GatewayPublicStatus> {
    const config = await this.readConfig();
    return {
      enabled: config.enabled,
      running: this.server !== undefined,
      port: config.port,
      ...(this.server ? { listeningPort: this.server.port } : {}),
      ...(config.boundTenantId ? { boundTenantId: config.boundTenantId } : {}),
      clients: config.clients.map(publicClient),
    };
  }

  /**
   * Enable with an explicit tenant binding. Clients are paired
   * separately; clients paired for another tenant are dropped.
   */
  async enable(input: {
    boundTenantId: string;
    port?: number;
  }): Promise<GatewayPublicStatus> {
    await this.withConfig(async () => {
      const config = await this.migratedConfig();
      const nextConfig: GatewayConfig = {
        ...config,
        enabled: true,
        port: input.port ?? config.port ?? DEFAULT_GATEWAY_PORT,
        boundTenantId: input.boundTenantId,
        clients: config.boundTenantId === input.boundTenantId ? config.clients : [],
      };
      await this.host.writeConfig(nextConfig);
      await this.restart(nextConfig);
    });
    return this.getStatus();
  }

  /** Stop the listener and revoke every paired client. */
  async disable(): Promise<GatewayPublicStatus> {
    await this.withConfig(async () => {
      const config = await this.migratedConfig();
      await this.host.writeConfig({ ...config, enabled: false, clients: [] });
      await this.stop();
    });
    return this.getStatus();
  }

  /**
   * Pair one client under the name the admin gave. Its token is
   * returned once and only its hash is kept. A record from before
   * per-client pairing with the same name is replaced.
   */
  async pairClient(input: {
    name: string;
  }): Promise<{ status: GatewayPublicStatus; client: GatewayClientSummary; token: string }> {
    const { record, token } = await this.withConfig(async () => {
      const config = await this.migratedConfig();
      if (!config.enabled || !config.boundTenantId) {
        throw new Error("Enable the gateway before pairing a client.");
      }
      const name = input.name.trim();
      if (name.length === 0 || name.length > CLIENT_NAME_MAX_LENGTH) {
        throw new Error(
          `Enter a client name of 1 to ${CLIENT_NAME_MAX_LENGTH} characters, for example Claude Code.`,
        );
      }
      const sameName = (client: GatewayClientRecord) =>
        client.name.toLowerCase() === name.toLowerCase();
      if (config.clients.some((client) => client.tokenHash && sameName(client))) {
        throw new Error(
          `A client named ${name} is already paired. Choose another name, or revoke ${name} and pair it again.`,
        );
      }
      const token = generateToken();
      const record: GatewayClientRecord = {
        id: `client_${randomBytes(6).toString("hex")}`,
        name,
        createdAt: new Date().toISOString(),
        tokenHash: hashToken(token),
      };
      await this.host.writeConfig({
        ...config,
        clients: [...config.clients.filter((client) => !sameName(client)), record],
      });
      return { record, token };
    });
    return { status: await this.getStatus(), client: publicClient(record), token };
  }

  /** Remove a client record; its token stops working on the next request. */
  async revokeClient(clientId: string): Promise<GatewayPublicStatus> {
    await this.withConfig(async () => {
      const config = await this.migratedConfig();
      await this.host.writeConfig({
        ...config,
        clients: config.clients.filter((client) => client.id !== clientId),
      });
    });
    return this.getStatus();
  }

  /** Start on app launch if persisted config says enabled. */
  async startIfEnabled(): Promise<void> {
    await this.withConfig(async () => {
      const config = await this.migratedConfig();
      if (config.enabled && config.boundTenantId) {
        await this.restart(config);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = undefined;
    }
  }

  /**
   * Resolve a presented token against the current client records, so a
   * revoke applies to the next request. Hashes are compared in constant
   * time and every record is checked. The config is read through the
   * migration, so the shared token of an earlier version is refused as
   * such even before anything else has read the config.
   */
  async authenticate(token: string): Promise<GatewayAuthResult> {
    const config = await this.readConfig();
    const presented = Buffer.from(hashToken(token), "hex");
    let match: GatewayClientRecord | undefined;
    for (const client of config.clients) {
      if (client.tokenHash && hashesEqual(presented, client.tokenHash)) match = client;
    }
    if (match) return { kind: "client", client: { id: match.id, name: match.name } };
    if (config.legacyTokenHash && hashesEqual(presented, config.legacyTokenHash)) {
      return { kind: "legacy-token" };
    }
    return { kind: "unknown" };
  }

  /**
   * Validate, then queue, a proposal from an authenticated client. The
   * client name on the run is the paired record's name.
   */
  async propose(
    tenantId: string,
    client: GatewayClientIdentity,
    input: Parameters<GatewayHost["proposeWritePlan"]>[1],
  ): ReturnType<GatewayHost["proposeWritePlan"]> {
    const { plan, requiredScopes } = buildProposalPlan({ ...input, clientName: client.name });
    try {
      const { run, alreadyWaiting } = await this.host.queueExternalProposal({
        tenantId,
        clientId: client.id,
        clientName: client.name,
        plan,
        requiredScopes,
      });
      return {
        outcome: alreadyWaiting ? "already-waiting" : "queued",
        runId: run.id,
        confirmationPhrase: run.plan?.confirmationPhrase ?? plan.confirmationPhrase,
      };
    } catch (error) {
      if (!(error instanceof GatewayProposalRefusedError)) throw error;
      try {
        this.host.recordAudit({
          type: "gateway.proposal.refused",
          tenantId,
          timestamp: new Date().toISOString(),
          details: {
            clientId: client.id,
            clientName: client.name,
            reason: error.reason,
            planDigest: error.details.planDigest,
            actionCount: plan.actions.length,
            ...(error.details.retryAfter ? { retryAfter: error.details.retryAfter } : {}),
          },
        });
      } catch (auditError) {
        this.host.log("gateway refusal could not be written to the audit log", {
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
      return {
        outcome: "refused",
        reason: error.reason,
        message: error.message,
        ...(error.details.retryAfter ? { retryAfter: error.details.retryAfter } : {}),
      };
    }
  }

  /**
   * The config, after moving a shared token an earlier version kept in
   * safeStorage to a hash. Clients that still present it are refused
   * with a message to pair again; it is never accepted, because every
   * client shared it and their names were self-reported.
   */
  private readConfig(): Promise<GatewayConfig> {
    return this.withConfig(() => this.migratedConfig());
  }

  /** The migrating read. Call it only inside `withConfig`. */
  private async migratedConfig(): Promise<GatewayConfig> {
    const config = await this.host.readConfig();
    const legacy = await this.host.readLegacyToken();
    if (!legacy) return config;
    const next: GatewayConfig = { ...config, legacyTokenHash: hashToken(legacy) };
    await this.host.writeConfig(next);
    await this.host.clearLegacyToken();
    return next;
  }

  /** Runs `task` after every config change queued before it has settled. */
  private withConfig<T>(task: () => Promise<T>): Promise<T> {
    const next = this.configQueue.then(task, task);
    this.configQueue = next.catch(() => undefined);
    return next;
  }

  private async restart(config: GatewayConfig): Promise<void> {
    await this.stop();
    if (!config.enabled || !config.boundTenantId) return;
    const boundTenantId = config.boundTenantId;
    const gatewayHost: GatewayHost = {
      tenantName: async () =>
        (await this.host.tenantName(boundTenantId)) ?? "the connected tenant",
      executeReadTool: (name, input) =>
        this.host.executeReadTool(boundTenantId, name, input),
      proposeWritePlan: (client, input) => this.propose(boundTenantId, client, input),
      getProposalStatus: async (client, runId) => {
        const run = await this.host.getRun(runId);
        if (
          !run ||
          run.origin !== "external-proposal" ||
          run.external?.clientId !== client.id
        ) {
          return { found: false };
        }
        return {
          found: true,
          status: run.status,
          ...(run.summary ? { summary: run.summary } : {}),
          ...(run.error ? { error: run.error } : {}),
        };
      },
      log: (message, metadata) => this.host.log(message, metadata),
    };
    this.server = await startGatewayServer(gatewayHost, {
      port: config.port,
      authenticate: (token) => this.authenticate(token),
    });
  }
}

function publicClient(client: GatewayClientRecord): GatewayClientSummary {
  return {
    id: client.id,
    name: client.name,
    createdAt: client.createdAt,
    ...(client.tokenHash ? {} : { needsPairing: true as const }),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(presented: Buffer, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Replace a concrete trailing id segment with a `{id}` template. */
function templatizeTrailingId(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const segments = withoutQuery.split("/");
  const last = segments[segments.length - 1];
  if (!last || last.startsWith("{")) return withoutQuery;
  segments[segments.length - 1] = "{id}";
  return segments.join("/");
}

/**
 * Validate proposed actions against the bundled Graph catalog and build
 * a WritePlan. Unknown endpoints are rejected outright: an external
 * client cannot smuggle in an unlisted path. Required write scopes are
 * collected from the catalog, and DELETE actions are marked destructive.
 */
export function buildProposalPlan(input: {
  title: string;
  clientName: string;
  actions: Array<{
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    label: string;
  }>;
}): { plan: WritePlan; requiredScopes: string[] } {
  const actions: WriteAction[] = [];
  const requiredScopes = new Set<string>();
  input.actions.forEach((action, index) => {
    // The catalog only recognizes GUID/numeric/quoted id segments as
    // templated ids. External clients may send other id shapes (or item
    // paths at all), so probe the concrete path first, then the same
    // path with a templated trailing id.
    const endpoint =
      lookupEndpoint(action.method, action.path) ??
      lookupEndpoint(action.method, templatizeTrailingId(action.path));
    if (!endpoint) {
      throw new Error(
        `Proposed ${action.method} ${action.path} is not a known Microsoft Graph endpoint.`,
      );
    }
    for (const scope of endpoint.scopesDelegated) {
      if (/ReadWrite|Write/.test(scope)) requiredScopes.add(scope);
    }
    actions.push({
      id: `proposal-${index}`,
      kind: "graph-write",
      label: action.label,
      description: `${action.method} ${action.path}`,
      severity: action.method === "DELETE" ? "destructive" : "default",
      request: {
        method: action.method,
        path: action.path,
        ...(action.body !== undefined ? { body: action.body } : {}),
      },
    });
  });
  const count = actions.length;
  return {
    plan: {
      summary: `${input.clientName} proposes ${count} ${count === 1 ? "change" : "changes"}: ${input.title}`,
      confirmationPhrase: `APPLY ${count} ${count === 1 ? "CHANGE" : "CHANGES"}`,
      actions,
    },
    requiredScopes: [...requiredScopes].sort(),
  };
}
