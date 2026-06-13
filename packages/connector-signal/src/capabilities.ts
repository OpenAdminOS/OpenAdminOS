export interface SignalConnectorCapabilities {
  sendMessage(args: SendSignalMessageArgs): Promise<SignalMessageRef>;
}

export interface SendSignalMessageArgs {
  /** E.164 phone number, Signal UUID, username, or group id accepted by signal-cli. */
  to?: string;
  text: string;
  idempotencyKey?: string;
}

export interface SignalMessageRef {
  messageId: string;
  to: string;
  timestamp?: number;
}
