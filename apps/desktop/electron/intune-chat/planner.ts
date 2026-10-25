import type {
  AgentSummary,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  IntuneChatAgentSuggestion,
  TenantRecord,
} from "@openadminos/agent-sdk";
import type { GraphCacheResourceDefinition } from "./sqlite-store.js";

const SCOPES = {
  managedDevices: ["DeviceManagementManagedDevices.Read.All"],
  deviceConfig: ["DeviceManagementConfiguration.Read.All"],
  deviceApps: ["DeviceManagementApps.Read.All"],
  deviceServiceConfig: ["DeviceManagementServiceConfig.Read.All"],
  deviceScripts: ["DeviceManagementScripts.Read.All"],
  deviceRbac: ["DeviceManagementRBAC.Read.All"],
  devices: ["Device.Read.All"],
  users: ["User.Read.All"],
  groups: ["GroupMember.Read.All"],
  audit: ["AuditLog.Read.All"],
  policy: ["Policy.Read.All"],
  roles: ["RoleManagement.Read.Directory"],
  adminUnits: ["AdministrativeUnit.Read.All"],
  applications: ["Application.Read.All"],
  domains: ["Domain.Read.All"],
  securityAlerts: ["SecurityAlert.Read.All"],
  securityIncidents: ["SecurityIncident.Read.All"],
  secureScore: ["SecurityEvents.Read.All"],
} satisfies Record<string, string[]>;

export const GRAPH_CACHE_RESOURCES: readonly GraphCacheResourceDefinition[] = [
  {
    resource: "managedDevices",
    label: "Intune managed devices",
    scopes: SCOPES.managedDevices,
  },
  {
    resource: "entraDevices",
    label: "Entra devices",
    scopes: SCOPES.devices,
  },
  {
    resource: "users",
    label: "Users",
    scopes: SCOPES.users,
  },
  {
    resource: "groups",
    label: "Groups",
    scopes: SCOPES.groups,
  },
  {
    resource: "deviceCompliancePolicies",
    label: "Device compliance policies",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "deviceConfigurations",
    label: "Legacy device configuration profiles",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "configurationPolicies",
    label: "Settings catalog policies",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "signIns",
    label: "Sign-in logs",
    scopes: SCOPES.audit,
  },
  {
    resource: "directoryAudits",
    label: "Directory audit logs",
    scopes: SCOPES.audit,
  },
  {
    resource: "intuneAuditEvents",
    label: "Intune audit events",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "conditionalAccessPolicies",
    label: "Conditional Access policies",
    scopes: SCOPES.policy,
  },
  {
    resource: "mobileApps",
    label: "Intune apps",
    scopes: SCOPES.deviceApps,
  },
  {
    resource: "detectedApps",
    label: "Detected installed apps",
    scopes: SCOPES.managedDevices,
  },
  {
    resource: "managedAppPolicies",
    label: "Managed app policies",
    scopes: SCOPES.deviceApps,
  },
  {
    resource: "iosManagedAppProtections",
    label: "iOS app protection policies",
    scopes: SCOPES.deviceApps,
  },
  {
    resource: "androidManagedAppProtections",
    label: "Android app protection policies",
    scopes: SCOPES.deviceApps,
  },
  {
    resource: "mobileAppConfigurations",
    label: "App configuration policies",
    scopes: SCOPES.deviceApps,
  },
  {
    resource: "deviceHealthScripts",
    label: "Remediations",
    scopes: SCOPES.deviceScripts,
  },
  {
    resource: "deviceManagementScripts",
    label: "Platform scripts",
    scopes: SCOPES.deviceScripts,
  },
  {
    resource: "windowsAutopilotDevices",
    label: "Windows Autopilot devices",
    scopes: SCOPES.deviceServiceConfig,
  },
  {
    resource: "autopilotEvents",
    label: "Autopilot events",
    scopes: SCOPES.managedDevices,
  },
  {
    resource: "windowsAutopilotProfiles",
    label: "Windows Autopilot profiles",
    scopes: SCOPES.deviceServiceConfig,
  },
  {
    resource: "deviceEnrollmentConfigurations",
    label: "Enrollment configurations",
    scopes: SCOPES.deviceServiceConfig,
  },
  {
    resource: "windowsQualityUpdateProfiles",
    label: "Windows quality update policies",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "windowsFeatureUpdateProfiles",
    label: "Windows feature update policies",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "endpointSecurityIntents",
    label: "Endpoint security policies",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "groupPolicyConfigurations",
    label: "Administrative templates",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "assignmentFilters",
    label: "Assignment filters",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "roleScopeTags",
    label: "Scope tags",
    scopes: SCOPES.deviceRbac,
  },
  {
    resource: "managedDeviceOverview",
    label: "Managed device overview",
    scopes: SCOPES.managedDevices,
  },
  {
    resource: "managedDeviceEncryptionStates",
    label: "Device encryption states",
    scopes: SCOPES.deviceConfig,
  },
  {
    resource: "troubleshootingEvents",
    label: "Troubleshooting events",
    scopes: SCOPES.managedDevices,
  },
  {
    resource: "namedLocations",
    label: "Named locations",
    scopes: SCOPES.policy,
  },
  {
    resource: "authenticationMethodsPolicy",
    label: "Authentication methods policy",
    scopes: SCOPES.policy,
  },
  {
    resource: "authorizationPolicy",
    label: "Authorization policy",
    scopes: SCOPES.policy,
  },
  {
    resource: "crossTenantAccessPolicy",
    label: "Cross-tenant access policy",
    scopes: SCOPES.policy,
  },
  {
    resource: "directoryRoles",
    label: "Directory roles",
    scopes: SCOPES.roles,
  },
  {
    resource: "administrativeUnits",
    label: "Administrative units",
    scopes: SCOPES.adminUnits,
  },
  {
    resource: "applications",
    label: "App registrations",
    scopes: SCOPES.applications,
  },
  {
    resource: "servicePrincipals",
    label: "Service principals",
    scopes: SCOPES.applications,
  },
  {
    resource: "domains",
    label: "Domains",
    scopes: SCOPES.domains,
  },
  {
    resource: "securityAlerts",
    label: "Defender alerts",
    scopes: SCOPES.securityAlerts,
  },
  {
    resource: "securityIncidents",
    label: "Defender incidents",
    scopes: SCOPES.securityIncidents,
  },
  {
    resource: "secureScores",
    label: "Secure Score history",
    scopes: SCOPES.secureScore,
  },
  {
    resource: "secureScoreControlProfiles",
    label: "Secure Score controls",
    scopes: SCOPES.secureScore,
  },
] as const;

export interface PlannedChatContext {
  resources: GraphCacheResourceKind[];
  searchTerms: string[];
  hasWriteIntent: boolean;
}

const WRITE_INTENT_TERMS = [
  "retire",
  "offboard",
  "delete",
  "disable",
  "enable",
  "wipe",
  "revoke",
  "remove",
  "create",
  "change",
  "assign",
  "grant",
  "update",
  "add",
  "rename",
  "block",
  "lock",
  "deploy",
  "edit",
  "modify",
  "configure",
  "deactivate",
  "suspend",
  "restore",
  "move",
] as const;

// Write intent must match a requested action, not a verb that merely
// appears in the question. Whole-word matching anywhere in the sentence
// hard-blocked ordinary read questions whose clauses describe tenant
// state: "Which Conditional Access policies grant access without MFA?",
// "Does the policy block legacy authentication?", "Why did Windows fail
// to update the device?" Since the block fires before refresh and model
// calls, a false positive suppresses the read answer entirely. A verb
// counts when it sits in imperative position (sentence start, after
// please / can you / need to, or after "and then"); interrogative
// questions without an imperative verb are reads. Declarative prompts
// keep the whole-word rule. "update" never falls back to whole-word: it
// is also a product noun and an infinitive in read questions.
const READ_QUESTION_START =
  /^(?:which|what|why|how|when|where|who|does|do|did|is|are|was|were|has|have|show|list|tell|find|count|can|could|summarize|describe|explain|give|compare|audit|outline|display|review|inspect|check)\b/;

function matchesWriteIntentTerm(lowerQuestion: string, term: string): boolean {
  // Classify per sentence and combine: an explanatory or read first
  // sentence must not exempt a write command in a later one
  // ("Explain which devices are stale. Retire them."), and polite
  // prefixes reset at each sentence boundary ("Show me the stale
  // devices. Can you retire them?").
  return lowerQuestion
    .split(/(?<=[.!?;])\s+/)
    .some((sentence) => matchesWriteIntentTermInSentence(sentence, term));
}

function matchesWriteIntentTermInSentence(lowerSentence: string, term: string): boolean {
  // Normalize a polite prefix first: "Please list policies that block
  // legacy authentication" is the same main clause as without it, and
  // must not fall through to the whole-word fallback.
  const question = lowerSentence
    .trim()
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+)+/, "");
  // Explanatory how-to prompts describe actions instead of
  // requesting them: "Explain how to disable an account and then
  // delete it." The exemption covers the how-to chain only; an
  // independent clause after a comma is still a request: "Explain
  // which devices are stale, then retire them."
  if (
    /^(?:explain|describe)\b/.test(question) &&
    /\bhow to\b/.test(question) &&
    !new RegExp(`,\\s*(?:and\\s+)?then\\s+${term}\\b`).test(question) &&
    !new RegExp(`,\\s*and\\s+${term}\\b`).test(question)
  ) {
    return false;
  }
  // "Add up the licenses" asks for a sum, not a tenant change.
  if (term === "add" && /^add\s+up\b/.test(question)) return false;
  // Anchored at the main clause only. Unanchored helper phrases
  // ("need to", "and <verb>") also occur inside descriptive
  // subordinate clauses of read questions: "Why do users need to
  // change their passwords?", "Which policies disable legacy
  // authentication and block risky sign-ins?"
  const imperative = new RegExp(
    `(?:^(?:please\\s+)?${term}\\b)|(?:^(?:can you|could you|would you|i want to|i need to|let's)\\s+${term}\\b)|(?:\\bplease\\s+${term}\\b)|(?:\\band then\\s+${term}\\b)|(?:,\\s*then\\s+${term}\\b)|(?:,\\s*and\\s+${term}\\b)|(?:[.!?;]\\s+(?:please\\s+)?${term}\\b)`,
  );
  if (imperative.test(question)) return true;
  // Coordinated imperatives after an imperative read verb are still
  // requests: "Show me the devices and retire the stale ones." A
  // relative clause before the conjunction makes the second verb
  // descriptive instead: "Show the policies that disable legacy
  // authentication and block risky sign-ins."
  const IMPERATIVE_READ_START =
    /^(?:show|list|tell|find|count|give|summarize|compare|audit|outline|display|review|inspect|check)\b/;
  if (IMPERATIVE_READ_START.test(question)) {
    const coordinated = new RegExp(`\\band\\s+${term}\\b`).exec(question);
    if (coordinated) {
      const before = question.slice(0, coordinated.index);
      // A comma before the conjunction starts an independent action
      // clause even after a relative clause: "Show me the devices
      // that have not synced in 90 days, and retire them."
      const independentClause = /,\s*$/.test(before);
      if (independentClause || !/\b(?:that|which|who)\b/.test(before)) {
        return true;
      }
    }
  }
  if (term === "update") return false;
  if (READ_QUESTION_START.test(question)) return false;
  return new RegExp(`\\b${term}\\b`).test(question);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Multi-word domain phrases name the subject of a question more
// precisely than single terms: in "Which device compliance policies
// exist?" both "device" and "compliance" match agent names, but the
// phrase is a compliance question.
const AGENT_CATEGORY_PHRASES: Record<AgentSummary["category"], string[]> = {
  apps: ["app protection", "managed app", "app registration"],
  compliance: ["compliance polic", "device compliance", "compliance state", "noncompliant"],
  devices: ["managed device", "device inventory", "stale device", "inactive device"],
  policies: ["conditional access", "configuration polic", "settings catalog", "endpoint security"],
  updates: ["os update", "windows update", "feature update", "quality update"],
};

const AGENT_CATEGORY_LABELS: Record<AgentSummary["category"], string> = {
  apps: "app deployment",
  compliance: "compliance",
  devices: "device",
  policies: "policy",
  updates: "Windows update",
};

const CATEGORY_RESOURCE_HINTS: Record<AgentSummary["category"], GraphCacheResourceKind[]> = {
  apps: [
    "mobileApps",
    "detectedApps",
    "managedAppPolicies",
    "iosManagedAppProtections",
    "androidManagedAppProtections",
    "mobileAppConfigurations",
  ],
  compliance: [
    "managedDevices",
    "deviceCompliancePolicies",
    "conditionalAccessPolicies",
  ],
  devices: [
    "managedDevices",
    "entraDevices",
    "managedDeviceOverview",
    "managedDeviceEncryptionStates",
    "windowsAutopilotDevices",
    "autopilotEvents",
    "troubleshootingEvents",
  ],
  policies: [
    "deviceCompliancePolicies",
    "deviceConfigurations",
    "configurationPolicies",
    "conditionalAccessPolicies",
    "endpointSecurityIntents",
    "groupPolicyConfigurations",
    "assignmentFilters",
    "roleScopeTags",
  ],
  updates: [
    "managedDevices",
    "windowsQualityUpdateProfiles",
    "windowsFeatureUpdateProfiles",
  ],
};

export function planChatContext(question: string): PlannedChatContext {
  const lower = question.toLowerCase();
  const resources = new Set<GraphCacheResourceKind>();
  const add = (...items: GraphCacheResourceKind[]) => {
    for (const item of items) resources.add(item);
  };

  if (matchesAny(lower, ["device", "intune", "stale", "sync", "retire", "offboard", "os", "windows", "macos", "ios", "android", "linux", "chrome", "ownership", "serial", "manufacturer", "model", "last check", "last seen", "primary user"])) {
    add("managedDevices", "entraDevices");
  }
  if (matchesAny(lower, ["overview", "summary", "summarize", "fleet", "tenant health", "health summary", "most stale", "inventory count"])) {
    add("managedDeviceOverview");
  }
  if (matchesAny(lower, ["encryption", "encrypted", "bitlocker", "filevault", "recovery key", "escrow", "laps", "local admin password", "secure boot", "tpm"])) {
    add("managedDevices", "managedDeviceEncryptionStates", "endpointSecurityIntents");
  }
  if (matchesAny(lower, ["user", "guest", "license", "account", "upn", "member", "primary user", "owner", "assigned user"])) {
    add("users", "managedDevices");
    if (lower.includes("primary user")) add("groups");
  }
  if (matchesAny(lower, ["group", "membership", "members", "dynamic group", "assignment group", "target group"])) {
    add("groups", "users");
  }
  if (matchesAny(lower, ["compliance", "noncompliance", "non-compliance", "noncompliant", "non-compliant", "not evaluated", "grace period", "compliance policy", "jailbreak", "rooted"])) {
    add("managedDevices", "deviceCompliancePolicies", "conditionalAccessPolicies");
  }
  // "policy", "policies", "profile" and "configuration" are the most
  // generic words an admin can use, and they used to plan six resources
  // at the same rank as a precise rule. A question such as "which
  // feature update policies are assigned" then filled the plan with
  // configuration profiles and pushed the update rings out. Generic
  // wording now plans the two core policy stores; the specific Intune
  // policy vocabulary still plans the full set.
  if (matchesAny(lower, ["policy", "policies", "configuration", "profile"])) {
    add(
      "configurationPolicies",
      "deviceConfigurations",
      "deviceCompliancePolicies",
      "endpointSecurityIntents",
      "assignmentFilters",
    );
  }
  if (matchesAny(lower, ["settings catalog", "baseline", "administrative template", "gpo", "group policy", "conflict", "not applicable", "error 65000", "firewall", "defender", "asr", "attack surface", "account protection", "security baseline", "security policies", "endpoint security", "wifi", "vpn", "certificate", "scep", "pkcs", "duplicated"])) {
    add(
      "deviceCompliancePolicies",
      "deviceConfigurations",
      "configurationPolicies",
      "endpointSecurityIntents",
      "groupPolicyConfigurations",
      "assignmentFilters",
    );
  }
  if (matchesAny(lower, ["app", "application", "win32", "company portal", "install", "deployment", "deployed", "detected app", "detection rule", "requirement rule", "dependency", "supersedence", "available", "required", "uninstall", "esp app", "store app", "lob app"])) {
    add("mobileApps", "detectedApps", "managedDevices");
  }
  if (matchesAny(lower, ["app protection", "mam", "managed app", "app config", "app configuration", "ios app", "android app", "mobile policies", "work profile", "data transfer", "copy paste", "pin requirement", "require a pin", "outlook mobile"])) {
    add(
      "managedAppPolicies",
      "iosManagedAppProtections",
      "androidManagedAppProtections",
      "mobileAppConfigurations",
      "mobileApps",
    );
  }
  if (matchesAny(lower, ["enrollment configuration", "enrollment restriction", "autopilot", "oobe", "esp", "enrollment status page", "pre-provision", "white glove", "hardware hash", "group tag", "deployment profile", "self-deploying", "user-driven", "kiosk", "enroll", "enrollment", "device enrollment manager", "dem"])) {
    add(
      "windowsAutopilotDevices",
      "autopilotEvents",
      "windowsAutopilotProfiles",
      "deviceEnrollmentConfigurations",
      "managedDevices",
      "entraDevices",
      "mobileApps",
    );
  }
  // Platform scripts are a distinct Intune object from remediation
  // scripts, so name them explicitly rather than letting the general
  // script rule decide which of the two a question meant.
  if (matchesAny(lower, ["platform script", "shell script", "custom script"])) {
    add("deviceManagementScripts");
  }
  if (matchesAny(lower, ["remediation", "proactive remediation", "health script", "device health script", "powershell", "script", "ime", "intune management extension", "exit code", "run summary", "detection script"])) {
    add("deviceHealthScripts", "deviceManagementScripts", "managedDevices", "troubleshootingEvents");
  }
  // Feature and quality update rings are separate objects; name each
  // one narrowly so a question about one does not rank the other above
  // it via the general update rule.
  if (matchesAny(lower, ["feature update"])) {
    add("windowsFeatureUpdateProfiles");
  }
  if (matchesAny(lower, ["quality update", "expedite"])) {
    add("windowsQualityUpdateProfiles");
  }
  if (matchesAny(lower, ["update", "updates", "feature update", "quality update", "expedite", "wufb", "windows update", "update ring", "deferral", "deadline", "safeguard", "25h2", "24h2", "patch"])) {
    add(
      "windowsQualityUpdateProfiles",
      "windowsFeatureUpdateProfiles",
      "managedDevices",
      "deviceConfigurations",
      "configurationPolicies",
    );
  }
  if (matchesAny(lower, ["sign-in", "signin", "signed in", "accessing microsoft 365", "login", "failure", "risk", "risks", "mfa", "conditional access", "ca policy", "blocked", "grant control", "session control", "trusted location", "named location"])) {
    add("signIns", "conditionalAccessPolicies", "users", "groups");
    if (matchesAny(lower, ["trusted location", "named location", "ip range", "country"])) {
      add("namedLocations");
    }
    if (matchesAny(lower, ["mfa", "authentication method", "authenticator", "passkey", "fido"])) {
      add("authenticationMethodsPolicy");
    }
  }
  if (matchesAny(lower, ["directory role", "admin role", "global admin", "privileged", "role assignment", "role member"])) {
    add("directoryRoles", "users");
  }
  if (matchesAny(lower, ["administrative unit", "admin unit", "scoped administration", "delegated administration"])) {
    add("administrativeUnits", "users", "groups");
  }
  if (matchesAny(lower, ["app registration", "app secret", "client secret", "certificate expiry", "expiring certificate", "expiring secret", "service principal", "enterprise application", "app credential"])) {
    add("applications", "servicePrincipals");
  }
  if (matchesAny(lower, ["domain", "domains", "federated", "federation", "dns", "verified domain"])) {
    add("domains");
  }
  if (matchesAny(lower, ["alert", "alerts", "incident", "incidents", "defender", "sentinel", "threat", "malware", "phishing", "compromised", "security operations", "soc"])) {
    add("securityAlerts", "securityIncidents");
  }
  if (matchesAny(lower, ["secure score", "securescore", "security posture", "improvement action", "security recommendation"])) {
    add("secureScores", "secureScoreControlProfiles");
  }
  if (matchesAny(lower, ["guest", "external user", "b2b", "cross-tenant", "external collaboration"])) {
    add("users");
    if (matchesAny(lower, ["cross-tenant", "b2b", "external collaboration", "inbound", "outbound"])) {
      add("crossTenantAccessPolicy");
    }
    if (matchesAny(lower, ["invite", "default role", "user consent", "authorization policy"])) {
      add("authorizationPolicy");
    }
  }
  if (matchesAny(lower, ["audit", "changed", "created", "deleted", "modified"])) {
    add("directoryAudits", "users");
    if (lower.includes("changed in the tenant")) add("troubleshootingEvents");
  }
  if (matchesAny(lower, ["what changed", "what happened", "changed since", "who modified", "who changed", "recent changes", "recent activity", "drift"])) {
    add("directoryAudits", "intuneAuditEvents");
  }
  if (matchesAny(lower, ["assignment", "assigned", "target", "targeted", "filter", "scope tag", "rbac", "role scope", "excluded", "included"])) {
    // Groups and users are what assignment questions are actually
    // about; scope tags are a secondary detail, so they are planned
    // last and are the first to be trimmed.
    add("assignmentFilters", "groups", "users", "roleScopeTags");
    if (matchesAny(lower, ["app", "apps", "unused", "assignments", "all users", "all devices"])) {
      add("mobileApps", "configurationPolicies", "deviceCompliancePolicies");
    }
    if (matchesAny(lower, ["policy", "policies", "filters", "scope tags"])) {
      add("configurationPolicies", "deviceCompliancePolicies");
    }
    if (matchesAny(lower, ["break-glass", "admin groups"])) {
      add("conditionalAccessPolicies");
    }
    if (lower.includes("group membership")) add("directoryAudits");
  }
  if (matchesAny(lower, ["troubleshoot", "troubleshooting", "error", "failed", "failure", "pending", "waiting", "stuck", "reporting", "report", "issues", "stop receiving"])) {
    add("troubleshootingEvents", "managedDevices");
    if (lower.includes("device issues")) add("signIns");
  }
  if (matchesAny(lower, ["secure boot", "security remediation"])) {
    add("deviceHealthScripts", "endpointSecurityIntents");
  }
  if (lower.includes("jailbroken")) {
    add("deviceCompliancePolicies");
  }
  if (matchesAny(lower, ["cache sources", "cache source"])) {
    add("managedDeviceOverview");
  }
  if (matchesAny(lower, ["top risks", "cached tenant data"])) {
    add("managedDevices", "endpointSecurityIntents");
  }
  if (matchesAny(lower, ["retiring", "retire"])) {
    add("signIns");
  }

  if (resources.size === 0 && !isSmallTalk(question)) {
    add("managedDevices", "entraDevices", "users");
  }

  return {
    resources: [...resources].slice(0, MAX_PLANNED_RESOURCES),
    searchTerms: extractSearchTerms(question),
    hasWriteIntent: WRITE_INTENT_TERMS.some((term) =>
      matchesWriteIntentTerm(lower, term),
    ),
  };
}

/**
 * Cache resources a confirmed write can have changed. Derived from the
 * write agent's scopes (manifest agents apply through runtime steps, so
 * scopes are the stable signal) plus any concrete Graph action paths
 * (system runs). Unknown writes invalidate everything: writes are rare
 * and a stale answer after a confirmed change is the worse failure.
 */
export function graphCacheResourcesForWrite(input: {
  scopes?: string[];
  paths?: string[];
}): GraphCacheResourceKind[] {
  const out = new Set<GraphCacheResourceKind>();
  const paths = input.paths ?? [];
  const pathMatchesResource = (path: string, resource: GraphCacheResourceKind) => {
    const base = pathForResource(resource).path;
    return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}(`);
  };
  for (const definition of GRAPH_CACHE_RESOURCES) {
    if (paths.some((path) => pathMatchesResource(path, definition.resource))) {
      out.add(definition.resource);
    }
  }
  // A concrete write path that maps to no cache resource can still
  // have changed cached state (restoring a deleted group changes
  // group counts). One unmapped path in a mixed batch must widen
  // invalidation, not hide behind the paths that did map.
  const hasUnmappedPath = paths.some(
    (path) =>
      !GRAPH_CACHE_RESOURCES.some((definition) =>
        pathMatchesResource(path, definition.resource),
      ),
  );
  const scopes = input.scopes ?? [];
  // Derive affected resources from scope families generically: every
  // cache resource whose own read scopes share a family root with a
  // write scope can have changed. Hand-enumerated family lists kept
  // missing sibling resources (app protection policies under
  // DeviceManagementApps, update profiles under Configuration), and a
  // nonempty-but-incomplete mapping suppresses the safe fallback.
  const scopeRoot = (scope: string) => scope.split(".")[0] ?? scope;
  const isWriteScope = (scope: string) =>
    !/\.Read\.All$|\.Read$|\.Read\.Directory$/.test(scope);
  const writeRoots = new Set(scopes.filter(isWriteScope).map(scopeRoot));
  const resourceRoots = new Set(
    GRAPH_CACHE_RESOURCES.flatMap((definition) =>
      definition.scopes.map(scopeRoot),
    ),
  );
  for (const definition of GRAPH_CACHE_RESOURCES) {
    if (definition.scopes.some((scope) => writeRoots.has(scopeRoot(scope)))) {
      out.add(definition.resource);
    }
  }
  // Cross-effects the scope roots cannot express.
  if (writeRoots.has("DeviceManagementManagedDevices")) {
    out.add("entraDevices");
    out.add("managedDeviceEncryptionStates");
  }
  if (writeRoots.has("User") || writeRoots.has("Directory")) {
    out.add("users");
    out.add("groups");
  }
  if (writeRoots.has("Group") || writeRoots.has("GroupMember")) {
    out.add("groups");
    out.add("users");
  }
  // A write scope whose family no cache resource reads with (and no
  // cross-effect above covers) can have changed anything: widen to
  // every resource instead of silently keeping its area fresh.
  const coveredRoots = new Set([
    ...resourceRoots,
    "Directory",
    "Group",
    "GroupMember",
  ]);
  const hasUnmappedWriteScope = [...writeRoots].some(
    (root) => !coveredRoots.has(root),
  );
  if (out.size === 0 || hasUnmappedWriteScope || hasUnmappedPath) {
    for (const definition of GRAPH_CACHE_RESOURCES) out.add(definition.resource);
  }
  return [...out];
}

export function requiredScopesForResources(resources: GraphCacheResourceKind[]): string[] {
  const selected = new Set(resources);
  const scopes = new Set<string>();
  for (const definition of GRAPH_CACHE_RESOURCES) {
    if (!selected.has(definition.resource)) continue;
    for (const scope of definition.scopes) scopes.add(scope);
  }
  return [...scopes].sort();
}

export function definitionForResource(
  resource: GraphCacheResourceKind,
): GraphCacheResourceDefinition {
  const definition = GRAPH_CACHE_RESOURCES.find((entry) => entry.resource === resource);
  if (!definition) {
    throw new Error(`Unknown Graph cache resource: ${resource}`);
  }
  return definition;
}

export function pathForResource(resource: GraphCacheResourceKind): {
  path: string;
  select?: string[];
  query?: Record<string, string>;
  headers?: Record<string, string>;
} {
  switch (resource) {
    case "managedDevices":
      return {
        path: "/deviceManagement/managedDevices",
        select: [
          "id",
          "deviceName",
          "userPrincipalName",
          "operatingSystem",
          "osVersion",
          "isEncrypted",
          "lastSyncDateTime",
          "enrolledDateTime",
          "complianceState",
          "azureADDeviceId",
          "managementState",
          "managedDeviceOwnerType",
          "deviceEnrollmentType",
          "manufacturer",
          "model",
        ],
      };
    case "entraDevices":
      return {
        path: "/devices",
        select: [
          "id",
          "deviceId",
          "displayName",
          "accountEnabled",
          "approximateLastSignInDateTime",
          "operatingSystem",
          "trustType",
          "isManaged",
        ],
      };
    case "users":
      return {
        path: "/users",
        select: ["id", "displayName", "userPrincipalName", "mail", "accountEnabled", "userType", "createdDateTime"],
      };
    case "groups":
      return {
        path: "/groups",
        select: ["id", "displayName", "mail", "securityEnabled", "groupTypes", "createdDateTime"],
      };
    case "deviceCompliancePolicies":
      return {
        path: "/deviceManagement/deviceCompliancePolicies",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "deviceConfigurations":
      return {
        path: "/deviceManagement/deviceConfigurations",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "configurationPolicies":
      return {
        path: "/deviceManagement/configurationPolicies",
        select: [
          "id",
          "name",
          "description",
          "platforms",
          "technologies",
          "createdDateTime",
          "lastModifiedDateTime",
          "settingCount",
          "isAssigned",
        ],
      };
    case "signIns":
      return {
        path: "/auditLogs/signIns",
        select: [
          "id",
          "createdDateTime",
          "userDisplayName",
          "userPrincipalName",
          "appDisplayName",
          "ipAddress",
          "clientAppUsed",
          "conditionalAccessStatus",
          "isInteractive",
          "riskDetail",
          "riskLevelAggregated",
          "riskLevelDuringSignIn",
          "riskState",
          "resourceDisplayName",
          "status",
          "deviceDetail",
          "location",
          "appliedConditionalAccessPolicies",
        ],
        query: { "$top": "250" },
      };
    case "directoryAudits":
      return {
        path: "/auditLogs/directoryAudits",
        select: [
          "id",
          "category",
          "activityDisplayName",
          "activityDateTime",
          "result",
          "resultReason",
          "operationType",
          "loggedByService",
          "initiatedBy",
          "targetResources",
          "additionalDetails",
        ],
        query: { "$top": "250" },
      };
    case "intuneAuditEvents":
      return {
        path: "/deviceManagement/auditEvents",
        select: [
          "id",
          "displayName",
          "componentName",
          "activityDateTime",
          "activityType",
          "activityOperationType",
          "activityResult",
          "category",
          "correlationId",
          "actor",
          "resources",
        ],
        query: { "$top": "250", "$orderby": "activityDateTime desc" },
      };
    case "conditionalAccessPolicies":
      return {
        path: "/identity/conditionalAccess/policies",
      };
    case "mobileApps":
      return {
        path: "/deviceAppManagement/mobileApps",
        select: [
          "id",
          "displayName",
          "description",
          "publisher",
          "createdDateTime",
          "lastModifiedDateTime",
          "isAssigned",
          "publishingState",
        ],
      };
    case "detectedApps":
      return {
        path: "/deviceManagement/detectedApps",
        select: ["id", "displayName", "version", "sizeInByte", "deviceCount", "publisher", "platform"],
      };
    case "managedAppPolicies":
      return {
        path: "/deviceAppManagement/managedAppPolicies",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "iosManagedAppProtections":
      return {
        path: "/deviceAppManagement/iosManagedAppProtections",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "androidManagedAppProtections":
      return {
        path: "/deviceAppManagement/androidManagedAppProtections",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "mobileAppConfigurations":
      return {
        path: "/deviceAppManagement/mobileAppConfigurations",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime", "targetedMobileApps"],
      };
    case "deviceHealthScripts":
      return {
        path: "/deviceManagement/deviceHealthScripts",
        select: [
          "id",
          "displayName",
          "description",
          "publisher",
          "createdDateTime",
          "lastModifiedDateTime",
          "runAsAccount",
          "runAs32Bit",
          "enforceSignatureCheck",
        ],
      };
    case "deviceManagementScripts":
      return {
        path: "/deviceManagement/deviceManagementScripts",
        select: [
          "id",
          "displayName",
          "description",
          "createdDateTime",
          "lastModifiedDateTime",
          "runAsAccount",
          "runAs32Bit",
          "enforceSignatureCheck",
        ],
      };
    case "windowsAutopilotDevices":
      return {
        path: "/deviceManagement/windowsAutopilotDeviceIdentities",
        // This beta collection currently returns HTTP 500 whenever `$select`
        // is supplied. Request the default projection and normalize the fields
        // locally until Microsoft fixes endpoint-side projection support.
      };
    case "autopilotEvents":
      return {
        path: "/deviceManagement/autopilotEvents",
        select: [
          "id",
          "deviceId",
          "userId",
          "eventDateTime",
          "deviceRegisteredDateTime",
          "enrollmentStartDateTime",
          "enrollmentType",
          "deviceSerialNumber",
          "managedDeviceName",
          "userPrincipalName",
          "windowsAutopilotDeploymentProfileDisplayName",
          "enrollmentState",
          "windows10EnrollmentCompletionPageConfigurationDisplayName",
          "deploymentState",
          "deviceSetupStatus",
          "accountSetupStatus",
          "osVersion",
          "deploymentStartDateTime",
          "deploymentEndDateTime",
          "enrollmentFailureDetails",
        ],
        query: { "$top": "250" },
      };
    case "windowsAutopilotProfiles":
      return {
        path: "/deviceManagement/windowsAutopilotDeploymentProfiles",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime", "deviceNameTemplate", "deviceType"],
      };
    case "deviceEnrollmentConfigurations":
      return {
        path: "/deviceManagement/deviceEnrollmentConfigurations",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime", "priority"],
      };
    case "windowsQualityUpdateProfiles":
      return {
        path: "/deviceManagement/windowsQualityUpdateProfiles",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "windowsFeatureUpdateProfiles":
      return {
        path: "/deviceManagement/windowsFeatureUpdateProfiles",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime", "featureUpdateVersion"],
      };
    case "endpointSecurityIntents":
      return {
        path: "/deviceManagement/intents",
        select: ["id", "displayName", "description", "templateId", "lastModifiedDateTime", "isAssigned"],
      };
    case "groupPolicyConfigurations":
      return {
        path: "/deviceManagement/groupPolicyConfigurations",
        select: ["id", "displayName", "description", "createdDateTime", "lastModifiedDateTime"],
      };
    case "assignmentFilters":
      return {
        path: "/deviceManagement/assignmentFilters",
        select: ["id", "displayName", "description", "platform", "rule", "assignmentFilterManagementType", "createdDateTime", "lastModifiedDateTime"],
      };
    case "roleScopeTags":
      return {
        path: "/deviceManagement/roleScopeTags",
        select: ["id", "displayName", "description"],
      };
    case "managedDeviceOverview":
      return {
        path: "/deviceManagement/managedDeviceOverview",
      };
    case "managedDeviceEncryptionStates":
      return {
        path: "/deviceManagement/managedDeviceEncryptionStates",
        select: ["id", "deviceName", "userPrincipalName", "encryptionState", "policyDetails", "fileVaultStates"],
      };
    case "troubleshootingEvents":
      return {
        path: "/deviceManagement/troubleshootingEvents",
        select: ["id", "eventDateTime", "correlationId", "troubleshootingErrorDetails"],
        query: { "$top": "250" },
      };
    case "namedLocations":
      return {
        path: "/identity/conditionalAccess/namedLocations",
        select: ["id", "displayName", "createdDateTime", "modifiedDateTime"],
      };
    // The three policy singletons return one object, not a collection;
    // fetchGraphCachePages unwraps both shapes.
    case "authenticationMethodsPolicy":
      return {
        path: "/policies/authenticationMethodsPolicy",
      };
    case "authorizationPolicy":
      return {
        path: "/policies/authorizationPolicy",
      };
    case "crossTenantAccessPolicy":
      return {
        path: "/policies/crossTenantAccessPolicy",
      };
    case "directoryRoles":
      return {
        path: "/directoryRoles",
        select: ["id", "displayName", "description", "roleTemplateId"],
      };
    case "administrativeUnits":
      return {
        // Beta exposes administrative units at the root; v1.0 moved them
        // under /directory. The cache client pins beta.
        path: "/administrativeUnits",
        select: ["id", "displayName", "description", "visibility"],
      };
    case "applications":
      return {
        path: "/applications",
        select: [
          "id",
          "appId",
          "displayName",
          "createdDateTime",
          "signInAudience",
          "passwordCredentials",
          "keyCredentials",
        ],
      };
    case "servicePrincipals":
      return {
        path: "/servicePrincipals",
        select: [
          "id",
          "appId",
          "displayName",
          "accountEnabled",
          "servicePrincipalType",
          "appOwnerOrganizationId",
          "passwordCredentials",
          "keyCredentials",
        ],
      };
    case "domains":
      return {
        path: "/domains",
        select: ["id", "isDefault", "isInitial", "isVerified", "authenticationType"],
      };
    case "securityAlerts":
      return {
        path: "/security/alerts_v2",
        select: [
          "id",
          "title",
          "severity",
          "status",
          "detectionSource",
          "serviceSource",
          "createdDateTime",
          "lastUpdateDateTime",
        ],
        query: { "$top": "250", "$orderby": "createdDateTime desc" },
      };
    case "securityIncidents":
      return {
        path: "/security/incidents",
        select: [
          "id",
          "displayName",
          "severity",
          "status",
          "classification",
          "determination",
          "assignedTo",
          "createdDateTime",
          "lastUpdateDateTime",
        ],
        query: { "$top": "50", "$orderby": "createdDateTime desc" },
      };
    case "secureScores":
      // Daily snapshots, newest first by default; ~90 days of history.
      return {
        path: "/security/secureScores",
        select: ["id", "createdDateTime", "currentScore", "maxScore", "activeUserCount", "licensedUserCount"],
        query: { "$top": "90" },
      };
    case "secureScoreControlProfiles":
      return {
        path: "/security/secureScoreControlProfiles",
        select: [
          "id",
          "title",
          "controlCategory",
          "actionType",
          "service",
          "maxScore",
          "rank",
          "deprecated",
          "implementationCost",
          "userImpact",
          "tier",
        ],
        query: { "$top": "250" },
      };
  }
}

const AGENT_MATCH_STOP_TERMS = new Set([
  "why",
  "are",
  "how",
  "many",
  "much",
  "who",
  "when",
  "where",
  "can",
  "could",
  "please",
  "does",
  "did",
  "has",
  "had",
  "was",
  "were",
  "will",
  "would",
  "should",
  "them",
  "they",
  "our",
  "your",
  "you",
  "all",
  "any",
  "not",
  "but",
  "get",
  "got",
  "give",
  "than",
  "then",
  "over",
  "under",
  "last",
  "days",
  "day",
]);

/**
 * Light stemming for agent matching. Substring matching let stop words
 * score inside unrelated words ("are" inside "Prepares") and missed
 * plain inflections ("failing" never matched "failed sign-ins").
 * Words match when their stems are equal, when one stem prefixes the
 * other, or when they share a long prefix ("compliant"/"compliance").
 */
function stemAgentWord(word: string): string {
  let stemmed = word.toLowerCase().replace(/'s$/, "");
  if (stemmed.length > 5 && stemmed.startsWith("non")) stemmed = stemmed.slice(3);
  if (stemmed.length > 4 && stemmed.endsWith("ies")) {
    stemmed = `${stemmed.slice(0, -3)}y`;
  } else if (stemmed.length > 5 && stemmed.endsWith("ing")) {
    stemmed = stemmed.slice(0, -3);
  } else if (stemmed.length > 4 && stemmed.endsWith("ed")) {
    stemmed = stemmed.slice(0, -2);
  } else if (stemmed.length > 4 && stemmed.endsWith("es")) {
    stemmed = stemmed.slice(0, -2);
  } else if (stemmed.length > 3 && stemmed.endsWith("s")) {
    stemmed = stemmed.slice(0, -1);
  }
  return stemmed;
}

function agentWordStems(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9-]+/g)
    .flatMap((word) => (word.includes("-") ? [word, ...word.split("-")] : [word]))
    .filter((word) => word.length >= 2);
  return [...new Set(words.map(stemAgentWord))];
}

function agentStemsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
  let shared = 0;
  while (shared < shorter.length && a[shared] === b[shared]) shared += 1;
  return shared >= 6;
}

export function matchAgentsToQuestion(
  question: string,
  agents: AgentSummary[],
): IntuneChatAgentSuggestion[] {
  const plan = planChatContext(question);
  const lower = question.toLowerCase();
  const writeIntentTerms = [...WRITE_INTENT_TERMS].filter((term) =>
    matchesWriteIntentTerm(lower, term),
  );
  // An imperative "Update the compliance policy" names an action, not
  // the OS-update topic. Keep the verb out of topic scoring so the
  // object of the request drives the match; read questions about
  // updates keep the term because the imperative rule did not fire.
  const terms = extractSearchTerms(question).filter(
    (term) =>
      !AGENT_MATCH_STOP_TERMS.has(term) &&
      !(term === "update" && plan.hasWriteIntent && matchesWriteIntentTerm(lower, "update")),
  );
  const inferredCategories = inferQuestionAgentCategories(lower);
  // Two passes so common words weigh less than distinctive ones. A
  // generic term like "device" appears in most agent names and
  // descriptions; counted flat, it outranked the actual subject of the
  // question ("Which device compliance policies exist?" put device
  // agents above the compliance overview).
  const rawMatches = agents.map((agent) => {
    const nameStems = agentWordStems(`${agent.name} ${agent.slug}`);
    const bodyStems = agentWordStems(`${agent.description} ${agent.category}`);
    const matches: Array<{ term: string; field: "name" | "body" }> = [];
    for (const term of terms) {
      const stem = stemAgentWord(term);
      if (nameStems.some((candidate) => agentStemsMatch(stem, candidate))) {
        matches.push({ term, field: "name" });
      } else if (bodyStems.some((candidate) => agentStemsMatch(stem, candidate))) {
        matches.push({ term, field: "body" });
      }
    }
    return matches;
  });
  const documentFrequency = new Map<string, number>();
  for (const matches of rawMatches) {
    for (const term of new Set(matches.map((match) => match.term))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const termWeight = (term: string): number => {
    const frequency = documentFrequency.get(term) ?? 0;
    return frequency <= 2 ? 1 : frequency <= 4 ? 0.75 : 0.4;
  };
  // A term most agents mention somewhere in their description is
  // incidental there ("compliance" in a device agent's signal list),
  // so description matches only score for distinctive terms. Name and
  // slug matches always score: the name is the agent's own claim.
  const bodyTermScores = (term: string): boolean =>
    (documentFrequency.get(term) ?? 0) <= 5;
  const suggestions = agents
    .map((agent, agentIndex) => {
      let score = 0;
      let nameMatches = 0;
      const matchedTerms: string[] = [];
      const matchedConcepts: string[] = [];
      const matchedResources = resourcesForAgentCategory(agent.category, plan.resources);
      for (const match of rawMatches[agentIndex] ?? []) {
        if (match.field === "body" && !bodyTermScores(match.term)) continue;
        score += (match.field === "name" ? 2 : 1) * termWeight(match.term);
        if (match.field === "name") nameMatches += 1;
        matchedTerms.push(match.term);
      }
      const matched = { agent, score, matchedTerms, matchedConcepts, matchedResources, nameMatches };
      if (agent.mode === "write" && !plan.hasWriteIntent) {
        return { ...matched, score: 0 };
      }
      if (
        agent.mode === "write" &&
        inferredCategories.size > 0 &&
        !inferredCategories.has(agent.category)
      ) {
        return { ...matched, score: 0 };
      }
      if (agent.mode === "write" && writeIntentTerms.length > 0) {
        score += 2;
        matchedConcepts.push(`Write intent: ${writeIntentTerms.slice(0, 3).join(", ")}`);
      }
      if (inferredCategories.has(agent.category)) {
        score += 1;
        matchedConcepts.push(
          `${AGENT_CATEGORY_LABELS[agent.category]} investigation`,
        );
      }
      const domainPhrase = AGENT_CATEGORY_PHRASES[agent.category].find((phrase) =>
        lower.includes(phrase),
      );
      if (domainPhrase) {
        score += 1.5;
        matchedConcepts.push(`Domain phrase: ${domainPhrase}`);
      }
      if (matchedResources.length > 0) {
        matchedConcepts.push(
          `Uses planned source${matchedResources.length === 1 ? "" : "s"}: ${matchedResources
            .slice(0, 2)
            .map((resource) => definitionForResource(resource).label)
            .join(", ")}`,
        );
      }
      if (matchedTerms.length > 0) {
        matchedConcepts.unshift(
          `Prompt terms in agent metadata: ${matchedTerms.slice(0, 5).join(", ")}`,
        );
      }
      return { ...matched, score };
    })
    // A suggestion needs real lexical evidence: a name/slug term, or at
    // least two metadata terms. Category and write-intent bonuses alone
    // used to float unrelated agents (a script-drafting helper on every
    // device question, a device offboarder on a guest-account request).
    .filter(
      (entry) =>
        entry.score >= (entry.agent.mode === "write" ? 3 : 1.75) &&
        (entry.nameMatches >= 1 || entry.matchedTerms.length >= 2),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.matchedTerms.length - a.matchedTerms.length ||
        a.agent.slug.localeCompare(b.agent.slug),
    )
    .slice(0, 3);

  return suggestions.map(({ agent, score, matchedTerms, matchedConcepts, matchedResources }) => ({
    agentSlug: agent.slug,
    agentName: agent.name,
    reason: agentSuggestionReason(agent, matchedTerms, matchedConcepts),
    matchedTerms: uniqueStrings(matchedTerms).slice(0, 8),
    matchedConcepts: uniqueStrings(matchedConcepts).slice(0, 5),
    matchedResources: matchedResources.slice(0, 6),
    confidence: Math.min(0.95, 0.45 + score * 0.1),
    mode: agent.mode,
    scopes: agent.scopes,
  }));
}

export function buildAnswerPack(input: {
  question: string;
  tenant: TenantRecord;
  cacheStatus: GraphCacheResourceStatus[];
  rows: Record<GraphCacheResourceKind, unknown[]>;
  /**
   * Exact counts over the whole cached set, keyed by resource. Sample
   * rows are capped for context budget, so without these the model can
   * only count what it can see and has no way to answer "how many".
   */
  aggregates?: Partial<
    Record<
      GraphCacheResourceKind,
      { total: number; breakdowns: Record<string, Record<string, number>> }
    >
  >;
  hasWriteIntent: boolean;
  agentSuggestions: IntuneChatAgentSuggestion[];
  generatedAt?: string;
  limits?: {
    maxRowsReadPerResource?: number;
    maxSampleRowsPerResource?: number;
    maxFindingSampleRows?: number;
    maxAgentSuggestions?: number;
    profile?: string;
  };
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const maxRowsReadPerResource = input.limits?.maxRowsReadPerResource ?? 40;
  const maxSampleRowsPerResource = input.limits?.maxSampleRowsPerResource ?? 20;
  const maxFindingSampleRows = input.limits?.maxFindingSampleRows ?? 20;
  const maxAgentSuggestions = input.limits?.maxAgentSuggestions;
  const resourceBlocks = input.cacheStatus
    .filter((status) => Object.prototype.hasOwnProperty.call(input.rows, status.resource))
    .map((status) => {
      const selectedRows = input.rows[status.resource] ?? [];
      const sampleRows = selectedRows
        .slice(0, maxSampleRowsPerResource)
        .map(compactGraphObject);
      const aggregate = input.aggregates?.[status.resource];
      return {
        resource: status.resource,
        label: status.label,
        cachedRows: status.rows,
        // Tenant-wide total from Graph. When present it is the correct
        // answer to "how many", even where it exceeds cachedRows.
        ...(status.tenantTotal !== undefined
          ? { tenantTotal: status.tenantTotal }
          : {}),
        pages: status.pages,
        pageLimitReached: status.pageLimitReached,
        selectedRows: selectedRows.length,
        includedSampleRows: sampleRows.length,
        omittedCachedRows: Math.max(0, status.rows - selectedRows.length),
        refreshedAt: status.refreshedAt,
        lastError: status.lastError,
        sampleRows,
        // Counted across every cached row, not just the sample above.
        // Quote these for any "how many" question; counting sampleRows
        // would undercount by the sampling ratio.
        breakdowns: aggregate?.breakdowns ?? buildBreakdowns(selectedRows),
        breakdownsCoverAllCachedRows: aggregate !== undefined,
      };
    });

  return JSON.stringify(
    {
      question: input.question,
      generatedAt,
      tenant: {
        displayName: input.tenant.displayName,
        entraTier: input.tenant.entraTier ?? "unknown",
      },
      writeIntentDetected: input.hasWriteIntent,
      agentSuggestions:
        maxAgentSuggestions === undefined
          ? input.agentSuggestions
          : input.agentSuggestions.slice(0, maxAgentSuggestions),
      deterministicFindings: buildDeterministicFindings({
        question: input.question,
        generatedAt,
        rows: input.rows,
        maxSampleRows: maxFindingSampleRows,
      }),
      compaction: {
        profile: input.limits?.profile ?? "default",
        maxRowsReadPerResource,
        maxSampleRowsPerResource,
        maxFindingSampleRows,
        rule: "SQLite/Graph filtering selects bounded evidence first; deterministic filters may preselect rows before sampling. cachedRows may be larger than selectedRows, and omittedCachedRows is intentionally not sent as raw data.",
      },
      resources: resourceBlocks,
      instruction:
        "Answer only from these resources. If evidence is missing, say what needs to be refreshed or connected. Do not invent tenant state.",
    },
    null,
    2,
  );
}

export function staleManagedDeviceSyncThresholdDays(question: string): number | undefined {
  const lower = question.toLowerCase();
  if (!matchesAny(lower, ["device", "devices", "managed device", "managed devices", "intune"])) {
    return undefined;
  }
  if (!matchesAny(lower, ["sync", "synced", "last sync", "lastsync", "inactive", "stale"])) {
    return undefined;
  }
  const dayMatch =
    lower.match(/(?:last|older than|more than|over|inactive for|stale for)\s+(\d{1,4})\s+days?/) ??
    lower.match(/not\s+synced\s+(?:in|within)\s+(?:the\s+)?last\s+(\d{1,4})\s+days?/) ??
    lower.match(/(\d{1,4})\s+days?/);
  if (!dayMatch?.[1]) return undefined;
  const days = Number(dayMatch[1]);
  if (!Number.isFinite(days)) return undefined;
  return Math.max(1, Math.min(3650, Math.floor(days)));
}

export function thresholdIsoDaysBefore(generatedAt: string, days: number): string {
  const generatedMs = new Date(generatedAt).getTime();
  const baseMs = Number.isFinite(generatedMs) ? generatedMs : Date.now();
  return new Date(baseMs - days * MS_PER_DAY).toISOString();
}

function buildDeterministicFindings(input: {
  question: string;
  generatedAt: string;
  rows: Record<GraphCacheResourceKind, unknown[]>;
  maxSampleRows: number;
}): Array<Record<string, unknown>> {
  const days = staleManagedDeviceSyncThresholdDays(input.question);
  if (days === undefined) return [];
  const thresholdAt = thresholdIsoDaysBefore(input.generatedAt, days);
  const managedDevices = input.rows.managedDevices ?? [];
  const staleDevices = managedDevices
    .filter((row) => {
      if (!isRecord(row)) return false;
      const value = row.lastSyncDateTime;
      if (typeof value !== "string") return false;
      const lastSyncMs = new Date(value).getTime();
      const thresholdMs = new Date(thresholdAt).getTime();
      return Number.isFinite(lastSyncMs) && lastSyncMs < thresholdMs;
    })
    .map(compactGraphObject);
  return [
    {
      id: "managed-devices-last-sync-before",
      resource: "managedDevices",
      operator: "lastSyncDateTime < thresholdAt",
      thresholdDays: days,
      thresholdAt,
      evaluatedSelectedRows: managedDevices.length,
      matchingRows: staleDevices.length,
      matchingSampleRows: staleDevices.slice(0, input.maxSampleRows),
      note:
        "For this stale-sync question, managedDevices rows were selected from SQLite by lastSyncDateTime before the model context was built.",
    },
  ];
}

export function chatTitleForPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 54) return cleaned || "Chat";
  return `${cleaned.slice(0, 51).trim()}...`;
}

export function selfTrainingCandidateFromPrompt(input: {
  question: string;
  agentSuggestions: IntuneChatAgentSuggestion[];
}): { agentSlug: string; text: string; reason: string } | undefined {
  if (input.agentSuggestions.length === 0) return undefined;
  const lower = input.question.toLowerCase();
  if (!matchesAny(lower, ["always", "never", "exclude", "include", "prefer", "avoid"])) {
    return undefined;
  }
  const sentence = sanitizeLearningText(input.question.replace(/\s+/g, " ").trim());
  if (sentence.length < 16 || sentence.length > 280) return undefined;
  const agent = input.agentSuggestions[0];
  if (!agent) return undefined;
  return {
    agentSlug: agent.agentSlug,
    text: sentence,
    reason: `The chat instruction appears to be a reusable preference for ${agent.agentName}.`,
  };
}

function extractSearchTerms(question: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "what",
    "which",
    "show",
    "tell",
    "about",
    "into",
    "their",
    "there",
    "tenant",
    "intune",
  ]);
  return question
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stop.has(term))
    .slice(0, 12);
}

/**
 * Keyword rules used to match by plain substring, which fired inside
 * unrelated words: "esp" matched "respond", "app" matched "happened",
 * and "os" matched "cost". A single question could plan 17 resource
 * refreshes, and worse, match the wrong rule entirely.
 *
 * Matching is now anchored to word boundaries, with an optional plural
 * suffix so "sign-in" still matches "sign-ins" and "device" still
 * matches "devices".
 */
const termPatterns = new Map<string, RegExp>();

function termPattern(needle: string): RegExp {
  let pattern = termPatterns.get(needle);
  if (!pattern) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow the common English inflections so "enroll" still matches
    // "enrolled" and "enrolling", and "device" still matches "devices",
    // without matching inside unrelated words.
    pattern = new RegExp(
      `(?:^|[^a-z0-9])${escaped}(?:e?s|e?d|ing)?(?:$|[^a-z0-9])`,
      "i",
    );
    termPatterns.set(needle, pattern);
  }
  return pattern;
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => termPattern(needle).test(value));
}

/**
 * Runaway guard only. Across the 150 researched questions the planner
 * selects a median of 7 resources and never more than 16, so this bound
 * is not reached in practice; it exists so that no single question can
 * queue an unbounded number of Graph refreshes. Trimming to a tighter
 * number was tried and rejected: questions in the bank legitimately
 * need resources that a tighter cap discards, and refresh concurrency
 * is the better lever for latency.
 */
export const MAX_PLANNED_RESOURCES = 20;

/**
 * Messages that carry no admin intent. These used to fall through to
 * the default resource trio and trigger a Graph refresh, so saying
 * "hi" fetched devices and users.
 */
const SMALL_TALK = /^(hi|hey|hello|yo|thanks|thank you|ta|ok|okay|cool|nice|got it|good (morning|afternoon|evening)|test|ping)\b[\s!.?]*$/i;

export function isSmallTalk(question: string): boolean {
  return SMALL_TALK.test(question.trim());
}

function inferQuestionAgentCategories(lowerQuestion: string): Set<AgentSummary["category"]> {
  const categories = new Set<AgentSummary["category"]>();
  if (
    matchesAny(lowerQuestion, [
      "device",
      "devices",
      "managed device",
      "autopilot",
      "enrollment",
      "esp",
      "windows",
      "macos",
      "ios",
      "android",
      "sync",
      "serial",
      "manufacturer",
      "model",
      "retire",
      "offboard",
    ])
  ) {
    categories.add("devices");
  }
  if (
    matchesAny(lowerQuestion, [
      "app",
      "apps",
      "application",
      "win32",
      "company portal",
      "install",
      "deployment",
      "supersedence",
      "detected app",
      "mam",
      "app protection",
      "app configuration",
    ])
  ) {
    categories.add("apps");
  }
  if (
    matchesAny(lowerQuestion, [
      "policy",
      "policies",
      "configuration",
      "settings catalog",
      "baseline",
      "conditional access",
      "assignment",
      "filter",
      "scope tag",
      "rbac",
      "endpoint security",
      // Identity questions route to the policy-category agents (sign-in
      // explainer, risky sign-in triage, stale guest cleanup). Without
      // these needles a sign-in question inferred no category at all
      // and the write-agent category gate could not exclude the device
      // offboarder from a guest-account request.
      "sign-in",
      "sign in",
      "signin",
      "signed in",
      "authentication",
      "mfa",
      "guest",
      "account",
    ])
  ) {
    categories.add("policies");
  }
  if (
    matchesAny(lowerQuestion, [
      "compliance",
      "noncompliant",
      "not evaluated",
      "grace period",
      "jailbreak",
      "rooted",
    ])
  ) {
    categories.add("compliance");
  }
  if (
    matchesAny(lowerQuestion, [
      "update",
      "updates",
      "feature update",
      "quality update",
      "wufb",
      "update ring",
      "deferral",
      "deadline",
      "25h2",
      "24h2",
      "patch",
    ])
  ) {
    categories.add("updates");
  }
  return categories;
}

function resourcesForAgentCategory(
  category: AgentSummary["category"],
  plannedResources: GraphCacheResourceKind[],
): GraphCacheResourceKind[] {
  const hints = new Set(CATEGORY_RESOURCE_HINTS[category]);
  return plannedResources.filter((resource) => hints.has(resource));
}

function agentSuggestionReason(
  agent: AgentSummary,
  matchedTerms: string[],
  matchedConcepts: string[],
): string {
  const category = AGENT_CATEGORY_LABELS[agent.category];
  if (agent.mode === "write") {
    return matchedConcepts.length > 0
      ? `This installed write agent matched ${category} evidence in the prompt. It still requires the normal preflight, write plan, and typed confirmation.`
      : "This installed write agent matched the request and still requires the normal preflight, write plan, and typed confirmation.";
  }
  if (matchedTerms.length > 0) {
    return `This installed read agent matched ${category} terms from the investigation.`;
  }
  return `This installed read agent matches the ${category} investigation you asked for.`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sanitizeLearningText(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[user]")
    .replace(/\b[a-z0-9-]+\.onmicrosoft\.com\b/gi, "[tenant-domain]")
    .replace(/\{[^{}]{20,}\}/g, "[object]")
    .trim();
}

function compactGraphObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { value };
  const keys = [
    "id",
    "@odata.type",
    "displayName",
    "deviceName",
    "userPrincipalName",
    "mail",
    "operatingSystem",
    "platform",
    "osVersion",
    "complianceState",
    "lastSyncDateTime",
    "approximateLastSignInDateTime",
    "accountEnabled",
    "userType",
    "trustType",
    "isManaged",
    "isAssigned",
    "publishingState",
    "state",
    "severity",
    "classification",
    "securityEnabled",
    "groupTypes",
    "platforms",
    "signInAudience",
    "servicePrincipalType",
    "authenticationType",
    "isVerified",
    "conditionalAccessStatus",
    "category",
    "result",
    "activityResult",
    "runAsAccount",
    "enrollmentState",
    "featureUpdateVersion",
    "encryptionState",
    "visibility",
    "publisher",
    "createdDateTime",
    "lastModifiedDateTime",
    "riskLevel",
    "riskState",
    "status",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return Object.keys(out).length > 0 ? out : { raw: value };
}

function buildBreakdowns(rows: unknown[]): Record<string, Record<string, number>> {
  const scalarFields = [
    "operatingSystem",
    "complianceState",
    "userType",
    "accountEnabled",
    "trustType",
    "platform",
    "@odata.type",
    "state",
    "status",
    "severity",
    "classification",
    "determination",
    "serviceSource",
    "detectionSource",
    "securityEnabled",
    "signInAudience",
    "servicePrincipalType",
    "authenticationType",
    "isVerified",
    "isDefault",
    "isInitial",
    "conditionalAccessStatus",
    "clientAppUsed",
    "isInteractive",
    "riskLevelAggregated",
    "riskLevelDuringSignIn",
    "riskState",
    "status.errorCode",
    "category",
    "result",
    "operationType",
    "loggedByService",
    "activityType",
    "activityOperationType",
    "activityResult",
    "componentName",
    "runAsAccount",
    "runAs32Bit",
    "enforceSignatureCheck",
    "enrollmentState",
    "deploymentProfileAssignmentStatus",
    "remediationState",
    "enrollmentType",
    "deploymentState",
    "deviceSetupStatus",
    "accountSetupStatus",
    "featureUpdateVersion",
    "assignmentFilterManagementType",
    "encryptionState",
    "visibility",
    "controlCategory",
    "actionType",
    "service",
    "implementationCost",
    "userImpact",
    "tier",
    "deprecated",
    "managedDeviceOwnerType",
    "deviceEnrollmentType",
    "managementState",
    "isManaged",
    "isAssigned",
    "publishingState",
  ];
  const arrayFields = ["platforms", "groupTypes"];
  const out: Record<string, Record<string, number>> = {};
  const scalarValue = (row: Record<string, unknown>, field: string): unknown =>
    field === "status.errorCode" && isRecord(row.status)
      ? row.status.errorCode
      : row[field];
  for (const field of scalarFields) {
    const counts: Record<string, number> = {};
    let seen = false;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const raw = scalarValue(row, field);
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        continue;
      }
      seen = true;
      const key = String(raw);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (seen && Object.keys(counts).length > 0) out[field] = counts;
  }
  for (const field of arrayFields) {
    const counts: Record<string, number> = {};
    let seen = false;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const values = Array.isArray(row[field]) ? (row[field] as unknown[]) : [row[field]];
      for (const raw of values) {
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
          continue;
        }
        seen = true;
        const key = String(raw);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    if (seen && Object.keys(counts).length > 0) out[field] = counts;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
