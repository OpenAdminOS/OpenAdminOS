import {
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openadminos/agent-sdk";

import type {
  SendSignalMessageArgs,
  SignalConnectorCapabilities,
  SignalMessageRef,
} from "./capabilities.js";
import {
  SIGNAL_CONNECTOR_ID,
  signalDescriptor,
} from "./descriptor.js";
import { createSignalClient, type SignalClient } from "./client.js";

export * from "./capabilities.js";
export {
  SIGNAL_CONNECTOR_ID,
  signalDescriptor,
} from "./descriptor.js";
export { createSignalClient } from "./client.js";

declare module "@openadminos/agent-sdk" {
  interface ConnectorRegistry {
    signal: SignalConnectorCapabilities;
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
  client: SignalClient,
  config: Record<string, unknown>,
): SignalConnectorCapabilities {
  const defaultRecipient = readConfigString(config, "defaultRecipient");
  return {
    async sendMessage(args: SendSignalMessageArgs): Promise<SignalMessageRef> {
      const to = args.to?.trim() || defaultRecipient;
      if (!to) {
        throw new ConnectorValidationError(
          "sendMessage requires a Signal recipient. Set a default recipient on the Connectors page, or supply one at invocation time.",
          { connectorId: SIGNAL_CONNECTOR_ID, capabilityId: "send-message" },
        );
      }
      if (typeof args.text !== "string" || args.text.trim().length === 0) {
        throw new ConnectorValidationError(
          "sendMessage requires a non-empty text body.",
          { connectorId: SIGNAL_CONNECTOR_ID, capabilityId: "send-message" },
        );
      }
      const result = await client.sendMessage({ to, text: args.text });
      return {
        messageId: result.timestamp ? String(result.timestamp) : (args.idempotencyKey ?? `signal:${Date.now()}`),
        to,
        ...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
      };
    },
  };
}

export const signalConnector: ConnectorFactory<SignalConnectorCapabilities> =
  defineConnector<SignalConnectorCapabilities>({
    descriptor: signalDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<SignalConnectorCapabilities>> {
      const clientOptions: Parameters<typeof createSignalClient>[0] = {
        account: readConfigString(ctx.config, "account") ?? "",
      };
      const httpUrl = readConfigString(ctx.config, "httpUrl");
      const cliPath = readConfigString(ctx.config, "cliPath");
      const configPath = readConfigString(ctx.config, "configPath");
      if (httpUrl) clientOptions.httpUrl = httpUrl;
      if (cliPath) clientOptions.cliPath = cliPath;
      if (configPath) clientOptions.configPath = configPath;
      const client = createSignalClient(clientOptions);
      return {
        descriptor: signalDescriptor,
        status: "connected",
        capabilities: buildCapabilities(client, ctx.config),
        async healthCheck() {
          try {
            await client.healthCheck();
            return { healthy: true };
          } catch (error) {
            return {
              healthy: false,
              message: error instanceof Error ? error.message : "Signal health check failed.",
            };
          }
        },
        async dispose() {
          // One-shot REST/subprocess client.
        },
      };
    },
  });

export default signalConnector;
