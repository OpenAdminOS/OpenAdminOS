import { useSyncExternalStore } from "react";

import type { IntuneChatMessage, IntuneChatProgressStep } from "../shared/openAdminOS";

export type ChatProgressState = {
  message: string;
  progressPercent: number;
  steps: IntuneChatProgressStep[];
};

/**
 * The chat answer that is streaming right now. The stream callbacks belong
 * to the Chat page that sent the question, so a Chat page mounted later in
 * the run (after the admin opened another page and came back) had no live
 * state and showed the question with nothing under it until the answer was
 * saved. The run is kept here as well, outside the page, so any Chat page
 * showing its conversation shows the live steps.
 */
export interface LiveChatRun {
  streamId: string;
  tenantId?: string;
  /** Unknown until the host has started the run. */
  conversationId: string | null;
  assistantMessageId: string;
  /** The question and the answer as the live page shows them. */
  messages: IntuneChatMessage[];
  progress: ChatProgressState | null;
}

let current: LiveChatRun | null = null;
const listeners = new Set<() => void>();

function publish(next: LiveChatRun | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function startLiveChatRun(run: LiveChatRun): void {
  publish(run);
}

/** Updates the run only while `streamId` is still the live one. */
export function updateLiveChatRun(streamId: string, update: (run: LiveChatRun) => LiveChatRun): void {
  if (current?.streamId === streamId) publish(update(current));
}

export function endLiveChatRun(streamId: string): void {
  if (current?.streamId === streamId) publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveChatRun(): LiveChatRun | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
