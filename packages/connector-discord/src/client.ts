import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  ConnectorRemoteError,
} from "@openadminos/agent-sdk";

import { DISCORD_CONNECTOR_ID } from "./descriptor.js";

export interface DiscordWebhookClient {
  healthCheck(): Promise<void>;
  sendMessage(input: { text: string; username?: string; threadId?: string }): Promise<{
    id: string;
    channelId?: string;
  }>;
}

export interface CreateDiscordWebhookClientOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createDiscordWebhookClient(
  options: CreateDiscordWebhookClientOptions,
): DiscordWebhookClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = normalizeWebhookUrl(options.webhookUrl);

  async function request<T>(method: "GET" | "POST", input?: {
    text?: string;
    username?: string;
    threadId?: string;
  }): Promise<T> {
    const url = new URL(baseUrl);
    if (method === "POST") {
      url.searchParams.set("wait", "true");
      if (input?.threadId) url.searchParams.set("thread_id", input.threadId);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      const requestInit: RequestInit = {
        method,
        signal: controller.signal,
      };
      if (method === "POST") {
        requestInit.headers = { "content-type": "application/json" };
        const body: Record<string, unknown> = {
          content: input?.text ?? "",
          allowed_mentions: { parse: [] },
        };
        if (input?.username) body.username = input.username;
        requestInit.body = JSON.stringify(body);
      }
      response = await fetchImpl(url.toString(), requestInit);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new ConnectorRemoteError(
          `Discord webhook request timed out after ${timeoutMs}ms.`,
          {
            connectorId: DISCORD_CONNECTOR_ID,
            capabilityId: method === "POST" ? "send-message" : "health-check",
            recovery: "retry",
            cause,
          },
        );
      }
      throw new ConnectorRemoteError(
        `Discord webhook request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          connectorId: DISCORD_CONNECTOR_ID,
          capabilityId: method === "POST" ? "send-message" : "health-check",
          recovery: "retry",
          cause,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ConnectorAuthError(
        `Discord webhook rejected the request (HTTP ${response.status}). Check the webhook URL.`,
        {
          connectorId: DISCORD_CONNECTOR_ID,
          capabilityId: method === "POST" ? "send-message" : "health-check",
        },
      );
    }
    if (response.status === 429) {
      throw new ConnectorRateLimitError("Discord rate-limited the webhook request.", {
        connectorId: DISCORD_CONNECTOR_ID,
        capabilityId: method === "POST" ? "send-message" : "health-check",
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ConnectorRemoteError(
        `Discord webhook responded with HTTP ${response.status}: ${text.slice(0, 200)}`,
        {
          connectorId: DISCORD_CONNECTOR_ID,
          capabilityId: method === "POST" ? "send-message" : "health-check",
          recovery: response.status >= 500 ? "retry" : "fatal",
          statusCode: response.status,
        },
      );
    }
    return (await response.json().catch(() => ({}))) as T;
  }

  return {
    async healthCheck(): Promise<void> {
      await request("GET");
    },
    async sendMessage(input): Promise<{ id: string; channelId?: string }> {
      const payload = await request<{ id?: string; channel_id?: string }>("POST", input);
      if (!payload.id) {
        throw new ConnectorRemoteError(
          "Discord webhook returned no message id.",
          {
            connectorId: DISCORD_CONNECTOR_ID,
            capabilityId: "send-message",
            recovery: "fatal",
          },
        );
      }
      return {
        id: payload.id,
        ...(payload.channel_id ? { channelId: payload.channel_id } : {}),
      };
    },
  };
}

function normalizeWebhookUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^https:\/\/discord(?:app)?\.com\/api\/webhooks\//.test(trimmed)) {
    throw new ConnectorAuthError(
      "Discord connector requires a Discord webhook URL.",
      { connectorId: DISCORD_CONNECTOR_ID },
    );
  }
  return trimmed;
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 2_000;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 2_000;
}
