import type { IntuneChatMessage } from "./openAdminOS.js";

/**
 * When the composer shows the full hosted-provider sentence and when only
 * its icon. The status strip always names where data goes; this decides
 * the extra sentence under the composer only.
 */

const STORAGE_KEY = "openadminos.chat.hosted-disclosure.v1";
const MAX_ENTRIES = 200;

/** What the sentence depends on: the provider, the model and every MCP host that receives tool queries. */
export function hostedDisclosureKey(input: { providerId: string; model?: string; toolHosts?: string }): string {
  return JSON.stringify([input.providerId, input.model ?? "", input.toolHosts ?? ""]);
}

/**
 * The full sentence shows on the first message of a conversation, and
 * again whenever the provider, the model or the MCP hosts differ from
 * what the conversation last sent with. A conversation with no record
 * (an older one, or another profile) counts as sent with the provider and
 * model of its latest answer.
 */
export function showFullHostedDisclosure(input: {
  hosted: boolean;
  currentKey: string;
  conversationId: string | null;
  messages: ReadonlyArray<Pick<IntuneChatMessage, "role" | "providerId" | "model">>;
  acknowledged: Readonly<Record<string, string>>;
  providerId: string;
  model?: string;
}): boolean {
  if (!input.hosted) return false;
  if (!input.conversationId || input.messages.length === 0) return true;
  const recorded = input.acknowledged[input.conversationId];
  if (recorded !== undefined) return recorded !== input.currentKey;
  const latest = [...input.messages].reverse().find((message) => message.role === "assistant");
  return !latest || latest.providerId !== input.providerId || (latest.model ?? "") !== (input.model ?? "");
}

/** The key each conversation last sent with. Per viewer; an empty record only shows the sentence more often. */
export function readHostedDisclosures(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  } catch {
    return {};
  }
}

export function recordHostedDisclosure(current: Readonly<Record<string, string>>, conversationId: string, key: string): Record<string, string> {
  const { [conversationId]: _previous, ...rest } = current;
  const next = Object.fromEntries([...Object.entries(rest), [conversationId, key]].slice(-MAX_ENTRIES));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the sentence then shows again next time.
  }
  return next;
}
