import type {
  GraphRequestInput as SdkGraphRequestInput,
  ManagedDeviceRecord,
  RunGraphApi,
  RunLogLevel,
} from "@openagents/agent-sdk";

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
  tokenProvider: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
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
}

/** Cap on the raw response sample stored in log metadata. */
const PREVIEW_BYTE_CAP = 4_000;
/** First N array items included in the raw response preview. */
const PREVIEW_ITEM_CAP = 3;

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
          fetchImpl,
          maxRetries,
          timeoutMs,
          baseUrl,
          log: options.log,
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
        fetchImpl,
        maxRetries,
        timeoutMs,
        expectJson: false,
        baseUrl,
        log: options.log,
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
        fetchImpl,
        maxRetries,
        timeoutMs,
        expectJson: method !== "DELETE",
        extraHeaders: input.headers,
        body: hasBody ? JSON.stringify(input.body) : undefined,
        idempotent: method === "GET" || method === "PUT" || method === "DELETE",
        baseUrl,
        log: options.log,
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
  tokenProvider: () => Promise<string>;
  fetchImpl: typeof fetch;
  maxRetries: number;
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
}

async function graphRequest<T>(input: GraphRequestInput): Promise<T> {
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
    const token = await input.tokenProvider();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

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
    try {
      response = await input.fetchImpl(input.url, {
        method: input.method,
        headers,
        signal: controller.signal,
        body: input.body,
      });
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const message = isTimeout
        ? `Graph request timed out after ${input.timeoutMs}ms: ${input.url}`
        : `Graph request failed (${input.url}): ${describe(error)}`;
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
    clearTimeout(timer);

    if (response.ok) {
      const status = response.status;
      let parsed: unknown = undefined;
      let bytes = 0;
      if (!expectJson) {
        const text = await response.text().catch(() => "");
        bytes = text.length;
      } else {
        const text = await response.text();
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
      await sleep(retryAfter * 1000);
      continue;
    }

    const body = await response.text().catch(() => "");
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
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
