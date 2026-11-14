import { createHash, randomUUID } from "node:crypto";

import { awaitWithSignal } from "./cancellation.js";
import { scopesFromAccessToken } from "./token-scopes.js";
import { GraphAccessDeniedError, type GraphAccessContext } from "@openadminos/agent-sdk";
import type {
  GraphRequestInput as SdkGraphRequestInput,
  ManagedDeviceRecord,
  RunGraphApi,
  RunLogLevel,
} from "@openadminos/agent-sdk";

/**
 * Callback the adapter uses to surface what it's doing during a run.
 * Mirrors `RunContext.log` so the runtime can pass its per-step logger
 * straight through; entries land in the active step the same way as
 * any `ctx.log(...)` call from agent code.
 */
export type GraphAdapterLogger = (
  level: RunLogLevel,
  message: string,
  metadata?: Record<string, unknown>,
) => void;

export interface GraphAdapterOptions {
  signal?: AbortSignal;
  tokenProvider: () => Promise<string | { accessToken: string; scopes?: readonly string[] }>;
  /** Reporting context only. Does not request scopes or probe access. */
  accessContext?: (method: SdkGraphRequestInput["method"], path: string) => GraphAccessContext;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /**
   * Base delay for the transient-fault backoff, doubling per attempt.
   * Defaults to 1s; set to 0 in tests to keep them fast.
   */
  retryBackoffMs?: number;
  timeoutMs?: number;
  /**
   * When set, the adapter emits a `debug`-level log at request start
   * (`→ GET /users?$select=…`) and an `info`-level log on completion
   * (`GET /users — 200 · 47 items · 1.2s`) with structured metadata
   * for the Logs tab's expandable details panel. Errors are emitted
   * at `warn` with the HTTP status and a truncated response body.
   * Omit to keep the adapter silent (default — preserves existing
   * call-site behaviour for tests and ad-hoc usage).
   */
  log?: GraphAdapterLogger;
  /**
   * Records every Graph write (any method but GET) in the host's audit
   * log: `attempted` before the request is sent, `result` after it.
   * When `attempted` rejects, the write is refused and nothing is sent.
   * Without a sink, every write is refused unless `unauditedWrites` is set.
   */
  writeAudit?: GraphWriteAuditSink;
  /**
   * Sends writes without an audit sink. Only for tests and tools that
   * never reach a tenant; the desktop host always passes `writeAudit`.
   */
  unauditedWrites?: boolean;
}

export type GraphWriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

/** A Graph write about to be sent. It never carries the request body, only its digest. */
export interface GraphWriteAuditAttempt {
  /** Shared by the attempt and its result. */
  attemptId: string;
  method: GraphWriteMethod;
  /** Path relative to the Graph base URL, without the query string. */
  path: string;
  /** SHA-256 hex of the JSON body sent, when the write has one. */
  bodyDigest?: string;
}

/**
 * Why a write failed: `not-sent` when it failed before any request left
 * the device, for example while acquiring a token.
 */
export type GraphWriteErrorClass =
  | "not-sent"
  | "cancelled"
  | "timeout"
  | "network-error"
  | "unauthorized"
  | "access-denied"
  | "http-error";

export interface GraphWriteAuditResult {
  attemptId: string;
  method: GraphWriteMethod;
  path: string;
  outcome: "ok" | "failed";
  /** HTTP status of the last response, when one arrived. */
  status?: number;
  /** Graph `request-id` (or `client-request-id`) of the last response. */
  requestId?: string;
  errorClass?: GraphWriteErrorClass;
  /** Requests sent, including retries. */
  attempts: number;
  durationMs: number;
}

export interface GraphWriteAuditSink {
  /** Must finish recording before the write is sent; a rejection refuses the write. */
  attempted(attempt: GraphWriteAuditAttempt): void | Promise<void>;
  /** A rejection is reported in the run log; the write already happened. */
  result(result: GraphWriteAuditResult): void | Promise<void>;
}

/** The audit log could not record a Graph write, so it was not sent. */
export class GraphWriteAuditError extends Error {
  constructor(method: GraphWriteMethod, path: string, cause: unknown) {
    super(
      `${method} ${path} was not sent: the audit log could not record it. ${describe(cause)} Check free disk space and permissions of the OpenAdminOS data folder, then run it again.`,
      { cause },
    );
    this.name = "GraphWriteAuditError";
  }
}

/** A write reached an adapter that has no audit sink, so it was not sent. */
export class GraphWriteUnauditedError extends Error {
  constructor(method: GraphWriteMethod, path: string) {
    super(
      `${method} ${path} was not sent: this Graph client has no audit log to record it, and OpenAdminOS sends no write it cannot record. This is a defect in OpenAdminOS. Report it with the name of the agent or connector that made the request.`,
    );
    this.name = "GraphWriteUnauditedError";
  }
}

/** Cap on the raw response sample stored in log metadata. */
const PREVIEW_BYTE_CAP = 4_000;
/** First N array items included in the raw response preview. */
const PREVIEW_ITEM_CAP = 3;
const MAX_RETRY_AFTER_SECONDS = 60;

interface ManagedDeviceResponseItem {
  id?: unknown;
  deviceName?: unknown;
  userPrincipalName?: unknown;
  operatingSystem?: unknown;
  osVersion?: unknown;
  lastSyncDateTime?: unknown;
  enrolledDateTime?: unknown;
  complianceState?: unknown;
}

interface GraphListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

const MANAGED_DEVICE_SELECT = [
  "id",
  "deviceName",
  "userPrincipalName",
  "operatingSystem",
  "osVersion",
  "lastSyncDateTime",
  "enrolledDateTime",
  "complianceState",
];

export function createGraphAdapter(options: GraphAdapterOptions): RunGraphApi {
  // Default to the beta endpoint everywhere. Beta supports the
  // advanced-query filters that the investigator agents
  // (sign-in-failure-explainer, risky-sign-in-triage,
  // conditional-access-explainer, secure-score-prioritizer) lean on,
  // and is dramatically faster than v1.0 for /auditLogs/* with
  // $filter+$orderby. Risk: beta endpoints can change without notice.
  // Acceptable trade for the v0.2 preview; revisit when Microsoft
  // promotes the relevant resources to v1.0 with full query parity.
  const baseUrl = options.baseUrl ?? "https://graph.microsoft.com/beta";
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 1000;
  // 60s default: audit-log and sign-in queries on real tenants
  // routinely take 30-45s. Agents that need shorter timeouts can
  // pass `timeoutMs` explicitly when constructing the adapter.
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async listManagedDevices(): Promise<ManagedDeviceRecord[]> {
      const url = `${baseUrl}/deviceManagement/managedDevices?$select=${MANAGED_DEVICE_SELECT.join(
        ",",
      )}`;
      const records: ManagedDeviceRecord[] = [];
      let nextLink: string | undefined = url;

      while (nextLink) {
        const payload: GraphListResponse<ManagedDeviceResponseItem> = await graphRequest<
          GraphListResponse<ManagedDeviceResponseItem>
        >({
          method: "GET",
          url: nextLink,
          tokenProvider: options.tokenProvider,
          signal: options.signal,
          fetchImpl,
          maxRetries,
          retryBackoffMs,
          timeoutMs,
          baseUrl,
          log: options.log,
          accessContext: options.accessContext,
        });
        for (const item of payload.value ?? []) {
          records.push(toManagedDeviceRecord(item));
        }
        nextLink = payload["@odata.nextLink"];
      }

      return records;
    },

    async retireManagedDevice(deviceId: string): Promise<void> {
      if (!deviceId || typeof deviceId !== "string") {
        throw new Error("retireManagedDevice requires a non-empty deviceId.");
      }
      // Action endpoint. Body is empty per Microsoft Graph docs.
      const url = `${baseUrl}/deviceManagement/managedDevices/${encodeURIComponent(
        deviceId,
      )}/retire`;
      await graphRequest<void>({
        method: "POST",
        url,
        tokenProvider: options.tokenProvider,
        signal: options.signal,
        fetchImpl,
        maxRetries,
        retryBackoffMs,
        timeoutMs,
        expectJson: false,
        idempotent: false,
        baseUrl,
        log: options.log,
        accessContext: options.accessContext,
        writeAudit: options.writeAudit,
        unauditedWrites: options.unauditedWrites,
      });
    },

    async request(input: SdkGraphRequestInput): Promise<unknown> {
      const method = input.method;
      if (
        method !== "GET" &&
        method !== "POST" &&
        method !== "PATCH" &&
        method !== "PUT" &&
        method !== "DELETE"
      ) {
        throw new Error(
          `RunGraphApi.request: unsupported method "${method}".`,
        );
      }
      if (!input.path || !input.path.startsWith("/")) {
        throw new Error(
          `RunGraphApi.request: path must start with "/" (got ${JSON.stringify(input.path)}).`,
        );
      }
      const url = buildGraphUrl(baseUrl, input.path, input.query);
      // GET/DELETE typically return either JSON or 204; PATCH/PUT/POST
      // vary. Stay generous — try to decode JSON if the response has
      // a body, otherwise return undefined. The retry policy below
      // never retries POST/PATCH on 5xx so a half-applied write is
      // not silently doubled; PUT/DELETE are idempotent so retries
      // remain in place. GET keeps the existing retry behaviour.
      const hasBody =
        method !== "GET" &&
        method !== "DELETE" &&
        input.body !== undefined;
      return await graphRequest<unknown>({
        method,
        url,
        tokenProvider: options.tokenProvider,
        signal: options.signal,
        fetchImpl,
        maxRetries,
        retryBackoffMs,
        timeoutMs,
        expectJson: method !== "DELETE",
        extraHeaders: input.headers,
        body: hasBody ? JSON.stringify(input.body) : undefined,
        idempotent: method === "GET" || method === "PUT" || method === "DELETE",
        baseUrl,
        log: options.log,
        accessContext: options.accessContext,
        writeAudit: options.writeAudit,
        unauditedWrites: options.unauditedWrites,
        ...(input.signal ? { signal: options.signal ? AbortSignal.any([options.signal, input.signal]) : input.signal } : {}),
      });
    },
  };
}

function buildGraphUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  let url = `${base}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      params.set(key, value);
    }
    url += (url.includes("?") ? "&" : "?") + params.toString();
  }
  return url;
}

interface GraphRequestInput {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  tokenProvider: GraphAdapterOptions["tokenProvider"];
  accessContext?: GraphAdapterOptions["accessContext"];
  fetchImpl: typeof fetch;
  maxRetries: number;
  retryBackoffMs: number;
  timeoutMs: number;
  expectJson?: boolean;
  extraHeaders?: Record<string, string>;
  body?: string;
  /**
   * Whether this request is safe to retry on 5xx. POST and PATCH are
   * not idempotent in Graph's general contract — retrying them on a
   * 500 risks duplicating a write. GET/PUT/DELETE are. 429 is always
   * retried regardless because Microsoft Graph documents it as a
   * pure rate-limit signal.
   */
  idempotent?: boolean;
  /**
   * Adapter base URL — threaded through for telemetry shaping (so the
   * logger can emit a path-relative URL instead of the full one).
   * Optional; the request fires regardless.
   */
  baseUrl?: string;
  /** Optional adapter logger; emits debug/info/warn at request boundaries. */
  log?: GraphAdapterLogger;
  /** Audit sink for writes; see GraphAdapterOptions.writeAudit. */
  writeAudit?: GraphWriteAuditSink;
  /** See GraphAdapterOptions.unauditedWrites. */
  unauditedWrites?: boolean;
  /**
   * Caller cancellation. Distinct from the per-attempt timeout: when
   * this aborts the request is abandoned without a retry, because the
   * user asked to stop rather than the network failing.
   */
  signal?: AbortSignal;
}

/** What the requests of one call showed, for the audit result of a write. */
interface GraphExchange {
  attempts: number;
  status?: number;
  requestId?: string;
}

async function graphRequest<T>(input: GraphRequestInput): Promise<T> {
  const exchange: GraphExchange = { attempts: 0 };
  if (input.method === "GET") return sendGraphRequest<T>(input, exchange);
  const method = input.method;
  const path = input.baseUrl ? shortenPath(input.url, input.baseUrl) : input.url.split("?")[0] ?? input.url;
  const sink = input.writeAudit;
  if (!sink) {
    if (input.unauditedWrites === true) return sendGraphRequest<T>(input, exchange);
    throw new GraphWriteUnauditedError(method, path);
  }
  const attemptId = randomUUID();
  try {
    await sink.attempted({
      attemptId,
      method,
      path,
      ...(input.body !== undefined
        ? { bodyDigest: createHash("sha256").update(input.body).digest("hex") }
        : {}),
    });
  } catch (cause) {
    throw new GraphWriteAuditError(method, path, cause);
  }
  const startMs = Date.now();
  const record = async (result: Pick<GraphWriteAuditResult, "outcome" | "errorClass">) => {
    try {
      await sink.result({
        attemptId,
        method,
        path,
        ...result,
        ...(exchange.status !== undefined ? { status: exchange.status } : {}),
        ...(exchange.requestId ? { requestId: exchange.requestId } : {}),
        attempts: exchange.attempts,
        durationMs: Date.now() - startMs,
      });
    } catch (error) {
      const message = `The audit log could not record the result of ${method} ${path}. ${describe(error)}`;
      if (input.log) input.log("warn", message);
      else console.warn(`[graph] ${message}`);
    }
  };
  try {
    const value = await sendGraphRequest<T>(input, exchange);
    await record({ outcome: "ok" });
    return value;
  } catch (error) {
    await record({ outcome: "failed", errorClass: classifyWriteFailure(error, exchange) });
    throw error;
  }
}

/** Microsoft Graph hosts of the public and national clouds. */
const GRAPH_HOSTS = new Set([
  "graph.microsoft.com",
  "graph.microsoft.us",
  "dod-graph.microsoft.us",
  "microsoftgraph.chinacloudapi.cn",
]);

/**
 * True for a Microsoft Graph host of the public or a national cloud. The
 * name is compared lowercased and without one trailing dot, so the fully
 * qualified "graph.microsoft.com." that reaches the same host is a Graph
 * host too.
 */
export function isGraphHost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return GRAPH_HOSTS.has(name.endsWith(".") ? name.slice(0, -1) : name);
}

const WRITE_METHODS = new Set<string>(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * A fetch that records every Graph write it sends in the audit sink, as
 * the adapter does: `attempted` before the request and `result` after
 * it. When `attempted` rejects, nothing is sent. Graph reads and other
 * hosts pass through unchanged. Connectors that bring their own Graph
 * client, such as Outlook and Teams, send through it.
 */
export function auditGraphWritesFetch(
  base: typeof fetch,
  sink: GraphWriteAuditSink,
  options: { log?: (message: string) => void } = {},
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!isGraphHost(url.hostname) || method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return base(input, init);
    }
    const path = url.pathname.replace(/^\/(?:v1\.0|beta)(?=\/|$)/, "") || "/";
    if (!WRITE_METHODS.has(method)) {
      throw new Error(`${method} ${path} was not sent: OpenAdminOS sends Graph requests only as GET, POST, PATCH, PUT or DELETE.`);
    }
    const writeMethod = method as GraphWriteMethod;
    const attemptId = randomUUID();
    const body = init?.body;
    try {
      await sink.attempted({
        attemptId,
        method: writeMethod,
        path,
        ...(typeof body === "string" ? { bodyDigest: createHash("sha256").update(body).digest("hex") } : {}),
      });
    } catch (cause) {
      throw new GraphWriteAuditError(writeMethod, path, cause);
    }
    const startMs = Date.now();
    const record = async (result: Omit<GraphWriteAuditResult, "attemptId" | "method" | "path" | "attempts" | "durationMs">) => {
      try {
        await sink.result({ attemptId, method: writeMethod, path, ...result, attempts: 1, durationMs: Date.now() - startMs });
      } catch (error) {
        const message = `The audit log could not record the result of ${method} ${path}. ${describe(error)}`;
        if (options.log) options.log(message);
        else console.warn(`[graph] ${message}`);
      }
    };
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      await record({ outcome: "failed", errorClass: init?.signal?.aborted ? "cancelled" : "network-error" });
      throw error;
    }
    const requestId = response.headers.get("request-id") ?? response.headers.get("client-request-id") ?? undefined;
    await record({
      outcome: response.ok ? "ok" : "failed",
      status: response.status,
      ...(requestId ? { requestId } : {}),
      ...(response.ok
        ? {}
        : { errorClass: response.status === 401 ? "unauthorized" as const : response.status === 403 ? "access-denied" as const : "http-error" as const }),
    });
    return response;
  }) as typeof fetch;
}

function classifyWriteFailure(error: unknown, exchange: GraphExchange): GraphWriteErrorClass {
  const message = describe(error);
  if (message === GRAPH_REQUEST_CANCELLED) return "cancelled";
  if (error instanceof GraphAccessDeniedError) return "access-denied";
  if (exchange.status === 401) return "unauthorized";
  if (exchange.status !== undefined) return "http-error";
  if (exchange.attempts === 0) return "not-sent";
  if (message.startsWith("Graph request timed out")) return "timeout";
  return "network-error";
}

async function sendGraphRequest<T>(input: GraphRequestInput, exchange: GraphExchange): Promise<T> {
  const expectJson = input.expectJson ?? true;
  const shortPath = input.baseUrl ? shortenPath(input.url, input.baseUrl) : input.url;
  const query = extractQuery(input.url);
  const startMs = Date.now();
  let attempt = 0;

  if (input.log) {
    input.log("debug", `→ ${input.method} ${shortPath}`, {
      graphCall: {
        phase: "start",
        method: input.method,
        path: shortPath,
        ...(query ? { query } : {}),
      },
    });
  }

  while (true) {
    attempt += 1;
    if (input.signal?.aborted) {
      throw new Error(GRAPH_REQUEST_CANCELLED);
    }
    const acquired = await awaitWithSignal(input.tokenProvider(), input.signal);
    const token = typeof acquired === "string" ? acquired : acquired.accessToken;
    const grantedScopes = typeof acquired === "string" ? scopesFromAccessToken(token) : acquired.scopes ?? scopesFromAccessToken(token);
    if (input.signal?.aborted) throw new Error(GRAPH_REQUEST_CANCELLED);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    // Caller cancellation aborts the same controller the timeout uses;
    // the two are told apart afterwards by inspecting input.signal.
    const onCallerAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const releaseSignal = () =>
      input.signal?.removeEventListener("abort", onCallerAbort);

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (expectJson) {
      headers.accept = "application/json";
    }
    if (input.extraHeaders) {
      for (const [key, value] of Object.entries(input.extraHeaders)) {
        headers[key.toLowerCase()] = value;
      }
    }

    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    // Only the last request decides what the audit result reports.
    exchange.attempts = attempt;
    delete exchange.status;
    delete exchange.requestId;
    try {
      response = await input.fetchImpl(input.url, {
        method: input.method,
        headers,
        signal: controller.signal,
        body: input.body,
      });
    } catch (error) {
      clearTimeout(timer);
      releaseSignal();
      const durationMs = Date.now() - startMs;
      if (input.signal?.aborted) {
        throw new Error(GRAPH_REQUEST_CANCELLED);
      }
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const message = isTimeout
        ? `Graph request timed out after ${input.timeoutMs}ms: ${input.url}`
        : `Graph request failed (${input.url}): ${describe(error)}`;
      // Timeouts and dropped connections are the common failure on a
      // laptop that sleeps, roams between networks, or sits behind a
      // VPN. They were previously fatal on the first occurrence, which
      // discarded an entire multi-request refresh. Retry them on the
      // same budget as 5xx, but only when the method is idempotent: a
      // POST that timed out may already have been applied upstream, and
      // repeating it could duplicate a write.
      const idempotentRequest = input.idempotent ?? true;
      if (idempotentRequest && attempt <= input.maxRetries) {
        if (input.log) {
          input.log(
            "warn",
            `${input.method} ${shortPath} retrying after ${isTimeout ? "timeout" : "network error"} (attempt ${attempt} of ${input.maxRetries + 1})`,
            {
              graphCall: {
                phase: "retry",
                method: input.method,
                path: shortPath,
                ...(query ? { query } : {}),
                ok: false,
                status: isTimeout ? "timeout" : "network-error",
                durationMs,
                attempts: attempt,
                error: message,
              },
            },
          );
        }
        await sleep(backoffMs(input.retryBackoffMs, attempt), input.signal);
        continue;
      }
      if (input.log) {
        input.log(
          "warn",
          `${input.method} ${shortPath} — ${isTimeout ? "timeout" : "network error"} · ${formatMs(durationMs)}`,
          {
            graphCall: {
              phase: "end",
              method: input.method,
              path: shortPath,
              ...(query ? { query } : {}),
              ok: false,
              status: isTimeout ? "timeout" : "network-error",
              durationMs,
              attempts: attempt,
              error: message,
            },
          },
        );
      }
      throw new Error(message);
    }
    // The body is read while the timeout and the caller's signal still
    // apply, so a response that stalls after its headers still settles.
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      if (input.signal?.aborted) throw new Error(GRAPH_REQUEST_CANCELLED);
      const isTimeout = error instanceof Error && error.name === "AbortError";
      throw new Error(
        isTimeout
          ? `Graph request timed out after ${input.timeoutMs}ms while reading the response: ${input.url}`
          : `Graph response could not be read (${input.url}): ${describe(error)}`,
      );
    } finally {
      clearTimeout(timer);
      releaseSignal();
    }
    exchange.status = response.status;
    const requestId = response.headers?.get("request-id") ?? response.headers?.get("client-request-id");
    if (requestId) exchange.requestId = requestId;

    if (response.ok) {
      const status = response.status;
      let parsed: unknown = undefined;
      let bytes = 0;
      if (!expectJson) {
        bytes = bodyText.length;
      } else {
        const text = bodyText;
        bytes = text.length;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            // Body advertised JSON but didn't parse — surface the raw text
            // in the preview so the user sees what came back.
            parsed = text;
          }
        }
      }
      const durationMs = Date.now() - startMs;
      if (input.log) {
        const preview = expectJson
          ? buildPreview(parsed)
          : { itemCount: undefined, shape: undefined, sample: undefined, truncated: false };
        const countSuffix =
          preview.itemCount !== undefined
            ? ` · ${preview.itemCount} item${preview.itemCount === 1 ? "" : "s"}`
            : "";
        const attemptSuffix = attempt > 1 ? ` · ${attempt} attempts` : "";
        input.log(
          "info",
          `${input.method} ${shortPath} — ${status}${countSuffix} · ${formatMs(durationMs)}${attemptSuffix}`,
          {
            graphCall: {
              phase: "end",
              method: input.method,
              path: shortPath,
              ...(query ? { query } : {}),
              ok: true,
              status,
              durationMs,
              attempts: attempt,
              bytes,
              ...(preview.itemCount !== undefined ? { itemCount: preview.itemCount } : {}),
              ...(preview.shape ? { shape: preview.shape } : {}),
              ...(preview.sample !== undefined ? { sample: preview.sample } : {}),
              ...(preview.truncated ? { sampleTruncated: true } : {}),
            },
          },
        );
      }
      return expectJson ? (parsed as T) : (undefined as T);
    }

    if (response.status === 401) {
      const durationMs = Date.now() - startMs;
      if (input.log) {
        input.log(
          "warn",
          `${input.method} ${shortPath} — 401 unauthorized · ${formatMs(durationMs)}`,
          {
            graphCall: {
              phase: "end",
              method: input.method,
              path: shortPath,
              ...(query ? { query } : {}),
              ok: false,
              status: 401,
              durationMs,
              attempts: attempt,
            },
          },
        );
      }
      throw new Error(
        "Graph rejected the access token (HTTP 401). Tenant needs reconnect.",
      );
    }

    const idempotent = input.idempotent ?? true;
    const retryable =
      response.status === 429 ||
      (response.status >= 500 && idempotent);
    if (retryable && attempt < input.maxRetries) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after")) ?? 2;
      await sleep(retryAfter * 1000, input.signal);
      continue;
    }

    const body = bodyText;
    const durationMs = Date.now() - startMs;
    if (input.log) {
      input.log(
        "warn",
        `${input.method} ${shortPath} — ${response.status} · ${formatMs(durationMs)}${attempt > 1 ? ` · ${attempt} attempts` : ""}`,
        {
          graphCall: {
            phase: "end",
            method: input.method,
            path: shortPath,
            ...(query ? { query } : {}),
            ok: false,
            status: response.status,
            durationMs,
            attempts: attempt,
            bytes: body.length,
            errorBody: truncate(body, 600),
          },
        },
      );
    }
    if (response.status === 403) {
      let errorCode: string | undefined;
      let graphMessage: string | undefined;
      try {
        const parsed = JSON.parse(body);
        const code = parsed?.error?.code ?? parsed?.code;
        if (typeof code === "string") errorCode = code;
        const message = parsed?.error?.message ?? parsed?.message;
        if (typeof message === "string") graphMessage = message;
      } catch { /* Unknown response shape remains an unverified denial. */ }
      throw new GraphAccessDeniedError({
        ...input.accessContext?.(input.method, shortPath),
        method: input.method,
        path: shortPath.split("?")[0],
        grantedScopes,
        errorCode,
        graphMessage,
      });
    }
    throw new Error(
      `Graph responded with HTTP ${response.status} for ${input.url}: ${truncate(body, 200)}`,
    );
  }
}

function shortenPath(fullUrl: string, baseUrl: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (fullUrl.startsWith(trimmed)) {
    const rest = fullUrl.slice(trimmed.length);
    const noQuery = rest.split("?")[0] ?? rest;
    return noQuery || "/";
  }
  try {
    return new URL(fullUrl).pathname;
  } catch {
    return fullUrl;
  }
}

function extractQuery(fullUrl: string): Record<string, string> | undefined {
  const qIndex = fullUrl.indexOf("?");
  if (qIndex < 0) return undefined;
  const search = fullUrl.slice(qIndex + 1);
  if (search.length === 0) return undefined;
  try {
    const params = new URLSearchParams(search);
    const out: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

interface ResponsePreview {
  itemCount: number | undefined;
  shape: string | undefined;
  sample: unknown;
  truncated: boolean;
}

function buildPreview(parsed: unknown): ResponsePreview {
  if (parsed === undefined || parsed === null) {
    return { itemCount: undefined, shape: undefined, sample: undefined, truncated: false };
  }
  // Graph list responses: { value: [...], "@odata.nextLink"?: string }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { value?: unknown }).value)
  ) {
    const arr = (parsed as { value: unknown[] }).value;
    const first = arr[0];
    const sample = capSample(arr.slice(0, PREVIEW_ITEM_CAP));
    return {
      itemCount: arr.length,
      shape: first !== undefined ? describeShape(first) : "value[] (empty)",
      sample: sample.value,
      truncated: sample.truncated || arr.length > PREVIEW_ITEM_CAP,
    };
  }
  // Bare arrays.
  if (Array.isArray(parsed)) {
    const sample = capSample(parsed.slice(0, PREVIEW_ITEM_CAP));
    return {
      itemCount: parsed.length,
      shape: parsed[0] !== undefined ? describeShape(parsed[0]) : "[] (empty)",
      sample: sample.value,
      truncated: sample.truncated || parsed.length > PREVIEW_ITEM_CAP,
    };
  }
  // Single object response.
  const sample = capSample(parsed);
  return {
    itemCount: undefined,
    shape: describeShape(parsed),
    sample: sample.value,
    truncated: sample.truncated,
  };
}

function capSample(value: unknown): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { value: "[unserializable]", truncated: false };
  }
  if (serialized.length <= PREVIEW_BYTE_CAP) {
    return { value, truncated: false };
  }
  // Re-emit a string-truncated form so the metadata stays small in
  // SQLite without losing the user-visible "what came back" signal.
  return {
    value: `${serialized.slice(0, PREVIEW_BYTE_CAP)}…`,
    truncated: true,
  };
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${describeShape(value[0])}, …]` : "[]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, 8);
    const ellipsis = keys.length > shown.length ? ", …" : "";
    return `{ ${shown.join(", ")}${ellipsis} }`;
  }
  return typeof value;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function toManagedDeviceRecord(item: ManagedDeviceResponseItem): ManagedDeviceRecord {
  const compliance = readString(item.complianceState) ?? "unknown";
  const normalizedCompliance: ManagedDeviceRecord["complianceState"] =
    compliance === "compliant" || compliance === "noncompliant" ? compliance : "unknown";

  const record: ManagedDeviceRecord = {
    id: readString(item.id) ?? "",
    deviceName: readString(item.deviceName) ?? "(unnamed)",
    userPrincipalName: readString(item.userPrincipalName) ?? "",
    operatingSystem: readString(item.operatingSystem) ?? "",
    lastSyncDateTime: readString(item.lastSyncDateTime) ?? "1970-01-01T00:00:00.000Z",
    enrolledDateTime: readString(item.enrolledDateTime) ?? "1970-01-01T00:00:00.000Z",
    complianceState: normalizedCompliance,
  };
  const osVersion = readString(item.osVersion);
  if (osVersion) {
    record.osVersion = osVersion;
  }
  return record;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const asNumber = Number.parseFloat(value);
  if (Number.isFinite(asNumber)) {
    return Math.min(Math.max(asNumber, 0), MAX_RETRY_AFTER_SECONDS);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.min(
      Math.max(0, Math.ceil((asDate - Date.now()) / 1000)),
      MAX_RETRY_AFTER_SECONDS,
    );
  }
  return undefined;
}

/**
 * Marker used for user-initiated cancellation so callers can tell it
 * apart from a genuine Graph failure and stay quiet about it.
 */
export const GRAPH_REQUEST_CANCELLED = "Graph request cancelled.";

/** Exponential backoff for transient faults, doubling per attempt. */
function backoffMs(base: number, attempt: number): number {
  return Math.min(base * 8, base * 2 ** (attempt - 1));
}

/** Waits between retries; a caller abort ends the wait as a cancellation. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error(GRAPH_REQUEST_CANCELLED));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new Error(GRAPH_REQUEST_CANCELLED));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
