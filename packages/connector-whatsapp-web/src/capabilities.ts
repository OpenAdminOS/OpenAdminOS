export interface WhatsAppWebConnectorCapabilities {
  sendMessage(args: SendWhatsAppWebMessageArgs): Promise<WhatsAppWebMessageRef>;
}

export type WhatsAppWebRecipientType = "self" | "group" | "manual";

export interface SendWhatsAppWebMessageArgs {
  /** `self`, an international phone number, or a raw WhatsApp JID. */
  to?: string;
  /** Plain text body sent through WhatsApp Web. */
  text: string;
  idempotencyKey?: string;
}

export interface WhatsAppWebMessageRef {
  messageId: string;
  to: string;
  targetType: WhatsAppWebRecipientType;
}

export interface WhatsAppWebGroupRef {
  id: string;
  subject: string;
  participantCount?: number;
  announce?: boolean;
}

export type WhatsAppWebConnectionState =
  | "not-linked"
  | "connecting"
  | "qr"
  | "connected"
  | "reconnecting"
  | "logged-out"
  | "error";

export interface WhatsAppWebStatus {
  state: WhatsAppWebConnectionState;
  message: string;
  qrDataUrl?: string;
  qrIssuedAt?: string;
  qrRefreshesAt?: string;
  lastConnectedAt?: string;
  lastError?: string;
}

export interface WhatsAppWebHealth {
  healthy: boolean;
  message?: string;
}
