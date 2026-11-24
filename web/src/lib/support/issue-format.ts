import { createHash } from "node:crypto";

// Keep the desktop and web formatters in sync. The web build has its own root.
const MAX_ISSUE_BODY_LENGTH = 58_000;
const MAX_DIAGNOSTICS_LENGTH = 40_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const COUNT_BUCKETS = ["0", "1-10", "11-100", "101-1000", "1001-10000", "10001+"];
const AGE_BUCKETS = ["<1h", "1-24h", "1-7d", "7-30d", ">30d"];
const DUE_BUCKETS = [...AGE_BUCKETS, "future"];
const SOURCES = ["sidebar", "run-failure", "settings-about", "native-menu"] as const;
const ERROR_CATEGORIES = [
  "ollama", "openai-codex", "apple-foundation", "auth", "permission", "rate-limit",
  "timeout", "network", "validation", "scheduler", "registry", "other",
];
const PROVIDERS = [
  "ollama", "apple-foundation", "lm-studio", "lemonade", "anthropic",
  "openai", "azure-openai", "copilot", "gemini",
];
const RUN_STATUSES = [
  "queued", "running", "awaiting-confirmation", "completed", "planned",
  "failed", "rejected", "cancelled",
];
const RUN_TRIGGERS = ["manual", "schedule"];
const PLATFORMS = [
  "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd",
];
const ARCHITECTURES = [
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64",
];
// Keep this allowlist aligned with GRAPH_CACHE_RESOURCE_KINDS in the agent SDK.
const CACHE_RESOURCES = [
  "managedDevices",
  "entraDevices",
  "users",
  "groups",
  "deviceCompliancePolicies",
  "deviceConfigurations",
  "configurationPolicies",
  "signIns",
  "directoryAudits",
  "intuneAuditEvents",
  "conditionalAccessPolicies",
  "mobileApps",
  "detectedApps",
  "managedAppPolicies",
  "iosManagedAppProtections",
  "androidManagedAppProtections",
  "mobileAppConfigurations",
  "deviceHealthScripts",
  "deviceManagementScripts",
  "windowsAutopilotDevices",
  "autopilotEvents",
  "windowsAutopilotProfiles",
  "deviceEnrollmentConfigurations",
  "windowsQualityUpdateProfiles",
  "windowsFeatureUpdateProfiles",
  "endpointSecurityIntents",
  "groupPolicyConfigurations",
  "assignmentFilters",
  "roleScopeTags",
  "managedDeviceOverview",
  "managedDeviceEncryptionStates",
  "troubleshootingEvents",
  "namedLocations",
  "authenticationMethodsPolicy",
  "authorizationPolicy",
  "crossTenantAccessPolicy",
  "directoryRoles",
  "administrativeUnits",
  "applications",
  "servicePrincipals",
  "domains",
  "securityAlerts",
  "securityIncidents",
  "secureScores",
  "secureScoreControlProfiles",
];

interface SupportIssuePayload {
  issue: {
    title: string;
    description: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    source: (typeof SOURCES)[number];
    appVersion: string;
  };
  diagnostics?: unknown;
}

interface FormattedSupportIssue {
  title: string;
  body: string;
  dedupInput: string;
}

export function bucketSupportCount(count: number): string {
  if (count <= 0) return "0";
  if (count <= 10) return "1-10";
  if (count <= 100) return "11-100";
  if (count <= 1_000) return "101-1000";
  if (count <= 10_000) return "1001-10000";
  return "10001+";
}

export function bucketSupportAge(value: unknown, createdAtMs: number, due = false): string | undefined {
  const timestamp = isoTimestamp(value);
  if (timestamp === undefined) return undefined;
  const age = createdAtMs - timestamp;
  if (age < 0) return due ? "future" : undefined;
  if (age < HOUR) return "<1h";
  if (age < DAY) return "1-24h";
  if (age < 7 * DAY) return "1-7d";
  if (age <= 30 * DAY) return "7-30d";
  return ">30d";
}

export function supportIssuePreviewDigest(title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([title, body])).digest("hex");
}

export function formatSupportIssue(
  body: unknown,
  publicAgentSlugs: ReadonlySet<string> = new Set(),
): { payload: FormattedSupportIssue } | { error: string } {
  if (!isObject(body)) return { error: "Body must be a JSON object." };
  if (!isObject(body.issue)) return { error: "`issue` is required." };

  const payload: SupportIssuePayload = {
    issue: {
      title: sanitizePublicText(stringField(body.issue.title), 180),
      description: sanitizePublicText(stringField(body.issue.description), 4_000),
      stepsToReproduce: optionalSanitizedText(body.issue.stepsToReproduce, 3_000),
      expectedBehavior: optionalSanitizedText(body.issue.expectedBehavior, 2_000),
      actualBehavior: optionalSanitizedText(body.issue.actualBehavior, 2_000),
      source: enumField(stringField(body.issue.source), SOURCES) ?? "sidebar",
      appVersion: versionField(body.issue.appVersion) ?? "",
    },
    diagnostics: sanitizeDiagnostics(body.diagnostics, publicAgentSlugs),
  };

  if (payload.issue.title.length < 3) return { error: "Issue title is required." };
  if (payload.issue.description.length < 10) {
    return { error: "Issue description is required." };
  }

  const title = `[Support] ${payload.issue.title}`;
  if (title.length > 200) return { error: "Issue title is too long." };

  const supportBody = buildIssueBody(payload);
  if (supportBody.length > MAX_ISSUE_BODY_LENGTH) {
    return { error: "Issue body is too long." };
  }

  return {
    payload: {
      title,
      body: supportBody,
      dedupInput: [
        title,
        payload.issue.description,
        payload.issue.stepsToReproduce ?? "",
        payload.issue.expectedBehavior ?? "",
        payload.issue.actualBehavior ?? "",
        payload.diagnostics === undefined ? "" : JSON.stringify(payload.diagnostics),
      ].join("\n"),
    },
  };
}

function buildIssueBody(payload: SupportIssuePayload): string {
  const diagnostics = payload.diagnostics
    ? `\n\`\`\`json\n${JSON.stringify(payload.diagnostics, null, 2)}\n\`\`\`\n`
    : "_Not included._\n";

  return [
    section("What happened", payload.issue.description),
    section("Steps to reproduce", payload.issue.stepsToReproduce),
    section("Expected behavior", payload.issue.expectedBehavior),
    section("Actual behavior", payload.issue.actualBehavior),
    section("Diagnostics", diagnostics),
    section(
      "Report metadata",
      [
        `App version: ${payload.issue.appVersion || "unknown"}`,
        `Source: ${payload.issue.source}`,
        "Submitted from OpenAdminOS after explicit public issue confirmation.",
      ].join("\n"),
    ),
    "---\n\n_Public issue created by the OpenAdminOS support report endpoint. Server-side redaction was applied before GitHub submission._\n",
  ].join("\n");
}

function section(title: string, value: string | undefined) {
  const body = value?.trim();
  if (!body) return `### ${title}\n_Not provided._\n`;
  return `### ${title}\n${body}\n`;
}

function sanitizeDiagnostics(value: unknown, publicAgentSlugs: ReadonlySet<string>) {
  if (!isObject(value)) return undefined;

  // Bound the submitted diagnostics before discarding any unrecognized fields.
  try {
    if (JSON.stringify(value).length > MAX_DIAGNOSTICS_LENGTH) {
      throw new SupportIssueSizeError(413, "Diagnostics payload is too large.");
    }
  } catch (error) {
    if (error instanceof RangeError) {
      throw new SupportIssueSizeError(413, "Diagnostics payload is too large.");
    }
    throw error;
  }

  // Both supported shapes share these fields. Older clients supplied exact counts
  // and timestamps, and included hashes. Only age buckets can enter the public body.
  const schemaVersion =
    value.schemaVersion === 1 || value.schemaVersion === "1" ? 1 :
    value.schemaVersion === 2 || value.schemaVersion === "2" ? 2 : undefined;
  const createdAtMs = isoTimestamp(value.createdAt);
  const agentSlug = (slug: unknown) =>
    typeof slug === "string" && (slug === "local" || publicAgentSlugs.has(slug))
      ? slug
      : undefined;

  return objectField(value, (diagnostics) => ({
    schemaVersion,
    createdAt: createdAtMs === undefined ? undefined : new Date(createdAtMs).toISOString().slice(0, 10),
    issueContext: objectField(diagnostics.issueContext, (context) => ({
      source: enumField(context.source, SOURCES),
      hasStepsToReproduce: booleanField(context.hasStepsToReproduce),
      hasExpectedBehavior: booleanField(context.hasExpectedBehavior),
      hasActualBehavior: booleanField(context.hasActualBehavior),
      agentSlug: agentSlug(context.agentSlug),
    })),
    app: objectField(diagnostics.app, (app) => ({
      version: versionField(app.version),
      packaged: booleanField(app.packaged),
      signed: booleanField(app.signed),
      platform: enumField(app.platform, ["macos", "windows", "linux", "unknown"]),
      processPlatform: enumField(app.processPlatform, PLATFORMS),
      processArch: enumField(app.processArch, ARCHITECTURES),
      osArch: enumField(app.osArch, ARCHITECTURES),
      osRelease: typeof app.osRelease === "string"
        ? /^\d{1,5}(?:\.\d{1,5}){1,3}(?=$|[-+_])/.exec(app.osRelease)?.[0]
        : undefined,
      electron: versionField(app.electron),
      chrome: versionField(app.chrome),
      node: versionField(app.node),
      v8: versionField(app.v8),
    })),
    privacy: objectField(diagnostics.privacy, (privacy) => ({
      tenantIdentifiersIncluded: booleanField(privacy.tenantIdentifiersIncluded),
      promptsIncluded: booleanField(privacy.promptsIncluded),
      graphResponsesIncluded: booleanField(privacy.graphResponsesIncluded),
      runResultsIncluded: booleanField(privacy.runResultsIncluded),
      runLogsIncluded: booleanField(privacy.runLogsIncluded),
      screenshotsIncluded: booleanField(privacy.screenshotsIncluded),
      automaticUploadByOpenAdminOS: booleanField(privacy.automaticUploadByOpenAdminOS),
      publicIssueSubmissionRequiresConfirmation: booleanField(privacy.publicIssueSubmissionRequiresConfirmation),
    })),
    state: objectField(diagnostics.state, (state) => ({
      activeProvider: state.activeProvider === null ? null : objectField(state.activeProvider, providerFields),
      providers: listField(state.providers, providerFields, PROVIDERS.length),
      tenants: objectField(state.tenants, (tenants) => ({
        connectedCount: countField(tenants.connectedCount),
        hasActiveTenant: booleanField(tenants.hasActiveTenant),
      })),
      agents: objectField(state.agents, (agents) => ({
        installedCount: countField(agents.installedCount),
        registryCount: countField(agents.registryCount),
        scheduledCount: countField(agents.scheduledCount),
      })),
      registry: objectField(state.registry, (registry) => ({
        sourceKind: enumField(registry.sourceKind, ["official", "custom"]),
        lastRefresh: enumField(registry.lastRefresh, AGE_BUCKETS),
        refreshErrorCategory: enumField(registry.refreshErrorCategory, ERROR_CATEGORIES),
        installCountsEnabled: booleanField(registry.installCountsEnabled),
      })),
      scheduler: objectField(state.scheduler, (scheduler) => ({
        supported: booleanField(scheduler.supported),
        enabled: booleanField(scheduler.enabled),
        requiresTenant: booleanField(scheduler.requiresTenant),
        activeScheduleCount: countField(scheduler.activeScheduleCount),
        lastWakeAt: enumField(scheduler.lastWakeAt, AGE_BUCKETS),
        lastSuccessAt: enumField(scheduler.lastSuccessAt, AGE_BUCKETS),
        nextDueAt: enumField(scheduler.nextDueAt, DUE_BUCKETS),
        lastErrorCategory: enumField(scheduler.lastErrorCategory, ERROR_CATEGORIES),
      })),
      companion: objectField(state.companion, (companion) => ({
        supported: booleanField(companion.supported),
        enabled: booleanField(companion.enabled),
        status: enumField(companion.status, ["not-registered", "enabled", "requires-approval", "not-found"]),
        helperBundled: booleanField(companion.helperBundled),
        startedAtLogin: booleanField(companion.startedAtLogin),
      })),
      runs: objectField(state.runs, (runs) => ({
        total: countField(runs.total),
        byStatus: countFields(runs.byStatus, RUN_STATUSES),
        byTrigger: countFields(runs.byTrigger, RUN_TRIGGERS),
        latestRunAt: enumField(runs.latestRunAt, AGE_BUCKETS),
      })),
      recentFailures: listField(state.recentFailures, (failure) => ({
        agentSlug: agentSlug(failure.agentSlug),
        trigger: enumField(failure.trigger, RUN_TRIGGERS),
        providerId: enumField(failure.providerId, PROVIDERS),
        queuedAt: enumField(failure.queuedAt, AGE_BUCKETS),
        finishedAt: enumField(failure.finishedAt, AGE_BUCKETS),
        failedStepCount: countField(failure.failedStepCount),
        errorLogCount: countField(failure.errorLogCount),
        errorCategory: enumField(failure.errorCategory, ERROR_CATEGORIES),
      }), 5),
      graphCache: objectField(state.graphCache, (cache) => ({
        available: booleanField(cache.available),
        reason: enumField(cache.reason, ["no-active-tenant", "status-unavailable"]),
        errorCategory: enumField(cache.errorCategory, ERROR_CATEGORIES),
        resourceCount: countField(cache.resourceCount),
        schedule: objectField(cache.schedule, (schedule) => ({
          enabled: booleanField(schedule.enabled),
          intervalMinutes: countField(schedule.intervalMinutes),
          updatedAt: enumField(schedule.updatedAt, AGE_BUCKETS),
          lastRunAt: enumField(schedule.lastRunAt, AGE_BUCKETS),
          lastSuccessAt: enumField(schedule.lastSuccessAt, AGE_BUCKETS),
          nextRunAt: enumField(schedule.nextRunAt, DUE_BUCKETS),
          lastErrorCategory: enumField(schedule.lastErrorCategory, ERROR_CATEGORIES),
        })),
        resources: listField(cache.resources, (entry) => {
          const resource = enumField(entry.resource, CACHE_RESOURCES);
          return resource === undefined ? undefined : {
            resource,
            rows: countField(entry.rows),
            pages: countField(entry.pages),
            pageLimitReached: booleanField(entry.pageLimitReached),
            refreshedAt: enumField(entry.refreshedAt, AGE_BUCKETS),
            scopeCount: countField(entry.scopeCount),
            lastErrorCategory: enumField(entry.lastErrorCategory, ERROR_CATEGORIES),
          };
        }, CACHE_RESOURCES.length),
      })),
    })),
  }));
}

type Fields = Record<string, unknown>;
type RebuildFields = (fields: Fields) => Fields | undefined;

function objectField(value: unknown, rebuild: RebuildFields): Fields | undefined {
  if (!isObject(value)) return undefined;
  const rebuilt = rebuild(value);
  return rebuilt && Object.values(rebuilt).some((field) => field !== undefined) ? rebuilt : undefined;
}

function listField(value: unknown, rebuild: RebuildFields, limit: number): Fields[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, limit).flatMap((entry) => {
    const fields = objectField(entry, rebuild);
    return fields ? [fields] : [];
  });
}

function providerFields(provider: Fields) {
  return {
    id: enumField(provider.id, PROVIDERS),
    isLocal: booleanField(provider.isLocal),
    status: enumField(provider.status, ["connected", "available", "not-installed", "error", "not-checked"]),
    modelCount: countField(provider.modelCount),
    hasDefaultModel: booleanField(provider.hasDefaultModel),
    detailCategory: enumField(provider.detailCategory, ERROR_CATEGORIES),
  };
}

function countFields(value: unknown, keys: readonly string[]) {
  return objectField(value, (fields) => Object.fromEntries(keys.map((key) => [key, countField(fields[key])])));
}

function countField(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (COUNT_BUCKETS.includes(value)) return value;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? bucketSupportCount(value)
    : undefined;
}

function enumField<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return choices.find((choice) => choice === value);
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function versionField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  return /^\d{1,5}(?:\.\d{1,5}){2,3}(?:-(?:nightly|electron|alpha|beta|rc)(?:\.\d{1,14})?)?$/.test(version)
    ? version
    : undefined;
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function optionalSanitizedText(value: unknown, maxLength: number): string | undefined {
  const raw = optionalStringField(value);
  return raw === undefined ? undefined : sanitizePublicText(raw, maxLength);
}

function sanitizePublicText(value: string, maxLength: number): string {
  return redactSupportPublicText(value)
    .replace(/\s+\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SupportIssueSizeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SECRET_REDACTION = "[redacted-secret]";
const PRIVATE_KEY_REDACTION = "[redacted-private-key]";

const SECRET_TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]*PRIVATE KEY-----/gi,
    replacement: PRIVATE_KEY_REDACTION,
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bgh[opsuhr]_[A-Za-z0-9_]{30,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bvercel_[A-Za-z0-9]{20,}\b/g, replacement: SECRET_REDACTION },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: SECRET_REDACTION,
  },
  { pattern: /\b[0-9a-f]{64,}\b/gi, replacement: SECRET_REDACTION },
  { pattern: /\b[A-Za-z0-9+/]{48,}={0,2}/g, replacement: SECRET_REDACTION },
];

const SECRET_KEY_NAMES =
  "api[_-]?key|apikey|client[_-]?secret|clientSecret|secret|password|passwd|pwd|refresh[_-]?token|access[_-]?token|id[_-]?token|auth[_-]?token|token|private[_-]?key|connection[_-]?string|webhook[_-]?url|sas[_-]?token|shared[_-]?access[_-]?signature";

const KEYED_SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_NAMES})\\b(\\s*["']?\\s*[:=]\\s*["']?)([^"'\\s,;\\]}]{8,})`,
  "gi",
);
const AUTH_HEADER_PATTERN =
  /\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

export function redactSupportSecrets(value: string): string {
  if (!value) return value;

  let redacted = value;
  for (const { pattern, replacement } of SECRET_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  redacted = redacted.replace(
    AUTH_HEADER_PATTERN,
    (_match, prefix: string) => `${prefix}${SECRET_REDACTION}`,
  );
  redacted = redacted.replace(
    KEYED_SECRET_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${SECRET_REDACTION}`,
  );

  return redacted;
}

export function redactSupportPublicText(value: string): string {
  return redactSupportSecrets(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[guid]",
    )
    .replace(/\b[A-Za-z0-9-]+\.onmicrosoft\.com\b/gi, "[tenant-domain]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\/Users\/[^\s"')\]]+/g, "[local-path]")
    .replace(/\/home\/[^\s"')\]]+/g, "[local-path]")
    .replace(/[A-Z]:\\Users\\[^\s"')\]]+/gi, "[local-path]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "[domain]");
}
