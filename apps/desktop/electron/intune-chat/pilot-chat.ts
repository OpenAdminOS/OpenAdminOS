import { randomUUID } from "node:crypto";

import type {
  IntuneChatMessage,
  IntuneChatStreamEvent,
  RunGraphApi,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
  TenantRecord,
} from "@openadminos/agent-sdk";

import { PILOT_COPY, pilotPromptEntry } from "../../src/shared/pilot-mode.js";
import { buildPilotPreparedAnswer } from "../sample-tenant/pilot-answers.js";
import { assertConversationTenant } from "../state-helpers.js";
import { GRAPH_CACHE_RESOURCES, chatTitleForPrompt } from "./planner.js";
import type { IntelligenceSqliteStore } from "./sqlite-store.js";

export class PilotPromptRejectedError extends Error {
  constructor() {
    super(PILOT_COPY.promptRejected);
    this.name = "PilotPromptRejectedError";
  }
}

/** True when the question is one of the prepared pilot prompts. */
export function isPreparedPilotPrompt(question: string): boolean {
  return pilotPromptEntry(question) !== undefined;
}

/**
 * Answers a Chat message on the pilot tenant. Pilot Chat never builds an
 * LLM, never refreshes a cache, and never reads provider settings, so it
 * behaves the same on every machine. Anything that is not a prepared prompt
 * is refused before a conversation or message is written.
 */
export async function answerPilotChatMessage(input: {
  message: SendIntuneChatMessageInput;
  tenant: TenantRecord;
  store: IntelligenceSqliteStore;
  graph: RunGraphApi;
  now: Date;
  onEvent?: (event: IntuneChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<SendIntuneChatMessageResult> {
  const content = input.message.content.trim();
  if (!content) throw new Error("Chat message must not be empty.");
  if (!isPreparedPilotPrompt(content)) throw new PilotPromptRejectedError();
  input.signal?.throwIfAborted();

  const { store, tenant } = input;
  const createdAt = input.now.toISOString();
  let conversation = input.message.conversationId
    ? store.getConversation(input.message.conversationId)
    : undefined;
  if (conversation) assertConversationTenant(conversation, tenant.id);
  if (!conversation) {
    conversation = store.createConversation({
      id: `chat_${randomUUID()}`,
      title: chatTitleForPrompt(content),
      tenantId: tenant.id,
      now: createdAt,
    });
  }

  const userMessage: IntuneChatMessage = {
    id: `msg_${randomUUID()}`,
    conversationId: conversation.id,
    role: "user",
    content,
    status: "completed",
    createdAt,
  };
  store.insertMessage(userMessage);
  const assistantId = `msg_${randomUUID()}`;
  const cacheStatus = () => ({
    tenantId: tenant.id,
    resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
    schedule: store.getGraphCacheRefreshSchedule(tenant.id),
  });
  input.onEvent?.({
    type: "started",
    conversation,
    userMessage,
    assistantMessage: {
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt,
    },
    cacheStatus: cacheStatus(),
  });
  input.onEvent?.({
    type: "status",
    conversationId: conversation.id,
    message: "Preparing the pilot answer from sample data.",
    stage: "building-context",
  });

  const prepared = await buildPilotPreparedAnswer(input.graph, content, input.now);
  if (!prepared) throw new PilotPromptRejectedError();
  input.signal?.throwIfAborted();
  input.onEvent?.({
    type: "delta",
    conversationId: conversation.id,
    assistantMessageId: assistantId,
    delta: prepared.markdown,
    content: prepared.markdown,
  });

  const assistantMessage: IntuneChatMessage = {
    id: assistantId,
    conversationId: conversation.id,
    role: "assistant",
    content: prepared.markdown,
    status: "completed",
    createdAt: new Date(input.now.getTime() + 1).toISOString(),
  };
  store.insertMessage(assistantMessage);
  store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

  const result: SendIntuneChatMessageResult = {
    conversation: store.getConversation(conversation.id) ?? conversation,
    userMessage,
    assistantMessage,
    cacheStatus: cacheStatus(),
  };
  input.onEvent?.({ type: "completed", result });
  return result;
}
