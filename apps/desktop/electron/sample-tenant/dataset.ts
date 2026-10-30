export const SAMPLE_TENANT_ID = "openadminos-sample-tenant";
export const SAMPLE_TENANT_NAME = "Contoso (sample data)";
export const SAMPLE_TENANT_USERNAME = "admin@contoso-sample.invalid";
export const SAMPLE_TENANT_HOME_ACCOUNT_ID = "openadminos-sample-account";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface SampleTenantDataset {
  loadedAt: string;
  resources: Record<string, Array<Record<string, unknown>>>;
  singletons: Record<string, Record<string, unknown>>;
}

type RelativeTime = `${"+" | "-"}${number} ${"hours" | "days"}`;

function at(now: Date, offset: RelativeTime): string {
  const match = /^([+-])(\d+) (hours|days)$/.exec(offset);
  if (!match) throw new Error(`Invalid sample timestamp offset: ${offset}`);
  const direction = match[1] === "+" ? 1 : -1;
  const amount = Number(match[2]);
  const unit = match[3] === "hours" ? HOUR_MS : DAY_MS;
  return new Date(now.getTime() + direction * amount * unit).toISOString();
}

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

const firstNames = [
  "Alex", "Amina", "Bao", "Camila", "Daniel", "Elena", "Farah", "Gabriel",
  "Hana", "Isaac", "Jade", "Kenji", "Leila", "Mateo", "Nadia", "Omar",
  "Priya", "Quinn", "Ravi", "Sofia", "Tariq", "Uma", "Victor", "Wen",
  "Yara", "Zane",
] as const;
const lastNames = [
  "Adler", "Bennett", "Chen", "Diaz", "Evans", "Fischer", "Gupta", "Haddad",
  "Ito", "Johansson", "Khan", "Lopez", "Mensah", "Novak", "Okafor", "Patel",
  "Reyes", "Singh", "Taylor", "Usman", "Volkov", "Wang", "Young", "Zoric",
] as const;

function sampleUsers(now: Date): Array<Record<string, unknown>> {
  return Array.from({ length: 80 }, (_, index) => {
    const guest = index >= 72;
    const disabled = [5, 31, 74, 77].includes(index);
    const first = firstNames[index % firstNames.length]!;
    const last = lastNames[(index * 7) % lastNames.length]!;
    const local = `${first}.${last}.${index + 1}`.toLowerCase();
    const userPrincipalName = guest
      ? `${local}_example.org#EXT#@contoso-sample.invalid`
      : `${local}@contoso-sample.invalid`;
    const staleGuest = guest && index !== 79;
    const lastSignIn = staleGuest
      ? at(now, `-${120 + (index - 72) * 19} days` as RelativeTime)
      : at(now, `-${(index % 18) + 1} days` as RelativeTime);
    return {
      id: id("user", index),
      displayName: `${first} ${last}`,
      givenName: first,
      surname: last,
      userPrincipalName,
      mail: `${local}@contoso-sample.invalid`,
      accountEnabled: !disabled,
      userType: guest ? "Guest" : "Member",
      usageLocation: index % 13 === 0 ? null : ["DE", "US", "GB", "NL"][index % 4],
      createdDateTime: at(now, `-${140 + index * 11} days` as RelativeTime),
      externalUserState: guest ? (index % 3 === 0 ? "PendingAcceptance" : "Accepted") : null,
      externalUserStateChangeDateTime: guest
        ? at(now, `-${100 + (index - 72) * 13} days` as RelativeTime)
        : null,
      signInActivity: {
        lastSignInDateTime: lastSignIn,
        lastSuccessfulSignInDateTime: lastSignIn,
      },
      assignedLicenses: index % 9 === 0 ? [] : [{ skuId: index % 2 === 0 ? "sku-e5" : "sku-ems-e5" }],
      assignedPlans: [],
    };
  });
}

function sampleDevices(now: Date, users: Array<Record<string, unknown>>) {
  const platforms = [
    ...Array.from({ length: 72 }, () => "Windows"),
    ...Array.from({ length: 18 }, () => "macOS"),
    ...Array.from({ length: 15 }, () => "iOS"),
    ...Array.from({ length: 15 }, () => "Android"),
  ];
  const managed = platforms.map((operatingSystem, index) => {
    const stale = index % 11 === 0 || index % 17 === 0;
    const noncompliant = index % 9 === 0 || index === 7 || index === 18;
    const unencrypted = operatingSystem === "Windows" && [7, 18, 35, 52, 69].includes(index);
    const owner = users[index % 72]!;
    const lastSyncDays = stale ? 10 + (index % 8) * 9 : index % 6;
    const deviceId = id("entra-device", index);
    return {
      id: id("managed-device", index),
      deviceName: `${operatingSystem === "Windows" ? "WIN" : operatingSystem === "macOS" ? "MAC" : operatingSystem === "iOS" ? "IOS" : "AND"}-${String(index + 1).padStart(3, "0")}`,
      userId: owner.id,
      userPrincipalName: owner.userPrincipalName,
      operatingSystem,
      osVersion:
        operatingSystem === "Windows"
          ? index % 8 === 0 ? "10.0.19045" : "10.0.26100"
          : operatingSystem === "macOS"
            ? index % 4 === 0 ? "14.7.1" : "15.2"
            : operatingSystem === "iOS"
              ? "18.2"
              : "15",
      lastSyncDateTime: at(now, `-${lastSyncDays} days` as RelativeTime),
      enrolledDateTime: at(now, `-${80 + index * 2} days` as RelativeTime),
      complianceState: noncompliant ? "noncompliant" : index % 23 === 0 ? "unknown" : "compliant",
      complianceGracePeriodExpirationDateTime: noncompliant ? at(now, "+2 days") : null,
      isEncrypted: !unencrypted,
      azureADDeviceId: deviceId,
      managementState: index === 44 ? "retirePending" : "managed",
      managedDeviceOwnerType: index % 6 === 0 ? "personal" : "company",
      deviceEnrollmentType: operatingSystem === "Windows" ? "windowsAutopilot" : "userEnrollment",
      manufacturer: operatingSystem === "Windows" ? ["Dell", "Lenovo", "Microsoft"][index % 3] : "Apple",
      model: operatingSystem === "Windows" ? ["Latitude 7440", "ThinkPad T14", "Surface Laptop 6"][index % 3] : operatingSystem,
      complianceReasons: noncompliant
        ? unencrypted
          ? ["BitLocker is not enabled", "Security baseline setting failed"]
          : [index % 2 === 0 ? "Required OS update is missing" : "Password policy is not met"]
        : [],
      retired: false,
    };
  });
  const entra = managed.map((device, index) => ({
    id: device.azureADDeviceId,
    deviceId: device.azureADDeviceId,
    displayName: device.deviceName,
    accountEnabled: index !== 44,
    approximateLastSignInDateTime:
      index % 11 === 0
        ? at(now, "-1 days")
        : at(now, `-${index % 17} days` as RelativeTime),
    operatingSystem: device.operatingSystem,
    operatingSystemVersion: device.osVersion,
    trustType: device.operatingSystem === "Windows" ? "AzureAd" : "Workplace",
    isManaged: true,
  }));
  const unmanagedEntra = Array.from({ length: 8 }, (_, index) => {
    const operatingSystem = ["Windows", "Windows", "macOS", "iOS", "Android", "Windows", "macOS", "Windows"][index]!;
    const operatingSystemVersion = operatingSystem === "Windows"
      ? index % 2 === 0 ? "10.0.22631" : "10.0.26100"
      : operatingSystem === "macOS"
        ? index % 2 === 0 ? "14.7.6" : "15.2.0"
        : operatingSystem === "iOS"
          ? "18.2.1"
          : "15.0";
    return {
      id: id("entra-unmanaged", index),
      deviceId: id("entra-unmanaged", index),
      displayName: `BYOD-${String(index + 1).padStart(3, "0")}`,
      accountEnabled: true,
      approximateLastSignInDateTime: at(now, `-${index + 1} days` as RelativeTime),
      operatingSystem,
      operatingSystemVersion,
      trustType: "Workplace",
      isManaged: false,
    };
  });
  return { managed, entra: [...entra, ...unmanagedEntra] };
}

function policies(now: Date) {
  const compliance = Array.from({ length: 5 }, (_, index) => ({
    id: id("compliance-policy", index),
    displayName: ["Windows baseline", "macOS FileVault", "iOS minimum OS", "Android work profile", "Privileged device baseline"][index],
    description: "Fictional sample policy for product evaluation.",
    createdDateTime: at(now, `-${220 + index * 17} days` as RelativeTime),
    lastModifiedDateTime: at(now, index < 2 ? `-${index + 1} days` as RelativeTime : `-${40 + index * 8} days` as RelativeTime),
    assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }],
  }));
  const configurations = Array.from({ length: 5 }, (_, index) => ({
    id: id("device-configuration", index),
    displayName: ["Windows security baseline", "macOS restrictions", "iOS restrictions", "Android restrictions", "Defender onboarding"][index],
    description: "Fictional sample configuration.",
    createdDateTime: at(now, `-${180 + index * 14} days` as RelativeTime),
    lastModifiedDateTime: at(now, `-${8 + index * 12} days` as RelativeTime),
  }));
  const settingsCatalog = Array.from({ length: 5 }, (_, index) => ({
    id: id("settings-catalog", index),
    name: ["Edge enterprise settings", "Windows Update ring", "Office security", "OneDrive known folders", "Local admin controls"][index],
    displayName: ["Edge enterprise settings", "Windows Update ring", "Office security", "OneDrive known folders", "Local admin controls"][index],
    description: "Fictional settings catalog policy.",
    platforms: "windows10",
    technologies: "mdm",
    createdDateTime: at(now, `-${160 + index * 15} days` as RelativeTime),
    lastModifiedDateTime: at(now, index === 1 ? "-3 days" : `-${15 + index * 9} days` as RelativeTime),
    settingCount: 8 + index * 3,
    isAssigned: index !== 4,
  }));
  return { compliance, configurations, settingsCatalog };
}

function conditionalAccessPolicies(now: Date) {
  return Array.from({ length: 8 }, (_, index) => ({
    id: id("ca-policy", index),
    displayName: [
      "Require MFA for administrators",
      "Require compliant devices",
      "Block legacy authentication",
      "Guest access controls",
      "Risky sign-in MFA",
      "Session controls for unmanaged devices",
      "Legacy pilot policy",
      "Report-only authentication strength",
    ][index],
    state: index === 6 ? "disabled" : index === 7 ? "enabledForReportingButNotEnforced" : "enabled",
    createdDateTime: at(now, `-${300 - index * 18} days` as RelativeTime),
    modifiedDateTime: at(now, `-${4 + index * 7} days` as RelativeTime),
    conditions: {
      users: {
        includeUsers: ["All"],
        excludeUsers: index === 1 ? ["group-break-glass", "group-helpdesk", "group-contractors"] : index === 0 ? ["group-break-glass"] : [],
        includeGuestsOrExternalUsers: index === 3 ? { guestOrExternalUserTypes: "b2bCollaborationGuest,b2bCollaborationMember" } : null,
        excludeGuestsOrExternalUsers: index === 5
          ? { guestOrExternalUserTypes: "b2bCollaborationGuest,b2bCollaborationMember,serviceProvider" }
          : null,
      },
      applications: { includeApplications: ["All"], excludeApplications: [] },
      clientAppTypes: index === 2 ? ["exchangeActiveSync", "other"] : ["all"],
      signInRiskLevels: index === 4 ? ["medium", "high"] : [],
    },
    grantControls: {
      operator: "OR",
      builtInControls: index === 1 ? ["compliantDevice"] : index === 2 ? ["block"] : ["mfa"],
    },
    sessionControls: index === 5 ? { signInFrequency: { value: 8, type: "hours", isEnabled: true } } : null,
  }));
}

function applications(now: Date) {
  return Array.from({ length: 10 }, (_, index) => ({
    id: id("application", index),
    appId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    displayName: ["Expense Portal", "Device Inventory API", "HR Onboarding", "Legacy Reporting", "Warehouse Scanner", "Partner Extranet", "Automation Runbooks", "Field Service", "Security Dashboard", "Training Portal"][index],
    publisherDomain: "contoso-sample.invalid",
    createdDateTime: at(now, `-${80 + index * 170} days` as RelativeTime),
    signInAudience: "AzureADMyOrg",
    passwordCredentials:
      index === 1
        ? [{ keyId: "secret-expiring", displayName: "production", startDateTime: at(now, "-359 days"), endDateTime: at(now, "+6 days") }]
        : index === 3
          ? [{ keyId: "secret-expired", displayName: "legacy", startDateTime: at(now, "-400 days"), endDateTime: at(now, "-5 days") }]
          : index % 3 === 0
            ? [{ keyId: id("secret", index), displayName: "client secret", startDateTime: at(now, "-100 days"), endDateTime: at(now, "+265 days") }]
            : [],
    keyCredentials: [],
  }));
}

function simplePolicy(pathLabel: string, now: Date, count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: id(pathLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"), index),
    displayName: `${pathLabel} ${index + 1}`,
    description: "Fictional sample configuration.",
    createdDateTime: at(now, `-${90 + index * 20} days` as RelativeTime),
    lastModifiedDateTime: at(now, `-${5 + index * 11} days` as RelativeTime),
  }));
}

/**
 * Builds a fresh deterministic dataset. Every time value is derived from a
 * relative offset here, so planted freshness findings remain useful at any date.
 */
export function createSampleTenantDataset(nowInput: Date = new Date()): SampleTenantDataset {
  const now = new Date(nowInput.getTime());
  const users = sampleUsers(now);
  const devices = sampleDevices(now, users);
  const policySet = policies(now);
  const apps = Array.from({ length: 15 }, (_, index) => {
    const displayName = index === 2
      ? "Contoso Secure Access"
      : index === 4
        ? "Contoso VPN Classic"
        : index === 5
          ? "Contoso VPN"
          : `Contoso App ${index + 1}`;
    const deviceInstallStatuses = index === 2
      ? Array.from({ length: 12 }, (_, statusIndex) => {
          const device = devices.managed[statusIndex]!;
          return {
            id: id("required-app-status", statusIndex),
            deviceId: device.id,
            deviceName: device.deviceName,
            userId: device.userId,
            userPrincipalName: device.userPrincipalName,
            installState: statusIndex < 4 ? "failed" : statusIndex < 6 ? "pendingInstall" : "installed",
            intent: "required",
            assignmentSource: "deviceGroup",
            lastSyncDateTime: at(now, `-${statusIndex + 1} hours` as RelativeTime),
            errorCode: statusIndex < 4 ? "0x87D1041C" : null,
          };
        })
      : index === 0
        ? Array.from({ length: 6 }, (_, statusIndex) => {
            const device = devices.managed[20 + statusIndex]!;
            return {
              id: id("primary-user-app-status", statusIndex),
              deviceId: device.id,
              deviceName: device.deviceName,
              userId: device.userId,
              userPrincipalName: device.userPrincipalName,
              installState: statusIndex === 5 ? "failed" : "installed",
              intent: "available",
              assignmentSource: "primaryUser",
              lastSyncDateTime: at(now, `-${statusIndex + 2} hours` as RelativeTime),
              errorCode: statusIndex === 5 ? "0x87D13B9F" : null,
            };
          })
        : [];
    const assignments = index === 0
      ? [{ id: "app-assignment-empty", intent: "available", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-025" } }]
      : index === 1
        ? [{ id: "app-assignment-stale", intent: "required", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-024" } }]
        : index === 2
          ? [{ id: "app-assignment-required", intent: "required", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-001" } }]
          : [];
    return {
      id: id("mobile-app", index),
      displayName,
      description: "Fictional Intune application.",
      publisher: "Contoso Sample Software",
      createdDateTime: at(now, `-${60 + index * 9} days` as RelativeTime),
      lastModifiedDateTime: at(now, `-${2 + index * 3} days` as RelativeTime),
      isAssigned: index < 10,
      isRequired: index === 2,
      publishingState: "published",
      supersededAppCount: index === 4 ? 0 : index === 5 ? 1 : 0,
      supersedingAppCount: index === 4 ? 1 : 0,
      supersededByAppId: index === 4 ? "mobile-app-006" : null,
      assignments,
      deviceInstallStatuses,
      installSummary: index === 2
        ? { installedDeviceCount: 6, failedDeviceCount: 4, pendingInstallDeviceCount: 2, notApplicableDeviceCount: 0 }
        : { installedDeviceCount: deviceInstallStatuses.filter((status) => status.installState === "installed").length, failedDeviceCount: deviceInstallStatuses.filter((status) => status.installState === "failed").length },
    };
  });
  const appRegistrations = applications(now);
  const failedUserIndexes = [3, 3, 3, 3, 3, 17, 17, 17, 17, 33, 33, 33];
  const signIns = Array.from({ length: 48 }, (_, index) => {
    const failed = index < failedUserIndexes.length;
    const risky = [2, 8, 20, 34].includes(index);
    const userIndex = failed ? failedUserIndexes[index]! : index % 72;
    const user = users[userIndex]!;
    const appDisplayName = failed
      ? index < 6 ? "Azure Portal" : index < 10 ? "Contoso Secure Access" : "Microsoft 365"
      : ["Microsoft 365", "Azure Portal", "Contoso Secure Access"][index % 3];
    return {
      id: id("sign-in", index),
      createdDateTime: at(now, `-${index * 3 + 1} hours` as RelativeTime),
      userId: user.id,
      userDisplayName: user.displayName,
      userPrincipalName: user.userPrincipalName,
      appDisplayName,
      ipAddress: `192.0.2.${20 + (index % 50)}`,
      clientAppUsed: index % 5 === 0 ? "Browser" : "Mobile Apps and Desktop clients",
      conditionalAccessStatus: failed ? "failure" : "success",
      isInteractive: true,
      riskDetail: risky ? "unfamiliarFeatures" : "none",
      riskLevelAggregated: risky ? "high" : "none",
      riskLevelDuringSignIn: risky ? "high" : "none",
      riskState: risky ? "atRisk" : "none",
      resourceDisplayName: "Microsoft Graph",
      status: { errorCode: failed ? 53003 : 0, failureReason: failed ? "Blocked by Conditional Access" : null, additionalDetails: failed ? "Review applied policy controls." : null },
      deviceDetail: { deviceId: devices.entra[index % 120]!.id, displayName: devices.entra[index % 120]!.displayName, operatingSystem: devices.entra[index % 120]!.operatingSystem, isManaged: true, isCompliant: !failed },
      location: { city: ["Berlin", "Seattle", "London", "Amsterdam"][index % 4], countryOrRegion: ["DE", "US", "GB", "NL"][index % 4] },
      appliedConditionalAccessPolicies: [],
    };
  });
  const directoryAudits = Array.from({ length: 18 }, (_, index) => ({
    id: id("directory-audit", index),
    category: index % 2 === 0 ? "Policy" : "UserManagement",
    activityDisplayName: index % 3 === 0 ? "Update conditional access policy" : index % 3 === 1 ? "Update user" : "Add member to group",
    activityDateTime: at(now, `-${index * 7 + 2} hours` as RelativeTime),
    result: "success",
    resultReason: "",
    operationType: "Update",
    loggedByService: "Core Directory",
    initiatedBy: { user: { id: users[index % users.length]!.id, displayName: users[index % users.length]!.displayName, userPrincipalName: users[index % users.length]!.userPrincipalName } },
    targetResources: [{ id: index % 3 === 0 ? id("ca-policy", index % 8) : users[(index + 1) % users.length]!.id, displayName: index % 3 === 0 ? "Conditional Access policy" : users[(index + 1) % users.length]!.displayName, type: index % 3 === 0 ? "Policy" : "User", modifiedProperties: [] }],
    additionalDetails: [],
  }));
  const intuneAudits = Array.from({ length: 16 }, (_, index) => ({
    id: id("intune-audit", index),
    displayName: index % 2 === 0 ? "Update device compliance policy" : "Update device configuration",
    componentName: "DeviceConfiguration",
    activityDateTime: at(now, `-${index * 6 + 3} hours` as RelativeTime),
    activityType: "Update",
    activityOperationType: "Update",
    activityResult: "Success",
    category: "Audit",
    correlationId: id("correlation", index),
    actor: { userPermissions: ["DeviceConfigurations.ReadWrite.All"], applicationDisplayName: "Microsoft Intune admin center", userPrincipalName: users[index % users.length]!.userPrincipalName },
    resources: [{ resourceId: policySet.compliance[index % policySet.compliance.length]!.id, displayName: policySet.compliance[index % policySet.compliance.length]!.displayName, modifiedProperties: [] }],
  }));
  const groups = Array.from({ length: 25 }, (_, index) => ({
    id: id("group", index),
    displayName: index === 23
      ? "Legacy App Pilot"
      : index === 24
        ? "Empty App Assignment"
        : ["All Corporate Devices", "Windows Ring 1", "Windows Ring 2", "macOS Fleet", "Mobile Users", "Helpdesk", "Break Glass Accounts", "Contractors"][index] ?? `Department ${index - 7}`,
    mail: `group${index + 1}@contoso-sample.invalid`,
    mailEnabled: index % 3 === 0,
    securityEnabled: true,
    groupTypes: index % 5 === 0 ? ["DynamicMembership"] : [],
    membershipRule: index % 5 === 0 ? "(device.deviceOwnership -eq \"Company\")" : null,
    createdDateTime: at(now, `-${100 + index * 13} days` as RelativeTime),
    renewedDateTime: at(now, index === 23 ? "-240 days" : `-${10 + index} days` as RelativeTime),
    memberIds: index === 24
      ? []
      : [users[index % users.length]!.id, users[(index + 7) % users.length]!.id],
  }));
  const riskyUsers = [3, 17, 33].map((index) => ({
    id: users[index]!.id,
    userId: users[index]!.id,
    userDisplayName: users[index]!.displayName,
    userPrincipalName: users[index]!.userPrincipalName,
    riskLastUpdatedDateTime: at(now, `-${index % 5 + 1} hours` as RelativeTime),
    riskLevel: index === 3 ? "high" : "medium",
    riskState: "atRisk",
    riskDetail: "unfamiliarFeatures",
  }));
  const secureScores = Array.from({ length: 14 }, (_, index) => ({
    id: id("secure-score", index),
    createdDateTime: at(now, `-${index === 13 ? 90 : index * 7} days` as RelativeTime),
    currentScore: 58 - index * (14 / 13),
    maxScore: 100,
    activeUserCount: 72,
    licensedUserCount: 70,
  }));
  const secureScoreControls = Array.from({ length: 12 }, (_, index) => ({
    id: id("secure-control", index),
    title: ["Require MFA for administrative roles", "Block legacy authentication", "Enable self-service password reset", "Review risky users", "Protect privileged access"][index] ?? `Security improvement ${index + 1}`,
    controlCategory: index % 2 === 0 ? "Identity" : "Apps",
    actionType: "Config",
    service: "Azure Active Directory",
    maxScore: 5 + (index % 4),
    rank: index + 1,
    deprecated: false,
    implementationCost: index % 3 === 0 ? "Low" : "Moderate",
    userImpact: index % 4 === 0 ? "Moderate" : "Low",
    tier: "All",
  }));

  const resources: SampleTenantDataset["resources"] = {
    "/deviceManagement/managedDevices": devices.managed,
    "/devices": devices.entra,
    "/users": users,
    "/groups": groups,
    "/deviceManagement/deviceCompliancePolicies": policySet.compliance,
    "/deviceManagement/deviceConfigurations": policySet.configurations,
    "/deviceManagement/configurationPolicies": policySet.settingsCatalog,
    "/auditLogs/signIns": signIns,
    "/auditLogs/directoryAudits": directoryAudits,
    "/deviceManagement/auditEvents": intuneAudits,
    "/identity/conditionalAccess/policies": conditionalAccessPolicies(now),
    "/identity/conditionalAccess/namedLocations": [{ id: "named-location-office", displayName: "Contoso offices", createdDateTime: at(now, "-300 days"), modifiedDateTime: at(now, "-20 days"), isTrusted: true, countriesAndRegions: ["DE", "US", "GB", "NL"] }],
    "/identityProtection/riskyUsers": riskyUsers,
    "/deviceAppManagement/mobileApps": apps,
    "/deviceManagement/detectedApps": apps.slice(0, 8).map((app, index) => ({ id: id("detected-app", index), displayName: app.displayName, version: `2.${index}.0`, sizeInByte: 20_000_000 + index * 1_000_000, deviceCount: index === 4 ? 7 : 12 + index * 7, publisher: app.publisher, platform: index % 2 ? "windows" : "macOS" })),
    "/deviceAppManagement/managedAppPolicies": simplePolicy("Managed app policy", now, 3),
    "/deviceAppManagement/iosManagedAppProtections": simplePolicy("iOS app protection", now, 2),
    "/deviceAppManagement/androidManagedAppProtections": simplePolicy("Android app protection", now, 2),
    "/deviceAppManagement/mobileAppConfigurations": simplePolicy("App configuration", now, 3),
    "/deviceManagement/deviceHealthScripts": simplePolicy("Remediation", now, 3),
    "/deviceManagement/deviceManagementScripts": simplePolicy("Platform script", now, 3),
    "/deviceManagement/windowsAutopilotDeviceIdentities": devices.managed.filter((device) => device.operatingSystem === "Windows").slice(0, 24).map((device, index) => ({ id: id("autopilot-device", index), serialNumber: `CNSAMPLE${String(index + 1).padStart(5, "0")}`, model: device.model, manufacturer: device.manufacturer, managedDeviceId: device.id, enrollmentState: "enrolled" })),
    "/deviceManagement/autopilotEvents": [{ id: "autopilot-event-001", deviceId: devices.entra[0]!.id, userId: users[0]!.id, eventDateTime: at(now, "-4 days"), deviceRegisteredDateTime: at(now, "-5 days"), enrollmentStartDateTime: at(now, "-4 days"), enrollmentType: "azureADJoinedWithAutopilot", deviceSerialNumber: "CNSAMPLE00001", managedDeviceName: devices.managed[0]!.deviceName, userPrincipalName: users[0]!.userPrincipalName, windowsAutopilotDeploymentProfileDisplayName: "Standard corporate", enrollmentState: "success", deploymentState: "success", deviceSetupStatus: "success", accountSetupStatus: "success", osVersion: "10.0.26100", deploymentStartDateTime: at(now, "-4 days"), deploymentEndDateTime: at(now, "-4 days"), enrollmentFailureDetails: null }],
    "/deviceManagement/windowsAutopilotDeploymentProfiles": simplePolicy("Autopilot profile", now, 2),
    "/deviceManagement/deviceEnrollmentConfigurations": simplePolicy("Enrollment configuration", now, 2).map((row, index) => ({ ...row, priority: index + 1 })),
    "/deviceManagement/windowsQualityUpdateProfiles": simplePolicy("Quality update profile", now, 2),
    "/deviceManagement/windowsFeatureUpdateProfiles": simplePolicy("Feature update profile", now, 2).map((row, index) => ({ ...row, featureUpdateVersion: index ? "Windows 11, version 24H2" : "Windows 11, version 23H2" })),
    "/deviceManagement/intents": simplePolicy("Endpoint security policy", now, 4).map((row, index) => ({ ...row, templateId: id("intent-template", index), isAssigned: true })),
    "/deviceManagement/groupPolicyConfigurations": simplePolicy("Administrative template", now, 3),
    "/deviceManagement/assignmentFilters": [{ id: "assignment-filter-corporate", displayName: "Corporate Windows devices", description: "Company-owned Windows devices", platform: "windows10AndLater", rule: '(device.deviceOwnership -eq "Corporate")', assignmentFilterManagementType: "devices", createdDateTime: at(now, "-140 days"), lastModifiedDateTime: at(now, "-12 days") }],
    "/deviceManagement/roleScopeTags": [{ id: "scope-tag-default", displayName: "Default", description: "Built-in scope tag" }, { id: "scope-tag-emea", displayName: "EMEA", description: "EMEA support scope" }, { id: "scope-tag-field", displayName: "Field devices", description: "Field operations scope" }],
    "/deviceManagement/managedDeviceEncryptionStates": devices.managed.filter((device) => device.operatingSystem === "Windows").map((device) => ({ id: device.id, deviceName: device.deviceName, userPrincipalName: device.userPrincipalName, encryptionState: device.isEncrypted ? "encrypted" : "notEncrypted", policyDetails: [], fileVaultStates: null })),
    "/deviceManagement/troubleshootingEvents": [{ id: "troubleshooting-001", eventDateTime: at(now, "-3 days"), correlationId: "troubleshooting-correlation-001", troubleshootingErrorDetails: { context: "App installation", failure: "Required app installation returned 0x87D1041C" } }],
    "/directoryRoles": [
      { id: "role-global-admin", displayName: "Global Administrator", description: "Can manage all aspects of Microsoft Entra ID.", roleTemplateId: "62e90394-69f5-4237-9190-012177145e10", memberIds: [users[0]!.id, users[1]!.id] },
      { id: "role-intune-admin", displayName: "Intune Administrator", description: "Can manage Intune.", roleTemplateId: "3a2c62db-5318-420d-8d74-23affee5d9d5", memberIds: [users[2]!.id, users[3]!.id, users[4]!.id] },
      { id: "role-privileged-role-admin", displayName: "Privileged Role Administrator", description: "Can manage role assignments.", roleTemplateId: "e8611ab8-c189-46e8-94e1-60213ab1f814", memberIds: [users[5]!.id] },
      { id: "role-security-reader", displayName: "Security Reader", description: "Can read security information.", roleTemplateId: "5d6b6bb7-de71-4623-b4af-96380a352509", memberIds: [users[6]!.id, users[7]!.id] },
    ],
    "/administrativeUnits": [{ id: "au-emea", displayName: "EMEA", description: "EMEA administration boundary", visibility: "Public" }, { id: "au-field", displayName: "Field Operations", description: "Field operations boundary", visibility: "Public" }],
    "/applications": appRegistrations,
    "/applications/microsoft.graph.agentIdentityBlueprint": [{ id: "agent-blueprint-001", displayName: "Sample operations agent", description: "Fictional agent identity blueprint.", createdDateTime: at(now, "-30 days") }],
    "/servicePrincipals": appRegistrations.map((app, index) => ({ id: id("service-principal", index), appId: app.appId, displayName: app.displayName, accountEnabled: index !== 3, servicePrincipalType: "Application", appOwnerOrganizationId: SAMPLE_TENANT_ID, passwordCredentials: app.passwordCredentials, keyCredentials: [] })),
    "/domains": [{ id: "contoso-sample.invalid", isDefault: true, isInitial: false, isVerified: true, authenticationType: "Managed" }, { id: "contoso-sample.onmicrosoft.invalid", isDefault: false, isInitial: true, isVerified: true, authenticationType: "Managed" }],
    "/security/alerts_v2": [
      { id: "alert-001", title: "Suspicious PowerShell activity on WIN-008", severity: "high", status: "new", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-5 hours"), lastUpdateDateTime: at(now, "-2 hours") },
      { id: "alert-002", title: "Unfamiliar sign-in properties", severity: "medium", status: "inProgress", detectionSource: "microsoftDefenderForIdentity", serviceSource: "microsoftDefenderForIdentity", createdDateTime: at(now, "-20 hours"), lastUpdateDateTime: at(now, "-8 hours") },
      { id: "alert-003", title: "Credential dumping behavior on WIN-036", severity: "high", status: "new", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-2 days"), lastUpdateDateTime: at(now, "-1 days") },
      { id: "alert-004", title: "Impossible travel sign-in", severity: "medium", status: "inProgress", detectionSource: "microsoftDefenderForIdentity", serviceSource: "microsoftDefenderForIdentity", createdDateTime: at(now, "-4 days"), lastUpdateDateTime: at(now, "-3 days") },
      { id: "alert-005", title: "Malware blocked on WIN-052", severity: "low", status: "resolved", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-6 days"), lastUpdateDateTime: at(now, "-5 days") },
      { id: "alert-006", title: "Historic phishing investigation", severity: "medium", status: "resolved", detectionSource: "microsoftDefenderForOffice365", serviceSource: "microsoftDefenderForOffice365", createdDateTime: at(now, "-12 days"), lastUpdateDateTime: at(now, "-10 days") },
    ],
    "/security/incidents": [
      { id: "incident-001", displayName: "Suspicious activity on finance workstation", severity: "high", status: "active", classification: "unknown", determination: "unknown", assignedTo: "soc@contoso-sample.invalid", createdDateTime: at(now, "-6 hours"), lastUpdateDateTime: at(now, "-2 hours") },
      { id: "incident-002", displayName: "Credential theft investigation", severity: "high", status: "inProgress", classification: "unknown", determination: "unknown", assignedTo: "response@contoso-sample.invalid", createdDateTime: at(now, "-2 days"), lastUpdateDateTime: at(now, "-5 hours") },
      { id: "incident-003", displayName: "Resolved phishing message", severity: "medium", status: "resolved", classification: "truePositive", determination: "malware", assignedTo: "soc@contoso-sample.invalid", createdDateTime: at(now, "-8 days"), lastUpdateDateTime: at(now, "-7 days") },
    ],
    "/security/secureScores": secureScores,
    "/security/secureScoreControlProfiles": secureScoreControls,
    "/subscribedSkus": [{ id: "sku-e5", skuId: "sku-e5", skuPartNumber: "SPE_E5", consumedUnits: 70, prepaidUnits: { enabled: 80, suspended: 0, warning: 0 }, servicePlans: [] }, { id: "sku-ems-e5", skuId: "sku-ems-e5", skuPartNumber: "EMS_PREMIUM", consumedUnits: 65, prepaidUnits: { enabled: 80, suspended: 0, warning: 0 }, servicePlans: [] }],
    "/me/messages": Array.from({ length: 6 }, (_, index) => ({ id: id("message", index), subject: `Sample administrative notice ${index + 1}`, receivedDateTime: at(now, `-${index + 2} hours` as RelativeTime), from: { emailAddress: { name: "Contoso Operations", address: "operations@contoso-sample.invalid" } }, isRead: index % 2 === 0 })),
  };

  const singletons: SampleTenantDataset["singletons"] = {
    "/deviceManagement/managedDeviceOverview": { enrolledDeviceCount: devices.managed.length, mdmEnrolledCount: devices.managed.length, totalCompliantDeviceCount: devices.managed.filter((device) => device.complianceState === "compliant").length, totalNonCompliantDeviceCount: devices.managed.filter((device) => device.complianceState === "noncompliant").length },
    "/policies/authenticationMethodsPolicy": { id: "authenticationMethodsPolicy", displayName: "Authentication methods policy", policyVersion: "1.5", registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: "enabled" } } },
    "/policies/authorizationPolicy": { id: "authorizationPolicy", displayName: "Authorization Policy", allowedToSignUpEmailBasedSubscriptions: false, allowEmailVerifiedUsersToJoinOrganization: false, allowInvitesFrom: "adminsAndGuestInviters" },
    "/policies/crossTenantAccessPolicy": { id: "crossTenantAccessPolicy", displayName: "Cross tenant access policy", allowedCloudEndpoints: [] },
    "/me": users[0]!,
    "/admin/edge/internetExplorerMode": { id: "internetExplorerMode", siteList: [] },
  };

  return { loadedAt: now.toISOString(), resources, singletons };
}
