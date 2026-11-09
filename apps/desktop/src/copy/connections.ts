/**
 * Organization switcher and Connections page copy. An organization is the
 * company an admin manages; it holds at most one Microsoft 365 tenant.
 */
export const ORGANIZATION_COPY = {
  noOrganization: "No organization",
  menuLabel: "Organizations",
  menuHeading: "Organizations",
  /** The filter shown first in the switcher once there are this many organizations. */
  findOrganization: "Find an organization",
  noMatch: (query: string) => `No organization matches ${query}.`,
  matchCount: (count: number) => (count === 1 ? "1 organization matches." : `${count} organizations match.`),
  /** One line per organization: its services in words, and its own app registration. */
  servicesLine: (titles: readonly string[], ownRegistration: boolean) =>
    `${titles.length > 0 ? titles.join(", ") : "No services connected"}${ownRegistration ? ". Own app registration" : ""}`,
  noOrganizationDetail: "Chat answers from the docs and references",
  sampleLabel: "Sample data",
  sampleDetail: "Fictional company, no Microsoft sign-in",
  none: "No organizations yet.",
  noneDetail: "Chat answers from the docs and public references. Agents that read a service wait.",
  addOrganization: "Add organization",
  previewSample: "Preview with sample data",
  manageConnections: "Manage connections",
  chipLabel: (name: string) => `Switch organization, ${name}`,
  chipLabelNone: (hasOrganizations: boolean) =>
    hasOrganizations ? "Choose an organization" : "Add an organization",
  tooltipNone: (hasOrganizations: boolean) =>
    hasOrganizations
      ? "No organization is active. Agents that read a service cannot start. Choose an organization."
      : "No organization yet. Connect Microsoft 365 to add one.",
  tooltipSample: "Sample organization. Fictional company data. No Microsoft sign-in.",
  tooltipActive: (name: string, username: string) => `${name}. Signed in to Microsoft 365 as ${username}.`,
  servicesLabel: (titles: readonly string[]) =>
    titles.length > 0 ? `Services: ${titles.join(", ")}` : "No services connected",
  switchFailed: (detail: string) =>
    `Switching organizations failed.${detail ? ` ${detail}` : ""} Try again from the organization menu.`,
  sampleFailed: (detail: string) =>
    `Sample data did not open.${detail ? ` ${detail}` : ""} Try again from the organization menu.`,
  disconnectTitle: (name: string) => `Disconnect Microsoft 365 from ${name}`,
  disconnectBody:
    "This removes the Microsoft sign-in connection and the organization, and permanently deletes its local Graph cache, change history, chats, workspaces, run history, learning records and queued deliveries from this device. Its schedules stay on their agents, unassigned, until you assign them to another organization.",
  disconnectNote: "Microsoft 365 data in the tenant is not changed. Connecting the tenant again creates the organization again with an empty local cache.",
  disconnectAction: "Disconnect and delete local data",
  /** What disconnecting deletes from this device, named one by one. */
  disconnectDeletes: (runCount: number) => [
    "Microsoft sign-in tokens for this organization",
    "Its Graph cache and change history",
    `Its run history (${runCount} ${runCount === 1 ? "run" : "runs"}) and queued report deliveries`,
    "Its chats, workspaces and learning records",
    "Its Agent Team missions, assignments and memory",
    "Multi-tenant chats and jobs that include it, deleted whole, with the results for the other organizations in them",
  ],
  disconnectAuditKept: "Configuration audit entries, including this disconnect, are kept.",
  disconnectNoOrganizationAfter: "No organization will be active afterwards.",
  disconnectSubtitle: (domain: string, username: string) => `${domain}, signed in as ${username}`,
  disconnectDeletesTitle: "Deleted from this device",
  disconnectKeepsTitle: "Stays in Microsoft Entra",
  disconnectKeepsBody:
    "The OpenAdminOS enterprise application and the admin consent granted to it stay in the tenant. Disconnecting here does not revoke them. Other admins in the tenant who use OpenAdminOS rely on the same enterprise application.",
  /** An organization connected with the admin's own app registration names that registration. */
  disconnectKeepsOwn: (label: string, clientId: string) =>
    `Your app registration ${label} (client ID ${clientId}) and the admin consent granted to it stay in the tenant. Disconnecting here does not revoke them.`,
  disconnectRevokeLink: "How to revoke access in Entra",
  disconnectRevokeUrl: "https://docs.openadminos.com/trust-model/authentication#disconnecting-and-revoking",
  disconnectRevokeOwnUrl: "https://docs.openadminos.com/trust-model/authentication#revoking-your-own-app-registration",
  disconnectSchedules: "Its schedules stay on their agents, unassigned, until you assign them to another organization.",
  disconnectConfirmLocal: (name: string) => `Delete ${name}'s local data from this device`,
  disconnected: (name: string) => `${name} disconnected. Its local data was deleted from this device.`,
  disconnectFailed: (detail: string) =>
    `Disconnecting failed.${detail ? ` ${detail}` : ""} Restart OpenAdminOS, check that secure storage is available, then try again.`,
  renameLabel: "Organization name",
  renameAction: "Rename",
  renameSave: "Save name",
  renamed: "Organization renamed.",
  renameFailed: (detail: string) => `The name was not saved.${detail ? ` ${detail}` : ""} Try again.`,
  sampleKeepsName: "The sample organization keeps its name.",
} as const;

export const CONNECTIONS_COPY = {
  pageTitle: "Connections",
  title: (name: string) => `${name} connections`,
  lede: "What Chat and agents can read for this organization, and everything that leaves this device.",
  ledeNone: "What Chat and agents can read, and everything that leaves this device.",
  emptyTitle: "No organization connected",
  emptyBody:
    "Chat answers from the model and public references. Connect Microsoft 365 to read Intune, Entra and Defender for an organization.",
  leavesNowHeading: "Leaves this device now",
  reportsNowHeading: "Run reports and agent messages",
  changeModel: "Change model",
  references: "References",
  sampleOrganization:
    "This is the sample organization: a fictional company with built-in data and no Microsoft sign-in. Connect Microsoft 365 to add your own organization. The sample organization is removed after the first real connection.",
  map: {
    label: "Where data goes",
    readFrom: "Reads from",
    device: "This device",
    deviceStays: "History, cache and sign-in tokens stay here",
    deviceSample: "Sample data and history stay here",
    leaves: "Leaves this device",
    questionWords: "Words from questions",
    noReferences: "Nowhere, no public reference is on",
    reports: "Run reports, by delivery rule or agent step",
    noReports: "Nowhere, no saved rule or step sends to a connector",
    reportsLoading: "Checking result connectors",
    reportsLoadingSentence: "Where run reports go is being checked.",
    reportsFailed: "Result connectors could not be checked",
    reportsFailedSentence: "Where run reports go could not be checked. Open Results go to below and try again.",
    prompts: "Prompts and tenant data",
    /** With no organization nothing from a tenant is read, so only prompts leave. */
    promptsNoOrganization: "Prompts and agent context",
    promptsLocal: "Nowhere, the model is local",
    promptsNoModel: "Nowhere, no model is ready",
    promptsSample: "Nowhere, sample answers are prepared",
    noServices: "No service connected",
    modelLocal: (model: string) => `${model}, local`,
    modelHosted: (model: string) => `${model}, hosted`,
    modelNone: "No model ready",
    modelSample: "Prepared sample answers, no model",
    partsSummary: (granted: number, total: number) => `${granted} of ${total} parts`,
    /** Nova voice with a hosted voice model, the same fact the status strip shows as "Voice · OpenAI". */
    voice: "Nova voice audio, shared context and web searches",
    voiceDestination: (location: string) => `${location}, while Nova voice is active`,
  },
  servicesHeading: "Services",
  servicesBody: "Each service is consented on its own. Agents and Chat use only what is connected here.",
  microsoft365: "Microsoft 365",
  connectMicrosoft365: "Connect Microsoft 365",
  otherServicesHeading: "Other services",
  otherServicesBody: "Each one has its own sign-in and is stored for this organization only.",
  addService: "Add a service",
  addServiceBody: "Services from vendors appear in the Marketplace when they ship.",
  openMarketplace: "Open Marketplace",
  referencesHeading: "Public references",
  referencesBody: "No sign-in. Used by Chat in every organization. Words from questions go to the host shown.",
  referencesEmpty: "No public reference is added. Add one from the Marketplace. Until you do, Chat sends no words from your questions to a reference host.",
  referenceOn: "On",
  referenceOff: "Off",
  referenceTurnOn: "Turn on",
  referenceTurnOff: "Turn off",
  referenceUnavailable: "Not used, a tool is missing",
  referenceToolsOff: "Not used, the model does not support tools",
  referenceToggleFailed: (name: string, detail: string) =>
    `${name} was not changed.${detail ? ` ${detail}` : ""} Try again.`,
  resultsHeading: "Results go to",
  resultsSent: (names: readonly string[]) =>
    `Run reports and agent messages can leave this device to ${names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}. A connection test is not required for that: saved credentials are used when a report is sent.`,
  resultsNone: "No run report or agent message leaves this device: no saved delivery rule or agent step sends to a connector.",
  resultsUnset: (names: readonly string[]) =>
    `Saved delivery rules use ${names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}, which ${names.length === 1 ? "has" : "have"} no destination set, so nothing is sent there. Set one below.`,
  resultsBody:
    "Where agents send finished run reports. Saved delivery rules post automatically, including for scheduled runs; agent steps that send a message show a preview first.",
  viewsLabel: "Connections views",
  organizationsTab: "Organizations",
  organizationsEmpty: "No organizations on this device yet. Connect Microsoft 365 to add one.",
  organizationsHeading: "Organizations on this device",
  organizationsBody: "Each organization keeps its runs, conversations, cache, drift and schedules apart.",
  active: "Active",
  makeActive: "Make active",
  savedRegistrationsHeading: "Saved app registrations",
  manage: "Manage",
  manageMicrosoft365: "Manage Microsoft 365",
  permissions: "Permissions",
  permissionsTitle: (organization: string) => `Permissions for ${organization}`,
  permissionGranted: "Granted",
  permissionNotGranted: "Not granted",
  permissionsHint: "Add a part that is not granted with Add access on its service row. Microsoft 365 data is only read through granted permissions.",
  renameOrganization: "Rename organization",
  disconnect: "Disconnect",
  licenses: (names: readonly string[]) => `Licenses: ${names.join(", ")}`,
  noLicenseDetails: "No license details",
  connect: "Connect",
  addPart: (title: string) => `Add ${title}`,
} as const;

/** Schedules belong to one organization and run only while it is active. */
export const SCHEDULE_ORGANIZATION_COPY = {
  backgroundOff: "Background runs are off. Schedules run only while OpenAdminOS is open.",
  backgroundFailed: (detail: string) => `Background runs were not turned on. ${detail} Try again from Settings, General.`,
  pausedSample:
    "Schedules are paused while the sample organization is active. Switch to one of your organizations to resume.",
  pausedNone:
    "Schedules are paused while no organization is active. Choose an organization to resume its schedules.",
  waiting: (unassigned: number, elsewhere: number) =>
    [
      unassigned > 0
        ? `${unassigned} ${unassigned === 1 ? "schedule is" : "schedules are"} unassigned and paused. Assign ${unassigned === 1 ? "it" : "each one"} to an organization on the agent page.`
        : "",
      elsewhere > 0
        ? `${elsewhere} ${elsewhere === 1 ? "schedule belongs" : "schedules belong"} to another organization and ${elsewhere === 1 ? "runs" : "run"} only while that organization is active.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  migrated: (
    notice: { assignedCount: number; unassignedCount: number; unassignedReason?: "no-active-tenant" | "pilot-active" },
    organizationName: string | undefined,
  ) =>
    [
      notice.assignedCount > 0
        ? `Schedules now belong to organizations. ${notice.assignedCount} ${notice.assignedCount === 1 ? "schedule moved" : "schedules moved"} to ${organizationName ?? "the organization that was active"} and ${notice.assignedCount === 1 ? "runs" : "run"} only while it is active.`
        : "Schedules now belong to organizations.",
      notice.unassignedCount > 0
        ? `${notice.unassignedCount} ${notice.unassignedCount === 1 ? "schedule stays" : "schedules stay"} paused and unassigned because ${notice.unassignedReason === "pilot-active" ? "the sample organization was active" : "no organization was active"}. Assign each one on its agent page.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  dismiss: "Dismiss",
  failed: (detail: string) => `That did not work.${detail ? ` ${detail}` : ""} Try again.`,
  rowLabel: "Organization",
  runsIn: (name: string) => `Runs only while ${name} is active.`,
  unassigned: "Unassigned. This schedule is paused until you assign it to an organization.",
  assignLabel: "Assign to organization",
  assignAction: "Assign",
  assigned: (name: string) => `Schedule assigned to ${name}.`,
  noOrganizations: "Connect an organization to assign this schedule. Schedules never run in the sample organization.",
} as const;

/** Run again for a run from an organization that is not active. */
export const RERUN_COPY = {
  title: (organization: string | undefined) =>
    organization ? `This run was in ${organization}` : "This run's organization is not on this device",
  body: (organization: string | undefined, active: string | undefined, ordinary: boolean) => {
    const where = organization
      ? `${organization} is not the active organization. An agent runs only in the active organization.`
      : "The organization this run was in has been removed from this device.";
    if (!ordinary) {
      return organization
        ? `${where} Switch to ${organization} to continue this run there.`
        : `${where} Open the agent to plan a new run in the active organization.`;
    }
    return active
      ? `${where} Switch to ${organization ?? "it"} to run it there, or run it in ${active} after reviewing the run.`
      : `${where} Switch to ${organization ?? "an organization"} to run it there.`;
  },
  switchTo: (organization: string) => `Switch to ${organization}`,
  planElsewhereTitle: (organization: string) => `This plan was prepared in ${organization}`,
  planElsewhereBody: (organization: string) =>
    `${organization} is not the active organization, so the plan cannot be applied now. The plan is kept unchanged. Switch to ${organization} to review and apply it.`,
  rerunNotContinued:
    "Run again did not continue: the run page closed before the organization switch finished. Open the run and choose Run again.",
  planNoOrganizationTitle: "This plan has no organization",
  planNoOrganizationBody:
    "It was prepared with no organization active, so it cannot be applied. The plan is kept unchanged. Run the agent again in an organization to prepare a plan you can apply.",
  runInActive: (organization: string) => `Run in ${organization}`,
} as const;
