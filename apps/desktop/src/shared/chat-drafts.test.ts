import { describe, expect, it } from "vitest";
import { clearChatDraft, readChatDraft, writeChatDraft } from "./chat-drafts.js";

describe("local Chat drafts", () => {
  it("round-trips drafts per conversation and clears after send", () => {
    writeChatDraft("conversation-1", "Inspect stale devices");
    writeChatDraft("conversation-2", "Review app failures");
    expect(readChatDraft("conversation-1")).toBe("Inspect stale devices");
    expect(readChatDraft("conversation-2")).toBe("Review app failures");
    clearChatDraft("conversation-1");
    expect(readChatDraft("conversation-1")).toBe("");
  });
});
