// Compact Conditional Access policy records for model prompts. A Graph
// policy object carries many null fields, OData annotations and the full
// authentication strength definition; a review needs only the scope, the
// conditions and the controls. Group, user and named location ids cannot be
// resolved by the model, so they become counts. Built-in role template ids
// become role names.

const DAY_MS = 86_400_000;

/** Directory role template ids, verified against GET /directoryRoleTemplates. */
const ROLE_NAMES: Record<string, string> = {
  "62e90394-69f5-4237-9190-012177145e10": "Global Administrator",
  "e8611ab8-c189-46e8-94e1-60213ab1f814": "Privileged Role Administrator",
  "7be44c8a-adaf-4e2a-84d6-ab2649e08a13": "Privileged Authentication Administrator",
  "194ae4cb-b126-40b2-bd5b-6091b380977d": "Security Administrator",
  "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9": "Conditional Access Administrator",
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3": "Application Administrator",
  "158c047a-c907-4556-b7ef-446551a6b5f7": "Cloud Application Administrator",
  "c4e39bd9-1100-46d3-8c65-fb160da0071f": "Authentication Administrator",
  "29232cdf-9323-42fd-ade2-1d097af3e4de": "Exchange Administrator",
  "f28a1f50-f6e7-4571-818b-6a12f2af6b6c": "SharePoint Administrator",
  "fe930be7-5e62-47db-91af-98c3a49a38b1": "User Administrator",
  "729827e3-9c14-49f7-bb1b-9608f156bbb8": "Helpdesk Administrator",
  "966707d0-3269-4727-9be2-8c3a10f19b9d": "Password Administrator",
  "b0f54661-2d74-4c50-afa3-1ec803f12efe": "Billing Administrator",
  "3a2c62db-5318-420d-8d74-23affee5d9d5": "Intune Administrator",
  "7698a772-787b-4ac8-901f-60d6b08affd2": "Cloud Device Administrator",
  "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2": "Hybrid Identity Administrator",
  "69091246-20e8-4a56-aa4d-066075b2a7a8": "Teams Administrator",
  "17315797-102d-40b4-93e0-432062caca18": "Compliance Administrator",
  "e6d1a23a-da11-4be4-9570-befc86d067a7": "Compliance Data Administrator",
  "11648597-926c-4cf3-9c36-bcebb0ba8dcc": "Power Platform Administrator",
  "892c5842-a9a6-463a-8041-72aa08ca3cf6": "Cloud App Security Administrator",
  "0526716b-113d-4c15-b2c8-68e3c22b9f80": "Authentication Policy Administrator",
  "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f": "Security Operator",
  "5d6b6bb7-de71-4623-b4af-96380a352509": "Security Reader",
  "f2ef992c-3afb-46b9-b7cf-a126ee74c451": "Global Reader",
  "d29b2b05-8046-44ba-8758-1e26182fcf32": "Directory Synchronization Accounts",
  "a92aed5d-d78a-4d16-b381-09adb37eb3b0": "On Premises Directory Sync Account",
};

/** First-party application ids that CA policies commonly target, verified against GET /servicePrincipals. */
const APP_NAMES: Record<string, string> = {
  "797f4846-ba00-4fd7-ba43-dac1f8f63013": "Azure Resource Manager (Azure management)",
  "0000000a-0000-0000-c000-000000000000": "Microsoft Intune",
  "d4ebce55-015a-49b5-a083-c84d1797ae8c": "Microsoft Intune Enrollment",
  "00000002-0000-0ff1-ce00-000000000000": "Office 365 Exchange Online",
  "00000003-0000-0ff1-ce00-000000000000": "Office 365 SharePoint Online",
};

/** Special values Graph uses in include and exclude lists. */
const KEYWORDS = new Set(["All", "None", "GuestsOrExternalUsers", "Office365", "MicrosoftAdminPortals", "AllTrusted", "ServicePrincipalsInMyTenant"]);

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];

function summarizeIds(ids: string[], names: Record<string, string>, unit: string): string[] {
  const out: string[] = [];
  let unnamed = 0;
  for (const id of ids) {
    if (KEYWORDS.has(id)) out.push(id);
    else if (names[id.toLowerCase()]) out.push(names[id.toLowerCase()]!);
    else unnamed += 1;
  }
  if (unnamed > 0) out.push(`${unnamed} ${unit}${unnamed === 1 ? "" : "s"}`);
  return out;
}

function summarizeRoles(ids: string[]): string[] {
  const out: string[] = [];
  let unnamed = 0;
  for (const id of ids) {
    const name = ROLE_NAMES[id.toLowerCase()];
    if (name) out.push(name);
    else unnamed += 1;
  }
  // Built-in or custom: the id alone cannot tell, so say neither.
  if (unnamed > 0) out.push(`${unnamed} other role${unnamed === 1 ? "" : "s"}`);
  return out;
}

function guestTypes(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const types = typeof record.guestOrExternalUserTypes === "string" ? record.guestOrExternalUserTypes : "";
  const tenants = asRecord(record.externalTenants);
  const scope = tenants?.membershipKind === "enumerated"
    ? `${asStrings(tenants.members).length} listed tenants`
    : tenants?.membershipKind === "all" ? "all tenants" : undefined;
  return [types || "guests", scope].filter(Boolean).join(" from ");
}

function compactUsers(users: Json | undefined): Json {
  const side = (prefix: "include" | "exclude") => {
    const out: Json = {};
    const named = summarizeIds(asStrings(users?.[`${prefix}Users`]), {}, "user");
    if (named.length) out.users = named.join(", ");
    const groups = asStrings(users?.[`${prefix}Groups`]).length;
    if (groups) out.groups = groups;
    const roles = summarizeRoles(asStrings(users?.[`${prefix}Roles`]));
    if (roles.length) out.roles = roles;
    const guests = guestTypes(users?.[`${prefix}GuestsOrExternalUsers`]);
    if (guests) out.guests = guests;
    return out;
  };
  const include = side("include");
  const exclude = side("exclude");
  return { include, ...(Object.keys(exclude).length ? { exclude } : {}) };
}

function compactApplications(apps: Json | undefined): Json | undefined {
  if (!apps) return undefined;
  const out: Json = {};
  const include = summarizeIds(asStrings(apps.includeApplications), APP_NAMES, "app");
  if (include.length) out.include = include.join(", ");
  const exclude = summarizeIds(asStrings(apps.excludeApplications), APP_NAMES, "app");
  if (exclude.length) out.exclude = exclude.join(", ");
  const actions = asStrings(apps.includeUserActions);
  if (actions.length) out.userActions = actions.map((action) => action.replace(/^urn:user:/, ""));
  const agentActions = asStrings(apps.includeAgentActions);
  if (agentActions.length) out.agentActions = agentActions.length;
  const contexts = asStrings(apps.includeAuthenticationContextClassReferences);
  if (contexts.length) out.authContexts = contexts.length;
  const filter = asRecord(apps.applicationFilter);
  if (filter && typeof filter.mode === "string") out.appFilter = filter.mode;
  return Object.keys(out).length ? out : undefined;
}

function compactIncludeExclude(value: unknown, include: string, exclude: string, unit: string): Json | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Json = {};
  const inc = summarizeIds(asStrings(record[include]), {}, unit);
  if (inc.length) out.include = inc.join(", ");
  const exc = summarizeIds(asStrings(record[exclude]), {}, unit);
  if (exc.length) out.exclude = exc.join(", ");
  return Object.keys(out).length ? out : undefined;
}

function compactPlatforms(value: unknown): Json | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Json = {};
  const include = asStrings(record.includePlatforms);
  if (include.length) out.include = include.join(", ");
  const exclude = asStrings(record.excludePlatforms);
  if (exclude.length) out.exclude = exclude.join(", ");
  return Object.keys(out).length ? out : undefined;
}

function compactGrant(value: unknown): Json | undefined {
  const grant = asRecord(value);
  if (!grant) return undefined;
  const out: Json = {};
  const controls = asStrings(grant.builtInControls);
  if (controls.length) out.controls = controls;
  const strength = asRecord(grant.authenticationStrength);
  if (strength && typeof strength.displayName === "string") {
    // The name alone can mislead (a custom "Admin MFA" may satisfy none), so
    // keep what it satisfies and whether it is built in.
    out.authStrength = {
      name: strength.displayName,
      ...(typeof strength.policyType === "string" ? { type: strength.policyType } : {}),
      ...(typeof strength.requirementsSatisfied === "string" ? { satisfies: strength.requirementsSatisfied } : {}),
    };
  }
  const terms = asStrings(grant.termsOfUse).length;
  if (terms) out.termsOfUse = terms;
  const custom = asStrings(grant.customAuthenticationFactors);
  if (custom.length) out.customFactors = custom.length;
  // With more than one requirement, OR means any one of them satisfies the
  // policy: MFA plus terms of use under OR does not make MFA mandatory.
  const requirements = controls.length + (out.authStrength ? 1 : 0) + terms + custom.length;
  if (typeof grant.operator === "string" && requirements > 1) out.operator = grant.operator;
  return Object.keys(out).length ? out : undefined;
}

function compactSession(value: unknown): string[] | undefined {
  const session = asRecord(value);
  if (!session) return undefined;
  const out: string[] = [];
  const enabled = (key: string) => {
    const entry = asRecord(session[key]);
    return entry && entry.isEnabled !== false ? entry : undefined;
  };
  if (enabled("applicationEnforcedRestrictions")) out.push("app enforced restrictions");
  const mcas = enabled("cloudAppSecurity");
  if (mcas) out.push(`app control ${String(mcas.cloudAppSecurityType ?? "on")}`);
  const frequency = enabled("signInFrequency");
  if (frequency) {
    out.push(frequency.frequencyInterval === "everyTime"
      ? "sign-in frequency every time"
      : `sign-in frequency ${String(frequency.value ?? "?")} ${String(frequency.type ?? "")}`.trim());
  }
  const browser = enabled("persistentBrowser");
  if (browser) out.push(`persistent browser ${String(browser.mode ?? "on")}`);
  const cae = asRecord(session.continuousAccessEvaluation);
  if (cae && typeof cae.mode === "string") out.push(`CAE ${cae.mode}`);
  if (session.disableResilienceDefaults === true) out.push("resilience defaults off");
  if (enabled("secureSignInSession")) out.push("token protection");
  const gsa = asRecord(session.globalSecureAccessFilteringProfile);
  if (gsa && gsa.isEnabled !== false && Object.keys(gsa).length) out.push("Global Secure Access profile");
  return out.length ? out : undefined;
}

const RENDERED_CONDITIONS = new Set([
  "users", "applications", "clientAppTypes", "platforms", "locations", "signInRiskLevels", "userRiskLevels",
  "servicePrincipalRiskLevels", "insiderRiskLevels", "devices", "authenticationFlows", "clientApplications",
]);

function isSet(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value as Json).some(isSet);
  return true;
}

/** Workload identity scope: service principals and agent identities as counts. */
function compactClientApplications(value: unknown): Json | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Json = {};
  const side = (key: string) => summarizeIds(asStrings(record[key]), {}, "service principal");
  const include = [...side("includeServicePrincipals"), ...summarizeIds(asStrings(record.includeAgentIdServicePrincipals), {}, "agent identity")];
  if (include.length) out.include = include.join(", ");
  const exclude = [...side("excludeServicePrincipals"), ...summarizeIds(asStrings(record.excludeAgentIdServicePrincipals), {}, "agent identity")];
  if (exclude.length) out.exclude = exclude.join(", ");
  for (const key of ["servicePrincipalFilter", "agentIdServicePrincipalFilter"]) {
    const filter = asRecord(record[key]);
    if (filter && typeof filter.mode === "string") out[key === "servicePrincipalFilter" ? "filter" : "agentFilter"] = filter.mode;
  }
  return Object.keys(out).length ? out : undefined;
}

function ageDays(policy: Json, now: number): number | undefined {
  for (const field of ["modifiedDateTime", "createdDateTime"]) {
    const raw = policy[field];
    if (typeof raw !== "string") continue;
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return Math.max(0, Math.floor((now - ms) / DAY_MS));
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** One short record per policy, with empty fields left out. */
export function compactConditionalAccessPolicy(policy: unknown, now = Date.now()): Json {
  const record = asRecord(policy) ?? {};
  const conditions = asRecord(record.conditions) ?? {};
  const out: Json = {
    name: typeof record.displayName === "string" ? record.displayName : "(unnamed policy)",
    state: typeof record.state === "string" ? record.state : "unknown",
  };
  const age = ageDays(record, now);
  if (age !== undefined) out.modifiedDaysAgo = age;
  const users = compactUsers(asRecord(conditions.users));
  // A workload identity policy has no user scope; an empty one would read as
  // "no users" next to the service principals it really targets.
  if (Object.keys(users.include as Json).length || users.exclude) out.users = users;
  const apps = compactApplications(asRecord(conditions.applications));
  if (apps) out.apps = apps;
  const clientAppTypes = asStrings(conditions.clientAppTypes).filter((type) => type !== "all");
  if (clientAppTypes.length) out.clientAppTypes = clientAppTypes;
  const platforms = compactPlatforms(conditions.platforms);
  if (platforms) out.platforms = platforms;
  const locations = compactIncludeExclude(conditions.locations, "includeLocations", "excludeLocations", "named location");
  if (locations) out.locations = locations;
  const signInRisk = asStrings(conditions.signInRiskLevels);
  if (signInRisk.length) out.signInRisk = signInRisk;
  const userRisk = asStrings(conditions.userRiskLevels);
  if (userRisk.length) out.userRisk = userRisk;
  const servicePrincipalRisk = asStrings(conditions.servicePrincipalRiskLevels);
  if (servicePrincipalRisk.length) out.servicePrincipalRisk = servicePrincipalRisk;
  const deviceFilter = asRecord(asRecord(conditions.devices)?.deviceFilter);
  if (deviceFilter && typeof deviceFilter.mode === "string") {
    out.deviceFilter = typeof deviceFilter.rule === "string"
      ? `${deviceFilter.mode}: ${truncate(deviceFilter.rule, 160)}`
      : deviceFilter.mode;
  }
  const flows = asRecord(conditions.authenticationFlows);
  if (flows && typeof flows.transferMethods === "string") out.authFlows = flows.transferMethods;
  const workloads = compactClientApplications(conditions.clientApplications);
  if (workloads) out.workloadIdentities = workloads;
  const insiderRisk = typeof conditions.insiderRiskLevels === "string"
    ? conditions.insiderRiskLevels.split(",").map((level) => level.trim()).filter(Boolean)
    : asStrings(conditions.insiderRiskLevels);
  if (insiderRisk.length) out.insiderRisk = insiderRisk;
  // Any other condition that is set still narrows the policy; name it so the
  // review does not read the policy as broader than it is.
  const other = Object.entries(conditions)
    .filter(([key, value]) => !RENDERED_CONDITIONS.has(key) && isSet(value))
    .map(([key]) => key);
  if (other.length) out.otherConditions = other;
  const grant = compactGrant(record.grantControls);
  if (grant) out.grant = grant;
  const session = compactSession(record.sessionControls);
  if (session) out.session = session;
  return out;
}

export function compactConditionalAccessPolicies(policies: unknown[], now = Date.now()): Json[] {
  return policies.map((policy) => compactConditionalAccessPolicy(policy, now));
}
