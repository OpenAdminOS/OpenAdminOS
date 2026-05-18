import {
  ConnectorRemoteError,
  ConnectorValidationError,
  defineConnector,
  type ConnectorBuildContext,
  type ConnectorFactory,
  type ConnectorInstance,
} from "@openagents/agent-sdk";

import {
  TEAMS_CONNECTOR_ID,
  TEAMS_SCOPES,
  teamsDescriptor,
} from "./descriptor.js";
import { createTeamsGraphClient, type TeamsGraphClient } from "./graph-client.js";
import { renderMarkdownForTeams } from "./markdown.js";
import type {
  ChannelRef,
  PostChannelMessageArgs,
  PostChatMessageArgs,
  TeamRef,
  TeamsConnectorCapabilities,
  TeamsMessageRef,
} from "./capabilities.js";

export * from "./capabilities.js";
export {
  TEAMS_CONNECTOR_ID,
  TEAMS_SCOPES,
  TEAMS_SCOPE_LIST,
  teamsDescriptor,
} from "./descriptor.js";
export { renderMarkdownForTeams } from "./markdown.js";

/**
 * Registry augmentation. Importing `@openagents/connector-teams` from
 * any TypeScript file that also imports `@openagents/agent-sdk`
 * activates the `teams` key on `ConnectorRegistry`, narrowing
 * `ctx.connectors.teams` to the typed capability surface. Consumers
 * who only load the connector at runtime (no static import) can
 * opt-in by adding `import '@openagents/connector-teams'` once.
 */
declare module "@openagents/agent-sdk" {
  interface ConnectorRegistry {
    teams: TeamsConnectorCapabilities;
  }
}

interface TeamsListJoinedResponse {
  value?: Array<{ id?: unknown; displayName?: unknown }>;
}

interface TeamsListChannelsResponse {
  value?: Array<{
    id?: unknown;
    displayName?: unknown;
    membershipType?: unknown;
  }>;
}

interface TeamsChatMessageResponse {
  id?: unknown;
  webUrl?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ChannelMembershipType = NonNullable<ChannelRef["membershipType"]>;

function readMembershipType(value: unknown): ChannelMembershipType {
  if (value === "standard" || value === "private" || value === "shared") {
    return value;
  }
  return "unknown";
}

function readConfigString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildCapabilities(
  client: TeamsGraphClient,
  config: Record<string, unknown>,
): TeamsConnectorCapabilities {
  const defaultTeamId = readConfigString(config, "defaultTeamId");
  const defaultChannelId = readConfigString(config, "defaultChannelId");
  const defaultChatId = readConfigString(config, "defaultChatId");
  return {
    async listTeams(): Promise<TeamRef[]> {
      const payload = await client.fetch<TeamsListJoinedResponse>({
        method: "GET",
        path: "/me/joinedTeams?$select=id,displayName",
        scopes: [TEAMS_SCOPES.TeamReadBasicAll],
        capabilityId: "list-teams",
      });
      const teams: TeamRef[] = [];
      for (const entry of payload.value ?? []) {
        const id = readString(entry.id);
        const displayName = readString(entry.displayName);
        if (id && displayName) {
          teams.push({ id, displayName });
        }
      }
      return teams;
    },

    async listChannels(teamId: string): Promise<ChannelRef[]> {
      if (!readString(teamId)) {
        throw new ConnectorValidationError(
          "listChannels requires a non-empty teamId.",
          { connectorId: TEAMS_CONNECTOR_ID, capabilityId: "list-channels" },
        );
      }
      const payload = await client.fetch<TeamsListChannelsResponse>({
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,membershipType`,
        scopes: [TEAMS_SCOPES.ChannelReadBasicAll],
        capabilityId: "list-channels",
      });
      const channels: ChannelRef[] = [];
      for (const entry of payload.value ?? []) {
        const id = readString(entry.id);
        const displayName = readString(entry.displayName);
        if (id && displayName) {
          channels.push({
            id,
            displayName,
            membershipType: readMembershipType(entry.membershipType),
          });
        }
      }
      return channels;
    },

    async postChannelMessage(
      args: PostChannelMessageArgs,
    ): Promise<TeamsMessageRef> {
      const teamId = readString(args.teamId) ?? defaultTeamId;
      const channelId = readString(args.channelId) ?? defaultChannelId;
      if (!teamId || !channelId) {
        throw new ConnectorValidationError(
          "postChannelMessage requires teamId and channelId. Set a default team and channel on the Connectors page, or supply them at invocation time.",
          {
            connectorId: TEAMS_CONNECTOR_ID,
            capabilityId: "post-channel-message",
          },
        );
      }
      if (typeof args.markdown !== "string" || args.markdown.trim() === "") {
        throw new ConnectorValidationError(
          "postChannelMessage requires non-empty markdown body.",
          {
            connectorId: TEAMS_CONNECTOR_ID,
            capabilityId: "post-channel-message",
          },
        );
      }
      const payload = await client.fetch<TeamsChatMessageResponse>({
        method: "POST",
        path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        scopes: [TEAMS_SCOPES.ChannelMessageSend],
        capabilityId: "post-channel-message",
        body: {
          body: {
            contentType: "html",
            content: renderMarkdownForTeams(args.markdown),
          },
        },
      });
      return readTeamsMessageRef(payload, "post-channel-message");
    },

    async postChatMessage(args: PostChatMessageArgs): Promise<TeamsMessageRef> {
      const chatId = readString(args.chatId) ?? defaultChatId;
      if (!chatId) {
        throw new ConnectorValidationError(
          "postChatMessage requires a chatId. Set a default chat on the Connectors page, or supply one at invocation time.",
          {
            connectorId: TEAMS_CONNECTOR_ID,
            capabilityId: "post-chat-message",
          },
        );
      }
      if (typeof args.markdown !== "string" || args.markdown.trim() === "") {
        throw new ConnectorValidationError(
          "postChatMessage requires non-empty markdown body.",
          {
            connectorId: TEAMS_CONNECTOR_ID,
            capabilityId: "post-chat-message",
          },
        );
      }
      const payload = await client.fetch<TeamsChatMessageResponse>({
        method: "POST",
        path: `/chats/${encodeURIComponent(chatId)}/messages`,
        scopes: [TEAMS_SCOPES.ChatReadWrite],
        capabilityId: "post-chat-message",
        body: {
          body: {
            contentType: "html",
            content: renderMarkdownForTeams(args.markdown),
          },
        },
      });
      return readTeamsMessageRef(payload, "post-chat-message");
    },
  };
}

function readTeamsMessageRef(
  payload: TeamsChatMessageResponse,
  capabilityId: string,
): TeamsMessageRef {
  const messageId = readString(payload.id);
  const webUrl = readString(payload.webUrl);
  if (!messageId || !webUrl) {
    throw new ConnectorRemoteError(
      "Microsoft Graph returned a Teams message response without id or webUrl.",
      {
        connectorId: TEAMS_CONNECTOR_ID,
        capabilityId,
        recovery: "fatal",
      },
    );
  }
  return { messageId, webUrl };
}

export const teamsConnector: ConnectorFactory<TeamsConnectorCapabilities> =
  defineConnector<TeamsConnectorCapabilities>({
    descriptor: teamsDescriptor,
    async build(
      ctx: ConnectorBuildContext,
    ): Promise<ConnectorInstance<TeamsConnectorCapabilities>> {
      const client = createTeamsGraphClient({ tenant: ctx.tenant });
      const capabilities = buildCapabilities(client, ctx.config);
      return {
        descriptor: teamsDescriptor,
        status: "connected",
        capabilities,
        async healthCheck() {
          try {
            await client.fetch<{ id?: unknown }>({
              method: "GET",
              path: "/me?$select=id",
              scopes: [TEAMS_SCOPES.TeamReadBasicAll],
              capabilityId: "health-check",
            });
            return { healthy: true };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Teams health check failed.";
            return { healthy: false, message };
          }
        },
        async dispose() {
          // Stateless Graph client — nothing to release.
        },
      };
    },
  });

export default teamsConnector;
