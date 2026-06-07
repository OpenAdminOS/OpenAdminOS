import {
  ConnectorNotConfiguredError,
  ConnectorRemoteError,
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openadminos/agent-sdk";

import type {
  SendWhatsAppWebMessageArgs,
  WhatsAppWebConnectorCapabilities,
  WhatsAppWebMessageRef,
} from "./capabilities.js";
import {
  WHATSAPP_WEB_CONNECTOR_ID,
  whatsappWebDescriptor,
} from "./descriptor.js";
import {
  WhatsAppWebNotLinkedError,
  WhatsAppWebValidationError,
  getWhatsAppWebClient,
} from "./runtime.js";

export * from "./capabilities.js";
export {
  WHATSAPP_WEB_CONNECTOR_ID,
  whatsappWebDescriptor,
} from "./descriptor.js";
export {
  WhatsAppWebClient,
  WhatsAppWebNotLinkedError,
  WhatsAppWebValidationError,
  getWhatsAppWebClient,
} from "./runtime.js";

declare module "@openadminos/agent-sdk" {
  interface ConnectorRegistry {
    "whatsapp-web": WhatsAppWebConnectorCapabilities;
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

function readDefaultRecipient(config: Record<string, unknown>): string {
  const type = readConfigString(config, "defaultRecipientType");
  if (type === "self") return "self";
  return readConfigString(config, "defaultRecipient") ?? "self";
}

function buildCapabilities(
  ctx: ConnectorBuildContext,
): WhatsAppWebConnectorCapabilities {
  const authDir = readConfigString(ctx.config, "authDir");
  if (!authDir) {
    throw new ConnectorNotConfiguredError(
      "WhatsApp Web connector requires a local auth directory.",
      { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
    );
  }
  const defaultRecipient = readDefaultRecipient(ctx.config);
  const client = getWhatsAppWebClient({ authDir });
  return {
    async sendMessage(
      args: SendWhatsAppWebMessageArgs,
    ): Promise<WhatsAppWebMessageRef> {
      const to = readConfigString({ to: args.to }, "to") ?? defaultRecipient;
      if (!to) {
        throw new ConnectorValidationError(
          "sendMessage requires a WhatsApp target. Set a default target on the Connectors page, or supply one at invocation time.",
          {
            connectorId: WHATSAPP_WEB_CONNECTOR_ID,
            capabilityId: "send-message",
          },
        );
      }
      if (typeof args.text !== "string" || args.text.trim() === "") {
        throw new ConnectorValidationError(
          "sendMessage requires a non-empty text body.",
          {
            connectorId: WHATSAPP_WEB_CONNECTOR_ID,
            capabilityId: "send-message",
          },
        );
      }
      try {
        return await client.sendMessage({ ...args, to });
      } catch (error) {
        if (error instanceof WhatsAppWebNotLinkedError) {
          throw new ConnectorNotConfiguredError(error.message, {
            connectorId: WHATSAPP_WEB_CONNECTOR_ID,
            capabilityId: "send-message",
          });
        }
        if (error instanceof WhatsAppWebValidationError) {
          throw new ConnectorValidationError(error.message, {
            connectorId: WHATSAPP_WEB_CONNECTOR_ID,
            capabilityId: "send-message",
          });
        }
        throw new ConnectorRemoteError(
          error instanceof Error ? error.message : String(error),
          {
            connectorId: WHATSAPP_WEB_CONNECTOR_ID,
            capabilityId: "send-message",
            recovery: "retry",
          },
        );
      }
    },
  };
}

export const whatsappWebConnector: ConnectorFactory<WhatsAppWebConnectorCapabilities> =
  defineConnector<WhatsAppWebConnectorCapabilities>({
    descriptor: whatsappWebDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<WhatsAppWebConnectorCapabilities>> {
      const authDir = readConfigString(ctx.config, "authDir");
      if (!authDir) {
        throw new ConnectorNotConfiguredError(
          "WhatsApp Web connector requires a local auth directory.",
          { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
        );
      }
      const client = getWhatsAppWebClient({ authDir });
      const status = client.getStatus();
      return {
        descriptor: whatsappWebDescriptor,
        status: status.state === "connected" ? "connected" : "needs-setup",
        capabilities: buildCapabilities(ctx),
        async healthCheck() {
          return client.checkHealth();
        },
        async dispose() {
          // The WhatsApp socket is intentionally shared and remains live for
          // background notification delivery after a one-shot connector build.
        },
      };
    },
  });

export default whatsappWebConnector;
