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
  /** The tool allowlist from the catalog. Other tools are never listed or called. */
  tools?: readonly string[];
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
  /** Allowlisted tools the server did not list. */
  missingTools: string[];
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

export type McpHostErrorCode = "unreachable" | "timeout" | "server-error" | "tool-error" | "unknown-tool" | "tools-missing" | "redirect" | "revoked";

export class McpHostError extends Error {
  /**
   * @param sent Whether the call may have reached the server. False only
   * when the host refused it before dispatch.
   */
  constructor(readonly code: McpHostErrorCode, message: string, readonly sent = true) {
    super(message);
    this.name = "McpHostError";
  }
}

/** Why a server's calls are no longer authorized. */
export type McpRevocation = "disabled" | "uninstalled";

export interface McpHostOptions {
  clientVersion: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Characters of tool output passed on to Chat. */
  maxOutputChars?: number;
  /** Bytes read from any single HTTP response before it is cut off. */
  maxResponseBytes?: number;
  fetch?: FetchLike;
  /**
   * Reads the server's installed and enabled state, immediately before a
   * call is dispatched. A reason refuses the call and nothing is sent.
   */
  revocation?: (serverId: string) => McpRevocation | undefined | Promise<McpRevocation | undefined>;
  /**
   * Receives the tools a session opened for a call listed, so the stored
   * listing and the Marketplace follow a server that changed its tools
   * since it was installed or last checked.
   */
  listed?: (serverId: string, tools: McpToolInfo[]) => void | Promise<void>;
}

interface Authorization {
  generation: number;
  /** Aborts calls of this generation still in flight when it is revoked. */
  controller: AbortController;
  /** Why the previous generation was revoked. */
  revoked?: McpRevocation;
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
  missingTools: string[];
}

/** Whether the catalog lets OpenAdminOS use this tool of the server. */
export function isAllowedTool(endpoint: Pick<McpEndpoint, "tools">, name: string): boolean {
  return !endpoint.tools || endpoint.tools.includes(name);
}

export class McpHost {
  private readonly sessions = new Map<string, Promise<Session>>();
  /**
   * Sessions opened for a call whose listing has not gone to `listed` yet.
   * The report runs in the call, never inside the session promise, so
   * closing a session never waits on the store that receives it.
   */
  private readonly unreported = new WeakSet<Session>();
  private readonly authorizations = new Map<string, Authorization>();
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
      const { client, tools, missingTools } = await session;
      const info = client.getServerVersion();
      return {
        ...(info?.name ? { serverName: info.name } : {}),
        ...(info?.version ? { serverVersion: info.version } : {}),
        tools,
        missingTools,
      };
    } catch (error) {
      this.sessions.delete(endpoint.id);
      throw error;
    }
  }

  /**
   * The server's current authorization generation. A Chat answer records
   * it when its tools are listed; a call from an older generation is
   * refused.
   */
  generation(id: string): number {
    return this.authorization(id).generation;
  }

  /**
   * Turning a server off or uninstalling it revokes the calls of every
   * answer already running: the generation moves on, calls in flight are
   * aborted and the session is closed.
   */
  async revoke(id: string, reason: McpRevocation): Promise<void> {
    const current = this.authorization(id);
    this.authorizations.set(id, { generation: current.generation + 1, controller: new AbortController(), revoked: reason });
    current.controller.abort();
    await this.disconnect(id);
  }

  /**
   * Calls a tool. With `generation`, the call is refused before anything
   * is sent when the server was turned off or uninstalled since then, and
   * the installed and enabled state is read again right before dispatch,
   * also before a closed session is reopened.
   */
  async callTool(
    endpoint: McpEndpoint,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    generation?: number,
  ): Promise<McpCallResult> {
    if (!isAllowedTool(endpoint, name)) {
      throw new McpHostError("unknown-tool", `OpenAdminOS does not offer ${name} from ${endpoint.name}. Nothing was sent.`, false);
    }
    await this.authorize(endpoint, generation);
    const session = await this.session(endpoint);
    let unsaved = false;
    if (this.unreported.delete(session)) {
      try {
        await this.options.listed?.(endpoint.id, session.tools);
      } catch (error) {
        // The next call on this session tries again; the call itself is decided by the session below.
        this.unreported.add(session);
        unsaved = true;
        // The detail stays in the local log: this message reaches the model, and a file error can name local paths.
        console.warn(`OpenAdminOS could not store the tool list of ${endpoint.name}:`, error);
      }
    }
    // A server missing any offered tool is skipped whole, also when a session opened for a call finds this.
    if (session.missingTools.length > 0) {
      const missing = session.missingTools.join(", ");
      const them = session.missingTools.length === 1 ? "it" : "them";
      const notSaved = unsaved
        ? "The Marketplace could not record this and still shows the old tool list. "
        : "";
      throw new McpHostError(
        "tools-missing",
        `${endpoint.name} no longer lists ${missing}, which OpenAdminOS offers from it, so Chat skips it. Nothing was sent. ${notSaved}Check its connection in the Marketplace once the server lists ${them} again.`,
        false,
      );
    }
    if (!session.tools.some((tool) => tool.name === name && !tool.unavailable)) {
      throw new McpHostError("unknown-tool", `${endpoint.name} does not list a tool named ${name}.`);
    }
    await this.authorize(endpoint, generation);
    // Nothing awaits between this check and the dispatch below.
    const authorization = this.checkGeneration(endpoint, generation);
    const signals = [authorization.controller.signal, ...(signal ? [signal] : [])];
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await session.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.callTimeoutMs,
        signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (authorization.controller.signal.aborted) {
        throw new McpHostError("revoked", `${endpoint.name} was ${this.authorization(endpoint.id).revoked === "uninstalled" ? "uninstalled" : "turned off"} while it answered. Its answer was not used.`);
      }
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

  private authorization(id: string): Authorization {
    let authorization = this.authorizations.get(id);
    if (!authorization) this.authorizations.set(id, (authorization = { generation: 0, controller: new AbortController() }));
    return authorization;
  }

  private revokedError(endpoint: McpEndpoint, reason: McpRevocation | undefined): McpHostError {
    const what = reason === "uninstalled" ? "uninstalled" : "turned off";
    return new McpHostError("revoked", `${endpoint.name} was ${what} during this answer. Nothing was sent.`, false);
  }

  private checkGeneration(endpoint: McpEndpoint, generation: number | undefined): Authorization {
    const authorization = this.authorization(endpoint.id);
    if (generation !== undefined && authorization.generation !== generation) throw this.revokedError(endpoint, authorization.revoked);
    return authorization;
  }

  private async authorize(endpoint: McpEndpoint, generation: number | undefined): Promise<void> {
    this.checkGeneration(endpoint, generation);
    const reason = await this.options.revocation?.(endpoint.id);
    if (reason) throw this.revokedError(endpoint, reason);
    this.checkGeneration(endpoint, generation);
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
    const session = this.open(endpoint).then((opened) => {
      this.unreported.add(opened);
      return opened;
    });
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
          // Tools outside the allowlist are never kept, so they never reach the Marketplace, Chat or a call.
          if (!isAllowedTool(endpoint, tool.name)) continue;
          const info = sanitizeTool(tool);
          if (info && tools.length < MCP_MAX_TOOLS_PER_SERVER) tools.push(info);
        }
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      const missingTools = (endpoint.tools ?? []).filter((name) => !tools.some((tool) => tool.name === name));
      // With an allowlist, missing tools are a designed Marketplace state, so the listing is still recorded.
      if (tools.length === 0 && !endpoint.tools) {
        throw new McpHostError("server-error", `${endpoint.name} connected but listed no usable tools.`);
      }
      return { client, tools, missingTools };
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
