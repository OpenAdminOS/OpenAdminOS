import { describe, expect, it } from "vitest";
import {
  chatSendReducer,
  initialChatSendState,
  shouldSubmitComposerKey,
} from "./chat-send-state.js";

describe("Chat send state", () => {
  it("models send, stream, stop, and retry transitions", () => {
    const sending = chatSendReducer(initialChatSendState, { type: "send" });
    const streaming = chatSendReducer(sending, { type: "stream" });
    const stopping = chatSendReducer(streaming, { type: "request-stop" });
    const lateStream = chatSendReducer(stopping, { type: "stream" });
    expect(lateStream.phase).toBe("stopping");
    const stopped = chatSendReducer(lateStream, { type: "stopped" });
    const retrying = chatSendReducer(stopped, { type: "retry" });
    expect(retrying.phase).toBe("retrying");
  });

  it("rejects invalid transitions", () => {
    expect(() => chatSendReducer(initialChatSendState, { type: "complete" })).toThrow(
      "Invalid Chat send transition",
    );
  });

  it("returns to streaming when a stop request cannot be delivered", () => {
    const sending = chatSendReducer(initialChatSendState, { type: "send" });
    const stopping = chatSendReducer(sending, { type: "request-stop" });
    const resumed = chatSendReducer(stopping, { type: "stop-failed" });
    expect(resumed.phase).toBe("streaming");
    expect(() => chatSendReducer(resumed, { type: "request-stop" })).not.toThrow();
  });

  it("sends on Enter and keeps Shift+Enter for a line break", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});
