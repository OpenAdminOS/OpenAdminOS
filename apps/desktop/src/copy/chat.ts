export const CHAT_COPY = {
  eyebrow: "Chat",
  emptyTitle: "What do you want to inspect?",
  emptySubtitle: "Answers come from your tenant’s own Graph data, with sources shown.",
  composerLabel: "Ask about your Microsoft 365 tenant",
  composerPlaceholder: "Ask about devices, users, apps, policies, sign-ins, or identity…",
  localBoundary: "Tenant context stays on this device with the selected local provider.",
  hostedBoundary: "Retrieved tenant context is sent to the selected hosted provider.",
  lifecycle: {
    sending: "Sending your question.",
    streaming: "Generating an answer.",
    complete: "Answer complete.",
    stopped: "Response stopped. Partial output is preserved.",
    failed: "The answer could not be completed.",
  },
} as const;
