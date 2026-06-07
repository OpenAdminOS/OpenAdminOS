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
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  if (matchesAny(lower, ["overview", "summary", "fleet", "tenant health", "health summary", "most stale", "inventory count"])) {
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
  if (matchesAny(lower, ["compliance", "noncompliant", "not evaluated", "grace period", "compliance policy", "jailbreak", "rooted"])) {
    add("managedDevices", "deviceCompliancePolicies", "conditionalAccessPolicies");
  }
  if (matchesAny(lower, ["policy", "policies", "configuration", "profile", "settings catalog", "baseline", "administrative template", "gpo", "group policy", "conflict", "not applicable", "error 65000", "firewall", "defender", "asr", "attack surface", "account protection", "security baseline", "security policies", "endpoint security", "wifi", "vpn", "certificate", "scep", "pkcs", "duplicated"])) {
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
  if (matchesAny(lower, ["autopilot", "oobe", "esp", "enrollment status page", "pre-provision", "white glove", "hardware hash", "group tag", "deployment profile", "self-deploying", "user-driven", "kiosk", "enroll", "enrollment", "device enrollment manager", "dem"])) {
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
  if (matchesAny(lower, ["remediation", "proactive remediation", "health script", "device health script", "powershell", "script", "ime", "intune management extension", "exit code", "run summary", "detection script"])) {
    add("deviceHealthScripts", "deviceManagementScripts", "managedDevices", "troubleshootingEvents");
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
  }
  if (matchesAny(lower, ["audit", "changed", "created", "deleted", "modified"])) {
    add("directoryAudits", "users");
    if (lower.includes("changed in the tenant")) add("troubleshootingEvents");
  }
  if (matchesAny(lower, ["assignment", "assigned", "targeted", "filter", "scope tag", "rbac", "role scope", "excluded", "included"])) {
    add("assignmentFilters", "roleScopeTags", "groups", "users");
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

  if (resources.size === 0) {
    add("managedDevices", "entraDevices", "users");
  }

  return {
    resources: [...resources],
    searchTerms: extractSearchTerms(question),
    hasWriteIntent: matchesAny(lower, [...WRITE_INTENT_TERMS]),
  };
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
        select: ["id", "displayName", "version", "sizeInByte", "deviceCount", "publisher"],
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
        select: [
          "id",
          "displayName",
          "serialNumber",
          "manufacturer",
          "model",
          "enrollmentState",
          "lastContactedDateTime",
          "userPrincipalName",
          "groupTag",
          "managedDeviceId",
        ],
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
  }
}

export function matchAgentsToQuestion(
  question: string,
  agents: AgentSummary[],
): IntuneChatAgentSuggestion[] {
  const plan = planChatContext(question);
  const terms = extractSearchTerms(question);
  const lower = question.toLowerCase();
  const writeIntentTerms = [...WRITE_INTENT_TERMS].filter((term) =>
    lower.includes(term),
  );
  const inferredCategories = inferQuestionAgentCategories(lower);
  const suggestions = agents
    .map((agent) => {
      const haystack = `${agent.name} ${agent.slug} ${agent.description} ${agent.category} ${agent.mode}`.toLowerCase();
      let score = 0;
      const matchedTerms: string[] = [];
      const matchedConcepts: string[] = [];
      const matchedResources = resourcesForAgentCategory(agent.category, plan.resources);
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1;
          matchedTerms.push(term);
        }
      }
      if (agent.mode === "write" && !plan.hasWriteIntent) {
        return { agent, score: 0, matchedTerms, matchedConcepts, matchedResources };
      }
      if (
        agent.mode === "write" &&
        inferredCategories.size > 0 &&
        !inferredCategories.has(agent.category)
      ) {
        return { agent, score: 0, matchedTerms, matchedConcepts, matchedResources };
      }
      if (agent.mode === "write" && writeIntentTerms.length > 0) {
        score += 2;
        matchedConcepts.push(`Write intent: ${writeIntentTerms.slice(0, 3).join(", ")}`);
      }
      if (agent.category === "devices" && matchesAny(lower, ["device", "intune", "stale", "sync", "offboard", "retire"])) {
        score += 1;
      }
      if (inferredCategories.has(agent.category)) {
        score += 1;
        matchedConcepts.push(
          `${AGENT_CATEGORY_LABELS[agent.category]} investigation`,
        );
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
      return { agent, score, matchedTerms, matchedConcepts, matchedResources };
    })
    .filter((entry) => entry.score >= (entry.agent.mode === "write" ? 3 : 2))
    .sort((a, b) => b.score - a.score)
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
      return {
        resource: status.resource,
        label: status.label,
        cachedRows: status.rows,
        pages: status.pages,
        pageLimitReached: status.pageLimitReached,
        selectedRows: selectedRows.length,
        includedSampleRows: sampleRows.length,
        omittedCachedRows: Math.max(0, status.rows - selectedRows.length),
        refreshedAt: status.refreshedAt,
        lastError: status.lastError,
        sampleRows,
        breakdowns: buildBreakdowns(selectedRows),
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
  if (cleaned.length <= 54) return cleaned || "Intune chat";
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

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
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
    "displayName",
    "deviceName",
    "userPrincipalName",
    "mail",
    "operatingSystem",
    "osVersion",
    "complianceState",
    "lastSyncDateTime",
    "approximateLastSignInDateTime",
    "accountEnabled",
    "userType",
    "trustType",
    "isManaged",
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
  const fields = ["operatingSystem", "complianceState", "userType", "accountEnabled", "trustType"];
  const out: Record<string, Record<string, number>> = {};
  for (const field of fields) {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const raw = row[field];
      const key =
        typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) out[field] = counts;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
