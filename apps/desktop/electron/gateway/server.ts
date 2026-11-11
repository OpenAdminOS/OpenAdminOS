import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * The governed MCP write-gateway. External AI clients get the same
 * read-only tool surface Chat uses, and exactly one write capability:
 * proposing a plan. A proposal parks as a run awaiting the standard
 * typed confirmation inside the desktop app; nothing an external
 * client sends can apply a change.
 *
 * Transport: streamable HTTP bound to 127.0.0.1 only. Every request
 * carries one paired client's own token; the host resolves it to that
 * client's record, and the client name on a proposal comes from that
 * record, never from the request. The server is stateless per request;
 * tenant scope is fixed by the gateway configuration, never chosen by
 * the client.
 */

/** The paired client a request authenticated as. */
export interface GatewayClientIdentity {
  id: string;
  name: string;
}

export type GatewayAuthResult =
  | { kind: "client"; client: GatewayClientIdentity }
  /** The shared token from before per-client pairing. */
  | { kind: "legacy-token" }
  | { kind: "unknown" }
  /** The gateway is off or unbound now, whatever the token. */
  | { kind: "gateway-off" }
  /** The gateway is bound to another tenant than this listener serves. */
  | { kind: "other-organization" };

export type GatewayProposalResult =
  | {
      outcome: "queued" | "already-waiting";
      runId: string;
      confirmationPhrase: string;
    }
  | {
      outcome: "refused";
      reason: "pending-limit" | "rejected-cooldown";
      message: string;
      retryAfter?: string;
    };

export const GATEWAY_LEGACY_TOKEN_COPY =
  "This client uses the shared gateway token from an earlier OpenAdminOS version. That token no longer works, because each client now has its own token. In OpenAdminOS, open Settings, Gateway, enter a name for this client and select Pair client, then replace the token in this client's MCP configuration with the one shown.";

export const GATEWAY_UNKNOWN_TOKEN_COPY =
  "This gateway token is not paired with OpenAdminOS, or the client was revoked. In OpenAdminOS, open Settings, Gateway, enter a name for this client and select Pair client, then put the token shown in this client's MCP configuration as a Bearer token.";

export const GATEWAY_OFF_COPY =
  "The OpenAdminOS gateway is off, so it accepts no requests. Turning the gateway off, or disconnecting the organization it was bound to, revokes every paired client. In OpenAdminOS, open Settings, Gateway, select the organization and turn on Enable gateway, then pair this client again and put the new token in this client's MCP configuration.";

export const GATEWAY_OTHER_ORGANIZATION_COPY =
  "The OpenAdminOS gateway is now bound to another organization, so this connection no longer works. In OpenAdminOS, open Settings, Gateway, check the bound tenant, then pair this client again and put the new token in this client's MCP configuration.";

/** The status, code and copy of each refused authentication. */
const GATEWAY_REFUSALS: Record<Exclude<GatewayAuthResult["kind"], "client">, { status: number; code: string; error: string }> = {
  "legacy-token": { status: 401, code: "legacy-shared-token", error: GATEWAY_LEGACY_TOKEN_COPY },
  unknown: { status: 401, code: "unpaired-token", error: GATEWAY_UNKNOWN_TOKEN_COPY },
  "gateway-off": { status: 403, code: "gateway-off", error: GATEWAY_OFF_COPY },
  "other-organization": { status: 403, code: "gateway-other-organization", error: GATEWAY_OTHER_ORGANIZATION_COPY },
};

export interface GatewayHost {
  /** Human-readable tenant label for tool descriptions and errors. */
  tenantName(): Promise<string>;
  executeReadTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  proposeWritePlan(client: GatewayClientIdentity, input: {
    title: string;
    actions: Array<{
      method: "POST" | "PATCH" | "PUT" | "DELETE";
      path: string;
      body?: Record<string, unknown>;
      label: string;
    }>;
  }): Promise<GatewayProposalResult>;
  /** Status of a proposal; only the client that made it can read it. */
  getProposalStatus(client: GatewayClientIdentity, runId: string): Promise<
    | { found: false }
    | { found: true; status: string; summary?: string; error?: string }
  >;
  /**
   * Check, when a tool runs, that `client` may still act: the gateway is
   * on, bound to this listener's tenant, and the client still paired.
   * The request was authenticated from its headers, before its body
   * arrived, so this reads the config again.
   */
  authorize(client: GatewayClientIdentity): Promise<GatewayAuthResult>;
  log(message: string, metadata?: Record<string, unknown>): void;
}

export interface GatewayServerOptions {
  port: number;
  /**
   * Resolve a presented Bearer token, reading the current config, so a
   * gateway turned off, unbound or bound elsewhere refuses the request.
   */
  authenticate(token: string): Promise<GatewayAuthResult>;
}

export interface RunningGatewayServer {
  port: number;
  close(): Promise<void>;
}

const READ_TOOL_INPUTS: Record<string, z.ZodRawShape> = {
  list_cached_resources: {
    staleAfterHours: z.number().optional(),
  },
  query_cache: {
    resource: z.string(),
    filters: z.array(z.record(z.string(), z.unknown())).optional(),
    sort: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().optional(),
  },
  graph_get: {
    path: z.string(),
    query: z.record(z.string(), z.string()).optional(),
  },
  query_drift: {
    resource: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    top: z.number().optional(),
  },
};

function buildMcpServer(
  host: GatewayHost,
  tenantLabel: string,
  client: GatewayClientIdentity,
): McpServer {
  const server = new McpServer({
    name: "openadminos-gateway",
    version: "0.5.0",
  });

  const toolResult = (value: unknown) => ({
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  });

  /**
   * Runs `tool` only when the client may still act. Otherwise the tool
   * returns the designed refusal the request would get now, as a tool
   * error, and nothing is read or queued.
   */
  const authorized = async <T>(tool: () => Promise<T>) => {
    const auth = await host.authorize(client);
    if (auth.kind === "client") return tool();
    host.log("gateway tool call refused", { reason: auth.kind, clientId: client.id });
    const refusal = GATEWAY_REFUSALS[auth.kind];
    return { ...toolResult({ error: refusal.error, code: refusal.code }), isError: true };
  };

  const readToolDescriptions: Record<string, string> = {
    list_cached_resources:
      "List the connected tenant's cached Graph resources with row counts, freshness, and errors.",
    query_cache:
      "Query cached tenant rows (filters, sort, capped limit). Read-only.",
    graph_get:
      "Perform a validated read-only Microsoft Graph GET within the gateway's scope allowlist.",
    query_drift:
      "Read the tenant's local configuration drift timeline. Read-only.",
  };

  for (const [name, shape] of Object.entries(READ_TOOL_INPUTS)) {
    server.registerTool(
      name,
      {
        description: `${readToolDescriptions[name]} Tenant: ${tenantLabel}.`,
        inputSchema: shape,
      },
      async (input: Record<string, unknown>) => authorized(async () => {
        host.log(`gateway read tool ${name}`, { name, clientId: client.id });
        return toolResult(await host.executeReadTool(name, input));
      }),
    );
  }

  server.registerTool(
    "propose_write_plan",
    {
      description:
        "Propose Microsoft Graph write actions for this tenant. The proposal is queued inside OpenAdminOS and applies ONLY after a human reviews the plan and types the confirmation phrase in the desktop app. This tool cannot apply changes.",
      inputSchema: {
        title: z.string().min(3).max(200),
        actions: z
          .array(
            z.object({
              method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
              path: z.string().min(2).max(1024),
              body: z.record(z.string(), z.unknown()).optional(),
              label: z.string().min(1).max(300),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    async (input: {
      title: string;
      actions: Array<{
        method: "POST" | "PATCH" | "PUT" | "DELETE";
        path: string;
        body?: Record<string, unknown>;
        label: string;
      }>;
    }) => authorized(async () => {
      host.log("gateway write proposal", {
        clientId: client.id,
        actionCount: input.actions.length,
      });
      // The proposing client is the authenticated one; a name in the
      // body is not part of the schema and never reaches the plan.
      const proposal = await host.proposeWritePlan(client, {
        title: input.title,
        actions: input.actions,
      });
      if (proposal.outcome === "refused") {
        return {
          ...toolResult({
            status: "refused",
            reason: proposal.reason,
            note: proposal.message,
            ...(proposal.retryAfter ? { retryAfter: proposal.retryAfter } : {}),
          }),
          isError: true,
        };
      }
      const confirm = `A human must review this plan in OpenAdminOS and type "${proposal.confirmationPhrase}" before anything is applied. Poll get_proposal_status for the outcome.`;
      return toolResult({
        runId: proposal.runId,
        status:
          proposal.outcome === "already-waiting"
            ? "already-awaiting-confirmation"
            : "awaiting-confirmation",
        note:
          proposal.outcome === "already-waiting"
            ? `An identical proposal from this client is already waiting for review, so no new one was queued. ${confirm}`
            : confirm,
      });
    }),
  );

  server.registerTool(
    "get_proposal_status",
    {
      description:
        "Check the status of a previously proposed write plan (awaiting-confirmation, running, completed, failed, or rejected).",
      inputSchema: { runId: z.string().min(1).max(200) },
    },
    async (input: { runId: string }) => authorized(async () => {
      const status = await host.getProposalStatus(client, input.runId);
      if (!status.found) {
        return toolResult({ found: false, note: "This client has no proposal with this id. Each client sees only the proposals it made." });
      }
      return toolResult(status);
    }),
  );

  return server;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

export async function startGatewayServer(
  host: GatewayHost,
  options: GatewayServerOptions,
): Promise<RunningGatewayServer> {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const presented = bearerToken(request.headers.authorization);
      const auth: GatewayAuthResult = presented
        ? await options.authenticate(presented)
        : { kind: "unknown" };
      if (auth.kind !== "client") {
        host.log("gateway request refused", { reason: auth.kind });
        const refusal = GATEWAY_REFUSALS[auth.kind];
        response.writeHead(refusal.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: refusal.error, code: refusal.code }));
        return;
      }
      // Stateless mode: one server + transport per request keeps every
      // request isolated; tenant scope comes from configuration.
      const tenantLabel = await host.tenantName();
      const server = buildMcpServer(host, tenantLabel, auth.client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      host.log("gateway request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Gateway request failed." }));
      } else {
        response.end();
      }
    }
  };

  const httpServer: Server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address();
  const port =
    typeof address === "object" && address !== null ? address.port : options.port;
  host.log("gateway listening", { port });

  return {
    port,
    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
