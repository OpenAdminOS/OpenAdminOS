import type { ConnectorDescriptor } from "@openadminos/agent-sdk";

export const SIGNAL_CONNECTOR_ID = "signal";

export const signalDescriptor: ConnectorDescriptor = {
  id: SIGNAL_CONNECTOR_ID,
  name: "Signal",
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
      account: {
        type: "string",
        title: "Signal account",
        description:
          "Signal sender account in E.164 format. Required for signal-cli and the REST bridge.",
      },
      defaultRecipient: {
        type: "string",
        title: "Default recipient",
        description:
          "Signal recipient used when an agent sends without specifying a target.",
      },
      defaultRecipientLabel: {
        type: "string",
        title: "Default recipient label",
        description:
          "Human-readable target label shown in delivery settings and run logs.",
      },
      httpUrl: {
        type: "string",
        title: "REST bridge URL",
        description:
          "Optional local signal-cli-rest-api URL. When absent, OpenAdminOS invokes signal-cli directly.",
      },
      cliPath: {
        type: "string",
        title: "signal-cli path",
        description:
          "Path to signal-cli. Defaults to signal-cli on PATH when REST bridge URL is absent.",
      },
      configPath: {
        type: "string",
        title: "signal-cli config directory",
        description:
          "Optional config directory passed to signal-cli with --config.",
      },
    },
  },
  trust: {
    label: "Signal · local bridge",
    detail:
      "Sends message content through a local signal-cli account. Data leaves Microsoft 365 and is delivered by Signal.",
    staysInTenant: false,
  },
};
