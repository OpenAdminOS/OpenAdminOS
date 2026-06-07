import {
  ConnectorNotConfiguredError,
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openadminos/agent-sdk";

import type {
  SendSlackMessageArgs,
  SlackConnectorCapabilities,
  SlackMessageRef,
} from "./capabilities.js";
import {
  SLACK_CONNECTOR_ID,
  SLACK_SECRET_KEYS,
  slackDescriptor,
} from "./descriptor.js";
import { createSlackClient, type SlackClient } from "./client.js";

export * from "./capabilities.js";
export {
  SLACK_CONNECTOR_ID,
  SLACK_SECRET_KEYS,
  slackDescriptor,
} from "./descriptor.js";
export { createSlackClient } from "./client.js";

declare module "@openadminos/agent-sdk" {
  interface ConnectorRegistry {
    slack: SlackConnectorCapabilities;
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
  client: SlackClient,
  config: Record<string, unknown>,
): SlackConnectorCapabilities {
  const defaultChannel = readConfigString(config, "defaultChannel");
  return {
    async sendMessage(args: SendSlackMessageArgs): Promise<SlackMessageRef> {
      const channel = args.channel?.trim() || defaultChannel;
      if (!channel) {
        throw new ConnectorValidationError(
          "sendMessage requires a Slack channel. Set a default channel on the Connectors page, or supply one at invocation time.",
          { connectorId: SLACK_CONNECTOR_ID, capabilityId: "send-message" },
        );
      }
      if (typeof args.text !== "string" || args.text.trim().length === 0) {
        throw new ConnectorValidationError(
          "sendMessage requires a non-empty text body.",
          { connectorId: SLACK_CONNECTOR_ID, capabilityId: "send-message" },
        );
      }
      const result = await client.postMessage({ channel, text: args.text });
      return {
        messageId: `${result.channel}:${result.ts}`,
        channel: result.channel,
        ts: result.ts,
      };
    },
  };
}

export const slackConnector: ConnectorFactory<SlackConnectorCapabilities> =
  defineConnector<SlackConnectorCapabilities>({
    descriptor: slackDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<SlackConnectorCapabilities>> {
      const botToken = await ctx.secrets.get(SLACK_SECRET_KEYS.botToken);
      if (!botToken) {
        throw new ConnectorNotConfiguredError(
          "Slack connector requires a bot token.",
          { connectorId: SLACK_CONNECTOR_ID },
        );
      }
      const client = createSlackClient({ botToken });
      return {
        descriptor: slackDescriptor,
        status: "connected",
        capabilities: buildCapabilities(client, ctx.config),
        async healthCheck() {
          try {
            await client.authTest();
            return { healthy: true };
          } catch (error) {
            return {
              healthy: false,
              message: error instanceof Error ? error.message : "Slack health check failed.",
            };
          }
        },
        async dispose() {
          // Stateless REST client.
        },
      };
    },
  });

export default slackConnector;
