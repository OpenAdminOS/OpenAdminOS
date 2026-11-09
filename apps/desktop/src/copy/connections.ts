/**
 * Organization switcher and Connections page copy. An organization is the
 * company an admin manages; it holds at most one Microsoft 365 tenant.
 */
export const ORGANIZATION_COPY = {
  noOrganization: "No organization",
  menuLabel: "Organizations",
  menuHeading: "Organizations",
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
  noOrganization:
    "No organization is active. Chat answers from the docs and public references; agents that read a service cannot start. Connect Microsoft 365 to add an organization, or choose one from the organization menu.",
  sampleOrganization:
    "This is the sample organization: a fictional company with built-in data and no Microsoft sign-in. Connect Microsoft 365 to add your own organization. The sample organization is removed after the first real connection.",
  map: {
    label: "Where data goes",
    readFrom: "Read from your services",
    tenantData: "Tenant data",
    device: "This device",
    deviceHistory: "Chat history and cache",
    deviceTokens: "Sign-in tokens, encrypted",
    deviceSample: "Sample data, stored on this device",
    sentOut: "Sent out",
    leaves: "Leaves this device",
    questionWords: "Words from your questions",
    noReferences: "Nowhere, no public reference is on",
    reports: "Run reports, by delivery rule or agent step",
    noReports: "Nowhere, no rule or step uses a connector that is set up",
    reportsLoading: "Checking result connectors",
    reportsLoadingSentence: "Where run reports go is being checked.",
    reportsFailed: "Result connectors could not be checked",
    reportsFailedSentence: "Where run reports go could not be checked. Open Results go to below and try again.",
    prompts: "Prompts and tenant data",
    /** With no organization nothing from a tenant is read, so only prompts leave. */
    promptsNoOrganization: "Prompts and agent context",
    promptsLocal: "Nowhere, the model is local",
    /**
     * The region of a hosted provider. No provider reports it to
     * OpenAdminOS today, and the map never guesses one.
     * TODO(ugur): show the region itself once providers carry one, for
     * example "Anthropic API · US".
     */
    hostedRegion: (_provider: string) => "Region not reported to OpenAdminOS",
    promptsNoModel: "Nowhere, no model is ready",
    promptsSample: "Nowhere, sample answers are prepared",
    noServices: "No service connected",
    modelLocal: (model: string) => `${model}, local`,
    modelHosted: (model: string) => `${model}, hosted`,
    modelNone: "No model ready",
    modelSample: "Prepared sample answers, no model",
    partsSummary: (granted: number, total: number) => `${granted} of ${total} parts`,
  },
  servicesHeading: "Services",
  servicesBody: "Each service is consented on its own. Agents and Chat use only what is connected here.",
  microsoft365: "Microsoft 365",
  microsoft365NotConnected: "Not connected. Connecting creates an organization named after the tenant.",
  connectMicrosoft365: "Connect Microsoft 365",
  otherServicesHeading: "Other services",
  otherServicesBody: "Each one has its own sign-in and is stored for this organization only.",
  addService: "Add a service",
  addServiceBody: "Services from vendors appear in the Marketplace when they ship.",
  openMarketplace: "Open Marketplace",
  referencesHeading: "Public references",
  referencesBody: "No sign-in. Used by Chat in every organization. Words from questions go to the host shown.",
  referencesEmpty: "No public reference is added. Add one from the Marketplace; with a local model nothing leaves this device until you do.",
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
    `Run reports and agent messages leave this device to ${names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}.`,
  resultsNone: "No run report or agent message leaves this device: no saved delivery rule or agent step uses a connector that is set up.",
  resultsUnset: (names: readonly string[]) =>
    `Saved delivery rules or agent steps use ${names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}, which ${names.length === 1 ? "is" : "are"} not set up, so nothing is sent there. Set ${names.length === 1 ? "it" : "them"} up below.`,
  resultsBody:
    "Where agents send finished run reports. Saved delivery rules post automatically, including for scheduled runs; agent steps that send a message show a preview first.",
  organizationsHeading: "Organizations on this device",
  organizationsBody: "Each organization keeps its runs, conversations, cache, drift and schedules apart.",
  active: "Active",
  makeActive: "Make active",
  savedRegistrationsHeading: "Saved app registrations",
  partsMissing: (labels: readonly string[]) => `${labels.join(", ")} not connected`,
  manage: "Manage",
  connect: "Connect",
  addPart: (title: string) => `Add ${title}`,
} as const;

/** Schedules belong to one organization and run only while it is active. */
export const SCHEDULE_ORGANIZATION_COPY = {
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
  runInActive: (organization: string) => `Run in ${organization}`,
} as const;
