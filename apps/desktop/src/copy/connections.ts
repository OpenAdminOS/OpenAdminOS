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
    reports: "Run reports, by delivery rule",
    noReports: "Nowhere, no delivery rule is saved",
    prompts: "Prompts and tenant data",
    promptsLocal: "Nowhere, the model is local",
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
