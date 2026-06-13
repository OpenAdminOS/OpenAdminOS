export interface OutlookConnectorCapabilities {
  sendMail(args: SendOutlookMailArgs): Promise<OutlookMailRef>;
}

export interface SendOutlookMailArgs {
  /** Recipient email addresses. Omitted means connector default recipients. */
  to?: string[];
  cc?: string[];
  subject?: string;
  /** Markdown source rendered to simple HTML before sending. */
  markdown?: string;
  /** Plain-text body. Used when `markdown` and `html` are absent. */
  text?: string;
  /** Pre-rendered HTML body. Agent-authored raw HTML should be avoided. */
  html?: string;
  saveToSentItems?: boolean;
  idempotencyKey?: string;
}

export interface OutlookMailRef {
  /** Graph sendMail returns 202 with no message id; use the idempotency key for audit correlation. */
  messageId: string;
  to: string[];
}
