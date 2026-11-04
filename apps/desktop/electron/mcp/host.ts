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
  /** Set when the tool cannot be offered to Chat; shown in the Marketplace. */
  unavailable?: string;
}

export const MCP_SCHEMA_UNAVAILABLE =
  "Not offered to Chat: its parameter schema is too large to pass to a model, even without descriptions.";

export interface McpConnectResult {
  serverName?: string;
  serverVersion?: string;
  tools: McpToolInfo[];
}

export interface McpCallResult {
  /** The result text, capped at the output limit. */
  text: string;
  truncated: boolean;
  /**
   * The whole result as data: the server's structured content, or its
   * text parsed as JSON. Capped text can cut a JSON result in half, so
   * result items are read from here.
   */
  structured?: unknown;
}

export type McpHostErrorCode = "unreachable" | "timeout" | "server-error" | "tool-error" | "unknown-tool" | "redirect";

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
export const MCP_DESCRIPTION_LIMIT = 600;
export const MCP_SCHEMA_LIMIT = 1_500;

/**
 * Tool descriptions come from the server and are untrusted: control
 * characters are removed, whitespace collapsed and the text capped.
 */
export function cleanMcpDescription(text: unknown): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= MCP_DESCRIPTION_LIMIT ? flat : `${flat.slice(0, MCP_DESCRIPTION_LIMIT - 3)}...`;
}

/**
 * A schema within the limit is kept. An oversized one keeps its property
 * names, types and required list without descriptions. If that is still
 * too large, the result is undefined and the tool is not offered to Chat.
 */
export function cleanMcpSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object" };
  const record = schema as Record<string, unknown>;
  if (JSON.stringify(record).length <= MCP_SCHEMA_LIMIT) return record;
  const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
    ? record.properties as Record<string, unknown>
    : {};
  const typeOf = (value: unknown) => {
    const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
    return typeof type === "string" || Array.isArray(type) ? { type } : {};
  };
  const reduced: Record<string, unknown> = {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => {
      const items = value && typeof value === "object" ? (value as { items?: unknown }).items : undefined;
      return [name, { ...typeOf(value), ...(items ? { items: typeOf(items) } : {}) }];
    })),
    ...(Array.isArray(record.required) ? { required: record.required.filter((key) => typeof key === "string") } : {}),
  };
  return JSON.stringify(reduced).length <= MCP_SCHEMA_LIMIT ? reduced : undefined;
}

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
    this.fetch = sameOriginFetch(cappedFetch(options.fetch ?? fetch, options.maxResponseBytes ?? 2 * 1024 * 1024));
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
    if (!session.tools.some((tool) => tool.name === name && !tool.unavailable)) {
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
    const structured = result.structuredContent ?? parseJson(text);
    const data = structured !== null && typeof structured === "object" ? { structured } : {};
    if (text.length <= this.maxOutputChars) return { text, truncated: false, ...data };
    return { text: text.slice(0, this.maxOutputChars), truncated: true, ...data };
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
      if (!client.getServerCapabilities()?.tools) {
        throw new McpHostError("server-error", `${endpoint.name} connected but offers no tools. Nothing was installed.`);
      }
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
  const inputSchema = cleanMcpSchema(tool.inputSchema);
  return {
    name: tool.name,
    description: cleanMcpDescription(tool.description),
    inputSchema: inputSchema ?? { type: "object" },
    ...(inputSchema ? {} : { unavailable: MCP_SCHEMA_UNAVAILABLE }),
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

function describeError(error: unknown, endpoint: McpEndpoint, timeoutMs: number): McpHostError {
  if (error instanceof McpHostError) return error;
  const host = new URL(endpoint.url).hostname;
  if (isTimeout(error)) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return new McpHostError("timeout", `${endpoint.name} did not answer within ${seconds} second${seconds === 1 ? "" : "s"}. Retry, or ask a narrower question.`);
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

/**
 * Follows a redirect only within the server's own origin. A redirect to
 * another host would resend the tool params there, so it is refused and
 * never requested.
 */
function sameOriginFetch(base: FetchLike): FetchLike {
  return async (url, init) => {
    let target = new URL(url);
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await base(target, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, target);
      if (next.origin !== target.origin) {
        throw new McpHostError("redirect", `${target.hostname} redirected to ${next.hostname}. OpenAdminOS does not follow redirects to another host, so nothing was sent there.`);
      }
      target = next;
    }
    throw new McpHostError("redirect", `${target.hostname} redirected too many times. Nothing more was sent.`);
  };
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
