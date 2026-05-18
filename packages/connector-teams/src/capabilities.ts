/**
 * Typed capability surface exposed to agents that declare the Teams
 * connector. Each method maps 1:1 to a Microsoft Graph endpoint.
 *
 * - `listTeams` / `listChannels` are `kind: read` — no side effects,
 *   safe to call from any agent code path.
 * - `postChannelMessage` / `postChatMessage` are `kind: notify` — the
 *   runtime gates each call with the preview-and-send confirmation
 *   modal before invoking. The capability method itself does NOT
 *   prompt; gating happens in the runtime wrapper that wraps the
 *   capability call.
 */
export interface TeamsConnectorCapabilities {
  listTeams(): Promise<TeamRef[]>;
  listChannels(teamId: string): Promise<ChannelRef[]>;
  postChannelMessage(args: PostChannelMessageArgs): Promise<TeamsMessageRef>;
  postChatMessage(args: PostChatMessageArgs): Promise<TeamsMessageRef>;
}

export interface TeamRef {
  id: string;
  displayName: string;
}

export interface ChannelRef {
  id: string;
  displayName: string;
  /** Channel type from Graph; `standard` is the common case. */
  membershipType?: "standard" | "private" | "shared" | "unknown";
}

export interface PostChannelMessageArgs {
  teamId: string;
  channelId: string;
  /**
   * Message body authored as Markdown. The connector renders a
   * Teams-compatible HTML subset before posting; raw HTML in the
   * source is escaped to defend against injection from agent output.
   */
  markdown: string;
  /**
   * Runtime-supplied idempotency key. Stable across retries for the
   * same `(runId, stepId, iteration)`. Teams Graph does not currently
   * honor a remote idempotency header, so the key is recorded in the
   * audit entry but does not influence the HTTP request directly.
   */
  idempotencyKey?: string;
}

export interface PostChatMessageArgs {
  chatId: string;
  markdown: string;
  idempotencyKey?: string;
}

export interface TeamsMessageRef {
  messageId: string;
  /** `https://teams.microsoft.com/l/message/...` deeplink returned by Graph. */
  webUrl: string;
}
