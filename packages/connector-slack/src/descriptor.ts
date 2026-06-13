import type { ConnectorDescriptor } from "@openadminos/agent-sdk";

export const SLACK_CONNECTOR_ID = "slack";

export const SLACK_SECRET_KEYS = {
  botToken: "botToken",
} as const;

export const slackDescriptor: ConnectorDescriptor = {
  id: SLACK_CONNECTOR_ID,
  name: "Slack",
  version: "1.0.0",
  authSource: "external",
  scopes: ["chat:write"],
  capabilities: [
    {
      id: "send-message",
      version: 1,
      kind: "notify",
      scopes: ["chat:write"],
    },
  ],
  configSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      defaultChannel: {
        type: "string",
        title: "Default channel",
        description:
          "Slack channel, user, or conversation id used when an agent sends without specifying a target.",
      },
      defaultChannelLabel: {
        type: "string",
        title: "Default channel label",
        description:
          "Human-readable target label shown in delivery settings and run logs.",
      },
    },
  },
  trust: {
    label: "Slack · external workspace",
    detail:
      "Sends message content to the configured Slack workspace through a Slack bot token. Data leaves Microsoft 365.",
    staysInTenant: false,
  },
};
