export type ChatSendPhase =
  | "idle"
  | "sending"
  | "streaming"
  | "stopping"
  | "complete"
  | "stopped"
  | "failed"
  | "retrying";

export interface ChatSendState {
  phase: ChatSendPhase;
  announcement: string;
}

export type ChatSendEvent =
  | { type: "send" }
  | { type: "stream" }
  | { type: "request-stop" }
  | { type: "stop-failed" }
  | { type: "complete" }
  | { type: "stopped" }
  | { type: "fail" }
  | { type: "retry" }
  | { type: "reset" };

export const initialChatSendState: ChatSendState = { phase: "idle", announcement: "" };

const transitions: Record<ChatSendPhase, Partial<Record<ChatSendEvent["type"], ChatSendPhase>>> = {
  idle: { send: "sending", reset: "idle" },
  sending: { stream: "streaming", complete: "complete", fail: "failed", "request-stop": "stopping", stopped: "stopped", reset: "idle" },
  streaming: { stream: "streaming", complete: "complete", fail: "failed", "request-stop": "stopping", stopped: "stopped", reset: "idle" },
  stopping: { stream: "stopping", "stop-failed": "streaming", stopped: "stopped", complete: "stopped", fail: "failed", reset: "idle" },
  complete: { send: "sending", reset: "idle" },
  stopped: { send: "sending", retry: "retrying", reset: "idle" },
  failed: { retry: "retrying", send: "sending", reset: "idle" },
  retrying: { stream: "streaming", complete: "complete", fail: "failed", "request-stop": "stopping", stopped: "stopped", reset: "idle" },
};

const announcements: Record<ChatSendPhase, string> = {
  idle: "",
  sending: "Sending your question.",
  streaming: "Generating an answer.",
  stopping: "Stopping the response.",
  complete: "Answer complete.",
  stopped: "Response stopped. Partial output is preserved.",
  failed: "The answer could not be completed.",
  retrying: "Retrying your question.",
};

export function chatSendReducer(state: ChatSendState, event: ChatSendEvent): ChatSendState {
  const next = transitions[state.phase][event.type];
  if (!next) {
    throw new Error(`Invalid Chat send transition: ${state.phase} -> ${event.type}`);
  }
  return { phase: next, announcement: announcements[next] };
}

export function shouldSubmitComposerKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
