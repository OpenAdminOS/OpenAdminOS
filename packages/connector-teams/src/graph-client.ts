import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  ConnectorRemoteError,
  ConnectorScopeError,
  type TenantSession,
} from "@openadminos/agent-sdk";

import { TEAMS_CONNECTOR_ID, qualifyGraphScope } from "./descriptor.js";

interface TeamsGraphFetchInput {
  method: "GET" | "POST";
  path: string;
  scopes: string[];
  capabilityId: string;
  body?: unknown;
}

export interface TeamsGraphClient {
  fetch<T>(input: TeamsGraphFetchInput): Promise<T>;
}

export interface CreateTeamsGraphClientOptions {
  tenant: TenantSession;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Lightweight Graph fetch wrapper specific to Teams endpoints. Mints a
 * scoped token per call via `tenant.acquireTokenForScopes`, applies
 * bounded exponential-backoff retries for 429/5xx, and translates
 * Graph error responses into the typed `ConnectorError` subclasses the
 * runtime expects.
 *
 * Per-capability incremental consent is handled implicitly: the
 * runtime's `TenantSession.acquireTokenForScopes` falls back to
 * interactive MSAL when silent acquisition fails. From this layer's
 * perspective, scope acquisition is opaque — it just gets a token or a
 * `ConnectorAuthError`.
 */
export function createTeamsGraphClient(
  options: CreateTeamsGraphClientOptions,
): TeamsGraphClient {
  const baseUrl = options.baseUrl ?? "https://graph.microsoft.com/v1.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async fetch<T>(input: TeamsGraphFetchInput): Promise<T> {
      const qualifiedScopes = input.scopes.map(qualifyGraphScope);
      let attempt = 0;

      while (true) {
        attempt += 1;

        let token: string;
        try {
          token = await options.tenant.acquireTokenForScopes(qualifiedScopes);
        } catch (cause) {
          throw new ConnectorAuthError(
            `Failed to acquire token for Teams scopes ${input.scopes.join(", ")}.`,
            {
              connectorId: TEAMS_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              cause,
            },
          );
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        };
        if (input.body !== undefined) {
          headers["content-type"] = "application/json";
        }

        const requestInit: RequestInit = {
          method: input.method,
          headers,
          signal: controller.signal,
        };
        if (input.body !== undefined) {
          requestInit.body = JSON.stringify(input.body);
        }

        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}${input.path}`, requestInit);
        } catch (cause) {
          clearTimeout(timer);
          if (cause instanceof Error && cause.name === "AbortError") {
            throw new ConnectorRemoteError(
              `Teams Graph request timed out after ${timeoutMs}ms (${input.path}).`,
              {
                connectorId: TEAMS_CONNECTOR_ID,
                capabilityId: input.capabilityId,
                recovery: "retry",
                cause,
              },
            );
          }
          throw new ConnectorRemoteError(
            `Teams Graph request failed (${input.path}): ${describe(cause)}`,
            {
              connectorId: TEAMS_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              recovery: "retry",
              cause,
            },
          );
        }
        clearTimeout(timer);

        if (response.ok) {
          if (response.status === 204) {
            await response.text().catch(() => "");
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        if (response.status === 401) {
          throw new ConnectorAuthError(
            "Microsoft Graph rejected the Teams access token (HTTP 401). Reconnect the tenant.",
            {
              connectorId: TEAMS_CONNECTOR_ID,
              capabilityId: input.capabilityId,
            },
          );
        }

        if (response.status === 403) {
          const missingScopes = await extractMissingScopes(response, input.scopes);
          throw new ConnectorScopeError(
            "Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes.",
            {
              connectorId: TEAMS_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              missingScopes,
            },
          );
        }

        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          if (attempt < maxRetries) {
            await sleep((retryAfter ?? 2) * 1000);
            continue;
          }
          throw new ConnectorRateLimitError(
            "Microsoft Graph rate-limited the Teams request (HTTP 429). Retry exhausted.",
            {
              connectorId: TEAMS_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              retryAfterMs: (retryAfter ?? 2) * 1000,
            },
          );
        }

        if (response.status >= 500 && attempt < maxRetries) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after")) ?? 2;
          await sleep(retryAfter * 1000);
          continue;
        }

        const body = await response.text().catch(() => "");
        throw new ConnectorRemoteError(
          `Microsoft Graph responded with HTTP ${response.status} for ${input.path}: ${truncate(body, 200)}`,
          {
            connectorId: TEAMS_CONNECTOR_ID,
            capabilityId: input.capabilityId,
            recovery: response.status >= 500 ? "retry" : "fatal",
            statusCode: response.status,
          },
        );
      }
    },
  };
}

async function extractMissingScopes(
  response: Response,
  declaredScopes: string[],
): Promise<string[]> {
  // Graph 403 sometimes embeds the missing scope in the JSON error
  // body's `error.message` ("Required scope ... is missing"). We don't
  // parse it deeply — the runtime treats the declared capability
  // scopes as the authoritative re-consent target.
  await response.text().catch(() => "");
  return [...declaredScopes];
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
