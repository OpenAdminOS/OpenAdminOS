import type { ManagedDeviceRecord, RunGraphApi } from "@openagents/agent-sdk";

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
  };
}

interface GraphRequestInput {
  url: string;
  tokenProvider: () => Promise<string>;
  fetchImpl: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
}

async function graphRequest<T>(input: GraphRequestInput): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const token = await input.tokenProvider();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    let response: Response;
    try {
      response = await input.fetchImpl(input.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: controller.signal,
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
      return (await response.json()) as T;
    }

    if (response.status === 401) {
      throw new Error(
        "Graph rejected the access token (HTTP 401). Tenant needs reconnect.",
      );
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < input.maxRetries
    ) {
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
