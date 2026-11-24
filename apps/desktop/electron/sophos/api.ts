import { setTimeout as delay } from "node:timers/promises";

import { isSophosId, isSophosRegionHost, type SophosConnectionRecord } from "@openadminos/agent-sdk";

const TOKEN_URL = "https://id.sophos.com/api/v2/oauth2/token";
const WHOAMI_URL = "https://api.central.sophos.com/whoami/v1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const READ_PATHS = {
  endpoints: "/endpoint/v1/endpoints",
  alerts: "/common/v1/alerts",
  events: "/siem/v1/events",
  siemAlerts: "/siem/v1/alerts",
  firewalls: "/firewall/v1/firewalls",
  firewallGroups: "/firewall/v1/firewall-groups",
  healthCheck: "/account-health-check/v1/health-check",
} as const;

export type SophosResource = keyof typeof READ_PATHS;
export type SophosIdentity = Pick<SophosConnectionRecord, "tenantId" | "host">;
export type SophosCredentials = { clientId: string; clientSecret: string };

type ErrorCode = "credentials" | "forbidden" | "rate-limit" | "unavailable" | "invalid-response" | "refused";

export class SophosApiError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "SophosApiError";
  }
}

function invalidResponse(): SophosApiError {
  return new SophosApiError("invalid-response", "Sophos Central returned an unexpected response. Check Sophos Central and try again.");
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SophosApiError("invalid-response", "The Sophos Central response exceeds 4 MB. Narrow the filters or use a smaller page.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    throw invalidResponse();
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw invalidResponse();
  return result as Record<string, unknown>;
}

export class SophosApi {
  private token?: { value: string; refreshAt: number };
  private refreshing?: Promise<string>;

  constructor(
    private readonly credentials: SophosCredentials,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
      wait?: (milliseconds: number) => Promise<unknown>;
      timeoutMs?: number;
    } = {},
  ) {}

  private async request(
    url: string | URL,
    init: RequestInit,
    operation: "token" | "read" | "write",
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      init.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: "manual", signal });
        if (response.ok) return await readObject(response);
        await response.body?.cancel();
      } catch (error) {
        if (error instanceof SophosApiError) throw error;
        throw new SophosApiError("unavailable", operation === "write"
          ? "Sophos Central did not confirm the request. Check the endpoints in Sophos Central before trying again."
          : signal.aborted
            ? "Sophos Central did not answer in time. Check the connection and try again."
            : "Could not reach Sophos Central. Check the network connection and try again.");
      }
      const status = response.status;
      if (status >= 300 && status < 400) {
        throw new SophosApiError("refused", "Sophos Central redirected the request. Test the connection in Connections.");
      }
      if (status === 401 || (operation === "token" && status === 400)) {
        this.token = undefined;
        throw new SophosApiError("credentials", "The Sophos Central credentials may have expired, been removed, or been entered incorrectly. Create or verify the tenant credentials and reconnect.");
      }
      if (status === 403) {
        const role = operation === "write" ? "Service Principal Management" : "Service Principal Read-Only";
        throw new SophosApiError("forbidden", `Sophos Central refused the request. Check that the credential has the ${role} role and reconnect.`);
      }
      if (status === 429 || status >= 500) {
        // A failed response to a write can leave its outcome unknown.
        if (attempt < 3 && (operation !== "write" || status === 429)) {
          const base = Math.min(30_000, 1_000 * 2 ** attempt);
          const wait = Math.floor(base * Math.random());
          if (this.options.wait) await this.options.wait(wait);
          else await delay(wait, undefined, init.signal ? { signal: init.signal } : undefined);
          continue;
        }
        if (status === 429) throw new SophosApiError("rate-limit", "Sophos Central is rate limiting requests. Wait a minute and try again.");
        throw new SophosApiError("unavailable", operation === "write"
          ? "Sophos Central did not confirm the request. Check the endpoints in Sophos Central before trying again."
          : "Sophos Central is temporarily unavailable. Try again shortly.");
      }
      if (status === 404) throw new SophosApiError("refused", "Sophos Central could not find this resource. Check the selected item and try again.");
      throw new SophosApiError("refused", `Sophos Central refused the request (HTTP ${status}). Check the inputs and try again.`);
    }
  }

  private async acquireToken(): Promise<string> {
    const result = await this.request(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "token",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }),
    }, "token");
    const { access_token, expires_in, token_type } = result;
    if (typeof access_token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(access_token) ||
        typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0 ||
        typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") throw invalidResponse();
    const now = (this.options.now ?? Date.now)();
    this.token = { value: access_token, refreshAt: now + Math.min(expires_in * 900, expires_in * 1_000 - 1) };
    return access_token;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.refreshAt > (this.options.now ?? Date.now)()) return this.token.value;
    this.refreshing ??= this.acquireToken().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async identify(): Promise<SophosIdentity> {
    const result = await this.request(WHOAMI_URL, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
    }, "read");
    if (result.idType !== "tenant") {
      throw new SophosApiError("refused", "Partner and organization credentials are not supported yet. Create a tenant credential in Sophos Central and try again.");
    }
    const region = (result.apiHosts as { dataRegion?: unknown } | undefined)?.dataRegion;
    const host = typeof region === "string" ? /^https:\/\/([^/]+)\/?$/.exec(region)?.[1] : undefined;
    if (!isSophosId(result.id) || !isSophosRegionHost(host) || (region !== `https://${host}` && region !== `https://${host}/`)) throw invalidResponse();
    return { tenantId: result.id, host };
  }

  private async regional(
    identity: SophosIdentity,
    path: string,
    query: URLSearchParams,
    body?: object,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!isSophosId(identity.tenantId) || !isSophosRegionHost(identity.host)) throw invalidResponse();
    const url = new URL(path, `https://${identity.host}`);
    url.search = query.toString();
    const headers = {
      Authorization: `Bearer ${await this.bearer()}`,
      "X-Tenant-ID": identity.tenantId,
    };
    const cancellation = signal ? { signal } : {};
    return body
      ? this.request(url, { ...cancellation, method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }, "write")
      : this.request(url, { ...cancellation, headers }, "read");
  }

  read(identity: SophosIdentity, resource: SophosResource, query = new URLSearchParams(), signal?: AbortSignal) {
    if (!Object.hasOwn(READ_PATHS, resource)) throw invalidResponse();
    return this.regional(identity, READ_PATHS[resource], query, undefined, signal);
  }

  alert(identity: SophosIdentity, id: string, signal?: AbortSignal) {
    if (!isSophosId(id)) throw new SophosApiError("refused", "Choose a valid Sophos Central alert ID and try again.");
    return this.regional(identity, `${READ_PATHS.alerts}/${id}`, new URLSearchParams(), undefined, signal);
  }

  change(identity: SophosIdentity, kind: "isolate" | "release" | "scan", ids: string[], comment?: string, signal?: AbortSignal) {
    if (ids.length < 1 || ids.length > 500 || ids.some((id) => !isSophosId(id))) {
      throw new SophosApiError("refused", "Choose between 1 and 500 valid Sophos Central endpoint IDs.");
    }
    if (kind === "scan") return this.regional(identity, "/endpoint/v1/endpoints/scans", new URLSearchParams(), { ids }, signal);
    if (!comment?.trim() || comment.length > 400) {
      throw new SophosApiError("refused", "Enter an isolation reason of 1 to 400 characters.");
    }
    return this.regional(identity, "/endpoint/v1/endpoints/isolation", new URLSearchParams(), { enabled: kind === "isolate", ids, comment }, signal);
  }
}
