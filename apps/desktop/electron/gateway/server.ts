import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

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
 * Transport: streamable HTTP bound to 127.0.0.1 only, authenticated
 * with a single pairing token. The server is stateless per request;
 * tenant scope is fixed by the gateway configuration, never chosen by
 * the client.
 */

export interface GatewayHost {
  /** Human-readable tenant label for tool descriptions and errors. */
  tenantName(): Promise<string>;
  executeReadTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  proposeWritePlan(input: {
    title: string;
    clientName: string;
    actions: Array<{
      method: "POST" | "PATCH" | "PUT" | "DELETE";
      path: string;
      body?: Record<string, unknown>;
      label: string;
    }>;
  }): Promise<{ runId: string; confirmationPhrase: string }>;
  getProposalStatus(runId: string): Promise<
    | { found: false }
    | { found: true; status: string; summary?: string; error?: string }
  >;
  log(message: string, metadata?: Record<string, unknown>): void;
}

export interface GatewayServerOptions {
  port: number;
  token: string;
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

function buildMcpServer(host: GatewayHost, tenantLabel: string): McpServer {
  const server = new McpServer({
    name: "openadminos-gateway",
    version: "0.5.0",
  });

  const toolResult = (value: unknown) => ({
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  });

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
      async (input: Record<string, unknown>) => {
        host.log(`gateway read tool ${name}`, { name });
        return toolResult(await host.executeReadTool(name, input));
      },
    );
  }

  server.registerTool(
    "propose_write_plan",
    {
      description:
        "Propose Microsoft Graph write actions for this tenant. The proposal is queued inside OpenAdminOS and applies ONLY after a human reviews the plan and types the confirmation phrase in the desktop app. This tool cannot apply changes.",
      inputSchema: {
        title: z.string().min(3).max(200),
        clientName: z.string().min(1).max(100),
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
      clientName: string;
      actions: Array<{
        method: "POST" | "PATCH" | "PUT" | "DELETE";
        path: string;
        body?: Record<string, unknown>;
        label: string;
      }>;
    }) => {
      host.log("gateway write proposal", {
        clientName: input.clientName,
        actionCount: input.actions.length,
      });
      const proposal = await host.proposeWritePlan(input);
      return toolResult({
        runId: proposal.runId,
        status: "awaiting-confirmation",
        note: `A human must review this plan in OpenAdminOS and type "${proposal.confirmationPhrase}" before anything is applied. Poll get_proposal_status for the outcome.`,
      });
    },
  );

  server.registerTool(
    "get_proposal_status",
    {
      description:
        "Check the status of a previously proposed write plan (awaiting-confirmation, running, completed, failed, or rejected).",
      inputSchema: { runId: z.string().min(1).max(200) },
    },
    async (input: { runId: string }) => {
      const status = await host.getProposalStatus(input.runId);
      if (!status.found) {
        return toolResult({ found: false, note: "No proposal with this id exists." });
      }
      return toolResult(status);
    },
  );

  return server;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export async function startGatewayServer(
  host: GatewayHost,
  options: GatewayServerOptions,
): Promise<RunningGatewayServer> {
  if (!options.token || options.token.length < 24) {
    throw new Error("Gateway pairing token is missing or too short.");
  }

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!tokenMatches(request.headers.authorization, options.token)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "Missing or invalid gateway pairing token." }),
        );
        return;
      }
      // Stateless mode: one server + transport per request keeps every
      // request isolated; tenant scope comes from configuration.
      const tenantLabel = await host.tenantName();
      const server = buildMcpServer(host, tenantLabel);
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
