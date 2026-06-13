import {
  ConnectorNotConfiguredError,
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openadminos/agent-sdk";

import type {
  DiscordConnectorCapabilities,
  DiscordMessageRef,
  SendDiscordMessageArgs,
} from "./capabilities.js";
import {
  DISCORD_CONNECTOR_ID,
  DISCORD_SECRET_KEYS,
  discordDescriptor,
} from "./descriptor.js";
import { createDiscordWebhookClient, type DiscordWebhookClient } from "./client.js";

export * from "./capabilities.js";
export {
  DISCORD_CONNECTOR_ID,
  DISCORD_SECRET_KEYS,
  discordDescriptor,
} from "./descriptor.js";
export { createDiscordWebhookClient } from "./client.js";

declare module "@openadminos/agent-sdk" {
  interface ConnectorRegistry {
    discord: DiscordConnectorCapabilities;
  }
}

function readConfigString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function buildCapabilities(
  client: DiscordWebhookClient,
  config: Record<string, unknown>,
): DiscordConnectorCapabilities {
  return {
    async sendMessage(args: SendDiscordMessageArgs): Promise<DiscordMessageRef> {
      if (typeof args.text !== "string" || args.text.trim().length === 0) {
        throw new ConnectorValidationError(
          "sendMessage requires a non-empty text body.",
          { connectorId: DISCORD_CONNECTOR_ID, capabilityId: "send-message" },
        );
      }
      const input: { text: string; username?: string; threadId?: string } = {
        text: args.text,
      };
      const username = args.username ?? readConfigString(config, "username");
      const threadId = args.threadId ?? readConfigString(config, "defaultThreadId");
      if (username) input.username = username;
      if (threadId) input.threadId = threadId;
      const result = await client.sendMessage(input);
      return {
        messageId: result.id,
        ...(result.channelId ? { channelId: result.channelId } : {}),
      };
    },
  };
}

export const discordConnector: ConnectorFactory<DiscordConnectorCapabilities> =
  defineConnector<DiscordConnectorCapabilities>({
    descriptor: discordDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<DiscordConnectorCapabilities>> {
      const webhookUrl = await ctx.secrets.get(DISCORD_SECRET_KEYS.webhookUrl);
      if (!webhookUrl) {
        throw new ConnectorNotConfiguredError(
          "Discord connector requires a channel webhook URL.",
          { connectorId: DISCORD_CONNECTOR_ID },
        );
      }
      const client = createDiscordWebhookClient({ webhookUrl });
      return {
        descriptor: discordDescriptor,
        status: "connected",
        capabilities: buildCapabilities(client, ctx.config),
        async healthCheck() {
          try {
            await client.healthCheck();
            return { healthy: true };
          } catch (error) {
            return {
              healthy: false,
              message: error instanceof Error ? error.message : "Discord health check failed.",
            };
          }
        },
        async dispose() {
          // Stateless webhook client.
        },
      };
    },
  });

export default discordConnector;
