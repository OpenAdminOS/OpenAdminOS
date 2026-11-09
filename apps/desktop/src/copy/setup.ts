import type { PendingIntent } from "../setup/pending-intent";
import { formatServiceList } from "../shared/openAdminOS";

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
  selectServiceReason: "Select at least one service.",
  servicePickerLegend: "Services",
  servicePickerHint:
    "Choose the services to connect. Expand a service to review its parts, each exact Microsoft Graph scope and why it is needed. You can add services later in Settings, Tenants.",
  scriptServicesLegend: "Services in the script",
  ownRegistrationServicesNote:
    "Your app registration's API permissions decide which services are available. OpenAdminOS reads the granted permissions from the token after sign-in and switches on each service part that is fully granted.",
  ownRegistrationSignIn: "Sign in with your app registration",
  connectedServicesSummary: (connected: readonly string[], missing: readonly string[]) =>
    [
      connected.length > 0
        ? `Connected services: ${connected.join(", ")}.`
        : "No service is connected yet.",
      missing.length > 0
        ? `Not connected: ${missing.join(", ")}. Add them in Settings, Tenants.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
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

const joinTitles = formatServiceList;

export const SERVICE_COPY = {
  status: {
    connected: "Connected",
    partial: "Partial",
    missing: "Not connected",
  },
  servicesHeading: "Services",
  chipsLabel: (services: readonly string[]) => `Services: ${services.join(", ")}`,
  filterAll: "All services",
  filterLabel: (service: string) => `Needs ${service}`,
  addAction: (service: string) => `Add ${service}`,
  addPermissionsAction: (service: string) => `Add ${service} permissions`,
  addAccessTitle: (service: string) => `Add ${service} access`,
  addPermissionsTitle: (service: string) => `Add ${service} permissions`,
  addPartLabel: (part: string) => `Add ${part}`,
  sharedAppSubtitle: (tenant: string) => `Review delegated access for ${tenant}`,
  ownRegistrationSubtitle: (tenant: string, clientId: string) =>
    `Your app registration ${clientId} for ${tenant}`,
  ownRegistrationSteps:
    "OpenAdminOS cannot change your app registration. Add these delegated Microsoft Graph permissions with the script or the JSON snippet, grant admin consent, then choose Check again.",
  missingPermissions: (scopes: readonly string[]) => `Missing: ${scopes.join(", ")}`,
  partsSummary: (granted: number, total: number) => `${granted} of ${total} parts`,
  checkAgain: "Check again",
  checkAgainHint:
    "Reads the permissions a new token carries from your app registration and switches on each part that is fully granted.",
  checkedAgain: "Permissions checked. Services follow what the new token carries.",
  checkedAgainWithWarning: (message: string) =>
    `Permissions checked, but the license check did not finish. ${message}`,
  tierProbeWarningTitle: "License check did not finish.",
  tierProbeWarningKept: "The stored Entra tier and licenses are kept.",
  tierProbeWarningShort: "License check did not finish",
  retryLicenseCheck: "Retry license check",
  retryLicenseCheckFor: (tenant: string) => `Retry license check for ${tenant}`,
  licenseCheckFinished: "License check finished. The Entra tier and licenses are up to date.",
  licenseCheckStillFailing: "Tried again. The license check still did not finish.",
  licensesNotChecked: "Licenses not checked",
  licensesNotCheckedBody:
    "The license check needs Organization.Read.All, which comes with Users and groups in Intune or Entra.",
  checkingPermissions: "Checking permissions.",
  checkingLicenses: "Checking licenses.",
  addingAccess: "Adding access.",
  waitingForSignIn: "Waiting for Microsoft sign-in. Finish it in your browser, or cancel.",
  waitingForSignInButton: "Waiting for Microsoft sign-in",
  checkRunning: "Checking",
  checkRunningFor: (tenant: string) => `Check in progress for ${tenant}`,
  cancelCheck: "Cancel check",
  cancelCheckFor: (tenant: string) => `Cancel the check for ${tenant}`,
  cancellingCheck: "Cancelling",
  accessAddedWithWarning: (message: string) =>
    `Access added, but the license check did not finish. ${message}`,
  copied: (label: string) => `${label} copied.`,
  alreadyConnected: (service: string, tenant: string) =>
    `${service} is connected for ${tenant}. Every part is granted.`,
  notConnectedTitle: (services: readonly string[], tenant: string) =>
    `${joinTitles(services)} ${services.length === 1 ? "is" : "are"} not connected for ${tenant}`,
  notConnectedBody: (feature: string, services: readonly string[], ownRegistration: boolean) =>
    `${feature} reads data from ${joinTitles(services, "or")}. ${
      ownRegistration
        ? "Add the permissions to your app registration, grant admin consent, then choose Check again."
        : "Add the service to ask Microsoft for consent to its read scopes only. Your other services stay as they are."
    }`,
  cacheSkipped: (count: number) =>
    `${count} ${count === 1 ? "resource belongs" : "resources belong"} to service parts that are not connected for this tenant. Refresh skips them until the access is added.`,
  needsNotConnected: (services: readonly string[]) => `Needs ${joinTitles(services)}, not connected.`,
  needsNotConnectedBody: (tenant: string) =>
    `Runs against ${tenant} are blocked until the service is added.`,
  consentNoteGeneric:
    "Runs are blocked while a service this agent needs is not connected for the tenant. Scopes a connected service has not granted yet are requested when the run starts.",
  consentNoteBlocked: (services: readonly string[], tenant: string) =>
    `Runs are blocked until ${joinTitles(services)} ${services.length === 1 ? "is" : "are"} connected for ${tenant}. Add ${services.length === 1 ? "it" : "them"} in Settings, Tenants.`,
  consentNotePending: (tenant: string) =>
    `Scopes not yet granted for ${tenant} are requested when the run starts.`,
  consentNoteGranted: (tenant: string) => `Every scope listed here is granted for ${tenant}.`,
  consentNotePilot: "Pilot mode uses the sample tenant, so no consent is requested.",
};


/** The two onboarding steps on first launch: a model, then Microsoft 365 (SPEC.md 4a, first launch). */
export const ONBOARDING_COPY = {
  stepsLabel: "Setup steps",
  steps: ["Model", "Microsoft 365"] as const,
  done: "done",
} as const;

/** The second onboarding step, Connect Microsoft 365 (mockup 32, section B). */
export const MICROSOFT_STEP_COPY = {
  title: "Connect Microsoft 365",
  body: "Pick the services you manage. OpenAdminOS asks Microsoft for read-only access to those, and nothing else.",
  servicesLabel: "Services you manage",
  noneYet: "Pick a service to see the read-only permissions it needs.",
  signIn: "Sign in with Microsoft",
  ownRegistration: "Use our own app registration",
  askAdmin: "Ask an admin to approve",
  notNow: "Not now",
  notNowNote: "Chat works without it. A question about your own devices or users asks you to connect first.",
  nodeOff: "Not connected",
  nodePicked: "Selected",
  nodeConnected: "Connected",
  connected: "Connected",
  partial: (title: string) => `${title}, partly`,
  connectedTitle: (organization: string) => `${organization} is connected`,
  connectedBody: "Chat answers from these services with the read-only permissions you approved. Writes always ask you first.",
  openChat: "Open Chat",
  signedInAs: (username: string) => `Signed in as ${username}.`,
  enterpriseApp: (organization: string, clientId: string) =>
    `The enterprise application OpenAdminOS (app ID ${clientId}) is now in ${organization}, with read-only delegated permissions. Find it in Entra admin center under Enterprise applications.`,
  ownApp: (clientId: string) => `Signed in with your app registration ${clientId}.`,
  announceConnected: (organization: string, services: string) => `${organization} is connected: ${services}.`,
  reopen: "Set up Microsoft 365",
} as const;
