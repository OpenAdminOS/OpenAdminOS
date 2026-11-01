export const SAMPLE_TENANT_ID = "openadminos-sample-tenant";
export const SAMPLE_TENANT_NAME = "Contoso (pilot)";
export const SAMPLE_TENANT_USERNAME = "admin@contoso-sample.invalid";
export const SAMPLE_TENANT_HOME_ACCOUNT_ID = "openadminos-sample-account";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TENANT_DOMAIN = "contoso-sample.invalid";

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

/** Deterministic pick so neighbouring rows do not share the same value. */
function pick<T>(values: readonly T[], index: number, salt = 0): T {
  return values[(index * 7 + salt) % values.length]!;
}

type Department =
  | "Finance"
  | "Sales"
  | "Engineering"
  | "HR"
  | "IT"
  | "Marketing"
  | "Operations"
  | "Legal";

/**
 * Member accounts (indexes 0 to 71). All people are fictional. The first
 * eight rows are the IT team because they hold the planted directory roles.
 */
const members: ReadonlyArray<readonly [string, string, Department, string]> = [
  ["Megan", "Bowen", "IT", "Senior Endpoint Administrator"],
  ["Daniel", "Okafor", "IT", "IT Operations Manager"],
  ["Priya", "Raman", "IT", "Endpoint Engineer"],
  ["Lukas", "Brandt", "IT", "Desktop Support Engineer"],
  ["Sofia", "Marchetti", "IT", "Service Desk Analyst"],
  ["Rafael", "Duarte", "IT", "Identity and Access Engineer"],
  ["Hannah", "Lindqvist", "IT", "Security Analyst"],
  ["Kwame", "Asante", "IT", "Security Engineer"],
  ["Grace", "Whitfield", "Finance", "Finance Director"],
  ["Tomasz", "Wrobel", "Finance", "Senior Accountant"],
  ["Leila", "Haddad", "Finance", "Accounts Payable Specialist"],
  ["Oliver", "Brennan", "Sales", "Account Executive"],
  ["Alex", "Wilber", "Sales", "Regional Sales Manager"],
  ["Mei", "Tanaka", "Engineering", "Software Engineer"],
  ["Jonas", "Weber", "Engineering", "Senior Software Engineer"],
  ["Chloe", "Dupont", "Marketing", "Marketing Manager"],
  ["Samuel", "Achebe", "Operations", "Operations Coordinator"],
  ["Nadia", "Petrova", "Finance", "Payroll Specialist"],
  ["Ethan", "Caldwell", "Sales", "Sales Development Representative"],
  ["Isabel", "Moreno", "HR", "HR Business Partner"],
  ["Arjun", "Mehta", "Engineering", "DevOps Engineer"],
  ["Freya", "Nilsson", "Marketing", "Content Strategist"],
  ["Marcus", "Hale", "Operations", "Logistics Manager"],
  ["Yusuf", "Demir", "Engineering", "QA Engineer"],
  ["Clara", "Hoffmann", "Legal", "Corporate Counsel"],
  ["Benjamin", "Ashford", "Sales", "Account Executive"],
  ["Aisha", "Rahman", "HR", "Talent Acquisition Specialist"],
  ["Diego", "Fuentes", "Operations", "Warehouse Supervisor"],
  ["Emily", "Sutherland", "Finance", "Financial Analyst"],
  ["Noah", "Fischer", "Engineering", "Engineering Manager"],
  ["Ingrid", "Solberg", "Marketing", "Digital Marketing Specialist"],
  ["Patrick", "Dunleavy", "Sales", "Key Account Manager"],
  ["Lina", "Kowalczyk", "Operations", "Procurement Specialist"],
  ["Victor", "Lindgren", "Engineering", "Software Engineer"],
  ["Ruth", "Abernathy", "Legal", "Paralegal"],
  ["Kenji", "Morita", "Engineering", "Site Reliability Engineer"],
  ["Amara", "Nwosu", "Sales", "Sales Operations Analyst"],
  ["Felix", "Bauer", "IT", "Network Engineer"],
  ["Zoe", "Castellanos", "Marketing", "Brand Designer"],
  ["Henrik", "Larsen", "Operations", "Facilities Manager"],
  ["Maya", "Goldberg", "Finance", "Financial Controller"],
  ["Theo", "Vasquez", "Sales", "Account Executive"],
  ["Elif", "Yilmaz", "Engineering", "Data Engineer"],
  ["Callum", "Fraser", "Operations", "Fleet Coordinator"],
  ["Naomi", "Brooks", "HR", "HR Generalist"],
  ["Gabriel", "Sousa", "Sales", "Solutions Consultant"],
  ["Anika", "Patel", "Engineering", "Product Manager"],
  ["Alex", "Wilber", "Engineering", "Technical Writer"],
  ["Rosa", "Jimenez", "Operations", "Customer Support Lead"],
  ["Martin", "Kral", "IT", "Systems Administrator"],
  ["Julia", "Novak", "Marketing", "Events Coordinator"],
  ["Owen", "Gallagher", "Sales", "Inside Sales Representative"],
  ["Sana", "Qureshi", "Finance", "Tax Specialist"],
  ["Pieter", "de Vries", "Operations", "Supply Chain Analyst"],
  ["Charlotte", "Reid", "Legal", "Contracts Manager"],
  ["Matteo", "Rinaldi", "Engineering", "Frontend Engineer"],
  ["Lucy", "Hargreaves", "HR", "Learning and Development Manager"],
  ["Andre", "Moreau", "Sales", "Channel Partner Manager"],
  ["Jiwoo", "Park", "Engineering", "Machine Learning Engineer"],
  ["Tobias", "Engel", "Operations", "Operations Manager"],
  ["Fatima", "Benali", "Marketing", "Marketing Coordinator"],
  ["Liam", "Coughlan", "Sales", "Account Manager"],
  ["Eva", "Horvath", "Finance", "Accounts Receivable Specialist"],
  ["Daniela", "Rojas", "Engineering", "Backend Engineer"],
  ["Robin", "Keller", "IT", "Help Desk Technician"],
  ["Mia", "Andersen", "HR", "Payroll and Benefits Coordinator"],
  ["Simon", "Achterberg", "Operations", "Field Service Technician"],
  ["Harriet", "Cole", "Marketing", "Communications Manager"],
  ["Ahmed", "Saleh", "Sales", "Sales Engineer"],
  ["Nora", "Eriksen", "Legal", "Compliance Officer"],
  ["Jakub", "Nowak", "Engineering", "Platform Engineer"],
  ["Sarah", "Mitchell", "Operations", "Office Manager"],
];

/** Partner guests (indexes 72 to 79): [given name, surname, company, home domain]. */
const guests: ReadonlyArray<readonly [string, string, string, string]> = [
  ["Nina", "Hartmann", "Fabrikam", "fabrikam-partner.invalid"],
  ["Jordan", "Ellis", "Northwind Traders", "northwind-sample.invalid"],
  ["Carlos", "Mendes", "Fabrikam", "fabrikam-partner.invalid"],
  ["Aylin", "Kaya", "Adatum Consulting", "adatum-consulting.invalid"],
  ["Peter", "Lindahl", "Tailspin Audit", "tailspin-audit.invalid"],
  ["Wen", "Zhao", "Northwind Traders", "northwind-sample.invalid"],
  ["Rohan", "Iyer", "Woodgrove MSP", "woodgrove-msp.invalid"],
  ["Elena", "Varga", "Adatum Consulting", "adatum-consulting.invalid"],
];

/** Middle initials used, in order, to disambiguate repeated names. */
const middleInitials = ["J", "M", "R", "T", "K", "D"] as const;

function mailLocalPart(...parts: string[]): string {
  return parts.map((part) => part.toLowerCase().replace(/[^a-z]/g, "")).join(".");
}

function sampleUsers(now: Date): Array<Record<string, unknown>> {
  const people = [
    ...members.map(([first, last, department, jobTitle]) => ({ first, last, department, jobTitle, company: "Contoso", domain: TENANT_DOMAIN })),
    ...guests.map(([first, last, company, domain]) => ({ first, last, department: null, jobTitle: null, company, domain })),
  ];
  const seen = new Map<string, number>();
  return people.map((person, index) => {
    const guest = index >= 72;
    const disabled = [5, 31, 74, 77].includes(index);
    const { first, last } = person;
    const base = mailLocalPart(first, last);
    const repeats = seen.get(base) ?? 0;
    seen.set(base, repeats + 1);
    const initial = repeats > 0 ? middleInitials[(repeats - 1) % middleInitials.length]! : null;
    const local = initial ? mailLocalPart(first, initial, last) : base;
    const displayName = initial ? `${first} ${initial}. ${last}` : `${first} ${last}`;
    const userPrincipalName = guest
      ? `${local}_${person.domain}#EXT#@${TENANT_DOMAIN}`
      : `${local}@${TENANT_DOMAIN}`;
    const staleGuest = guest && index !== 79;
    const lastSignIn = staleGuest
      ? at(now, `-${120 + (index - 72) * 19} days` as RelativeTime)
      : at(now, `-${(index % 18) + 1} days` as RelativeTime);
    return {
      id: id("user", index),
      displayName,
      givenName: first,
      surname: last,
      userPrincipalName,
      mail: `${local}@${person.domain}`,
      department: person.department,
      jobTitle: person.jobTitle,
      companyName: person.company,
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

const windowsLaptops = [
  ["Dell", "Latitude 7440"],
  ["Lenovo", "ThinkPad T14 Gen 4"],
  ["Microsoft", "Surface Laptop 6"],
  ["Dell", "Latitude 5540"],
  ["Lenovo", "ThinkPad X1 Carbon Gen 11"],
  ["Microsoft", "Surface Laptop 5"],
] as const;
const windowsDesktops = [
  ["Dell", "OptiPlex 7010"],
  ["Lenovo", "ThinkCentre M70q Gen 4"],
  ["Dell", "OptiPlex 7020 Micro"],
  ["Lenovo", "ThinkCentre M90t Gen 4"],
] as const;
const macModels = [
  "MacBook Pro (14-inch, M3)",
  "MacBook Air (13-inch, M2)",
  "MacBook Air (15-inch, M3)",
  "MacBook Pro (16-inch, M3 Pro)",
  "MacBook Air (13-inch, M3)",
] as const;
const iPhoneModels = ["iPhone 15", "iPhone 14 Pro", "iPhone 13", "iPhone 15 Pro", "iPhone SE (3rd generation)"] as const;
const androidModels = [
  ["Samsung", "Galaxy S23"],
  ["Google", "Pixel 8"],
  ["Samsung", "Galaxy A54 5G"],
  ["Samsung", "Galaxy S24"],
  ["Google", "Pixel 7a"],
] as const;
const windows11Builds = ["10.0.22631.4460", "10.0.26100.2314", "10.0.22631.4391", "10.0.26100.2161", "10.0.22631.4317", "10.0.26100.2033"] as const;
const windows10Builds = ["10.0.19045.5131", "10.0.19045.5011"] as const;
const sonomaVersions = ["14.7.1", "14.6.1"] as const;
const sequoiaVersions = ["15.1.1", "15.2", "15.1"] as const;
const iOSVersions = ["18.2", "18.1.1", "17.7.2", "18.2", "18.1"] as const;
const androidVersions = ["14", "15", "13", "14", "15"] as const;

/**
 * Days since last Intune sync for the stale devices (index % 11 === 0 or
 * index % 17 === 0). Spread so the warn (30), stale (90) and retire (180)
 * bands of find-inactive-devices all have members. Every value is above 7
 * days and below the device's enrollment age.
 */
const staleSyncDays: Readonly<Record<number, number>> = {
  0: 12, 11: 34, 17: 9, 22: 47, 33: 96, 34: 21, 44: 63, 51: 118, 55: 15,
  66: 41, 68: 196, 77: 214, 85: 18, 88: 143, 99: 104, 102: 11, 110: 186, 119: 38,
};

/** Four-digit asset tag. 7919 is coprime with 10000, so tags are unique. */
function assetTag(index: number): string {
  return String((index * 7919 + 417) % 10_000).padStart(4, "0");
}

function serialNumber(manufacturer: string, index: number): string {
  const alphabet = "0123456789BCDFGHJKLMNPQRSTVWXYZ";
  let seed = 1 + ((index + 1) * 104_729) % 2_147_483_646;
  const next = (size: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % size;
  };
  const chars = (count: number, source: string) =>
    Array.from({ length: count }, () => source[next(source.length)]).join("");
  if (manufacturer === "Lenovo") return `PF${chars(6, alphabet)}`;
  if (manufacturer === "Microsoft") return chars(12, "0123456789");
  return chars(7, alphabet);
}

function deviceHardware(operatingSystem: string, index: number) {
  if (operatingSystem === "Windows") {
    const desktop = index % 5 === 2;
    const [manufacturer, model] = desktop ? pick(windowsDesktops, index) : pick(windowsLaptops, index);
    return { prefix: desktop ? "DT" : "LT", manufacturer, model };
  }
  if (operatingSystem === "macOS") return { prefix: "MB", manufacturer: "Apple", model: pick(macModels, index) };
  if (operatingSystem === "iOS") return { prefix: "IP", manufacturer: "Apple", model: pick(iPhoneModels, index) };
  const [manufacturer, model] = pick(androidModels, index);
  return { prefix: "AN", manufacturer, model };
}

function deviceOsVersion(operatingSystem: string, index: number): string {
  if (operatingSystem === "Windows") {
    return index % 8 === 0 ? pick(windows10Builds, index) : pick(windows11Builds, index, 3);
  }
  if (operatingSystem === "macOS") {
    return index % 4 === 0 ? pick(sonomaVersions, index) : pick(sequoiaVersions, index, 1);
  }
  if (operatingSystem === "iOS") return pick(iOSVersions, index, 2);
  return pick(androidVersions, index, 4);
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
    const lastSyncDays = stale ? staleSyncDays[index]! : index % 6;
    const deviceId = id("entra-device", index);
    const hardware = deviceHardware(operatingSystem, index);
    return {
      id: id("managed-device", index),
      deviceName: `CTS-${hardware.prefix}-${assetTag(index)}`,
      userId: owner.id,
      userPrincipalName: owner.userPrincipalName,
      operatingSystem,
      osVersion: deviceOsVersion(operatingSystem, index),
      lastSyncDateTime: at(now, `-${lastSyncDays} days` as RelativeTime),
      enrolledDateTime: at(now, `-${80 + index * 2} days` as RelativeTime),
      complianceState: noncompliant ? "noncompliant" : index % 23 === 0 ? "unknown" : "compliant",
      complianceGracePeriodExpirationDateTime: noncompliant ? at(now, "+2 days") : null,
      isEncrypted: !unencrypted,
      azureADDeviceId: deviceId,
      managementState: index === 44 ? "retirePending" : "managed",
      managedDeviceOwnerType: index % 6 === 0 ? "personal" : "company",
      deviceEnrollmentType: operatingSystem === "Windows" ? "windowsAutopilot" : "userEnrollment",
      manufacturer: hardware.manufacturer,
      model: hardware.model,
      serialNumber: serialNumber(hardware.manufacturer, index),
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
  const unmanagedDevices = [
    ["DESKTOP-7Q2K9LM", "Windows", "10.0.22631.4460"],
    ["LAPTOP-H3V8RT2N", "Windows", "10.0.26100.2314"],
    ["Freya's MacBook Air", "macOS", "14.7.1"],
    ["Megan's iPad", "iOS", "18.1.1"],
    ["Galaxy Tab S8", "Android", "14"],
    ["DESKTOP-M4X8PQ1", "Windows", "10.0.19045.5131"],
    ["Tomasz's MacBook Pro", "macOS", "15.1.1"],
    ["LAPTOP-9F2KD7QW", "Windows", "10.0.22631.4391"],
  ] as const;
  const unmanagedEntra = unmanagedDevices.map(([displayName, operatingSystem, operatingSystemVersion], index) => ({
    id: id("entra-unmanaged", index),
    deviceId: id("entra-unmanaged", index),
    displayName,
    accountEnabled: true,
    approximateLastSignInDateTime: at(now, `-${index + 1} days` as RelativeTime),
    operatingSystem,
    operatingSystemVersion,
    trustType: "Workplace",
    isManaged: false,
  }));
  return { managed, entra: [...entra, ...unmanagedEntra] };
}

function policies(now: Date) {
  const compliancePolicies = [
    ["WIN-Compliance-Baseline", "BitLocker, Secure Boot, Defender real-time protection and minimum build 10.0.19045."],
    ["MAC-Compliance-FileVault", "FileVault, firewall and minimum macOS 14.6."],
    ["IOS-Compliance-MinimumOS", "Minimum iOS 17.7, passcode required, jailbreak detection."],
    ["AND-Compliance-WorkProfile", "Work profile, minimum Android 13, Play Integrity verdict."],
    ["WIN-Compliance-PrivilegedAccess", "Stricter baseline for admin workstations: TPM, BitLocker, Defender risk score Low."],
  ] as const;
  const compliance = compliancePolicies.map(([displayName, description], index) => ({
    id: id("compliance-policy", index),
    displayName,
    description,
    createdDateTime: at(now, `-${220 + index * 17} days` as RelativeTime),
    lastModifiedDateTime: at(now, index < 2 ? `-${index + 1} days` as RelativeTime : `-${40 + index * 8} days` as RelativeTime),
    assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }],
  }));
  const configurationProfiles = [
    ["WIN-Security-Baseline", "Windows security baseline settings for corporate devices."],
    ["MAC-Device-Restrictions", "macOS restrictions: AirDrop, iCloud Drive and Gatekeeper."],
    ["IOS-Device-Restrictions", "iOS restrictions for corporate iPhones."],
    ["AND-Device-Restrictions", "Android Enterprise work profile restrictions."],
    ["WIN-Defender-Onboarding", "Defender for Endpoint onboarding package."],
  ] as const;
  const configurations = configurationProfiles.map(([displayName, description], index) => ({
    id: id("device-configuration", index),
    displayName,
    description,
    createdDateTime: at(now, `-${180 + index * 14} days` as RelativeTime),
    lastModifiedDateTime: at(now, `-${8 + index * 12} days` as RelativeTime),
  }));
  const settingsCatalogPolicies = [
    ["WIN-SC-Edge-Baseline", "Microsoft Edge enterprise settings and SmartScreen."],
    ["WIN-SC-Windows-Update-Ring1", "Update deferrals and deadlines for Ring 1."],
    ["WIN-SC-M365-Apps-Security", "Macro and add-in controls for Microsoft 365 Apps."],
    ["WIN-SC-OneDrive-KFM", "OneDrive known folder move and silent sign-in."],
    ["WIN-SC-LAPS-LocalAdmin", "Windows LAPS and local administrator controls."],
  ] as const;
  const settingsCatalog = settingsCatalogPolicies.map(([name, description], index) => ({
    id: id("settings-catalog", index),
    name,
    displayName: name,
    description,
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
      "CA001-Require MFA for admins",
      "CA002-Require compliant device",
      "CA003-Block legacy authentication",
      "CA004-Guest access MFA",
      "CA005-Risky sign-in MFA",
      "CA006-Unmanaged device session controls",
      "CA007-Legacy pilot (disabled)",
      "CA008-Phishing-resistant MFA for admins (report-only)",
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
    displayName: [
      "Contoso Expense API",
      "ServiceNow Connector",
      "Workday HR Sync",
      "Legacy Reporting Service",
      "Warehouse Scanner Backend",
      "Partner Extranet",
      "Azure Automation Runbooks",
      "Field Service Mobile",
      "Payroll Export",
      "Security Operations Dashboard",
    ][index],
    publisherDomain: TENANT_DOMAIN,
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

/** `pathLabel` only shapes the row ids; `names` are the display names. */
function simplePolicy(pathLabel: string, names: readonly string[], now: Date) {
  return names.map((displayName, index) => ({
    id: id(pathLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"), index),
    displayName,
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
  // Index roles: 0 has primary-user deployments and the empty-group
  // assignment, 1 targets the stale group, 2 is the required app with failed
  // installs, 4 is superseded by 5.
  const mobileApps = [
    ["Zoom Workplace", "Zoom Video Communications, Inc.", "Video meetings and team chat.", "6.2.11"],
    ["Contoso Expense", "Contoso Ltd.", "Line-of-business expense capture client.", "3.4.1"],
    ["Zscaler Client Connector", "Zscaler, Inc.", "Zero trust network access client. Required on all corporate devices.", "4.4.0.379"],
    ["Company Portal", "Microsoft Corporation", "Self-service app catalog and device enrollment.", "11.2.1495.0"],
    ["Cisco AnyConnect Secure Mobility Client", "Cisco Systems, Inc.", "Legacy VPN client. Superseded by Cisco Secure Client.", "4.10.08029"],
    ["Cisco Secure Client", "Cisco Systems, Inc.", "VPN and posture client.", "5.1.6.103"],
    ["Microsoft 365 Apps for enterprise", "Microsoft Corporation", "Word, Excel, PowerPoint, Outlook and Teams, current channel.", "16.0.18129.20158"],
    ["Google Chrome", "Google LLC", "Enterprise browser package.", "131.0.6778.86"],
    ["Adobe Acrobat Reader", "Adobe Inc.", "PDF viewer.", "24.004.20220"],
    ["Microsoft Teams", "Microsoft Corporation", "New Teams client for Windows and macOS.", "24295.605.3225.8804"],
    ["Slack", "Slack Technologies, LLC", "Used by Engineering and partner channels.", "4.41.105"],
    ["Microsoft Authenticator", "Microsoft Corporation", "MFA and passwordless sign-in.", "6.8.17"],
    ["Contoso Field Service", "Contoso Ltd.", "Work orders and parts lookup for field technicians.", "2.9.0"],
    ["Mozilla Firefox", "Mozilla", "Alternative browser for web testing.", "132.0.2"],
    ["Visual Studio Code", "Microsoft Corporation", "Code editor for Engineering.", "1.95.3"],
  ] as const;
  const apps = mobileApps.map(([displayName, publisher, description, version], index) => {
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
      description,
      publisher,
      displayVersion: version,
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
  // Every fifth group (index % 5 === 0) is dynamic and carries a rule.
  // Index 23 is the stale legacy pilot group, index 24 the empty group.
  const groupDefinitions: ReadonlyArray<readonly [string, string, string | null]> = [
    ["SG-Intune-Corporate-Devices", "All company-owned devices enrolled in Intune.", "(device.deviceOwnership -eq \"Company\")"],
    ["SG-Windows-Ring1", "Windows update ring 1: IT and early adopters.", null],
    ["SG-Windows-Ring2", "Windows update ring 2: broad deployment.", null],
    ["SG-Intune-Pilot-Ring", "Pilot users for new Intune policies and apps.", null],
    ["SG-Mobile-Users", "Users licensed for corporate mobile devices.", null],
    ["SG-Windows-Autopilot-Devices", "Devices registered with Windows Autopilot.", "(device.devicePhysicalIds -any (_ -startsWith \"[ZTDId]\"))"],
    ["SG-Helpdesk", "Service desk staff.", null],
    ["SG-BreakGlass-Accounts", "Emergency access accounts. Excluded from Conditional Access.", null],
    ["SG-Contractors", "External contractors with Contoso accounts.", null],
    ["SG-Finance-Users", "Finance department.", null],
    ["SG-macOS-Fleet", "Corporate macOS devices.", "(device.deviceOSType -eq \"MacMDM\")"],
    ["SG-Sales-Users", "Sales department.", null],
    ["SG-Engineering-Users", "Engineering department.", null],
    ["SG-HR-Users", "Human Resources department.", null],
    ["SG-IT-Admins", "IT administrators eligible for admin roles.", null],
    ["SG-iOS-Devices", "Corporate iPhones.", "(device.deviceOSType -eq \"iPhone\")"],
    ["SG-Marketing-Users", "Marketing department.", null],
    ["SG-Operations-Users", "Operations department.", null],
    ["SG-Legal-Users", "Legal department.", null],
    ["SG-M365-E5-Licensed", "Group-based licensing for Microsoft 365 E5.", null],
    ["SG-Android-Devices", "Corporate Android Enterprise devices.", "(device.deviceOSType -eq \"AndroidForWork\")"],
    ["SG-VPN-Users", "Users allowed to use the corporate VPN.", null],
    ["SG-Defender-Onboarding", "Devices onboarded to Defender for Endpoint.", null],
    ["SG-LegacyApp-Pilot", "Pilot ring for the legacy expense client. No longer maintained.", null],
    ["SG-App-Deploy-Empty", "Placeholder deployment group for app rollouts.", null],
  ];
  const groups = groupDefinitions.map(([displayName, description, membershipRule], index) => ({
    id: id("group", index),
    displayName,
    description,
    mail: `${displayName.toLowerCase()}@${TENANT_DOMAIN}`,
    mailEnabled: index % 3 === 0,
    securityEnabled: true,
    groupTypes: membershipRule ? ["DynamicMembership"] : [],
    membershipRule,
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
    title: [
      "Require MFA for administrative roles",
      "Block legacy authentication",
      "Enable self-service password reset",
      "Review risky users",
      "Protect privileged access",
      "Turn on Microsoft Defender for Endpoint sensor",
      "Block abuse of exploited vulnerable signed drivers",
      "Encrypt all devices with BitLocker",
      "Do not allow users to grant consent to unreliable applications",
      "Turn on sign-in risk policy",
      "Turn on user risk policy",
      "Use limited administrative roles",
    ][index],
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
    "/deviceManagement/detectedApps": apps.slice(0, 8).map((app, index) => ({ id: id("detected-app", index), displayName: app.displayName, version: app.displayVersion, sizeInByte: 20_000_000 + index * 1_000_000, deviceCount: index === 4 ? 7 : 12 + index * 7, publisher: app.publisher, platform: index % 2 ? "windows" : "macOS" })),
    "/deviceAppManagement/managedAppPolicies": simplePolicy("Managed app policy", ["MAM-Baseline-All-Users", "MAM-Outlook-Config", "MAM-Teams-Config"], now),
    "/deviceAppManagement/iosManagedAppProtections": simplePolicy("iOS app protection", ["IOS-APP-Protection-Corporate", "IOS-APP-Protection-BYOD"], now),
    "/deviceAppManagement/androidManagedAppProtections": simplePolicy("Android app protection", ["AND-APP-Protection-Corporate", "AND-APP-Protection-BYOD"], now),
    "/deviceAppManagement/mobileAppConfigurations": simplePolicy("App configuration", ["IOS-AppConfig-Outlook", "AND-AppConfig-Outlook", "IOS-AppConfig-Edge"], now),
    "/deviceManagement/deviceHealthScripts": simplePolicy("Remediation", ["WIN-REM-Clear-Teams-Cache", "WIN-REM-Restart-Pending-Updates", "WIN-REM-Disk-Cleanup"], now),
    "/deviceManagement/deviceManagementScripts": simplePolicy("Platform script", ["WIN-PS-Set-Time-Zone", "WIN-PS-Map-Network-Drives", "MAC-PS-Install-Rosetta"], now),
    "/deviceManagement/windowsAutopilotDeviceIdentities": devices.managed.filter((device) => device.operatingSystem === "Windows").slice(0, 24).map((device, index) => ({ id: id("autopilot-device", index), serialNumber: device.serialNumber, model: device.model, manufacturer: device.manufacturer, managedDeviceId: device.id, enrollmentState: "enrolled" })),
    "/deviceManagement/autopilotEvents": [{ id: "autopilot-event-001", deviceId: devices.entra[0]!.id, userId: users[0]!.id, eventDateTime: at(now, "-4 days"), deviceRegisteredDateTime: at(now, "-5 days"), enrollmentStartDateTime: at(now, "-4 days"), enrollmentType: "azureADJoinedWithAutopilot", deviceSerialNumber: devices.managed[0]!.serialNumber, managedDeviceName: devices.managed[0]!.deviceName, userPrincipalName: users[0]!.userPrincipalName, windowsAutopilotDeploymentProfileDisplayName: "AP-Corporate-UserDriven", enrollmentState: "success", deploymentState: "success", deviceSetupStatus: "success", accountSetupStatus: "success", osVersion: devices.managed[0]!.osVersion, deploymentStartDateTime: at(now, "-4 days"), deploymentEndDateTime: at(now, "-4 days"), enrollmentFailureDetails: null }],
    "/deviceManagement/windowsAutopilotDeploymentProfiles": simplePolicy("Autopilot profile", ["AP-Corporate-UserDriven", "AP-Kiosk-SelfDeploying"], now),
    "/deviceManagement/deviceEnrollmentConfigurations": simplePolicy("Enrollment configuration", ["ESP-Corporate-Default", "ENR-Restrictions-Corporate"], now).map((row, index) => ({ ...row, priority: index + 1 })),
    "/deviceManagement/windowsQualityUpdateProfiles": simplePolicy("Quality update profile", ["WIN-QU-Monthly", "WIN-QU-Expedite-Critical"], now),
    "/deviceManagement/windowsFeatureUpdateProfiles": simplePolicy("Feature update profile", ["WIN-FU-23H2-Hold", "WIN-FU-24H2-Broad"], now).map((row, index) => ({ ...row, featureUpdateVersion: index ? "Windows 11, version 24H2" : "Windows 11, version 23H2" })),
    "/deviceManagement/intents": simplePolicy("Endpoint security policy", ["ES-AV-Defender-Baseline", "ES-Firewall-Windows", "ES-ASR-Rules", "ES-BitLocker-Disk-Encryption"], now).map((row, index) => ({ ...row, templateId: id("intent-template", index), isAssigned: true })),
    "/deviceManagement/groupPolicyConfigurations": simplePolicy("Administrative template", ["ADMX-Office-Settings", "ADMX-Chrome-Settings", "ADMX-Legacy-IE-Mode"], now),
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
      { id: "alert-001", title: `Suspicious PowerShell activity on ${devices.managed[7]!.deviceName}`, severity: "high", status: "new", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-5 hours"), lastUpdateDateTime: at(now, "-2 hours") },
      { id: "alert-002", title: "Unfamiliar sign-in properties", severity: "medium", status: "inProgress", detectionSource: "microsoftDefenderForIdentity", serviceSource: "microsoftDefenderForIdentity", createdDateTime: at(now, "-20 hours"), lastUpdateDateTime: at(now, "-8 hours") },
      { id: "alert-003", title: `Credential dumping behavior on ${devices.managed[35]!.deviceName}`, severity: "high", status: "new", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-2 days"), lastUpdateDateTime: at(now, "-1 days") },
      { id: "alert-004", title: "Impossible travel sign-in", severity: "medium", status: "inProgress", detectionSource: "microsoftDefenderForIdentity", serviceSource: "microsoftDefenderForIdentity", createdDateTime: at(now, "-4 days"), lastUpdateDateTime: at(now, "-3 days") },
      { id: "alert-005", title: `Malware blocked on ${devices.managed[51]!.deviceName}`, severity: "low", status: "resolved", detectionSource: "microsoftDefenderForEndpoint", serviceSource: "microsoftDefenderForEndpoint", createdDateTime: at(now, "-6 days"), lastUpdateDateTime: at(now, "-5 days") },
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
    "/me/messages": [
      "Apple MDM push certificate expires in 21 days",
      "Weekly Intune compliance summary",
      "Change CHG0041 approved: Windows Ring 2 feature update",
      "Defender incident assigned to your queue",
      "License usage report: Microsoft 365 E5",
      "Reminder: quarterly access review for SG-IT-Admins",
    ].map((subject, index) => ({ id: id("message", index), subject, receivedDateTime: at(now, `-${index + 2} hours` as RelativeTime), from: { emailAddress: { name: "Contoso IT Notifications", address: "it-notifications@contoso-sample.invalid" } }, isRead: index % 2 === 0 })),
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
