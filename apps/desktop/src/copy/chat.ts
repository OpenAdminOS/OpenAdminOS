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
    stopped: "Response stopped.",
    failed: "The answer could not be completed.",
  },
} as const;

/** The company behind a hosted provider, as the hosted send confirmation names it. */
export const PROVIDER_COMPANIES: Readonly<Partial<Record<string, string>>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  copilot: "GitHub",
  gemini: "Google",
  "azure-openai": "Azure OpenAI",
};

/** The hosted send confirmation above the composer (mockup 32, section D). */
export const HOSTED_CONFIRM_COPY = {
  title: (company: string) => `Send this question to ${company}?`,
  /** A CLI decides where it sends prompts (Claude Code to Anthropic, Bedrock or Vertex), so the tool is named. */
  titleThrough: (tool: string) => `Send this question through ${tool}?`,
  bodyThroughNoTenant: (tool: string) => `${tool} answers with your existing sign-in. Nothing is connected, so no tenant data is included.`,
  bodyThroughTenant: (tool: string, tenant: string) => `${tool} answers with your existing sign-in. Selected cached data from ${tenant} is included.`,
  sendThrough: (tool: string) => `Send through ${tool}`,
  bodyNoTenant: (tool: string, company: string) => `${tool} answers through ${company}. Nothing is connected, so no tenant data is included.`,
  bodyTenant: (tool: string, company: string, tenant: string) => `${tool} answers through ${company}. Selected cached data from ${tenant} is included.`,
  goesTo: "Goes to",
  whatIsSent: "What is sent",
  staysHere: "Stays here",
  sentNoTenant: (references: boolean) => `Your question and this conversation${references ? ", and results from the references you added" : ""}`,
  sentTenant: (tenant: string, workspace?: string) =>
    `Your question, this conversation and selected cached data from ${tenant}${workspace ? `, with ${workspace}` : ""}`,
  staysNoTenant: "Chat history",
  staysTenant: "Chat history and the local cache",
  rememberNoTenant: (model: string) => `Do not ask again for questions without a tenant on ${model}`,
  rememberTenant: (tenant: string, tool: string) => `Do not ask again for ${tenant} with ${tool}`,
  send: (company: string) => `Send to ${company}`,
  cancel: "Cancel",
  useLocal: "Use a model on this device",
} as const;
