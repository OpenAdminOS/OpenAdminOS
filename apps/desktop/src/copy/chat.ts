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

/** Chat with a model and nothing connected, and the inline model choice (SPEC.md 4a, 2026-11-08). */
export const FIRST_RUN_CHAT_COPY = {
  homeTitle: "What are you working on?",
  homeSubtitle:
    "Ask about Intune, Entra, Defender, macOS management, KQL or PowerShell. Questions about your own devices and users need a connected service.",
  modelLineLocal: (model: string, provider: string) => `Answering with ${model} in ${provider} on this device.`,
  modelLineHosted: (model: string, location: string) => `Answering with ${model} through ${location}.`,
  changeModel: "Change model",
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
  composerNoTenant: "Nothing connected. Chat answers from the model and the references you add.",
  placeholderNoTenant: "Ask a question",
  placeholderNoModel: "Choose a model to start asking",
  modelChoiceTitle: "Choose a model to answer with",
  modelChoiceBody: "OpenAdminOS runs the conversation; the model writes the answers. You can change it at any time.",
  localOptionTitle: "OpenAdmin 8B on this device",
  localOptionBody: "Install Ollama, then run the command below. OpenAdmin 8B is a model trained for Intune and Entra work.",
  localOptionCommand: "ollama run openadminos/openadmin-8b",
  localOptionWhere: "Nothing leaves this device",
  localOptionAction: "Set up",
  hostedOptionTitle: (provider: string) => `${provider}, signed in on this device`,
  hostedOptionBody: "Uses your existing sign-in. No API key is stored.",
  hostedOptionWhere: (location: string) => `Prompts go to ${location}`,
  hostedOptionAction: (provider: string) => `Use ${provider}`,
  otherOptionTitle: "Another provider",
  otherOptionBody: "LM Studio, Codex, Azure OpenAI and others.",
  otherOptionAction: "Show all",
  previewPrefix: "Not ready to set up a model?",
  previewLink: "Preview with sample data",
  previewSuffix: "from a fictional company.",
  previewFailed: (reason: string) => `Sample data did not open. ${reason}`,
  noModelFooter: "Read-only by default. Write actions always ask for your confirmation.",
  noModelSendNotice: "Choose a model above to send this question. It is kept in the composer.",
  hostedNoTenantSentence: (location: string) =>
    `Prompts go to ${location} while this model is selected. Nothing is connected, so no tenant data is sent.`,
  hostedTenantSentence: (location: string) => `Prompts and tenant data go to ${location} while this model is selected.`,
} as const;

/** The not-connected card in the Chat transcript (SPEC.md 4a, mockup 32 section D). */
export const NOT_CONNECTED_COPY = {
  needsTitle: (services: string) => `This needs ${services}`,
  needsTenantTitle: "This needs a connected tenant",
  noTenantBody: (services: string) =>
    `Chat reads this from ${services}, and nothing is connected yet. Connect ${services} to answer this. Your question is kept and no tenant data was read.`,
  noTenantGenericBody:
    "Chat reads this from your Microsoft 365 tenant, and nothing is connected yet. Connect a tenant to answer this. Your question is kept and no tenant data was read.",
  removedTenantBody: (services: string) =>
    `The tenant this question was about is no longer in OpenAdminOS. Connect a tenant with ${services} to answer this. Your question is kept and no tenant data was read.`,
  tenantBody: (tenant: string) =>
    `Add it for ${tenant} to answer this. Your question is kept and nothing was read from the missing service.`,
  signInPart: "Sign-in",
  otherParts: (service: string, parts: string) => `Other ${service} parts (${parts}) can be added now or later.`,
  connect: (services: string) => `Connect ${services}`,
  connectTenant: "Connect a tenant",
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
