import type { PendingIntent } from "../setup/pending-intent";

export const SETUP_COPY = {
  title: "Connect a Microsoft 365 tenant",
  subtitle: "Review the read access OpenAdminOS requests before Microsoft sign-in.",
  readOnlyNote:
    "All requested permissions are read-only. Write-mode agents request their specific scope separately at install time, with their own Microsoft consent screen.",
  betaNote:
    "Graph reads use Microsoft’s beta endpoint. OpenAdminOS never calls write endpoints from this permission set.",
  signInScopesNote:
    "Microsoft also adds openid, profile, and offline_access for sign-in and local token refresh. These are standard sign-in scopes, not separate admin-consent permissions.",
  approve: "Approve and continue to Microsoft",
  waitingTitle: "Waiting for Microsoft sign-in…",
  waitingBody: "Complete the sign-in in your browser, then return here. This can take a minute.",
  timeoutTitle: "Still waiting for Microsoft",
  timeoutBody:
    "The sign-in has not completed. The browser tab may have been closed, or the sign-in may still be in progress.",
  providerTitle: "Pick an LLM provider",
  providerBody: "Answers need an LLM. Local providers keep tenant data and prompts on this device.",
  providerRequired: "Your pending action needs a working provider before it can run.",
  connectedTitle: "Tenant connected",
  cancelled: "Sign-in cancelled. Nothing was connected.",
  lateSuccess: (tenantName: string) =>
    `Tenant ${tenantName} connected. Your earlier action was not resumed.`,
  guestChatHint:
    "No tenant connected. You can draft a question now; connecting happens when you send.",
  guestComposerPlaceholder:
    "Ask about devices, users, apps, policies, or sign-ins. Connect a tenant when you send.",
  statusNoTenant: "No active tenant · Connect",
} as const;

export function pendingIntentCopy(intent: PendingIntent | null, agentName?: string): string | null {
  if (!intent) return null;
  switch (intent.kind) {
    case "chat-send":
      return "After connecting, your question will be ready to send.";
    case "agent-run":
      return `After connecting, ${agentName ?? "this agent"} will open its normal run review.`;
    case "view-changes":
      return "After connecting, change history for this tenant will load.";
    case "refresh-cache":
      return "After connecting, the requested tenant data refresh will be ready.";
    case "scheduled-batch":
      return `After connecting, the ${intent.mode === "due" ? "due" : "enabled"} read-only schedules will be ready to run.`;
  }
}

export function resumeIntentLabel(intent: PendingIntent | null, agentName?: string): string {
  if (!intent) return "Done";
  switch (intent.kind) {
    case "chat-send":
      return "Send your question";
    case "agent-run":
      return `Review ${agentName ?? "agent"} run`;
    case "view-changes":
      return "Open Changes";
    case "refresh-cache":
      return "Continue refresh";
    case "scheduled-batch":
      return intent.mode === "due" ? "Run due schedules" : "Run enabled schedules";
  }
}
