import type {
  GraphRequestInput as SdkGraphRequestInput,
  ManagedDeviceRecord,
  RunGraphApi,
} from "@openagents/agent-sdk";

export interface GraphAdapterOptions {
  tokenProvider: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

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
  const baseUrl = options.baseUrl ?? "https://graph.microsoft.com/v1.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;

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
}

async function graphRequest<T>(input: GraphRequestInput): Promise<T> {
  const expectJson = input.expectJson ?? true;
  let attempt = 0;
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
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Graph request timed out after ${input.timeoutMs}ms: ${input.url}`);
      }
      throw new Error(`Graph request failed (${input.url}): ${describe(error)}`);
    }
    clearTimeout(timer);

    if (response.ok) {
      if (!expectJson) {
        // Consume the body so the underlying connection can be reused.
        await response.text().catch(() => "");
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    if (response.status === 401) {
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
    throw new Error(
      `Graph responded with HTTP ${response.status} for ${input.url}: ${truncate(body, 200)}`,
    );
  }
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
