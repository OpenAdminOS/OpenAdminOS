import type { RunGraphApi } from "@openadminos/agent-sdk";

import {
  CHAT_PROMPT_GROUPS,
  CHAT_SUGGESTED_PROMPTS,
  type ChatSuggestedPrompt,
} from "../../src/shared/chat-prompts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TABLE_ROWS = 10;
const FOOTER =
  "Shown without an LLM summary. Pick a provider in Settings to get explained answers.";

type Row = Record<string, unknown>;
type TableRow = readonly unknown[];

export const SAMPLE_NO_PROVIDER_PROMPTS = [
  CHAT_PROMPT_GROUPS[0].prompts[0],
  CHAT_PROMPT_GROUPS[2].prompts[0],
  CHAT_PROMPT_GROUPS[4].prompts[0],
  CHAT_PROMPT_GROUPS[6].prompts[0],
] as const;

const promptByNormalizedText = new Map(
  CHAT_SUGGESTED_PROMPTS.map((prompt) => [normalizePrompt(prompt), prompt]),
);

export function normalizePrompt(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function sampleProviderRequiredAnswer(): string {
  return [
    "Answering your own questions needs an LLM provider. Pick one in Settings, or try one of these:",
    "",
    ...SAMPLE_NO_PROVIDER_PROMPTS.map((prompt) => `- ${prompt}`),
  ].join("\n");
}

export async function buildSampleTenantSuggestedPromptAnswer(
  graph: RunGraphApi,
  question: string,
  nowInput: Date = new Date(),
): Promise<string | undefined> {
  const prompt = promptByNormalizedText.get(normalizePrompt(question));
  if (!prompt) return undefined;
  const now = new Date(nowInput.getTime());

  switch (prompt) {
    case "Which managed devices have not synced in the last 7 days?":
      return staleManagedDevices(graph, now);
    case "Which devices are stale in Intune but still active in Entra?":
      return staleIntuneActiveEntra(graph, now);
    case "Which devices are both stale and noncompliant?":
      return staleNoncompliantDevices(graph, now);
    case "Which Windows devices are not encrypted?":
      return unencryptedWindowsDevices(graph);
    case "Which user accounts are disabled?":
      return disabledUsers(graph);
    case "Which guest users have not signed in recently?":
      return inactiveGuests(graph, now);
    case "Which users are linked to noncompliant managed devices?":
      return usersWithNoncompliantDevices(graph);
    case "Which users appear in recent directory audit events?":
      return usersInDirectoryAudits(graph, now);
    case "Which required apps are assigned but not installed on targeted devices?":
      return requiredAppInstallFailures(graph);
    case "Which app deployments appear tied to the primary user?":
      return primaryUserAppDeployments(graph);
    case "Which superseded apps are still detected on devices?":
      return supersededAppsStillDetected(graph);
    case "Which app assignments target empty or stale groups?":
      return emptyOrStaleGroupAssignments(graph, now);
    case "Which compliance policies were modified most recently?":
      return recentlyModifiedCompliancePolicies(graph, now);
    case "Which Conditional Access policies are disabled or report-only?":
      return inactiveConditionalAccessPolicies(graph);
    case "Which configuration policies have the highest setting counts?":
      return configurationPoliciesBySettingCount(graph);
    case "Which policies changed recently?":
      return recentlyChangedPolicies(graph, now);
    case "Which recent sign-ins failed because of Conditional Access?":
      return conditionalAccessFailures(graph);
    case "Which users have repeated failed sign-ins?":
      return repeatedSignInFailures(graph);
    case "Which risky sign-ins need review?":
      return riskySignIns(graph);
    case "Which applications have the most sign-in failures?":
      return applicationsBySignInFailures(graph);
    case "Which Entra devices are not managed in Intune?":
      return unmanagedEntraDevices(graph);
    case "Which app registration secrets or certificates expire soon?":
      return expiringAppCredentials(graph, now);
    case "Which users hold privileged directory roles?":
      return privilegedRoleMembers(graph);
    case "Which Conditional Access policies exclude guest or external identities?":
      return guestExclusionPolicies(graph);
    case "Which high-severity Defender incidents are open?":
      return openHighSeverityIncidents(graph);
    case "Which Defender alerts were raised this week?":
      return defenderAlertsThisWeek(graph, now);
    case "How has Secure Score changed over the last 90 days?":
      return secureScoreChange(graph, now);
    case "Which Secure Score improvement actions rank highest?":
      return secureScoreActions(graph);
  }
}

async function staleManagedDevices(graph: RunGraphApi, now: Date) {
  const users = indexById(await readCollection(graph, "/users"));
  const rows = (await readCollection(graph, "/deviceManagement/managedDevices"))
    .filter((device) => isManaged(device) && daysOld(device.lastSyncDateTime, now) > 7)
    .sort(oldestFirst("lastSyncDateTime"));
  return answer(
    `${rows.length} managed devices have not synced in more than 7 days.`,
    ["Device", "OS", "Last sync", "Compliance", "Primary user"],
    rows.map((device) => [
      device.deviceName,
      `${device.operatingSystem} ${device.osVersion}`,
      shortDate(device.lastSyncDateTime),
      device.complianceState,
      users.get(String(device.userId))?.displayName ?? device.userPrincipalName,
    ]),
  );
}

async function staleIntuneActiveEntra(graph: RunGraphApi, now: Date) {
  const [managed, entra] = await Promise.all([
    readCollection(graph, "/deviceManagement/managedDevices"),
    readCollection(graph, "/devices"),
  ]);
  const entraByDeviceId = new Map(
    entra.map((device) => [String(device.deviceId), device]),
  );
  const rows = managed
    .filter((device) => {
      const entraDevice = entraByDeviceId.get(String(device.azureADDeviceId));
      return (
        isManaged(device) &&
        daysOld(device.lastSyncDateTime, now) > 7 &&
        Boolean(entraDevice) &&
        daysOld(entraDevice?.approximateLastSignInDateTime, now) <= 7
      );
    })
    .sort(oldestFirst("lastSyncDateTime"));
  return answer(
    `${rows.length} devices are stale in Intune but were active in Entra within 7 days.`,
    ["Device", "OS", "Intune sync", "Entra activity", "Compliance"],
    rows.map((device) => {
      const entraDevice = entraByDeviceId.get(String(device.azureADDeviceId));
      return [
        device.deviceName,
        device.operatingSystem,
        shortDate(device.lastSyncDateTime),
        shortDate(entraDevice?.approximateLastSignInDateTime),
        device.complianceState,
      ];
    }),
  );
}

async function staleNoncompliantDevices(graph: RunGraphApi, now: Date) {
  const rows = (await readCollection(graph, "/deviceManagement/managedDevices"))
    .filter(
      (device) =>
        isManaged(device) &&
        daysOld(device.lastSyncDateTime, now) > 7 &&
        device.complianceState === "noncompliant",
    )
    .sort(oldestFirst("lastSyncDateTime"));
  return answer(
    `${rows.length} managed devices are both stale and noncompliant.`,
    ["Device", "OS", "Last sync", "Primary user", "Reason"],
    rows.map((device) => [
      device.deviceName,
      device.operatingSystem,
      shortDate(device.lastSyncDateTime),
      device.userPrincipalName,
      arrayStrings(device.complianceReasons).join(", "),
    ]),
  );
}

async function unencryptedWindowsDevices(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/deviceManagement/managedDevices"))
    .filter(
      (device) =>
        isManaged(device) &&
        device.operatingSystem === "Windows" &&
        device.isEncrypted === false,
    )
    .sort(byText("deviceName"));
  return answer(
    `${rows.length} managed Windows devices are not encrypted.`,
    ["Device", "OS version", "Compliance", "Primary user", "Last sync"],
    rows.map((device) => [
      device.deviceName,
      device.osVersion,
      device.complianceState,
      device.userPrincipalName,
      shortDate(device.lastSyncDateTime),
    ]),
  );
}

async function disabledUsers(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/users"))
    .filter((user) => user.accountEnabled === false)
    .sort(byText("displayName"));
  return answer(
    `${rows.length} user accounts are disabled.`,
    ["User", "UPN", "Type", "Last sign-in"],
    rows.map((user) => [
      user.displayName,
      user.userPrincipalName,
      user.userType,
      shortDate(nested(user, "signInActivity", "lastSuccessfulSignInDateTime")),
    ]),
  );
}

async function inactiveGuests(graph: RunGraphApi, now: Date) {
  const rows = (await readCollection(graph, "/users"))
    .filter(
      (user) =>
        user.userType === "Guest" &&
        daysOld(nested(user, "signInActivity", "lastSuccessfulSignInDateTime"), now) > 90,
    )
    .sort((left, right) =>
      Date.parse(String(nested(left, "signInActivity", "lastSuccessfulSignInDateTime"))) -
      Date.parse(String(nested(right, "signInActivity", "lastSuccessfulSignInDateTime"))),
    );
  return answer(
    `${rows.length} guest users have not signed in for more than 90 days.`,
    ["Guest", "UPN", "Last sign-in", "Invitation state"],
    rows.map((user) => [
      user.displayName,
      user.userPrincipalName,
      shortDate(nested(user, "signInActivity", "lastSuccessfulSignInDateTime")),
      user.externalUserState,
    ]),
  );
}

async function usersWithNoncompliantDevices(graph: RunGraphApi) {
  const [users, devices] = await Promise.all([
    readCollection(graph, "/users"),
    readCollection(graph, "/deviceManagement/managedDevices"),
  ]);
  const userById = indexById(users);
  const grouped = groupBy(
    devices.filter((device) => isManaged(device) && device.complianceState === "noncompliant"),
    (device) => String(device.userId),
  );
  const rows = [...grouped.entries()]
    .map(([userId, linked]) => ({ user: userById.get(userId), devices: linked }))
    .filter((entry) => entry.user)
    .sort((left, right) => left.devices[0]!.deviceName!.toString().localeCompare(right.devices[0]!.deviceName!.toString()));
  return answer(
    `${rows.length} users are linked to at least one noncompliant managed device.`,
    ["User", "UPN", "Noncompliant devices", "Device names"],
    rows.map(({ user, devices: linked }) => [
      user?.displayName,
      user?.userPrincipalName,
      linked.length,
      linked.map((device) => String(device.deviceName)).join(", "),
    ]),
  );
}

async function usersInDirectoryAudits(graph: RunGraphApi, now: Date) {
  const audits = (await readCollection(graph, "/auditLogs/directoryAudits"))
    .filter((audit) => daysOld(audit.activityDateTime, now) <= 7);
  const entries = new Map<string, { user: Row; events: Row[] }>();
  for (const audit of audits) {
    for (const target of rowArray(audit.targetResources)) {
      if (target.type !== "User") continue;
      const key = String(target.id);
      const current = entries.get(key) ?? { user: target, events: [] };
      current.events.push(audit);
      entries.set(key, current);
    }
  }
  const rows = [...entries.values()].sort((left, right) =>
    String(left.user.displayName).localeCompare(String(right.user.displayName)),
  );
  return answer(
    `${rows.length} users appear as targets in directory audit events from the last 7 days.`,
    ["User", "Events", "Latest activity", "Result"],
    rows.map(({ user, events }) => [
      user.displayName,
      events.length,
      events[0]?.activityDisplayName,
      events[0]?.result,
    ]),
  );
}

async function requiredAppInstallFailures(graph: RunGraphApi) {
  const [apps, devices, users] = await Promise.all([
    readCollection(graph, "/deviceAppManagement/mobileApps"),
    readCollection(graph, "/deviceManagement/managedDevices"),
    readCollection(graph, "/users"),
  ]);
  const deviceById = indexById(devices);
  const userById = indexById(users);
  const rows = apps.flatMap((app) =>
    app.isRequired === true
      ? rowArray(app.deviceInstallStatuses)
          .filter((status) => status.installState !== "installed")
          .map((status) => ({ app, status }))
      : [],
  );
  return answer(
    `${rows.length} targeted device installs for required apps are not installed.`,
    ["App", "Device", "Primary user", "Install state", "Last report"],
    rows.map(({ app, status }) => {
      const device = deviceById.get(String(status.deviceId));
      const user = userById.get(String(status.userId));
      return [
        app.displayName,
        device?.deviceName ?? status.deviceName,
        user?.displayName ?? device?.userPrincipalName,
        status.installState,
        shortDate(status.lastSyncDateTime),
      ];
    }),
  );
}

async function primaryUserAppDeployments(graph: RunGraphApi) {
  const [apps, devices, users] = await Promise.all([
    readCollection(graph, "/deviceAppManagement/mobileApps"),
    readCollection(graph, "/deviceManagement/managedDevices"),
    readCollection(graph, "/users"),
  ]);
  const deviceById = indexById(devices);
  const userById = indexById(users);
  const rows = apps.flatMap((app) =>
    rowArray(app.deviceInstallStatuses)
      .filter((status) => status.assignmentSource === "primaryUser")
      .map((status) => ({ app, status })),
  );
  return answer(
    `${rows.length} app deployment records are tied to a device's primary user.`,
    ["App", "Device", "Primary user", "Intent", "Install state"],
    rows.map(({ app, status }) => {
      const device = deviceById.get(String(status.deviceId));
      const user = userById.get(String(status.userId));
      return [
        app.displayName,
        device?.deviceName ?? status.deviceName,
        user?.displayName ?? device?.userPrincipalName,
        status.intent,
        status.installState,
      ];
    }),
  );
}

async function supersededAppsStillDetected(graph: RunGraphApi) {
  const [apps, detected] = await Promise.all([
    readCollection(graph, "/deviceAppManagement/mobileApps"),
    readCollection(graph, "/deviceManagement/detectedApps"),
  ]);
  const detectedByName = new Map(
    detected.map((app) => [String(app.displayName), app]),
  );
  const rows = apps
    .filter((app) => typeof app.supersededByAppId === "string")
    .map((app) => ({ app, detected: detectedByName.get(String(app.displayName)) }))
    .filter((entry) => Number(entry.detected?.deviceCount ?? 0) > 0);
  const deviceCount = rows.reduce(
    (total, entry) => total + Number(entry.detected?.deviceCount ?? 0),
    0,
  );
  return answer(
    `${rows.length} superseded app is still detected on ${deviceCount} devices.`,
    ["Superseded app", "Replacement", "Detected devices", "Version"],
    rows.map(({ app, detected: detectedApp }) => [
      app.displayName,
      apps.find((candidate) => candidate.id === app.supersededByAppId)?.displayName,
      detectedApp?.deviceCount,
      detectedApp?.version,
    ]),
  );
}

async function emptyOrStaleGroupAssignments(graph: RunGraphApi, now: Date) {
  const apps = await readCollection(graph, "/deviceAppManagement/mobileApps");
  const rows: Array<{ app: Row; assignment: Row; group: Row; reason: string }> = [];
  for (const app of apps) {
    const assignments = await readCollection(
      graph,
      `/deviceAppManagement/mobileApps/${encodeURIComponent(String(app.id))}/assignments`,
    );
    for (const assignment of assignments) {
      const groupId = nested(assignment, "target", "groupId");
      if (typeof groupId !== "string") continue;
      const group = await readItem(graph, `/groups/${encodeURIComponent(groupId)}`);
      const members = await readCollection(
        graph,
        `/groups/${encodeURIComponent(groupId)}/members`,
      );
      const stale = daysOld(group.renewedDateTime, now) > 180;
      if (members.length === 0 || stale) {
        rows.push({
          app,
          assignment,
          group,
          reason: members.length === 0 ? "Empty group" : "No renewal in 180 days",
        });
      }
    }
  }
  return answer(
    `${rows.length} app assignments target an empty or stale group.`,
    ["App", "Intent", "Group", "Reason", "Last renewed"],
    rows.map(({ app, assignment, group, reason }) => [
      app.displayName,
      assignment.intent,
      group.displayName,
      reason,
      shortDate(group.renewedDateTime),
    ]),
  );
}

async function recentlyModifiedCompliancePolicies(graph: RunGraphApi, now: Date) {
  const rows = (await readCollection(graph, "/deviceManagement/deviceCompliancePolicies"))
    .filter((policy) => daysOld(policy.lastModifiedDateTime, now) <= 30)
    .sort(newestFirst("lastModifiedDateTime"));
  return answer(
    `${rows.length} compliance policies were modified in the last 30 days.`,
    ["Policy", "Modified", "Created", "Assignments"],
    rows.map((policy) => [
      policy.displayName,
      shortDate(policy.lastModifiedDateTime),
      shortDate(policy.createdDateTime),
      rowArray(policy.assignments).length,
    ]),
  );
}

async function inactiveConditionalAccessPolicies(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/identity/conditionalAccess/policies"))
    .filter(
      (policy) =>
        policy.state === "disabled" ||
        policy.state === "enabledForReportingButNotEnforced",
    )
    .sort(byText("displayName"));
  return answer(
    `${rows.length} Conditional Access policies are disabled or report-only.`,
    ["Policy", "State", "Modified", "Included apps"],
    rows.map((policy) => [
      policy.displayName,
      policy.state === "enabledForReportingButNotEnforced" ? "Report-only" : "Disabled",
      shortDate(policy.modifiedDateTime),
      arrayStrings(nested(policy, "conditions", "applications", "includeApplications")).join(", "),
    ]),
  );
}

async function configurationPoliciesBySettingCount(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/deviceManagement/configurationPolicies"))
    .sort((left, right) => Number(right.settingCount) - Number(left.settingCount));
  return answer(
    `${rows.length} configuration policies have setting counts available for ranking.`,
    ["Policy", "Settings", "Platform", "Modified", "Assigned"],
    rows.map((policy) => [
      policy.displayName,
      policy.settingCount,
      policy.platforms,
      shortDate(policy.lastModifiedDateTime),
      policy.isAssigned === true ? "Yes" : "No",
    ]),
  );
}

async function recentlyChangedPolicies(graph: RunGraphApi, now: Date) {
  const definitions = [
    ["Compliance", "/deviceManagement/deviceCompliancePolicies", "lastModifiedDateTime"],
    ["Configuration", "/deviceManagement/deviceConfigurations", "lastModifiedDateTime"],
    ["Settings catalog", "/deviceManagement/configurationPolicies", "lastModifiedDateTime"],
    ["Conditional Access", "/identity/conditionalAccess/policies", "modifiedDateTime"],
  ] as const;
  const collections = await Promise.all(
    definitions.map(async ([type, path, field]) =>
      (await readCollection(graph, path)).map(
        (policy): Row & { policyType: string; changedAt: unknown } => ({
          ...policy,
          policyType: type,
          changedAt: policy[field],
        }),
      ),
    ),
  );
  const rows = collections
    .flat()
    .filter((policy) => daysOld(policy.changedAt, now) <= 14)
    .sort(newestFirst("changedAt"));
  return answer(
    `${rows.length} policies changed in the last 14 days.`,
    ["Policy", "Type", "Changed", "Description"],
    rows.map((policy) => [
      policy.displayName,
      policy.policyType,
      shortDate(policy.changedAt),
      policy.description,
    ]),
  );
}

async function conditionalAccessFailures(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/auditLogs/signIns"))
    .filter(
      (signIn) =>
        Number(nested(signIn, "status", "errorCode")) === 53003 ||
        signIn.conditionalAccessStatus === "failure",
    )
    .sort(newestFirst("createdDateTime"));
  return answer(
    `${rows.length} recent sign-ins failed because of Conditional Access.`,
    ["User", "Application", "Time", "Error", "Location"],
    rows.map((signIn) => [
      signIn.userDisplayName,
      signIn.appDisplayName,
      shortDateTime(signIn.createdDateTime),
      nested(signIn, "status", "errorCode"),
      nested(signIn, "location", "city"),
    ]),
  );
}

async function repeatedSignInFailures(graph: RunGraphApi) {
  const failed = (await readCollection(graph, "/auditLogs/signIns")).filter(
    (signIn) => Number(nested(signIn, "status", "errorCode")) !== 0,
  );
  const grouped = groupBy(failed, (signIn) => String(signIn.userId));
  const rows = [...grouped.values()]
    .filter((events) => events.length >= 2)
    .sort((left, right) => right.length - left.length);
  return answer(
    `${rows.length} users have repeated failed sign-ins.`,
    ["User", "UPN", "Failures", "Top application", "Latest failure"],
    rows.map((events) => [
      events[0]?.userDisplayName,
      events[0]?.userPrincipalName,
      events.length,
      mostCommon(events.map((event) => String(event.appDisplayName))),
      shortDateTime(events[0]?.createdDateTime),
    ]),
  );
}

async function riskySignIns(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/auditLogs/signIns"))
    .filter(
      (signIn) =>
        signIn.riskState === "atRisk" ||
        ["medium", "high"].includes(String(signIn.riskLevelAggregated)),
    )
    .sort(newestFirst("createdDateTime"));
  return answer(
    `${rows.length} risky sign-ins need review.`,
    ["User", "Application", "Risk", "State", "Time"],
    rows.map((signIn) => [
      signIn.userDisplayName,
      signIn.appDisplayName,
      signIn.riskLevelAggregated,
      signIn.riskState,
      shortDateTime(signIn.createdDateTime),
    ]),
  );
}

async function applicationsBySignInFailures(graph: RunGraphApi) {
  const failed = (await readCollection(graph, "/auditLogs/signIns")).filter(
    (signIn) => Number(nested(signIn, "status", "errorCode")) !== 0,
  );
  const grouped = groupBy(failed, (signIn) => String(signIn.appDisplayName));
  const rows = [...grouped.entries()]
    .map(([app, events]) => ({ app, events }))
    .sort((left, right) => right.events.length - left.events.length);
  return answer(
    `${rows.length} applications have recent sign-in failures.`,
    ["Application", "Failures", "Affected users", "Latest failure"],
    rows.map(({ app, events }) => [
      app,
      events.length,
      new Set(events.map((event) => String(event.userId))).size,
      shortDateTime(events[0]?.createdDateTime),
    ]),
  );
}

async function unmanagedEntraDevices(graph: RunGraphApi) {
  const [managed, entra] = await Promise.all([
    readCollection(graph, "/deviceManagement/managedDevices"),
    readCollection(graph, "/devices"),
  ]);
  const managedIds = new Set(managed.map((device) => String(device.azureADDeviceId)));
  const rows = entra
    .filter(
      (device) =>
        device.isManaged === false && !managedIds.has(String(device.deviceId)),
    )
    .sort(byText("displayName"));
  return answer(
    `${rows.length} Entra devices are not managed in Intune.`,
    ["Device", "OS", "OS version", "Last activity", "Trust type"],
    rows.map((device) => [
      device.displayName,
      device.operatingSystem,
      device.operatingSystemVersion,
      shortDate(device.approximateLastSignInDateTime),
      device.trustType,
    ]),
  );
}

async function expiringAppCredentials(graph: RunGraphApi, now: Date) {
  const apps = await readCollection(graph, "/applications");
  const rows = apps.flatMap((app) => [
    ...rowArray(app.passwordCredentials).map((credential) => ({ app, credential, type: "Secret" })),
    ...rowArray(app.keyCredentials).map((credential) => ({ app, credential, type: "Certificate" })),
  ]).filter(({ credential }) => {
    const remaining = Date.parse(String(credential.endDateTime)) - now.getTime();
    return remaining >= 0 && remaining <= 30 * DAY_MS;
  }).sort((left, right) =>
    Date.parse(String(left.credential.endDateTime)) - Date.parse(String(right.credential.endDateTime)),
  );
  return answer(
    `${rows.length} app registration credential expires in the next 30 days.`,
    ["Application", "Credential", "Type", "Expires", "Days left"],
    rows.map(({ app, credential, type }) => [
      app.displayName,
      credential.displayName,
      type,
      shortDate(credential.endDateTime),
      Math.ceil((Date.parse(String(credential.endDateTime)) - now.getTime()) / DAY_MS),
    ]),
  );
}

async function privilegedRoleMembers(graph: RunGraphApi) {
  const privilegedNames = new Set([
    "Global Administrator",
    "Intune Administrator",
    "Privileged Role Administrator",
  ]);
  const roles = (await readCollection(graph, "/directoryRoles")).filter((role) =>
    privilegedNames.has(String(role.displayName)),
  );
  const assignments: Array<{ role: Row; member: Row }> = [];
  for (const role of roles) {
    const members = await readCollection(
      graph,
      `/directoryRoles/${encodeURIComponent(String(role.id))}/members`,
    );
    assignments.push(...members.map((member) => ({ role, member })));
  }
  const userCount = new Set(assignments.map(({ member }) => String(member.id))).size;
  return answer(
    `${userCount} users hold ${assignments.length} assignments across privileged directory roles.`,
    ["User", "UPN", "Role", "Account enabled"],
    assignments.map(({ role, member }) => [
      member.displayName,
      member.userPrincipalName,
      role.displayName,
      member.accountEnabled === true ? "Yes" : "No",
    ]),
  );
}

async function guestExclusionPolicies(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/identity/conditionalAccess/policies"))
    .filter((policy) => Boolean(nested(policy, "conditions", "users", "excludeGuestsOrExternalUsers")))
    .sort(byText("displayName"));
  return answer(
    `${rows.length} Conditional Access policy excludes guest or external identities.`,
    ["Policy", "State", "Excluded identity types", "Modified"],
    rows.map((policy) => [
      policy.displayName,
      policy.state,
      nested(
        policy,
        "conditions",
        "users",
        "excludeGuestsOrExternalUsers",
        "guestOrExternalUserTypes",
      ),
      shortDate(policy.modifiedDateTime),
    ]),
  );
}

async function openHighSeverityIncidents(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/security/incidents"))
    .filter(
      (incident) =>
        incident.severity === "high" &&
        !["resolved", "redirected"].includes(String(incident.status).toLowerCase()),
    )
    .sort(newestFirst("createdDateTime"));
  return answer(
    `${rows.length} high-severity Defender incidents are open.`,
    ["Incident", "Status", "Created", "Last updated", "Assigned to"],
    rows.map((incident) => [
      incident.displayName,
      incident.status,
      shortDateTime(incident.createdDateTime),
      shortDateTime(incident.lastUpdateDateTime),
      incident.assignedTo,
    ]),
  );
}

async function defenderAlertsThisWeek(graph: RunGraphApi, now: Date) {
  const rows = (await readCollection(graph, "/security/alerts_v2"))
    .filter((alert) => daysOld(alert.createdDateTime, now) <= 7)
    .sort(newestFirst("createdDateTime"));
  return answer(
    `${rows.length} Defender alerts were raised in the last 7 days.`,
    ["Alert", "Severity", "Status", "Source", "Created"],
    rows.map((alert) => [
      alert.title,
      alert.severity,
      alert.status,
      alert.serviceSource,
      shortDateTime(alert.createdDateTime),
    ]),
  );
}

async function secureScoreChange(graph: RunGraphApi, now: Date) {
  const scores = (await readCollection(graph, "/security/secureScores"))
    .filter((score) => daysOld(score.createdDateTime, now) <= 90)
    .sort(newestFirst("createdDateTime"));
  const newest = scores[0]!;
  const oldest = scores.at(-1)!;
  const change = Number(newest.currentScore) - Number(oldest.currentScore);
  const direction = change >= 0 ? "increased" : "decreased";
  const sampled = scores.filter(
    (_score, index) => index === 0 || index === scores.length - 1 || index % 3 === 0,
  );
  return answer(
    `Secure Score ${direction} by ${Math.abs(change).toFixed(1)} points over 90 days, from ${Number(oldest.currentScore).toFixed(1)} to ${Number(newest.currentScore).toFixed(1)}.`,
    ["Date", "Score", "Maximum", "Percent"],
    sampled.map((score) => [
      shortDate(score.createdDateTime),
      Number(score.currentScore).toFixed(1),
      Number(score.maxScore).toFixed(1),
      `${((Number(score.currentScore) / Number(score.maxScore)) * 100).toFixed(1)}%`,
    ]),
  );
}

async function secureScoreActions(graph: RunGraphApi) {
  const rows = (await readCollection(graph, "/security/secureScoreControlProfiles"))
    .filter((control) => control.deprecated !== true)
    .sort(
      (left, right) =>
        Number(left.rank) - Number(right.rank) ||
        Number(right.maxScore) - Number(left.maxScore),
    );
  return answer(
    `${rows.length} Secure Score improvement actions are available, ranked by Microsoft's priority and score impact.`,
    ["Rank", "Action", "Score impact", "Cost", "User impact"],
    rows.map((control) => [
      control.rank,
      control.title,
      control.maxScore,
      control.implementationCost,
      control.userImpact,
    ]),
  );
}

function answer(
  sentence: string,
  columns: readonly string[],
  rows: readonly TableRow[],
): string {
  const visible = rows.slice(0, MAX_TABLE_ROWS);
  const lines = [
    sentence,
    "",
    `| ${columns.map(markdownCell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...visible.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ];
  if (rows.length > visible.length) {
    lines.push("", `and ${rows.length - visible.length} more.`);
  }
  lines.push("", FOOTER);
  return lines.join("\n");
}

async function readCollection(graph: RunGraphApi, initialPath: string): Promise<Row[]> {
  const rows: Row[] = [];
  let path = initialPath;
  const seen = new Set<string>();
  while (path) {
    if (seen.has(path)) throw new Error(`Sample Graph returned a repeated page: ${path}`);
    seen.add(path);
    const response = (await graph.request({ method: "GET", path })) as {
      value?: unknown;
      "@odata.nextLink"?: unknown;
    };
    rows.push(...rowArray(response.value));
    path = typeof response["@odata.nextLink"] === "string"
      ? response["@odata.nextLink"]
      : "";
  }
  return rows;
}

async function readItem(graph: RunGraphApi, path: string): Promise<Row> {
  const value = await graph.request({ method: "GET", path });
  return isRow(value) ? value : {};
}

function rowArray(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nested(row: Row, ...path: string[]): unknown {
  return path.reduce<unknown>((value, key) =>
    isRow(value) ? value[key] : undefined,
  row);
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function indexById(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function isManaged(device: Row): boolean {
  return device.retired !== true && device.managementState !== "retirePending";
}

function daysOld(value: unknown, now: Date): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? (now.getTime() - parsed) / DAY_MS : Infinity;
}

function shortDate(value: unknown): string {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toISOString().slice(0, 10);
}

function shortDateTime(value: unknown): string {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime())
    ? "Unknown"
    : parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function byText(field: string) {
  return (left: Row, right: Row) =>
    String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
}

function newestFirst(field: string) {
  return (left: Row, right: Row) =>
    Date.parse(String(right[field] ?? "")) - Date.parse(String(left[field] ?? ""));
}

function oldestFirst(field: string) {
  return (left: Row, right: Row) =>
    Date.parse(String(left[field] ?? "")) - Date.parse(String(right[field] ?? ""));
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "Unknown";
}

function markdownCell(value: unknown): string {
  return String(value ?? "Unknown")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

export const SAMPLE_TENANT_ANSWER_PROMPTS: readonly ChatSuggestedPrompt[] =
  CHAT_SUGGESTED_PROMPTS;

