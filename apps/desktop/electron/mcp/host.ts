import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * MCP client for remote servers, in the main process. Chat reaches a
 * server only through this host: the renderer never opens a connection,
 * and the external MCP gateway never forwards to it.
 */
export interface McpEndpoint {
  id: string;
  name: string;
  url: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpConnectResult {
  serverName?: string;
  serverVersion?: string;
  tools: McpToolInfo[];
}

export interface McpCallResult {
  text: string;
  truncated: boolean;
}

export type McpHostErrorCode = "unreachable" | "timeout" | "server-error" | "tool-error" | "unknown-tool";

export class McpHostError extends Error {
  constructor(readonly code: McpHostErrorCode, message: string) {
    super(message);
    this.name = "McpHostError";
  }
}

export interface McpHostOptions {
  clientVersion: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Characters of tool output passed on to Chat. */
  maxOutputChars?: number;
  /** Bytes read from any single HTTP response before it is cut off. */
  maxResponseBytes?: number;
  fetch?: FetchLike;
}

export const MCP_MAX_TOOLS_PER_SERVER = 32;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_SCHEMA_CHARS = 4_000;

interface Session {
  client: Client;
  tools: McpToolInfo[];
}

export class McpHost {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fetch: FetchLike;

  constructor(private readonly options: McpHostOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.maxOutputChars = options.maxOutputChars ?? 12_000;
    this.fetch = cappedFetch(options.fetch ?? fetch, options.maxResponseBytes ?? 2 * 1024 * 1024);
  }

  /** Open a fresh session and list the server's tools. */
  async connect(endpoint: McpEndpoint): Promise<McpConnectResult> {
    await this.disconnect(endpoint.id);
    const session = this.open(endpoint);
    this.sessions.set(endpoint.id, session);
    try {
      const { client, tools } = await session;
      const info = client.getServerVersion();
      return {
        ...(info?.name ? { serverName: info.name } : {}),
        ...(info?.version ? { serverVersion: info.version } : {}),
        tools,
      };
    } catch (error) {
      this.sessions.delete(endpoint.id);
      throw error;
    }
  }

  async callTool(
    endpoint: McpEndpoint,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const session = await this.session(endpoint);
    if (!session.tools.some((tool) => tool.name === name)) {
      throw new McpHostError("unknown-tool", `${endpoint.name} does not list a tool named ${name}.`);
    }
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await session.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.callTimeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      // A broken session must not stick: the next call opens a new one.
      if (!isTimeout(error)) await this.disconnect(endpoint.id);
      throw describeError(error, endpoint, this.callTimeoutMs);
    }
    const text = resultText(result);
    if (result.isError === true) {
      throw new McpHostError("tool-error", `${endpoint.name} returned an error: ${clip(text || "no detail", 300)}`);
    }
    if (text.length <= this.maxOutputChars) return { text, truncated: false };
    return { text: text.slice(0, this.maxOutputChars), truncated: true };
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.then((open) => open.client.close(), () => undefined).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  private session(endpoint: McpEndpoint): Promise<Session> {
    const existing = this.sessions.get(endpoint.id);
    if (existing) return existing;
    const session = this.open(endpoint);
    this.sessions.set(endpoint.id, session);
    session.catch(() => {
      if (this.sessions.get(endpoint.id) === session) this.sessions.delete(endpoint.id);
    });
    return session;
  }

  private async open(endpoint: McpEndpoint): Promise<Session> {
    const client = new Client({ name: "OpenAdminOS", version: this.options.clientVersion });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      fetch: this.fetch,
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs });
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4 && tools.length < MCP_MAX_TOOLS_PER_SERVER; page += 1) {
        const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.connectTimeoutMs });
        for (const tool of listed.tools) {
          const info = sanitizeTool(tool);
          if (info && tools.length < MCP_MAX_TOOLS_PER_SERVER) tools.push(info);
        }
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      if (tools.length === 0) {
        throw new McpHostError("server-error", `${endpoint.name} connected but listed no usable tools.`);
      }
      return { client, tools };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw describeError(error, endpoint, this.connectTimeoutMs);
    }
  }
}

function sanitizeTool(tool: { name: string; description?: string; inputSchema: unknown }): McpToolInfo | undefined {
  if (!TOOL_NAME.test(tool.name)) return undefined;
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema as Record<string, unknown> : {};
  const serialized = JSON.stringify(schema);
  return {
    name: tool.name,
    description: clip((tool.description ?? "").replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_CHARS),
    inputSchema: serialized.length <= MAX_SCHEMA_CHARS ? schema : { type: "object" },
  };
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && item.resource && typeof (item.resource as { text?: unknown }).text === "string") {
      parts.push((item.resource as { text: string }).text);
    } else if (typeof item.type === "string") parts.push(`[${item.type} content omitted]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n\n").trim();
}

function isTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

function describeError(error: unknown, endpoint: McpEndpoint, timeoutMs: number): McpHostError {
  if (error instanceof McpHostError) return error;
  const host = new URL(endpoint.url).hostname;
  if (isTimeout(error)) {
    return new McpHostError("timeout", `${endpoint.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Retry, or ask a narrower question.`);
  }
  const status = (error as { code?: unknown })?.code;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return new McpHostError("server-error", `${endpoint.name} at ${host} answered HTTP ${status}. Retry later.`);
  }
  if (error instanceof McpError) {
    return new McpHostError("server-error", `${endpoint.name} returned a protocol error: ${clip(error.message, 300)}`);
  }
  return new McpHostError("unreachable", `${endpoint.name} could not be reached at ${host}. Check the network connection, then retry.`);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/** Stops reading any single response after `maxBytes`. */
function cappedFetch(base: FetchLike, maxBytes: number): FetchLike {
  return async (url, init) => {
    const response = await base(url, init);
    if (!response.body || [101, 204, 205, 304].includes(response.status)) return response;
    let size = 0;
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(new Error("MCP response exceeded the size limit."));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
