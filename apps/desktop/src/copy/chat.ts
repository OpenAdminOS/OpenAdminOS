export const CHAT_COPY = {
  /** Chat starters after a connect, one line per connected service. */
  askAbout: (service: string) => `Ask about ${service}`,
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

/** Chat with a model and nothing connected, and the inline model choice (SPEC.md 4a, 2026-11-08). */
export const FIRST_RUN_CHAT_COPY = {
  homeTitle: "What are you working on?",
  homeSubtitle:
    "Ask about Intune, Entra, Defender, macOS management, KQL or PowerShell. Questions about your own devices and users need a connected service.",
  startersLabel: "Starter questions",
  worksNow: "Works now",
  needs: (service: string) => `Needs ${service}`,
  /**
   * Fixed until the reference catalog carries its own examples. Each is a
   * request the keyword rules route as docs, so it works with nothing
   * connected also on deterministic retrieval.
   */
  worksNowStarters: [
    "Write a KQL query for failed sign-ins in the last 24 hours",
    "Write a PowerShell script that exports Intune compliance policies with Microsoft Graph",
  ],
  referencesTitle: "Ground answers in public references",
  referencesHint: "No sign-in. Each one receives words from your questions.",
  referenceHost: (host: string) => `Questions go to ${host}`,
  addReference: "Add",
  addReferenceLabel: (name: string) => `Add ${name}`,
  moreReferences: (count: number) => `${count} more in the`,
  marketplace: "Marketplace",
  hideReferences: "Hide",
  hideReferencesLabel: "Hide reference suggestions",
  composerNoTenant: "No organization. Chat answers from the model and the references you add.",
  placeholderNoTenant: "Ask a question",
  placeholderNoModel: "Choose a model to start asking",
  modelChoiceTitle: "Choose a model to answer with",
  noModelFooter: "Read-only by default. Write actions always ask for your confirmation.",
  noModelSendNotice: "Choose a model above to send this question. It is kept in the composer.",
  /** `goesTo` is `promptsGoTo(provider)`: "Prompts go to ..." or "Prompts leave this device through ...". */
  hostedNoTenantSentence: (goesTo: string) => `${goesTo}. No organization is active, so no tenant data is sent.`,
  hostedTenantSentence: (goesTo: string) => `${goesTo}.`,
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
  bodyThroughNoTenant: (tool: string) => `${tool} answers with your existing sign-in. No organization is active, so no tenant data is included.`,
  bodyThroughTenant: (tool: string, tenant: string) => `${tool} answers with your existing sign-in. Selected cached data from ${tenant} is included.`,
  sendThrough: (tool: string) => `Send through ${tool}`,
  bodyNoTenant: (tool: string, company: string) => `${tool} answers through ${company}. No organization is active, so no tenant data is included.`,
  bodyTenant: (tool: string, company: string, tenant: string) => `${tool} answers through ${company}. Selected cached data from ${tenant} is included.`,
  goesTo: "Goes to",
  /** The acknowledgement is bound to this model, in both variants. */
  model: "Model",
  whatIsSent: "What is sent",
  staysHere: "Stays here",
  sentNoTenant: (references: boolean) => `Your question and this conversation${references ? ", and results from the references you added" : ""}`,
  sentTenant: (tenant: string, workspace?: string) =>
    `Your question, this conversation and selected cached data from ${tenant}${workspace ? `, with ${workspace}` : ""}`,
  staysNoTenant: "Chat history",
  staysTenant: "Chat history and the local cache",
  rememberNoTenant: (model: string) => `Do not ask again for questions with no organization on ${model}`,
  rememberTenant: (tenant: string, tool: string, model?: string) => `Do not ask again for ${tenant} with ${tool}${model ? ` on ${model}` : ""}`,
  send: (company: string) => `Send to ${company}`,
  cancel: "Cancel",
  useLocal: "Use a model on this device",
} as const;

/** The not-connected card in the Chat transcript (SPEC.md 4a, mockup 32 section D). */
export const NOT_CONNECTED_COPY = {
  needsTitle: (services: string) => `This needs ${services}`,
  needsTenantTitle: "This needs Microsoft 365",
  noTenantBody: (services: string) =>
    `Chat reads this from ${services}, and no organization is active. Connect ${services} to answer this. Your question is kept and no tenant data was read.`,
  noTenantGenericBody:
    "Chat reads this from Microsoft 365, and no organization is active. Connect Microsoft 365 to answer this. Your question is kept and no tenant data was read.",
  removedTenantBody: (services: string) =>
    `The organization this question was about is no longer in OpenAdminOS. Connect Microsoft 365 with ${services} to answer this. Your question is kept and no tenant data was read.`,
  tenantBody: (tenant: string) =>
    `Add it for ${tenant} to answer this. Your question is kept and nothing was read from the missing service.`,
  signInPart: "Sign-in",
  permissionsSummary: (count: number) => `${count} read-only Microsoft Graph permission${count === 1 ? "" : "s"}`,
  connect: (services: string) => `Connect ${services}`,
  connectTenant: "Connect Microsoft 365",
  add: (service: string) => `Add ${service}`,
  ownRegistration: "Use our own app registration",
  askAdmin: "Ask an admin to approve",
  askAdminCopied: "Message with the admin consent link copied. Send it to an admin who can approve the permissions.",
  askAdminFailed: "The message could not be copied. Select the link below and copy it yourself.",
  fine:
    "Read-only and delegated: OpenAdminOS can only read what these permissions and your own role allow. An admin with at least the Cloud Application Administrator role approves them once for the tenant.",
  resolvedTitle: (services: string, tenant: string) => `${services} connected for ${tenant}`,
  resolvedTenantTitle: (tenant: string) => `${tenant} connected`,
  resolvedBody: "Nothing is sent until you ask again.",
  askAgain: "Ask again",
  adminMessage: (input: { services: string; permissions: string; link: string }) =>
    [
      `Please approve read-only access for OpenAdminOS in our Microsoft 365 tenant. It needs these delegated Microsoft Graph permissions for ${input.services}: ${input.permissions}.`,
      "They are read-only. OpenAdminOS can only read what both these permissions and the signed-in admin's own role allow. Approving needs at least the Cloud Application Administrator role.",
      `Open this link, sign in, review the permissions and accept: ${input.link}`,
      "After you accept, the browser opens http://localhost, which can show that the page cannot be reached. The approval is saved all the same.",
    ].join("\n\n"),
} as const;
