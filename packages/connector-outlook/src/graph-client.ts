import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  ConnectorRemoteError,
  ConnectorScopeError,
  type TenantSession,
} from "@openadminos/agent-sdk";

import { OUTLOOK_CONNECTOR_ID, qualifyGraphScope } from "./descriptor.js";

interface OutlookGraphFetchInput {
  method: "POST";
  path: string;
  scopes: string[];
  capabilityId: string;
  body?: unknown;
}

export interface OutlookGraphClient {
  fetch(input: OutlookGraphFetchInput): Promise<void>;
  acquire(scopes: string[], capabilityId: string): Promise<void>;
}

export interface CreateOutlookGraphClientOptions {
  tenant: TenantSession;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createOutlookGraphClient(
  options: CreateOutlookGraphClientOptions,
): OutlookGraphClient {
  const baseUrl = options.baseUrl ?? "https://graph.microsoft.com/v1.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function acquire(scopes: string[], capabilityId: string): Promise<string> {
    try {
      return await options.tenant.acquireTokenForScopes(
        scopes.map(qualifyGraphScope),
      );
    } catch (cause) {
      throw new ConnectorAuthError(
        `Failed to acquire token for Outlook scopes ${scopes.join(", ")}.`,
        { connectorId: OUTLOOK_CONNECTOR_ID, capabilityId, cause },
      );
    }
  }

  return {
    async acquire(scopes: string[], capabilityId: string): Promise<void> {
      await acquire(scopes, capabilityId);
    },

    async fetch(input: OutlookGraphFetchInput): Promise<void> {
      let attempt = 0;
      while (true) {
        attempt += 1;
        const token = await acquire(input.scopes, input.capabilityId);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}${input.path}`, {
            method: input.method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify(input.body ?? {}),
            signal: controller.signal,
          });
        } catch (cause) {
          clearTimeout(timer);
          if (cause instanceof Error && cause.name === "AbortError") {
            throw new ConnectorRemoteError(
              `Outlook Graph request timed out after ${timeoutMs}ms (${input.path}).`,
              {
                connectorId: OUTLOOK_CONNECTOR_ID,
                capabilityId: input.capabilityId,
                recovery: "retry",
                cause,
              },
            );
          }
          throw new ConnectorRemoteError(
            `Outlook Graph request failed (${input.path}): ${describe(cause)}`,
            {
              connectorId: OUTLOOK_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              recovery: "retry",
              cause,
            },
          );
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          await response.text().catch(() => "");
          return;
        }
        if (response.status === 401) {
          throw new ConnectorAuthError(
            "Microsoft Graph rejected the Outlook access token (HTTP 401). Reconnect the tenant.",
            {
              connectorId: OUTLOOK_CONNECTOR_ID,
              capabilityId: input.capabilityId,
            },
          );
        }
        if (response.status === 403) {
          await response.text().catch(() => "");
          throw new ConnectorScopeError(
            "Microsoft Graph rejected the Outlook request (HTTP 403). The signed-in admin lacks Mail.Send.",
            {
              connectorId: OUTLOOK_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              missingScopes: input.scopes,
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
            "Microsoft Graph rate-limited the Outlook request (HTTP 429). Retry exhausted.",
            {
              connectorId: OUTLOOK_CONNECTOR_ID,
              capabilityId: input.capabilityId,
              retryAfterMs: (retryAfter ?? 2) * 1000,
            },
          );
        }
        if (response.status >= 500 && attempt < maxRetries) {
          await sleep((parseRetryAfter(response.headers.get("retry-after")) ?? 2) * 1000);
          continue;
        }
        const body = await response.text().catch(() => "");
        throw new ConnectorRemoteError(
          `Microsoft Graph responded with HTTP ${response.status} for ${input.path}: ${truncate(body, 200)}`,
          {
            connectorId: OUTLOOK_CONNECTOR_ID,
            capabilityId: input.capabilityId,
            recovery: response.status >= 500 ? "retry" : "fatal",
            statusCode: response.status,
          },
        );
      }
    },
  };
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
