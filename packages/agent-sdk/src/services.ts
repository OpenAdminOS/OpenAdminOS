import type { GraphCacheResourceKind } from "./index.js";

/**
 * Services are the unit an admin connects: Intune, Entra, Defender, and
 * later Exchange, Teams and SharePoint. Each service is split into parts,
 * and a part is the smallest set of delegated scopes that can be granted
 * or added on its own. This registry is the only source for services,
 * parts, scopes, reasons, audiences, cache resources, roles and licences.
 */
export type ServiceId =
  | "intune"
  | "entra"
  | "defender"
  | "exchange"
  | "teams"
  | "sharepoint";

/**
 * The token audience a scope belongs to. Only Microsoft Graph exists
 * today; Exchange and SharePoint resources widen this later.
 */
export type ScopeAudience = "graph";

export interface ServiceScope {
  audience: ScopeAudience;
  name: string;
  /** Why OpenAdminOS asks for this scope, shown before consent. */
  reason: string;
  /** Delegated permission ID on the audience's service principal. */
  permissionId: string;
}

/**
 * A scope an agent may declare at run time without it ever being requested
 * at connect: write scopes and broad reads such as `Directory.Read.All`.
 */
export interface AgentOnlyScope {
  audience: ScopeAudience;
  name: string;
  reason: string;
}

export interface ServicePart {
  /** `<service>.<part>`, for example `intune.devices`. */
  id: string;
  service: ServiceId;
  title: string;
  summary: string;
  scopes: readonly ServiceScope[];
  cacheResources: readonly GraphCacheResourceKind[];
  /** Chat questions this part lets OpenAdminOS answer. */
  chatExamples: readonly string[];
  /** Documented only. A planned part is never requested. */
  planned?: true;
}

export interface ServiceRole {
  name: string;
  why: string;
}

export interface ServiceDefinition {
  id: ServiceId;
  title: string;
  summary: string;
  status: "available" | "planned";
  parts: readonly ServicePart[];
  /** Least-privilege Entra or service roles for the signed-in admin. */
  roles: readonly ServiceRole[];
  licences: readonly string[];
  agentOnlyScopes: readonly AgentOnlyScope[];
}

export const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

/**
 * Delegated Microsoft Graph permission IDs, checked with Lokka against
 * the Microsoft Graph service principal on 2026-11-04 (tasks/todo.md,
 * "Lokka verification"). Setup scripts still resolve IDs at run time.
 */
export const GRAPH_DELEGATED_PERMISSION_IDS: Readonly<Record<string, string>> = {
  openid: "37f7f235-527c-4136-accd-4a02d197296e",
  profile: "14dad69e-099b-42c9-810b-d002981feec1",
  offline_access: "7427e0e9-2fba-42fe-b0c0-848c9e6a8182",
  "User.Read": "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
  "DeviceManagementManagedDevices.Read.All": "314874da-47d6-4978-88dc-cf0d37f0bb82",
  "DeviceManagementConfiguration.Read.All": "f1493658-876a-4c87-8fa7-edb559b3476a",
  "DeviceManagementApps.Read.All": "4edf5f54-4666-44af-9de9-0144fb4b6e8c",
  "DeviceManagementServiceConfig.Read.All": "8696daa5-bce5-4b2e-83f9-51b6defc4e1e",
  "DeviceManagementScripts.Read.All": "d32381d8-ee89-4220-9c83-b672aa68d404",
  "DeviceManagementRBAC.Read.All": "49f0cc30-024c-4dfd-ab3e-82e137ee5431",
  "Device.Read.All": "951183d1-1a61-466f-a6d1-1fde911bfd95",
  "GroupMember.Read.All": "bc024368-1153-4739-b217-4326f2e966d0",
  "Organization.Read.All": "4908d5b9-3fb2-4b1e-9336-1888b7937185",
  "Directory.Read.All": "06da0dbc-49e2-44d2-8312-53f166ab848a",
  "User.Read.All": "a154be20-db9c-4678-8ab7-66f6cc099a59",
  "User.ReadBasic.All": "b340eb25-3456-403f-be2f-af7a0d370277",
  "Policy.Read.All": "572fea84-0151-49b2-9301-11cb16974376",
  "Application.Read.All": "c79f8feb-a9db-4090-85f9-90d820caa0eb",
  "AuditLog.Read.All": "e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20",
  "IdentityRiskyUser.Read.All": "d04bb851-cb7c-4146-97c7-ca3e71baf56c",
  "SecurityEvents.Read.All": "64733abd-851e-478a-bffb-e47a14b18235",
  "RoleManagement.Read.Directory": "741c54c3-0c1e-44a1-818b-3f97ab4e8c83",
  "AdministrativeUnit.Read.All": "3361d15d-be43-4de6-b441-3c746d05163d",
  "Domain.Read.All": "2f9ee017-59c1-4f1d-9472-bd5529a7b311",
  "SecurityAlert.Read.All": "bc257fb8-46b4-4b15-8713-01e91bfbe4ea",
  "SecurityIncident.Read.All": "b9abcc4f-94fc-4457-9141-d20ce80ec952",
  "ThreatHunting.Read.All": "b152eca8-ea73-4a48-8c98-1a6742673d99",
};

function graph(name: string, reason: string): ServiceScope {
  const permissionId = GRAPH_DELEGATED_PERMISSION_IDS[name];
  if (!permissionId) throw new Error(`No verified permission ID for ${name}.`);
  return { audience: "graph", name, reason, permissionId };
}

function agentOnly(name: string, reason: string): AgentOnlyScope {
  return { audience: "graph", name, reason };
}

/** Sign-in only. Every service adds the scopes it needs on top. */
export const BASELINE_SCOPES = ["openid", "profile", "offline_access", "User.Read"] as const;

export const BASELINE_SERVICE_SCOPES: readonly ServiceScope[] = [
  graph("openid", "Signs you in."),
  graph("profile", "Shows your name and account on the connected tenant."),
  graph("offline_access", "Keeps you signed in between sessions with a refresh token."),
  graph("User.Read", "Reads your own profile to confirm which account signed in."),
];

const USERS_REASON =
  "Reads users, their licence assignments, location and last sign-in, so assignments, owners and audit entries show names rather than object IDs.";
const GROUPS_REASON =
  "Reads groups and group membership, which policy, app and filter assignments target.";
// Organization.Read.All sits in the people parts (SPEC.md 2a). It also feeds
// the Entra tier and licence probe in the status strip.
const ORGANIZATION_REASON =
  "Reads the tenant profile and /subscribedSkus so the status strip shows the Entra ID tier and licences, and agents that need P1 or P2 are badged.";
// Device.Read.All is listed in both intune.devices and entra.devices
// (SPEC.md 2a).
const ENTRA_DEVICES_REASON =
  "Reads Entra device objects for stale device checks, Autopilot matching and Intune versus Entra inventory comparisons.";

export const SERVICES: readonly ServiceDefinition[] = [
  {
    id: "intune",
    title: "Intune",
    summary: "Managed devices, compliance and configuration policies, apps, scripts and Autopilot.",
    status: "available",
    parts: [
      {
        id: "intune.people",
        service: "intune",
        title: "Users and groups",
        summary: "Users and groups that Intune assignments target, and the tenant licence profile.",
        scopes: [
          graph("User.Read.All", USERS_REASON),
          graph("GroupMember.Read.All", GROUPS_REASON),
          graph("Organization.Read.All", ORGANIZATION_REASON),
        ],
        cacheResources: ["users", "groups"],
        chatExamples: [
          "Which groups is this policy assigned to?",
          "Which devices belong to members of the Sales group?",
        ],
      },
      {
        id: "intune.devices",
        service: "intune",
        title: "Devices and configuration",
        summary: "Managed devices, compliance and configuration policies, update rings, scripts, Autopilot and scope tags.",
        scopes: [
          graph(
            "DeviceManagementManagedDevices.Read.All",
            "Reads Intune enrolled devices, detected apps, troubleshooting events and fleet status. Used by Compliance overview, Find inactive devices, OS update posture, Tenant health report and Chat device questions.",
          ),
          graph(
            "DeviceManagementConfiguration.Read.All",
            "Reads compliance policies, configuration profiles, settings catalog policies, update policies, endpoint security policies, assignment filters, administrative templates and encryption states.",
          ),
          graph(
            "DeviceManagementServiceConfig.Read.All",
            "Reads Windows Autopilot devices, Autopilot deployment profiles and enrollment configurations.",
          ),
          graph(
            "DeviceManagementScripts.Read.All",
            "Reads remediations and platform scripts so Chat can explain assignment, execution and reporting gaps.",
          ),
          graph(
            "DeviceManagementRBAC.Read.All",
            "Reads Intune scope tags so Chat can explain policy visibility and scope tag targeting.",
          ),
          graph("Device.Read.All", ENTRA_DEVICES_REASON),
        ],
        cacheResources: [
          "managedDevices",
          "entraDevices",
          "detectedApps",
          "windowsAutopilotDevices",
          "autopilotEvents",
          "windowsAutopilotProfiles",
          "deviceEnrollmentConfigurations",
          "deviceCompliancePolicies",
          "deviceConfigurations",
          "configurationPolicies",
          "windowsQualityUpdateProfiles",
          "windowsFeatureUpdateProfiles",
          "endpointSecurityIntents",
          "groupPolicyConfigurations",
          "assignmentFilters",
          "roleScopeTags",
          "deviceHealthScripts",
          "deviceManagementScripts",
          "intuneAuditEvents",
          "managedDeviceEncryptionStates",
          "troubleshootingEvents",
          "managedDeviceOverview",
        ],
        chatExamples: [
          "Which devices have not synced in 30 days?",
          "Why is this device noncompliant?",
          "Which configuration profiles are assigned to All devices?",
        ],
      },
      {
        id: "intune.apps",
        service: "intune",
        title: "Apps",
        summary: "Intune app deployments, app protection and app configuration policies.",
        scopes: [
          graph(
            "DeviceManagementApps.Read.All",
            "Reads Intune apps, managed app policies, app protection policies and app configuration policies so Chat can answer deployment and mobile app protection questions.",
          ),
        ],
        cacheResources: [
          "mobileApps",
          "managedAppPolicies",
          "iosManagedAppProtections",
          "androidManagedAppProtections",
          "mobileAppConfigurations",
        ],
        chatExamples: [
          "Which apps are required for all users?",
          "Which app protection policies apply to iOS?",
        ],
      },
    ],
    roles: [
      { name: "Read Only Operator (Intune role)", why: "Views users, devices, enrollment, configuration and apps in Intune without permission to change them. Assigned in Intune, and scope tags still apply." },
      { name: "Global Reader", why: "Reads all Intune data and the Entra directory without permission to change them." },
    ],
    licences: [
      "Microsoft Intune Plan 1, included in Microsoft 365 E3, E5, F3, Business Premium and EMS E3 or E5.",
    ],
    agentOnlyScopes: [
      agentOnly("DeviceManagementManagedDevices.ReadWrite.All", "Changes managed device properties. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementManagedDevices.PrivilegedOperations.All", "Runs remote actions such as retire and wipe. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementConfiguration.ReadWrite.All", "Changes compliance and configuration policies. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementServiceConfig.ReadWrite.All", "Changes Autopilot and enrollment configuration. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementScripts.ReadWrite.All", "Changes remediations and platform scripts. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementRBAC.ReadWrite.All", "Changes Intune roles and scope tags. Requested only when a write agent that declares it runs."),
      agentOnly("DeviceManagementApps.ReadWrite.All", "Changes Intune apps and app policies. Requested only when a write agent that declares it runs."),
    ],
  },
  {
    id: "entra",
    title: "Entra",
    summary: "Users, groups, app registrations, roles, Conditional Access, sign-in logs and risk signals.",
    status: "available",
    parts: [
      {
        id: "entra.people",
        service: "entra",
        title: "Users and groups",
        summary: "Users, guests, groups and the tenant licence profile.",
        scopes: [
          graph("User.Read.All", USERS_REASON),
          graph("GroupMember.Read.All", GROUPS_REASON),
          graph("Organization.Read.All", ORGANIZATION_REASON),
        ],
        cacheResources: ["users", "groups"],
        chatExamples: [
          "Which guests have not signed in for 90 days?",
          "Which users have no licence assigned?",
        ],
      },
      {
        id: "entra.devices",
        service: "entra",
        title: "Devices",
        summary: "Entra device objects and their join type and activity.",
        scopes: [graph("Device.Read.All", ENTRA_DEVICES_REASON)],
        cacheResources: ["entraDevices"],
        chatExamples: ["Which Entra devices have been inactive for 90 days?"],
      },
      {
        id: "entra.apps",
        service: "entra",
        title: "App registrations",
        summary: "App registrations and enterprise applications.",
        scopes: [
          graph(
            "Application.Read.All",
            "Reads app registrations and service principals so Dormant app registrations can flag apps that are no longer used.",
          ),
        ],
        cacheResources: ["applications", "servicePrincipals"],
        chatExamples: ["Which app registrations have credentials that expire this month?"],
      },
      {
        id: "entra.access",
        service: "entra",
        title: "Roles and domains",
        summary: "Directory roles, administrative units and verified domains.",
        scopes: [
          graph(
            "RoleManagement.Read.Directory",
            "Reads Entra directory roles so Chat can answer which admin roles exist and how policies target privileged users. Role assignments are never changed.",
          ),
          graph(
            "AdministrativeUnit.Read.All",
            "Reads administrative units so scoped administration questions use the tenant's actual delegation structure.",
          ),
          graph(
            "Domain.Read.All",
            "Reads verified domains and their authentication type so Chat can explain federation and domain configuration.",
          ),
        ],
        cacheResources: ["directoryRoles", "administrativeUnits", "domains"],
        chatExamples: ["Who holds the Global Administrator role?"],
      },
      {
        id: "entra.policies",
        service: "entra",
        title: "Conditional Access and policies",
        summary: "Conditional Access, named locations, authentication methods, authorization and cross-tenant access policies.",
        scopes: [
          graph(
            "Policy.Read.All",
            "Reads Conditional Access and related tenant policies so the Conditional access explainer can describe what is enforced and why.",
          ),
        ],
        cacheResources: [
          "conditionalAccessPolicies",
          "namedLocations",
          "authenticationMethodsPolicy",
          "authorizationPolicy",
          "crossTenantAccessPolicy",
        ],
        chatExamples: ["Which Conditional Access policies exclude break-glass accounts?"],
      },
      {
        id: "entra.signins",
        service: "entra",
        title: "Sign-in logs",
        summary: "Sign-in logs, directory audit logs and risky users.",
        scopes: [
          graph(
            "AuditLog.Read.All",
            "Reads sign-in logs and directory audit events. Used by Sign-in failure explainer, Tenant change audit and Stale guest cleanup.",
          ),
          graph(
            "IdentityRiskyUser.Read.All",
            "Reads Entra ID Protection risky user signals so Risky sign-in triage can group and explain risk events. Returns data only on Entra ID P2.",
          ),
        ],
        cacheResources: ["signIns", "directoryAudits"],
        chatExamples: [
          "Why did this user's sign-in fail?",
          "What changed in the directory yesterday?",
        ],
      },
    ],
    roles: [
      { name: "Global Reader", why: "Reads users, groups, apps, roles and policies without permission to change them." },
      { name: "Security Reader", why: "Reads sign-in logs, Conditional Access and risky users." },
      { name: "Reports Reader", why: "Reads sign-in and audit logs." },
    ],
    licences: [
      "Microsoft Entra ID Free for users, groups, app registrations, roles and domains.",
      "Microsoft Entra ID P1 for sign-in logs and Conditional Access.",
      "Microsoft Entra ID P2 for risky users.",
    ],
    agentOnlyScopes: [
      agentOnly("Directory.Read.All", "Reads broad directory data. Never requested at connect, only when an agent that declares it runs."),
      agentOnly("User.ReadWrite.All", "Changes users. Requested only when a write agent that declares it runs."),
      agentOnly("Group.Read.All", "Reads all groups and their properties. Older agents declare it where GroupMember.Read.All is enough. Requested only when an agent that declares it runs."),
      agentOnly("Group.ReadWrite.All", "Changes groups. Requested only when a write agent that declares it runs."),
      agentOnly("GroupMember.ReadWrite.All", "Changes group memberships. Requested only when a write agent that declares it runs."),
      agentOnly("IdentityRiskyUser.ReadWrite.All", "Confirms or dismisses risky users. Requested only when a write agent that declares it runs."),
      agentOnly("Directory.ReadWrite.All", "Changes directory objects. Requested only when a write agent that declares it runs."),
      agentOnly("Application.ReadWrite.All", "Changes app registrations. Requested only when a write agent that declares it runs."),
      agentOnly("RoleManagement.ReadWrite.Directory", "Changes directory role assignments. Requested only when a write agent that declares it runs."),
      agentOnly("AdministrativeUnit.ReadWrite.All", "Changes administrative units. Requested only when a write agent that declares it runs."),
      agentOnly("Domain.ReadWrite.All", "Changes domains. Requested only when a write agent that declares it runs."),
      agentOnly("Policy.ReadWrite.ConditionalAccess", "Changes Conditional Access policies. Requested only when a write agent that declares it runs."),
    ],
  },
  {
    id: "defender",
    title: "Defender",
    summary: "Microsoft Defender alerts and incidents, and Secure Score.",
    status: "available",
    parts: [
      {
        id: "defender.incidents",
        service: "defender",
        title: "Alerts and incidents",
        summary: "Microsoft Defender alerts and incidents.",
        scopes: [
          graph(
            "SecurityAlert.Read.All",
            "Reads Microsoft Defender alerts so Chat can summarize open alerts by severity and service. Triage actions are never taken.",
          ),
          graph(
            "SecurityIncident.Read.All",
            "Reads Microsoft Defender incidents so Chat can report incident status, classification and assignment. Incidents are never changed.",
          ),
        ],
        cacheResources: ["securityAlerts", "securityIncidents"],
        chatExamples: ["Which high severity incidents are still open?"],
      },
      {
        // Secure Score sits under Defender (SPEC.md 2a).
        id: "defender.score",
        service: "defender",
        title: "Secure Score",
        summary: "Microsoft Secure Score history and improvement actions.",
        scopes: [
          graph(
            "SecurityEvents.Read.All",
            "Reads Microsoft Secure Score and its controls so the Secure score prioritizer can rank improvement actions by impact.",
          ),
        ],
        cacheResources: ["secureScores", "secureScoreControlProfiles"],
        chatExamples: ["Which Secure Score actions would raise the score most?"],
      },
      {
        id: "defender.hunting",
        service: "defender",
        title: "Advanced hunting",
        summary: "Advanced hunting queries across Defender data.",
        scopes: [
          graph(
            "ThreatHunting.Read.All",
            "Runs read-only advanced hunting queries across Microsoft Defender data.",
          ),
        ],
        cacheResources: [],
        chatExamples: [],
        planned: true,
      },
    ],
    roles: [
      { name: "Security Reader", why: "Reads Defender alerts, incidents and Secure Score without permission to change them." },
      { name: "Global Reader", why: "Reads Defender alerts and incidents without permission to change them. Use Security Reader for Secure Score." },
    ],
    licences: [
      "Alerts and incidents need a Microsoft Defender product, for example Defender for Endpoint, Defender for Office 365 or Microsoft 365 E5.",
      "Secure Score is available in Microsoft 365 tenants without an extra licence.",
    ],
    agentOnlyScopes: [
      agentOnly("SecurityEvents.ReadWrite.All", "Changes Secure Score control states. Requested only when a write agent that declares it runs."),
      agentOnly("SecurityAlert.ReadWrite.All", "Updates Defender alerts, for example status and classification. Requested only when a write agent that declares it runs."),
      agentOnly("SecurityIncident.ReadWrite.All", "Updates Defender incidents, for example status and assignment. Requested only when a write agent that declares it runs."),
    ],
  },
  // Planned services and parts appear only in the docs (SPEC.md 2a). The app
  // never lists or requests them.
  {
    id: "exchange",
    title: "Exchange",
    summary: "Mailboxes, transport rules and mail flow.",
    status: "planned",
    parts: [],
    roles: [],
    licences: [],
    agentOnlyScopes: [],
  },
  {
    id: "teams",
    title: "Teams",
    summary: "Teams, channels and Teams policies.",
    status: "planned",
    parts: [],
    roles: [],
    licences: [],
    agentOnlyScopes: [],
  },
  {
    id: "sharepoint",
    title: "SharePoint",
    summary: "Sites, sharing settings and storage.",
    status: "planned",
    parts: [],
    roles: [],
    licences: [],
    agentOnlyScopes: [],
  },
];

const SERVICE_BY_ID = new Map(SERVICES.map((service) => [service.id, service]));
const PART_BY_ID = new Map(
  SERVICES.flatMap((service) => service.parts.map((part) => [part.id, part] as const)),
);

/** Services that can be connected today. */
export const AVAILABLE_SERVICES: readonly ServiceDefinition[] = SERVICES.filter(
  (service) => service.status === "available",
);

/** Every part that can be requested today, in registry order. */
export const SERVICE_PARTS: readonly ServicePart[] = AVAILABLE_SERVICES.flatMap((service) =>
  service.parts.filter((part) => !part.planned),
);

export function serviceById(id: ServiceId): ServiceDefinition {
  const service = SERVICE_BY_ID.get(id);
  if (!service) throw new Error(`Unknown service: ${id}`);
  return service;
}

export function servicePartById(id: string): ServicePart | undefined {
  return PART_BY_ID.get(id);
}

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === "string" && SERVICE_BY_ID.has(value as ServiceId);
}

/** Requestable part IDs of the given services, in registry order. */
export function partIdsFor(serviceIds: readonly ServiceId[]): string[] {
  const selected = new Set(serviceIds);
  return SERVICE_PARTS.filter((part) => selected.has(part.service)).map((part) => part.id);
}

/**
 * The baseline sign-in scopes plus the deduplicated union of the scopes of
 * the given parts. Unknown and planned parts are ignored: nothing planned
 * is ever requested.
 */
export function requestedScopes(partIds: readonly string[]): ServiceScope[] {
  const selected = new Set(partIds);
  const byKey = new Map<string, ServiceScope>();
  for (const scope of BASELINE_SERVICE_SCOPES) byKey.set(`${scope.audience}:${scope.name}`, scope);
  for (const part of SERVICE_PARTS) {
    if (!selected.has(part.id)) continue;
    for (const scope of part.scopes) {
      const key = `${scope.audience}:${scope.name}`;
      if (!byKey.has(key)) byKey.set(key, scope);
    }
  }
  return [...byKey.values()];
}

export const GRAPH_RESOURCE_PREFIX = "https://graph.microsoft.com/";

/** Reserved OpenID Connect scopes. They are not Graph permissions. */
export const OIDC_SCOPES: ReadonlySet<string> = new Set(["openid", "profile", "offline_access"]);

const AUDIENCES: ReadonlySet<string> = new Set<ScopeAudience>(["graph"]);

export interface ParsedScope {
  audience: ScopeAudience;
  name: string;
}

/**
 * Accepts the stored form (`graph:User.Read.All`), the resource form
 * (`https://graph.microsoft.com/User.Read.All`) and a bare name, which
 * means Graph. Scope names never contain `:`, so qualifying twice is a
 * no-op.
 */
export function parseScope(scope: string): ParsedScope {
  const trimmed = scope.trim();
  if (trimmed.toLowerCase().startsWith(GRAPH_RESOURCE_PREFIX)) {
    return { audience: "graph", name: trimmed.slice(GRAPH_RESOURCE_PREFIX.length) };
  }
  const separator = trimmed.indexOf(":");
  if (separator > 0 && AUDIENCES.has(trimmed.slice(0, separator))) {
    return {
      audience: trimmed.slice(0, separator) as ScopeAudience,
      name: trimmed.slice(separator + 1),
    };
  }
  return { audience: "graph", name: trimmed };
}

/** The stored form of a scope, for example `graph:User.Read.All`. */
export function qualifyScope(scope: string): string {
  const parsed = parseScope(scope);
  return `${parsed.audience}:${parsed.name}`;
}

/** The form MSAL requests. OIDC scopes stay bare. */
export function toResourceScope(scope: string | ParsedScope): string {
  const parsed = typeof scope === "string" ? parseScope(scope) : scope;
  if (OIDC_SCOPES.has(parsed.name)) return parsed.name;
  return `${GRAPH_RESOURCE_PREFIX}${parsed.name}`;
}

export function toResourceScopes(scopes: readonly (string | ParsedScope)[]): string[] {
  return scopes.map(toResourceScope);
}

/** The bare Graph scope name of any accepted form. */
export function normalizeGraphScopeName(scope: string): string {
  return parseScope(scope).name;
}

/**
 * Union of every requestable part scope. Tenants connected before grants
 * were recorded, and the sample tenant, count as having all of these.
 * `Directory.Read.All` is not among them.
 */
export const DEFAULT_GRAPH_READ_SCOPE_NAMES: readonly string[] = [
  ...new Set(SERVICE_PARTS.flatMap((part) => part.scopes.map((scope) => scope.name))),
];

interface GrantSource {
  kind?: "sample";
  grantedScopes?: readonly string[];
}

/** Bare scope names granted for one audience. */
export function grantedScopeSet(
  input: GrantSource,
  audience: ScopeAudience = "graph",
): Set<string> {
  if (input.kind === "sample" || input.grantedScopes === undefined) {
    return new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES);
  }
  const granted = new Set<string>();
  for (const entry of input.grantedScopes) {
    const parsed = parseScope(entry);
    if (parsed.audience === audience) granted.add(parsed.name);
  }
  return granted;
}

function partIsGranted(part: ServicePart, input: GrantSource): boolean {
  const granted = grantedScopeSet(input, "graph");
  return part.scopes.every((scope) => scope.audience !== "graph" || granted.has(scope.name));
}

/** Requestable parts whose every scope is granted. */
export function grantedParts(input: GrantSource): ServicePart[] {
  return SERVICE_PARTS.filter((part) => partIsGranted(part, input));
}

const PART_SCOPE_NAMES: ReadonlySet<string> = new Set(
  SERVICE_PARTS.flatMap((part) => part.scopes.map((scope) => scope.name)),
);

/**
 * Bare Graph scope names the app may use for a tenant. Chat, cache
 * refresh, Changes and agent preflight gate on this, and it follows the
 * same rule as serviceStatus and grantedParts in Settings: a scope that a
 * part lists counts only when a part that lists it is fully granted, so data is never read for a service that Settings
 * shows as not connected. Granted scopes that no part lists, such as
 * agent-only scopes consented at run time, count as granted.
 */
export function availableScopeSet(input: GrantSource): Set<string> {
  const granted = grantedScopeSet(input, "graph");
  const available = new Set([...granted].filter((name) => !PART_SCOPE_NAMES.has(name)));
  for (const part of SERVICE_PARTS) {
    if (!part.scopes.every((scope) => scope.audience !== "graph" || granted.has(scope.name))) continue;
    for (const scope of part.scopes) available.add(scope.name);
  }
  return available;
}

export type ServiceConnectionStatus = "connected" | "partial" | "missing";

export function serviceStatus(input: GrantSource, serviceId: ServiceId): ServiceConnectionStatus {
  const parts = SERVICE_PARTS.filter((part) => part.service === serviceId);
  const granted = parts.filter((part) => partIsGranted(part, input)).length;
  if (parts.length > 0 && granted === parts.length) return "connected";
  return granted > 0 ? "partial" : "missing";
}

/**
 * The first requestable part that lists the scope. A scope shared by
 * several services resolves to a part of a preferred service when one
 * lists it.
 */
export function partForScope(
  scope: string,
  preferredServices: readonly ServiceId[] = [],
): ServicePart | undefined {
  const name = normalizeGraphScopeName(scope);
  const owners = SERVICE_PARTS.filter((part) => part.scopes.some((entry) => entry.name === name));
  return owners.find((part) => preferredServices.includes(part.service)) ?? owners[0];
}

/** The service that owns a part scope or an agent-only scope. */
export function serviceForScope(
  scope: string,
  preferredServices: readonly ServiceId[] = [],
): ServiceDefinition | undefined {
  const part = partForScope(scope, preferredServices);
  if (part) return serviceById(part.service);
  const name = normalizeGraphScopeName(scope);
  return AVAILABLE_SERVICES.find((service) =>
    service.agentOnlyScopes.some((entry) => entry.name === name),
  );
}

/** A part named with its service, for example "Entra sign-in logs". */
export function partLabel(part: ServicePart): string {
  // Titles with a proper noun inside, such as "Secure Score", keep their case.
  const title = /[A-Z]/.test(part.title.slice(1))
    ? part.title
    : `${part.title.charAt(0).toLowerCase()}${part.title.slice(1)}`;
  return `${serviceById(part.service).title} ${title}`;
}

/** Parts that would grant the ungranted part scopes in `scopes`. */
export function missingPartsForScopes(
  scopes: readonly string[],
  granted: ReadonlySet<string>,
  preferredServices: readonly ServiceId[] = [],
): ServicePart[] {
  const missing = new Set<string>();
  for (const scope of scopes) {
    const name = normalizeGraphScopeName(scope);
    if (granted.has(name)) continue;
    const part = partForScope(name, preferredServices);
    if (part) missing.add(part.id);
  }
  return SERVICE_PARTS.filter((part) => missing.has(part.id));
}

/** The service part a resource or request needs that the tenant has not granted. */
export interface NotGrantedService {
  serviceId: ServiceId;
  /** Service title, for example "Defender". */
  service: string;
  partId: string;
  /** The part named with its service, for example "Entra sign-in logs". */
  part: string;
  /** True when no part of the service is granted: the service is not connected. */
  serviceMissing: boolean;
}

/** The first part `scopes` need that is not granted, or undefined when all are. */
export function notGrantedServiceForScopes(
  tenant: GrantSource,
  scopes: readonly string[],
): NotGrantedService | undefined {
  const [part] = missingPartsForScopes(scopes, availableScopeSet(tenant));
  if (!part) return undefined;
  const service = serviceById(part.service);
  return {
    serviceId: service.id,
    service: service.title,
    partId: part.id,
    part: partLabel(part),
    serviceMissing: serviceStatus(tenant, service.id) === "missing",
  };
}

/** "Defender", "Intune and Entra", "Intune, Entra and Defender". */
export function formatServiceList(titles: readonly string[], conjunction: "and" | "or" = "and"): string {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} ${conjunction} ${titles.at(-1)}`;
}

/**
 * Names the services whose earlier drift snapshots a view left out, for
 * example "Intune is not connected. Its earlier snapshots are not
 * compared." A service with some parts granted is named by its missing
 * parts. Undefined when nothing was left out.
 */
export function omittedSnapshotsCopy(
  omitted: readonly { notGrantedService: NotGrantedService }[],
  outcome: "compared" | "shown",
  tenantName?: string,
): string | undefined {
  const services = [...new Set(omitted.filter((entry) => entry.notGrantedService.serviceMissing).map((entry) => entry.notGrantedService.service))];
  const parts = [...new Set(omitted.filter((entry) => !entry.notGrantedService.serviceMissing).map((entry) => entry.notGrantedService.part))];
  const forTenant = tenantName ? ` for ${tenantName}` : "";
  const sentence = (names: string[], state: string) =>
    `${formatServiceList(names)} ${names.length === 1 ? "is" : "are"} ${state}${forTenant}. ${names.length === 1 ? "Its" : "Their"} earlier snapshots are not ${outcome}.`;
  const copy = [
    ...(services.length > 0 ? [sentence(services, "not connected")] : []),
    ...(parts.length > 0 ? [sentence(parts, "not granted")] : []),
  ];
  return copy.length > 0 ? copy.join(" ") : undefined;
}

/**
 * Names what is missing when `scopes` are not granted. A service with no
 * part granted is "not connected"; otherwise the missing part is named.
 * Undefined when every part scope is granted, or when the scopes belong
 * to no part (agent-only scopes are consented at run time).
 */
export function missingServiceCopy(
  tenant: GrantSource & { displayName?: string },
  scopes: readonly string[],
): string | undefined {
  const parts = missingPartsForScopes(scopes, availableScopeSet(tenant));
  if (parts.length === 0) return undefined;
  const missingServices = AVAILABLE_SERVICES.filter(
    (service) =>
      parts.some((part) => part.service === service.id) &&
      serviceStatus(tenant, service.id) === "missing",
  );
  if (missingServices.length > 0) {
    const titles = missingServices.map((service) => service.title);
    return `${formatServiceList(titles)} ${titles.length === 1 ? "is" : "are"} not connected for this tenant. Add ${titles.length === 1 ? "it" : "them"} in Settings, Tenants.`;
  }
  const labels = parts.map(partLabel);
  return `This needs ${formatServiceList(labels)}, which ${labels.length === 1 ? "is" : "are"} not granted for ${tenant.displayName ?? "this tenant"}. Add ${labels.length === 1 ? "it" : "them"} in Settings, Tenants.`;
}

/**
 * Services an agent needs: its declaration, or derived from its scopes.
 * An empty declaration means the agent reads no Graph data.
 */
export function agentServiceIds(agent: {
  services?: readonly ServiceId[];
  scopes: readonly string[];
}): ServiceId[] {
  return agent.services !== undefined ? [...agent.services] : servicesForScopes(agent.scopes);
}

/**
 * Declared services with no part granted for the tenant, in registry
 * order. The sample tenant and tenants whose grants were never recorded
 * have every service. A partly connected service is not missing: its
 * missing part is consented at run time with the OpenAdminOS app.
 */
export function missingServicesForAgent(
  tenant: GrantSource,
  services: readonly ServiceId[],
): ServiceDefinition[] {
  return AVAILABLE_SERVICES.filter(
    (service) => services.includes(service.id) && serviceStatus(tenant, service.id) === "missing",
  );
}

/** Qualified grants after adding `additions` to the current grants. */
export function mergeGrantedScopes(
  current: GrantSource,
  additions: readonly string[],
): string[] {
  const merged = new Set(
    current.kind === "sample" || current.grantedScopes === undefined
      ? DEFAULT_GRAPH_READ_SCOPE_NAMES.map(qualifyScope)
      : current.grantedScopes.map(qualifyScope),
  );
  for (const scope of additions) merged.add(qualifyScope(scope));
  const defaults = DEFAULT_GRAPH_READ_SCOPE_NAMES.map(qualifyScope).filter((scope) =>
    merged.delete(scope),
  );
  return [...defaults, ...[...merged].sort((left, right) => left.localeCompare(right))];
}

/**
 * Qualified grants from the scopes a token carries. OIDC scopes and
 * `.default` are never recorded: they are not permissions.
 */
export function grantsFromTokenScopes(scopes: readonly string[] | null | undefined): string[] {
  const grants = new Set<string>();
  for (const scope of scopes ?? []) {
    const parsed = parseScope(scope);
    if (!parsed.name || parsed.name === ".default" || OIDC_SCOPES.has(parsed.name)) continue;
    grants.add(`${parsed.audience}:${parsed.name}`);
  }
  return [...grants];
}

/** Services that list the scope in a part, planned parts included, or as agent-only. */
function servicesOwningScope(scope: string): ServiceId[] {
  const name = normalizeGraphScopeName(scope);
  return AVAILABLE_SERVICES.filter(
    (service) =>
      service.parts.some((part) => part.scopes.some((entry) => entry.name === name)) ||
      service.agentOnlyScopes.some((entry) => entry.name === name),
  ).map((service) => service.id);
}

const BASELINE_NAMES: ReadonlySet<string> = new Set(BASELINE_SCOPES);

// A scope several services share, such as User.Read.All, is attributed to
// the first service in this order when no other scope settles it.
const SHARED_SCOPE_PREFERENCE: readonly ServiceId[] = ["entra", "intune", "defender"];

/**
 * The smallest set of services that covers the scopes. Used when a
 * manifest does not declare `services`, and to suggest a declaration.
 */
export function servicesForScopes(scopes: readonly string[]): ServiceId[] {
  const owners = scopes
    .filter((scope) => !BASELINE_NAMES.has(normalizeGraphScopeName(scope)))
    .map(servicesOwningScope)
    .filter((ids) => ids.length > 0);
  const selected = new Set<ServiceId>();
  for (const ids of owners) if (ids.length === 1) selected.add(ids[0]!);
  for (const ids of owners) {
    if (ids.some((id) => selected.has(id))) continue;
    selected.add(SHARED_SCOPE_PREFERENCE.find((id) => ids.includes(id)) ?? ids[0]!);
  }
  return AVAILABLE_SERVICES.filter((service) => selected.has(service.id)).map((service) => service.id);
}

/**
 * Scopes that no service lists, baseline and OIDC scopes excepted. An
 * agent that uses one has a dependency OpenAdminOS cannot check, so
 * preflight blocks it instead of treating the scope as no dependency.
 */
export function unmappedScopes(scopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes
        .map(normalizeGraphScopeName)
        .filter((name) => !BASELINE_NAMES.has(name) && !OIDC_SCOPES.has(name))
        .filter((name) => servicesOwningScope(name).length === 0),
    ),
  ];
}

/** The blocked-state copy for an agent that uses unmapped scopes, or undefined. */
export function unmappedScopesCopy(scopes: readonly string[]): string | undefined {
  const unmapped = unmappedScopes(scopes);
  if (unmapped.length === 0) return undefined;
  const one = unmapped.length === 1;
  return `This agent uses ${formatServiceList(unmapped)}, which OpenAdminOS does not map to a service yet. It cannot run until ${one ? "that scope is" : "those scopes are"} added to the service registry. Report it to the agent author or to OpenAdminOS.`;
}

/**
 * The blocked-state copy for an agent whose declared services do not cover
 * its scopes, or undefined. The parser rejects such a manifest, but an agent
 * installed before that check keeps its stored metadata. Unmapped scopes
 * are left to `unmappedScopesCopy`, and agents without a declaration have
 * their services derived from the scopes, so they are always covered.
 */
export function uncoveredScopesCopy(agent: {
  services?: readonly ServiceId[];
  scopes: readonly string[];
}): string | undefined {
  if (agent.services === undefined) return undefined;
  const unmapped = new Set(unmappedScopes(agent.scopes));
  const uncovered = [
    ...new Set(
      scopesNotCoveredByServices(agent.scopes, agent.services)
        .map(normalizeGraphScopeName)
        .filter((name) => !unmapped.has(name)),
    ),
  ];
  if (uncovered.length === 0) return undefined;
  const declared = agent.services.map((id) => serviceById(id).title);
  const needed = servicesForScopes(uncovered).map((id) => serviceById(id).title);
  const declaredCopy =
    declared.length > 0
      ? `which ${declared.length === 1 ? "its declared service" : "its declared services"} ${formatServiceList(declared)} ${declared.length === 1 ? "does" : "do"} not cover`
      : "but declares no services";
  return `This agent uses ${formatServiceList(uncovered)}, ${declaredCopy}. It cannot run until the agent also declares ${formatServiceList(needed)}. Report it to the agent author.`;
}

/**
 * Declared scopes that need a service: every scope except the baseline
 * sign-in scopes, which each tenant grants at sign-in. An agent whose
 * scopes are all baseline may declare `services: []`.
 */
export function scopesRequiringService(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !BASELINE_NAMES.has(normalizeGraphScopeName(scope)));
}

/**
 * Declared scopes that none of the declared services lists. Baseline
 * sign-in scopes are always covered. Unknown scopes are never covered,
 * so a new scope has to be added to the registry first.
 */
export function scopesNotCoveredByServices(
  scopes: readonly string[],
  services: readonly ServiceId[],
): string[] {
  const declared = new Set(services);
  return scopesRequiringService(scopes).filter(
    (scope) => !servicesOwningScope(scope).some((id) => declared.has(id)),
  );
}
