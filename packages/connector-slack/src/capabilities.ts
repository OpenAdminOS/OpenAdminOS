export interface SlackConnectorCapabilities {
  sendMessage(args: SendSlackMessageArgs): Promise<SlackMessageRef>;
}

export interface SendSlackMessageArgs {
  /** Slack channel/user/conversation id. Omitted means connector default channel. */
  channel?: string;
  text: string;
  idempotencyKey?: string;
}

export interface SlackMessageRef {
  messageId: string;
  channel: string;
  ts: string;
}
