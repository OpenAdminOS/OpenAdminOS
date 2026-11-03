import type { PendingIntent } from "../setup/pending-intent";

export const WELCOME_COPY = {
  title: "Welcome to OpenAdminOS",
  subtitle: "Try it on sample data first, or connect your Microsoft 365 tenant now.",
  pilotTitle: "Start in pilot mode",
  pilotBody:
    "Explore a fictional company's tenant. No Microsoft sign-in, no AI setup. Prepared prompts and three agents show how OpenAdminOS works.",
  pilotBullets: [
    "Sample data, clearly labeled",
    "Nothing leaves this device",
    "Switch to production any time",
  ],
  pilotAction: "Start pilot mode",
  pilotStarting: "Starting pilot mode",
  pilotFailed: "Pilot mode did not start.",
  connectTitle: "Connect your tenant",
  connectBody:
    "Production. Ask anything about your own tenant and use every agent. Needs a Microsoft sign-in and one-time admin approval for read access.",
  connectAction: "Connect tenant",
  ownRegistrationLink:
    "Your organization blocks third-party apps? Use your own app registration.",
  footer: "Read-only by default. Write actions always ask for your confirmation.",
  skip: "Skip for now",
} as const;

export const SETUP_COPY = {
  title: "Connect a Microsoft 365 tenant",
  subtitle: "Review the read access OpenAdminOS requests before Microsoft sign-in.",
  dailyRole:
    "Global Reader is recommended for daily read access across Intune and Entra. Coverage depends on tenant licences and service-specific access controls.",
  consentRole:
    "A Global Administrator is only needed once to grant the requested admin consent. Use your daily account after consent is granted.",
  scopedRoles:
    "Scoped roles such as Security Reader, Conditional Access Administrator, and Intune Administrator also work, with reduced coverage outside their area. Consent does not add role permissions or licences.",
  tokenStorage:
    "Tokens are stored through the operating system's protected credential store and are never sent to an OpenAdminOS server.",
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
    "Ask about devices, users, apps, policies, sign-ins, or identity. Connect a tenant when you send.",
  signInChoiceLegend: "Sign in with",
  signInChoiceHint:
    "Choose the Entra app registration that signs you in. The read permissions below are the same for both. Access can be revoked from Enterprise applications at any time.",
  openAdminOSAppTitle: "OpenAdminOS app",
  openAdminOSAppPoints: (clientId: string) => [
    `Appears in Enterprise applications and sign-in logs as OpenAdminOS, client ID ${clientId}.`,
    "An administrator who can grant tenant-wide consent approves once for the tenant.",
    "No client secret. Tokens are stored on this device only.",
  ],
  ownRegistrationTitle: "Your own app registration",
  ownRegistrationPoints: [
    "An app your organization creates and owns. No third-party multi-tenant app is added to the tenant.",
    "Sign-in logs show your app's name, and your Conditional Access and consent rules apply to it.",
    "No client secret. Tokens are stored on this device only.",
  ],
  ownRegistrationBody:
    "Register a public client in Entra under Mobile and desktop applications with the redirect URI http://localhost and Allow public client flows set to Yes, then enter its details below. The setup script below can create it for you.",
  savedRegistrationsLegend: "Saved registrations",
  savedRegistrationsHint: "Registrations you connected with before. Remove them in Settings, Tenants.",
  newRegistrationOption: "Enter a different registration",
  chooseSignInReason: "Choose OpenAdminOS app or your own app registration above to continue.",
  clientIdRequiredReason: "Enter the Application (client) ID of your app registration to continue.",
  clientIdInvalidReason:
    "The Application (client) ID must be a GUID from your app registration overview.",
  directoryIdInvalidReason:
    "The Directory (tenant) ID must be a GUID or a verified domain name.",
  editSignIn: "Change sign-in options",
  savedRegistrationsSettingsTitle: "Saved app registrations",
  savedRegistrationsSettingsBody:
    "Your own app registrations used on this device. Removing one only removes it from the connect dialog. Tenants already connected with it keep working.",
  removeSavedRegistration: (name: string) => `Remove saved registration ${name}`,
  removeSavedRegistrationFailed: (reason: string) =>
    `The saved registration was not removed. ${reason} Try again.`,
  savedRegistrationRemoved: "Saved registration removed. Connected tenants are unchanged.",
  ownRegistrationNoSecret:
    "No client secret is used. OpenAdminOS signs in as a public client (Authorization Code with PKCE), so there is no secret to store on this device.",
  delegatedPermissionsNote:
    "Delegated permissions: OpenAdminOS can only read what both these permissions and your own admin role allow. Intune RBAC roles and scope tags still apply.",
  clientIdLabel: "Application (client) ID",
  clientIdHint: "The GUID from your app registration overview.",
  directoryIdLabel: "Directory (tenant) ID",
  directoryIdHint:
    "Only needed when your registration is single-tenant. Leave empty for a multi-tenant registration.",
  registrationLabelLabel: "Label (optional)",
  registrationLabelHint: "Shown in Settings and the tenant menu. Stored on this device only.",
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
