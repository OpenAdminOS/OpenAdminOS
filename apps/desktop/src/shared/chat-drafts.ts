const PREFIX = "openadminos:chat-draft:v1:";

export function chatDraftKey(conversationId: string | null): string {
  return `${PREFIX}${conversationId ?? "new"}`;
}
export function readChatDraft(conversationId: string | null): string {
  try {
    return window.sessionStorage.getItem(chatDraftKey(conversationId)) ?? "";
  } catch {
    return "";
  }
}

export function writeChatDraft(conversationId: string | null, value: string): void {
  try {
    const key = chatDraftKey(conversationId);
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Draft persistence is best effort. The composer remains usable.
  }
}

export function clearChatDraft(conversationId: string | null): void {
  writeChatDraft(conversationId, "");
}
