import {
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openadminos/agent-sdk";

import type {
  OutlookConnectorCapabilities,
  OutlookMailRef,
  SendOutlookMailArgs,
} from "./capabilities.js";
import {
  OUTLOOK_CONNECTOR_ID,
  OUTLOOK_SCOPES,
  outlookDescriptor,
} from "./descriptor.js";
import { createOutlookGraphClient, type OutlookGraphClient } from "./graph-client.js";
import { renderMarkdownForEmail, escapeHtml } from "./markdown.js";

export * from "./capabilities.js";
export {
  OUTLOOK_CONNECTOR_ID,
  OUTLOOK_SCOPES,
  OUTLOOK_SCOPE_LIST,
  outlookDescriptor,
} from "./descriptor.js";
export { createOutlookGraphClient } from "./graph-client.js";
export { renderMarkdownForEmail } from "./markdown.js";

declare module "@openadminos/agent-sdk" {
  interface ConnectorRegistry {
    outlook: OutlookConnectorCapabilities;
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

function readRecipients(args: SendOutlookMailArgs, config: Record<string, unknown>): string[] {
  const explicit = sanitizeRecipients(args.to ?? []);
  if (explicit.length > 0) return explicit;
  return sanitizeRecipients(splitRecipientList(readConfigString(config, "defaultRecipients")));
}

function splitRecipientList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,\n;]/g);
}

function sanitizeRecipients(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function buildSubject(args: SendOutlookMailArgs, config: Record<string, unknown>): string {
  const prefix = readConfigString(config, "defaultSubjectPrefix");
  const subject = args.subject?.trim() || "OpenAdminOS notification";
  return prefix ? `${prefix} ${subject}` : subject;
}

function shouldSaveToSentItems(args: SendOutlookMailArgs, config: Record<string, unknown>): boolean {
  if (typeof args.saveToSentItems === "boolean") return args.saveToSentItems;
  return readConfigString(config, "saveToSentItems")?.toLowerCase() !== "false";
}

function buildBody(args: SendOutlookMailArgs): { contentType: "HTML" | "Text"; content: string } {
  if (typeof args.html === "string" && args.html.trim().length > 0) {
    return { contentType: "HTML", content: args.html };
  }
  if (typeof args.markdown === "string" && args.markdown.trim().length > 0) {
    return { contentType: "HTML", content: renderMarkdownForEmail(args.markdown) };
  }
  if (typeof args.text === "string" && args.text.trim().length > 0) {
    return { contentType: "Text", content: args.text };
  }
  return { contentType: "HTML", content: renderMarkdownForEmail("OpenAdminOS notification") };
}

function recipientPayload(addresses: readonly string[]): Array<{ emailAddress: { address: string } }> {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

function buildCapabilities(
  client: OutlookGraphClient,
  config: Record<string, unknown>,
): OutlookConnectorCapabilities {
  return {
    async sendMail(args: SendOutlookMailArgs): Promise<OutlookMailRef> {
      const to = readRecipients(args, config);
      const cc = sanitizeRecipients(args.cc ?? []);
      if (to.length === 0) {
        throw new ConnectorValidationError(
          "sendMail requires at least one recipient. Set default recipients on the Connectors page, or supply recipients at invocation time.",
          { connectorId: OUTLOOK_CONNECTOR_ID, capabilityId: "send-mail" },
        );
      }
      const body = buildBody(args);
      await client.fetch({
        method: "POST",
        path: "/me/sendMail",
        scopes: [OUTLOOK_SCOPES.MailSend],
        capabilityId: "send-mail",
        body: {
          message: {
            subject: escapeHtml(buildSubject(args, config)),
            body,
            toRecipients: recipientPayload(to),
            ...(cc.length > 0 ? { ccRecipients: recipientPayload(cc) } : {}),
          },
          saveToSentItems: shouldSaveToSentItems(args, config),
        },
      });
      return {
        messageId: args.idempotencyKey ?? `outlook:${Date.now()}`,
        to,
      };
    },
  };
}

export const outlookConnector: ConnectorFactory<OutlookConnectorCapabilities> =
  defineConnector<OutlookConnectorCapabilities>({
    descriptor: outlookDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<OutlookConnectorCapabilities>> {
      const client = createOutlookGraphClient({ tenant: ctx.tenant });
      return {
        descriptor: outlookDescriptor,
        status: "connected",
        capabilities: buildCapabilities(client, ctx.config),
        async healthCheck() {
          try {
            await client.acquire([OUTLOOK_SCOPES.MailSend], "health-check");
            return { healthy: true };
          } catch (error) {
            return {
              healthy: false,
              message: error instanceof Error ? error.message : "Outlook health check failed.",
            };
          }
        },
        async dispose() {
          // Stateless Graph client.
        },
      };
    },
  });

export default outlookConnector;
