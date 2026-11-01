import type {
  GraphCacheResourceKind,
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
} from "./openAdminOS.js";

export function conversationCacheSummary(cacheStatus: GraphCacheStatus | null): string {
  if (!cacheStatus) return "No cache";
  const refreshed = cacheStatus.resources.filter((resource) => resource.refreshedAt);
  if (refreshed.length === 0) return "No cache";
  const newest = refreshed
    .map((resource) => resource.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return newest ? `Updated ${formatDateTime(newest)}` : "Cache ready";
}

export function buildConversationExportMarkdown(input: {
  conversation: IntuneChatConversation;
  messages: IntuneChatMessage[];
  tenantName?: string;
  providerName?: string;
  cacheSummary: string;
  sampleData?: boolean;
}): string {
  const lines = [
    `# ${input.conversation.title}`,
    "",
    `Exported: ${new Date().toISOString()}`,
    `Tenant: ${input.tenantName ?? input.conversation.tenantId ?? "Unknown"}`,
    `Provider: ${input.providerName ?? "Unknown"}`,
    `Cache: ${input.cacheSummary}`,
    ...(input.sampleData ? ["Data: Pilot mode sample data from a fictional company"] : []),
    "",
    "This export was generated locally by OpenAdminOS. It includes chat text and source metadata, not cached Graph row payloads.",
    "",
  ];

  for (const message of input.messages) {
    lines.push(`## ${message.role === "user" ? "Prompt" : "Response"} · ${formatDateTime(message.createdAt)}`);
    if (message.providerId || message.model || message.status !== "completed") {
      lines.push(
        [
          message.status !== "completed" ? `status=${message.status}` : undefined,
          message.providerId ? `provider=${message.providerId}` : undefined,
          message.model ? `model=${message.model}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    lines.push("", message.content.trim() || "_No content._", "");

    if (message.sources?.length) {
      lines.push("### Sources", "");
      for (const source of message.sources) {
        lines.push(`- **${source.label}** (${source.source})`);
        lines.push(`  - Resource: \`${source.resource}\``);
        if (source.path) lines.push(`  - Path: \`${source.path}\``);
        if (source.select?.length) lines.push(`  - Select: \`${source.select.join(", ")}\``);
        if (source.query && Object.keys(source.query).length > 0) {
          lines.push(`  - Query: \`${formatSourceQuery(source.query)}\``);
        }
        lines.push(`  - Rows: ${source.rows}`);
        lines.push(`  - Pages: ${source.pages ?? "unknown"}`);
        lines.push(`  - Capped: ${source.pageLimitReached ? "yes" : "no"}`);
        lines.push(`  - Refreshed: ${source.refreshedAt ?? "not refreshed"}`);
        if (source.error) lines.push(`  - Error: ${source.error}`);
      }
      lines.push("");
    }

    if (message.toolTrace?.length) {
      lines.push("### What Ran", "");
      for (const entry of message.toolTrace) {
        lines.push(`- \`${entry.tool}\` · ${entry.resultSummary} · ${entry.durationMs} ms`);
        lines.push(`  - Params: \`${summarizeToolParams(entry.params)}\``);
        if (entry.error) lines.push(`  - Error: ${entry.error}`);
      }
      lines.push("");
    }

    if (message.agentSuggestions?.length) {
      lines.push("### Agent Suggestions", "");
      for (const suggestion of message.agentSuggestions) {
        lines.push(
          `- **${suggestion.agentName}** (${suggestion.mode}, ${Math.round(suggestion.confidence * 100)}% match)`,
        );
        lines.push(`  - Reason: ${suggestion.reason}`);
        if (suggestion.matchedTerms?.length) {
          lines.push(`  - Matched terms: ${suggestion.matchedTerms.join(", ")}`);
        }
        if (suggestion.matchedConcepts?.length) {
          lines.push(`  - Routing evidence: ${suggestion.matchedConcepts.join("; ")}`);
        }
        if (suggestion.matchedResources?.length) {
          lines.push(
            `  - Planned sources: ${suggestion.matchedResources.map(chatResourceLabel).join(", ")}`,
          );
        }
        lines.push(`  - Scopes: ${suggestion.scopes.join(", ") || "none"}`);
      }
      lines.push("");
    }
  }

  return capExportContent(`${lines.join("\n")}\n`);
}

function summarizeToolParams(params: unknown): string {
  if (!params || typeof params !== "object") return "{}";
  const json = JSON.stringify(params);
  if (!json) return "{}";
  return json.length > 180 ? `${json.slice(0, 180)}...` : json;
}

function formatSourceQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function chatResourceLabel(resource: GraphCacheResourceKind): string {
  const labels: Record<GraphCacheResourceKind, string> = {
    androidManagedAppProtections: "Android app protection policies",
    assignmentFilters: "Assignment filters",
    autopilotEvents: "Autopilot events",
    conditionalAccessPolicies: "Conditional Access policies",
    configurationPolicies: "Settings catalog policies",
    detectedApps: "Detected installed apps",
    deviceCompliancePolicies: "Device compliance policies",
    deviceConfigurations: "Legacy device configuration profiles",
    deviceEnrollmentConfigurations: "Enrollment configurations",
    deviceHealthScripts: "Remediations",
    deviceManagementScripts: "Platform scripts",
    directoryAudits: "Directory audit logs",
    intuneAuditEvents: "Intune audit events",
    endpointSecurityIntents: "Endpoint security policies",
    entraDevices: "Entra devices",
    groupPolicyConfigurations: "Administrative templates",
    groups: "Groups",
    iosManagedAppProtections: "iOS app protection policies",
    managedAppPolicies: "Managed app policies",
    managedDeviceEncryptionStates: "Device encryption states",
    managedDeviceOverview: "Managed device overview",
    managedDevices: "Intune managed devices",
    mobileAppConfigurations: "App configuration policies",
    mobileApps: "Intune apps",
    roleScopeTags: "Scope tags",
    signIns: "Sign-in logs",
    troubleshootingEvents: "Troubleshooting events",
    users: "Users",
    windowsAutopilotDevices: "Windows Autopilot devices",
    windowsAutopilotProfiles: "Windows Autopilot profiles",
    windowsFeatureUpdateProfiles: "Windows feature update policies",
    windowsQualityUpdateProfiles: "Windows quality update policies",
    namedLocations: "Named locations",
    authenticationMethodsPolicy: "Authentication methods policy",
    authorizationPolicy: "Authorization policy",
    crossTenantAccessPolicy: "Cross-tenant access policy",
    directoryRoles: "Directory roles",
    administrativeUnits: "Administrative units",
    applications: "App registrations",
    servicePrincipals: "Service principals",
    domains: "Domains",
    securityAlerts: "Defender alerts",
    securityIncidents: "Defender incidents",
    secureScores: "Secure Score history",
    secureScoreControlProfiles: "Secure Score controls",
  };
  return labels[resource];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function capExportContent(content: string): string {
  const maxLength = 1_900_000;
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n\n_Export truncated by OpenAdminOS because it exceeded the local save limit._\n`;
}
