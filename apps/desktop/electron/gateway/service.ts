import { randomBytes } from "node:crypto";

import type {
  GatewayPublicStatus,
  RunRecord,
  WriteAction,
  WritePlan,
} from "@openadminos/agent-sdk";

import { lookupEndpoint } from "../graph-catalog.js";
import {
  startGatewayServer,
  type GatewayHost,
  type RunningGatewayServer,
} from "./server.js";

export interface GatewayConfig {
  enabled: boolean;
  port: number;
  boundTenantId?: string;
  clients: Array<{ id: string; name: string; createdAt: string }>;
}

const DEFAULT_GATEWAY_PORT = 8092;

export interface GatewayServiceHost {
  readConfig(): Promise<GatewayConfig>;
  writeConfig(config: GatewayConfig): Promise<void>;
  readToken(): Promise<string | undefined>;
  writeToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  tenantName(tenantId: string): Promise<string | undefined>;
  executeReadTool(
    tenantId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  queueExternalProposal(input: {
    tenantId: string;
    clientName: string;
    plan: WritePlan;
    requiredScopes: string[];
  }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  log(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Owns the MCP gateway lifecycle and the translation between an
 * external client's proposed actions and a host-validated WritePlan
 * that flows through the standard confirmation gate.
 */
export class GatewayService {
  private server: RunningGatewayServer | undefined;

  constructor(private readonly host: GatewayServiceHost) {}

  async getStatus(): Promise<GatewayPublicStatus> {
    const config = await this.host.readConfig();
    const token = await this.host.readToken();
    return {
      enabled: config.enabled,
      running: this.server !== undefined,
      port: config.port,
      ...(this.server ? { listeningPort: this.server.port } : {}),
      ...(config.boundTenantId ? { boundTenantId: config.boundTenantId } : {}),
      hasToken: Boolean(token),
      clients: config.clients,
    };
  }

  /** Enable with an explicit tenant binding, returning the pairing token once. */
  async enable(input: {
    boundTenantId: string;
    port?: number;
  }): Promise<{ status: GatewayPublicStatus; token: string }> {
    const config = await this.host.readConfig();
    const token = generateToken();
    await this.host.writeToken(token);
    const nextConfig: GatewayConfig = {
      ...config,
      enabled: true,
      port: input.port ?? config.port ?? DEFAULT_GATEWAY_PORT,
      boundTenantId: input.boundTenantId,
    };
    await this.host.writeConfig(nextConfig);
    await this.restart(nextConfig, token);
    return { status: await this.getStatus(), token };
  }

  async disable(): Promise<GatewayPublicStatus> {
    const config = await this.host.readConfig();
    await this.host.writeConfig({ ...config, enabled: false });
    await this.stop();
    await this.host.clearToken();
    return this.getStatus();
  }

  /** Fresh token; existing paired clients must re-pair. */
  async regenerateToken(): Promise<{ status: GatewayPublicStatus; token: string }> {
    const config = await this.host.readConfig();
    if (!config.enabled || !config.boundTenantId) {
      throw new Error("Enable the gateway before regenerating its token.");
    }
    const token = generateToken();
    await this.host.writeToken(token);
    await this.restart(config, token);
    return { status: await this.getStatus(), token };
  }

  async revokeClient(clientId: string): Promise<GatewayPublicStatus> {
    const config = await this.host.readConfig();
    await this.host.writeConfig({
      ...config,
      clients: config.clients.filter((client) => client.id !== clientId),
    });
    return this.getStatus();
  }

  /** Start on app launch if persisted config says enabled. */
  async startIfEnabled(): Promise<void> {
    const config = await this.host.readConfig();
    const token = await this.host.readToken();
    if (config.enabled && config.boundTenantId && token) {
      await this.restart(config, token);
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = undefined;
    }
  }

  private async restart(config: GatewayConfig, token: string): Promise<void> {
    await this.stop();
    if (!config.enabled || !config.boundTenantId) return;
    const boundTenantId = config.boundTenantId;
    const gatewayHost: GatewayHost = {
      tenantName: async () =>
        (await this.host.tenantName(boundTenantId)) ?? "the connected tenant",
      executeReadTool: (name, input) =>
        this.host.executeReadTool(boundTenantId, name, input),
      proposeWritePlan: async (input) => {
        await this.recordClient(input.clientName);
        const { plan, requiredScopes } = buildProposalPlan(input);
        const run = await this.host.queueExternalProposal({
          tenantId: boundTenantId,
          clientName: input.clientName,
          plan,
          requiredScopes,
        });
        return { runId: run.id, confirmationPhrase: plan.confirmationPhrase };
      },
      getProposalStatus: async (runId) => {
        const run = await this.host.getRun(runId);
        if (!run || run.origin !== "external-proposal") return { found: false };
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
      token,
    });
  }

  private async recordClient(name: string): Promise<void> {
    const config = await this.host.readConfig();
    if (config.clients.some((client) => client.name === name)) return;
    await this.host.writeConfig({
      ...config,
      clients: [
        ...config.clients,
        { id: `client_${randomBytes(6).toString("hex")}`, name, createdAt: new Date().toISOString() },
      ],
    });
  }
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
