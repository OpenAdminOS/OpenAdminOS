import type { ConnectorDescriptor } from "@openagents/agent-sdk";

/**
 * Graph scope identifiers. The fully-qualified
 * `https://graph.microsoft.com/<scope>` form is required when calling
 * MSAL; the bare form is what shows up on the consent screen. We keep
 * both available so other layers can use whichever is appropriate.
 */
export const TEAMS_SCOPES = {
  /** Required to list joined teams via `/me/joinedTeams`. */
  TeamReadBasicAll: "Team.ReadBasic.All",
  /** Required to enumerate channels via `/teams/{id}/channels`. */
  ChannelReadBasicAll: "Channel.ReadBasic.All",
  /** Required to post a channel message via `/teams/{id}/channels/{id}/messages`. */
  ChannelMessageSend: "ChannelMessage.Send",
  /** Required to post a chat message via `/chats/{id}/messages`. */
  ChatReadWrite: "Chat.ReadWrite",
} as const;

export const TEAMS_SCOPE_LIST = Object.values(TEAMS_SCOPES);

/**
 * Returns the fully-qualified MSAL scope string for a bare Graph
 * permission name. MSAL accepts both forms but the fully-qualified
 * form removes ambiguity when multiple resources are in play.
 */
export function qualifyGraphScope(scope: string): string {
  if (scope.startsWith("https://")) return scope;
  return `https://graph.microsoft.com/${scope}`;
}

export const TEAMS_CONNECTOR_ID = "teams";

export const teamsDescriptor: ConnectorDescriptor = {
  id: TEAMS_CONNECTOR_ID,
  name: "Microsoft Teams",
  version: "1.0.0",
  authSource: "graph-delegated",
  scopes: TEAMS_SCOPE_LIST,
  capabilities: [
    {
      id: "list-teams",
      version: 1,
      kind: "read",
      scopes: [TEAMS_SCOPES.TeamReadBasicAll],
    },
    {
      id: "list-channels",
      version: 1,
      kind: "read",
      scopes: [TEAMS_SCOPES.ChannelReadBasicAll],
    },
    {
      id: "post-channel-message",
      version: 1,
      kind: "notify",
      scopes: [TEAMS_SCOPES.ChannelMessageSend],
    },
    {
      id: "post-chat-message",
      version: 1,
      kind: "notify",
      scopes: [TEAMS_SCOPES.ChatReadWrite],
    },
  ],
  configSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      defaultTeamId: {
        type: "string",
        title: "Default team",
        description:
          "Team selected by default when an agent posts a channel message without specifying one.",
      },
      defaultChannelId: {
        type: "string",
        title: "Default channel",
        description:
          "Channel within the default team. Agents may override at invocation time.",
      },
      defaultChatId: {
        type: "string",
        title: "Default chat",
        description:
          "Group or 1:1 chat used when an agent posts a chat message without specifying one.",
      },
    },
  },
  trust: {
    label: "Microsoft Teams · {tenant}",
    detail:
      "Posts via Microsoft Graph as the signed-in admin. Data stays inside the tenant.",
    staysInTenant: true,
  },
};
