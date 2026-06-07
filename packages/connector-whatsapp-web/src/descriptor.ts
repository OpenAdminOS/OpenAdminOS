import type { ConnectorDescriptor } from "@openadminos/agent-sdk";

export const WHATSAPP_WEB_CONNECTOR_ID = "whatsapp-web";

export const whatsappWebDescriptor: ConnectorDescriptor = {
  id: WHATSAPP_WEB_CONNECTOR_ID,
  name: "WhatsApp Web",
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
      defaultRecipientType: {
        type: "string",
        enum: ["self", "group", "manual"],
        title: "Default notification target type",
        description:
          "How the default WhatsApp notification target is selected.",
      },
      defaultRecipient: {
        type: "string",
        title: "Default notification target",
        description:
          "The reserved value 'self', an international phone number, or a WhatsApp JID used when an agent sends a notification without its own target.",
      },
      defaultRecipientLabel: {
        type: "string",
        title: "Default notification target label",
        description:
          "Human-readable label shown in delivery settings and run logs.",
      },
    },
  },
  trust: {
    label: "WhatsApp Web · local session",
    detail:
      "Sends through a WhatsApp Web session linked on this device. Message content leaves Microsoft 365 and is delivered by WhatsApp.",
    staysInTenant: false,
  },
};
