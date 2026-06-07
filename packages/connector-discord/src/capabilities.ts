export interface DiscordConnectorCapabilities {
  sendMessage(args: SendDiscordMessageArgs): Promise<DiscordMessageRef>;
}

export interface SendDiscordMessageArgs {
  text: string;
  threadId?: string;
  username?: string;
  idempotencyKey?: string;
}

export interface DiscordMessageRef {
  messageId: string;
  channelId?: string;
}
