import { afterEach, describe, expect, it } from "vitest";

import type { IntuneChatMessage } from "../shared/openAdminOS";
import { endLiveChatRun, liveChatRuns, startLiveChatRun, updateLiveChatRun, type LiveChatRun } from "./live-chat-run";

const run = (streamId: string, conversationId: string): LiveChatRun => ({
  streamId,
  tenantId: "tenant-1",
  conversationId,
  assistantMessageId: `a-${streamId}`,
  messages: [],
  progress: null,
});

const answer = (id: string, content: string): IntuneChatMessage => ({ id, conversationId: "c", role: "assistant", content, status: "streaming", createdAt: "" });

afterEach(() => {
  for (const entry of liveChatRuns()) endLiveChatRun(entry.streamId);
});

describe("live chat runs", () => {
  it("keeps a second run without replacing the first, and updates each by its stream", () => {
    startLiveChatRun(run("s1", "c1"));
    startLiveChatRun(run("s2", "c2"));
    updateLiveChatRun("s1", (entry) => ({ ...entry, messages: [answer("a-s1", "first")] }));
    updateLiveChatRun("s2", (entry) => ({ ...entry, messages: [answer("a-s2", "second")] }));
    expect(liveChatRuns().map((entry) => [entry.streamId, entry.messages[0]?.content])).toEqual([["s1", "first"], ["s2", "second"]]);
  });

  it("removes a run when it ends and leaves the others live", () => {
    startLiveChatRun(run("s1", "c1"));
    startLiveChatRun(run("s2", "c2"));
    endLiveChatRun("s1");
    expect(liveChatRuns().map((entry) => entry.streamId)).toEqual(["s2"]);
    // An update for an ended run does not bring it back.
    updateLiveChatRun("s1", (entry) => ({ ...entry, conversationId: "c9" }));
    expect(liveChatRuns().map((entry) => entry.streamId)).toEqual(["s2"]);
    endLiveChatRun("s2");
    expect(liveChatRuns()).toEqual([]);
  });

  it("gives the same list to every reader until something changes", () => {
    startLiveChatRun(run("s1", "c1"));
    const before = liveChatRuns();
    expect(liveChatRuns()).toBe(before);
    updateLiveChatRun("missing", (entry) => entry);
    expect(liveChatRuns()).toBe(before);
  });
});
