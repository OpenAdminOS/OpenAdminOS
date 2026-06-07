import type { ConnectorDescriptor } from "@openadminos/agent-sdk";

export const DISCORD_CONNECTOR_ID = "discord";

export const DISCORD_SECRET_KEYS = {
  webhookUrl: "webhookUrl",
} as const;

export const discordDescriptor: ConnectorDescriptor = {
  id: DISCORD_CONNECTOR_ID,
  name: "Discord",
  version: "1.0.0",
  authSource: "external",
  scopes: [],
  capabilities: [
    {
      id: "send-message",
      version: 1,
      kind: "notify",
      scopes: [],
    },
  ],
  configSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      defaultTargetLabel: {
        type: "string",
        title: "Default target label",
        description:
          "Human-readable label shown in delivery settings and run logs.",
      },
      username: {
        type: "string",
        title: "Webhook username",
        description:
          "Optional username override for messages sent by the Discord webhook.",
      },
      defaultThreadId: {
        type: "string",
        title: "Default thread id",
        description:
          "Optional Discord thread id used when the webhook posts into a forum/thread target.",
      },
    },
  },
  trust: {
    label: "Discord · external webhook",
    detail:
      "Sends message content to the configured Discord channel webhook. Data leaves Microsoft 365.",
    staysInTenant: false,
  },
};
