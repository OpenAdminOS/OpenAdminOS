import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";

import type {
  ConfirmationDecision,
  ConnectorInvocationInfo,
} from "@openadminos/runtime";
import type {
  PendingConnectorConfirmation,
  PendingConnectorDecision,
} from "@openadminos/agent-sdk";

interface Pending {
  resolve(decision: ConfirmationDecision): void;
}

const pending = new Map<string, Pending>();

let getMainWindow: () => BrowserWindow | null = () => null;
let connectorNameLookup: (id: string) => string = (id) => id;
let connectorConfigLookup: (id: string) => Record<string, unknown> = () => ({});

export function installConnectorConfirmBridge(input: {
  getMainWindow: () => BrowserWindow | null;
  connectorNameLookup: (id: string) => string;
  connectorConfigLookup: (id: string) => Record<string, unknown>;
}): void {
  getMainWindow = input.getMainWindow;
  connectorNameLookup = input.connectorNameLookup;
  connectorConfigLookup = input.connectorConfigLookup;
}

/**
 * Implementation of `ExecuteRunInput.confirmCapability`. Sends a
 * confirmation request to the renderer over IPC and resolves when the
 * renderer calls `respondConnectorConfirm`. Used by every run that
 * invokes a `notify`/`mutating`/`destructive` connector capability.
 *
 * Constructs the payload with two enrichments over the raw invocation
 * info:
 *   - `bodyPreview`: the message body rendered or forwarded as a
 *     safe preview so the modal shows what will be sent.
 *   - `targetLabel`: a human-readable destination ("Ugur Koc Lab →
 *     #General") resolved from the saved connector config + args,
 *     replacing the opaque "teams:team=…;channel=…" engineer string.
 */
export async function requestConnectorConfirmation(
  info: ConnectorInvocationInfo,
): Promise<ConfirmationDecision> {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) {
    return { approved: false, reason: "No renderer attached to receive confirmation." };
  }

  const requestId = randomUUID();
  const config = connectorConfigLookup(info.connectorId);
  const bodyPreview = extractBodyPreview(info.args);
  const targetLabel = resolveTargetLabel(info.connectorId, info.args, config);

  const payload: PendingConnectorConfirmation = {
    requestId,
    runId: extractRunId(info.idempotencyKey),
    stepId: extractStepId(info.idempotencyKey),
    connectorId: info.connectorId,
    connectorName: connectorNameLookup(info.connectorId),
    capability: info.capability,
    args: redactConfirmationArgs(info.connectorId, info.args),
    egressTarget: info.egressTarget,
    idempotencyKey: info.idempotencyKey,
    ...(bodyPreview !== undefined ? { bodyPreview } : {}),
    ...(targetLabel !== undefined ? { targetLabel } : {}),
  };

  return new Promise<ConfirmationDecision>((resolve) => {
    pending.set(requestId, { resolve });
    window.webContents.send("openadminos:connector-confirm-request", payload);
  });
}

export function respondConnectorConfirm(
  requestId: string,
  decision: PendingConnectorDecision,
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  entry.resolve(
    decision.approved
      ? { approved: true }
      : { approved: false, reason: decision.reason },
  );
}

function extractRunId(idempotencyKey: string): string {
  return idempotencyKey.split(":")[0] ?? "";
}

function extractStepId(idempotencyKey: string): string {
  return idempotencyKey.split(":")[1] ?? "";
}

function extractBodyPreview(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  if (Array.isArray(args)) {
    if (args.length === 0) return undefined;
    return extractBodyPreview(args[0]);
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.markdown === "string") return obj.markdown;
  if (typeof obj.body === "string") return obj.body;
  if (typeof obj.text === "string") return obj.text;
  return undefined;
}

function resolveTargetLabel(
  connectorId: string,
  args: unknown,
  config: Record<string, unknown>,
): string | undefined {
  const argObj =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : Array.isArray(args) && args[0] && typeof args[0] === "object"
        ? (args[0] as Record<string, unknown>)
        : undefined;

  if (connectorId === "whatsapp-web") {
    const rawRecipient =
      readString(argObj?.to) ?? readString(config.defaultRecipient);
    const label = readString(config.defaultRecipientLabel);
    if (rawRecipient === "self" || readString(config.defaultRecipientType) === "self") {
      return label ?? "My WhatsApp";
    }
    if (label && label !== rawRecipient) return label;
    if (rawRecipient?.endsWith("@g.us")) return "WhatsApp group";
    return "WhatsApp recipient";
  }

  if (connectorId !== "teams") return undefined;

  const teamName = readString(config.defaultTeamName);
  const channelName = readString(config.defaultChannelName);
  const chatLabel = readString(config.defaultChatName);

  if (argObj && readString(argObj.chatId)) {
    return chatLabel ?? "Microsoft Teams chat";
  }
  if (teamName && channelName) {
    return `${teamName} → #${channelName}`;
  }
  if (channelName) {
    return `#${channelName}`;
  }
  if (teamName) {
    return teamName;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redactConfirmationArgs(connectorId: string, args: unknown): unknown {
  if (connectorId !== "whatsapp-web") return args;
  if (Array.isArray(args)) {
    return args.map((item) => redactConfirmationArgs(connectorId, item));
  }
  if (!args || typeof args !== "object") return args;
  const redacted = { ...(args as Record<string, unknown>) };
  if (typeof redacted.to === "string") {
    redacted.to = "redacted";
  }
  return redacted;
}
