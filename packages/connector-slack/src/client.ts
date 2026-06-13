import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  ConnectorRemoteError,
  ConnectorScopeError,
} from "@openadminos/agent-sdk";

import { SLACK_CONNECTOR_ID } from "./descriptor.js";

export interface SlackClient {
  authTest(): Promise<void>;
  postMessage(input: { channel: string; text: string }): Promise<{ channel: string; ts: string }>;
}

export interface CreateSlackClientOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createSlackClient(options: CreateSlackClientOptions): SlackClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://slack.com/api";
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.botToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new ConnectorRemoteError(
          `Slack request timed out after ${timeoutMs}ms (${method}).`,
          {
            connectorId: SLACK_CONNECTOR_ID,
            capabilityId: method,
            recovery: "retry",
            cause,
          },
        );
      }
      throw new ConnectorRemoteError(
        `Slack request failed (${method}): ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          connectorId: SLACK_CONNECTOR_ID,
          capabilityId: method,
          recovery: "retry",
          cause,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError("Slack rate-limited the request.", {
        connectorId: SLACK_CONNECTOR_ID,
        capabilityId: method,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ConnectorRemoteError(
        `Slack responded with HTTP ${response.status}: ${text.slice(0, 200)}`,
        {
          connectorId: SLACK_CONNECTOR_ID,
          capabilityId: method,
          recovery: response.status >= 500 ? "retry" : "fatal",
          statusCode: response.status,
        },
      );
    }

    const payload = (await response.json()) as { ok?: boolean; error?: string };
    if (payload.ok === false) {
      throwSlackApiError(method, payload.error ?? "unknown_error");
    }
    return payload as T;
  }

  return {
    async authTest(): Promise<void> {
      await call<{ ok: boolean }>("auth.test");
    },
    async postMessage(input): Promise<{ channel: string; ts: string }> {
      const payload = await call<{ channel?: string; ts?: string }>("chat.postMessage", {
        channel: input.channel,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!payload.channel || !payload.ts) {
        throw new ConnectorRemoteError(
          "Slack chat.postMessage returned no channel or timestamp.",
          {
            connectorId: SLACK_CONNECTOR_ID,
            capabilityId: "send-message",
            recovery: "fatal",
          },
        );
      }
      return { channel: payload.channel, ts: payload.ts };
    },
  };
}

function throwSlackApiError(method: string, code: string): never {
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") {
    throw new ConnectorAuthError(`Slack authentication failed: ${code}.`, {
      connectorId: SLACK_CONNECTOR_ID,
      capabilityId: method,
    });
  }
  if (code === "missing_scope" || code === "not_allowed_token_type") {
    throw new ConnectorScopeError(`Slack rejected the request: ${code}.`, {
      connectorId: SLACK_CONNECTOR_ID,
      capabilityId: method,
      missingScopes: ["chat:write"],
    });
  }
  throw new ConnectorRemoteError(`Slack rejected the request: ${code}.`, {
    connectorId: SLACK_CONNECTOR_ID,
    capabilityId: method,
    recovery: "fatal",
  });
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 2_000;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 2_000;
}
