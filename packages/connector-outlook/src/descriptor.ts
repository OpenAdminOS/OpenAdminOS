import type { ConnectorDescriptor } from "@openadminos/agent-sdk";

export const OUTLOOK_CONNECTOR_ID = "outlook";

export const OUTLOOK_SCOPES = {
  MailSend: "Mail.Send",
} as const;

export const OUTLOOK_SCOPE_LIST = Object.values(OUTLOOK_SCOPES);

export function qualifyGraphScope(scope: string): string {
  if (scope.startsWith("https://")) return scope;
  return `https://graph.microsoft.com/${scope}`;
}

export const outlookDescriptor: ConnectorDescriptor = {
  id: OUTLOOK_CONNECTOR_ID,
  name: "Outlook",
  version: "1.0.0",
  authSource: "graph-delegated",
  scopes: OUTLOOK_SCOPE_LIST,
  capabilities: [
    {
      id: "send-mail",
      version: 1,
      kind: "notify",
      scopes: [OUTLOOK_SCOPES.MailSend],
    },
  ],
  configSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      defaultRecipients: {
        type: "string",
        title: "Default recipients",
        description:
          "Comma- or newline-separated email addresses used when an agent sends mail without specifying recipients.",
      },
      defaultSubjectPrefix: {
        type: "string",
        title: "Subject prefix",
        description:
          "Optional prefix added to notification email subjects, for example [OpenAdminOS].",
      },
      saveToSentItems: {
        type: "string",
        title: "Save to Sent Items",
        description:
          "Set to 'false' to avoid saving connector notifications to Sent Items. Defaults to true.",
      },
    },
  },
  trust: {
    label: "Outlook · {tenant}",
    detail:
      "Sends email via Microsoft Graph as the signed-in admin. Mail stays inside Exchange Online unless recipients are external.",
    staysInTenant: true,
  },
};
