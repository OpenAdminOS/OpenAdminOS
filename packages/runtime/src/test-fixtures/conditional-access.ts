// Synthetic Conditional Access policies in the shape Microsoft Graph beta
// returns for GET /identity/conditionalAccess/policies with the explainer's
// $select. Shapes were checked against a live tenant response and the Graph
// schema (conditionalAccessConditionSet, grantControls, sessionControls,
// authenticationStrengthPolicy). Every id is synthetic except Microsoft's
// published role template and first-party application ids.

const DAY_MS = 86_400_000;

const ADMIN_ROLES = [
  "62e90394-69f5-4237-9190-012177145e10",
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
  "c4e39bd9-1100-46d3-8c65-fb160da0071f",
  "b0f54661-2d74-4c50-afa3-1ec803f12efe",
  "158c047a-c907-4556-b7ef-446551a6b5f7",
  "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
  "29232cdf-9323-42fd-ade2-1d097af3e4de",
  "729827e3-9c14-49f7-bb1b-9608f156bbb8",
  "966707d0-3269-4727-9be2-8c3a10f19b9d",
  "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
  "e8611ab8-c189-46e8-94e1-60213ab1f814",
  "194ae4cb-b126-40b2-bd5b-6091b380977d",
  "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
  "fe930be7-5e62-47db-91af-98c3a49a38b1",
];
const DIRECTORY_SYNC_ROLE = "d29b2b05-8046-44ba-8758-1e26182fcf32";
const AZURE_MANAGEMENT_APP = "797f4846-ba00-4fd7-ba43-dac1f8f63013";
const INTUNE_ENROLLMENT_APP = "d4ebce55-015a-49b5-a083-c84d1797ae8c";

function syntheticId(seed: number, salt: number): string {
  const hex = (n: number, width: number) =>
    (Math.abs(Math.imul(n + 1, 2654435761) ^ (salt * 40503)) >>> 0).toString(16).padStart(width, "0").slice(0, width);
  return `${hex(seed, 8)}-${hex(seed + 7, 4)}-4${hex(seed + 13, 3)}-a${hex(seed + 19, 3)}-${hex(seed + 29, 8)}${hex(seed + 31, 4)}`;
}

function authenticationStrength(kind: "mfa" | "phishing-resistant", policyId: string) {
  const mfaCombinations = [
    "windowsHelloForBusiness", "fido2", "x509CertificateMultiFactor", "deviceBasedPush",
    "temporaryAccessPassOneTime", "temporaryAccessPassMultiUse", "password,microsoftAuthenticatorPush",
    "password,softwareOath", "password,hardwareOath", "password,sms", "password,voice",
    "federatedMultiFactor", "microsoftAuthenticatorPush,federatedSingleFactor", "softwareOath,federatedSingleFactor",
    "hardwareOath,federatedSingleFactor", "sms,federatedSingleFactor", "voice,federatedSingleFactor",
  ];
  const phishingResistant = ["windowsHelloForBusiness", "fido2", "x509CertificateMultiFactor"];
  const builtIn = kind === "mfa"
    ? { id: "00000000-0000-0000-0000-000000000002", displayName: "Multifactor authentication", description: "Combinations of methods that satisfy strong authentication, such as a password + SMS" }
    : { id: "00000000-0000-0000-0000-000000000004", displayName: "Phishing-resistant MFA", description: "Phishing-resistant, Passwordless methods for the strongest authentication, such as a FIDO2 security key" };
  return {
    "authenticationStrength@odata.context": `https://graph.microsoft.com/beta/$metadata#identity/conditionalAccess/policies('${policyId}')/grantControls/authenticationStrength/$entity`,
    authenticationStrength: {
      ...builtIn,
      policyType: "builtIn",
      requirementsSatisfied: "mfa",
      allowedCombinations: kind === "mfa" ? mfaCombinations : phishingResistant,
      createdDateTime: "2021-12-01T00:00:00Z",
      modifiedDateTime: "2021-12-01T00:00:00Z",
      "combinationConfigurations@odata.context": `https://graph.microsoft.com/beta/$metadata#identity/conditionalAccess/policies('${policyId}')/grantControls/authenticationStrength/combinationConfigurations`,
      combinationConfigurations: [],
    },
  };
}

function noStrength(policyId: string) {
  return {
    "authenticationStrength@odata.context": `https://graph.microsoft.com/beta/$metadata#identity/conditionalAccess/policies('${policyId}')/grantControls/authenticationStrength/$entity`,
    authenticationStrength: null,
  };
}

interface Archetype {
  name: string;
  state: string;
  users: Record<string, unknown>;
  applications?: Record<string, unknown>;
  clientAppTypes?: string[];
  platforms?: Record<string, unknown> | null;
  locations?: Record<string, unknown> | null;
  devices?: Record<string, unknown> | null;
  signInRiskLevels?: string[];
  userRiskLevels?: string[];
  grant: (id: string) => Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
}

const users = (overrides: Record<string, unknown>) => ({
  includeUsers: [], excludeUsers: [], includeGroups: [], excludeGroups: [], includeRoles: [], excludeRoles: [],
  includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null, ...overrides,
});
const grant = (operator: string, builtInControls: string[], extra: (id: string) => Record<string, unknown> = noStrength, termsOfUse: string[] = []) =>
  (id: string) => ({ operator, builtInControls, customAuthenticationFactors: [], termsOfUse, ...extra(id) });

function archetypes(seed: number): Archetype[] {
  const breakGlass = [syntheticId(seed, 901), syntheticId(seed, 902)];
  const group = (n: number) => syntheticId(seed + n, 77);
  const namedLocations = [syntheticId(seed, 501), syntheticId(seed, 502), syntheticId(seed, 503)];
  return [
    { name: "Require MFA for administrators", state: "enabled", users: users({ includeRoles: ADMIN_ROLES, excludeUsers: breakGlass }), grant: grant("OR", ["mfa"]) },
    { name: "Block legacy authentication", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), clientAppTypes: ["exchangeActiveSync", "other"], grant: grant("OR", ["block"]) },
    { name: "Require MFA for all users", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass, excludeGroups: [group(1)], excludeRoles: [DIRECTORY_SYNC_ROLE] }), grant: grant("OR", [], (id) => authenticationStrength("mfa", id)) },
    { name: "Require compliant or hybrid joined device", state: "enabledForReportingButNotEnforced", users: users({ includeUsers: ["All"], excludeUsers: breakGlass, excludeGroups: [group(2), group(3)] }), platforms: { includePlatforms: ["windows", "macOS"], excludePlatforms: [] }, grant: grant("OR", ["compliantDevice", "domainJoinedDevice"]) },
    { name: "Require MFA for guest access", state: "enabled", users: users({ includeGuestsOrExternalUsers: { guestOrExternalUserTypes: "internalGuest,b2bCollaborationGuest,b2bCollaborationMember,b2bDirectConnectUser,otherExternalUser,serviceProvider", externalTenants: { "@odata.type": "#microsoft.graph.conditionalAccessAllExternalTenants", membershipKind: "all" } } }), grant: grant("OR", [], (id) => authenticationStrength("mfa", id)) },
    { name: "Sign-in risk requires MFA", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), signInRiskLevels: ["high", "medium"], grant: grant("OR", ["mfa"]), session: { signInFrequency: { value: null, type: null, authenticationType: "primaryAndSecondaryAuthentication", frequencyInterval: "everyTime", isEnabled: true } } },
    { name: "User risk requires password change", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), userRiskLevels: ["high"], grant: grant("AND", ["mfa", "passwordChange"]) },
    { name: "Unmanaged devices browser only", state: "enabledForReportingButNotEnforced", users: users({ includeGroups: [group(4)] }), applications: { includeApplications: ["Office365"] }, clientAppTypes: ["browser"], grant: () => null, session: { applicationEnforcedRestrictions: { isEnabled: true }, cloudAppSecurity: { cloudAppSecurityType: "monitorOnly", isEnabled: true }, persistentBrowser: { mode: "never", isEnabled: true }, signInFrequency: { value: 12, type: "hours", authenticationType: "primaryAndSecondaryAuthentication", frequencyInterval: "timeBased", isEnabled: true } } },
    { name: "Block access from blocked countries", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), locations: { includeLocations: namedLocations, excludeLocations: ["AllTrusted"] }, grant: grant("OR", ["block"]) },
    { name: "Require MFA for Azure management", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), applications: { includeApplications: [AZURE_MANAGEMENT_APP] }, grant: grant("OR", ["mfa"]) },
    { name: "Phishing-resistant MFA for privileged roles", state: "enabledForReportingButNotEnforced", users: users({ includeRoles: ADMIN_ROLES.slice(0, 5), excludeUsers: breakGlass }), grant: grant("OR", [], (id) => authenticationStrength("phishing-resistant", id)) },
    { name: "Terms of use for Intune enrollment", state: "enabled", users: users({ includeUsers: ["All"] }), applications: { includeApplications: [INTUNE_ENROLLMENT_APP] }, grant: grant("OR", [], noStrength, [syntheticId(seed, 601)]) },
    { name: "Exclude kiosk devices by filter", state: "enabledForReportingButNotEnforced", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), devices: { deviceFilter: { mode: "exclude", rule: 'device.extensionAttribute1 -eq "Kiosk" -or device.model -startsWith "Surface Hub"' } }, grant: grant("OR", ["compliantDevice"]) },
    { name: "Legacy VPN MFA (old)", state: "disabled", users: users({ includeGroups: [group(5), group(6), group(7)] }), applications: { includeApplications: [syntheticId(seed, 701)] }, grant: grant("OR", ["mfa"]) },
    { name: "Require app protection on mobile", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass }), applications: { includeApplications: ["Office365"] }, platforms: { includePlatforms: ["android", "iOS"], excludePlatforms: [] }, grant: grant("OR", ["compliantApplication", "approvedApplication"]) },
    { name: "Secure security info registration", state: "enabled", users: users({ includeUsers: ["All"], excludeUsers: breakGlass, excludeGuestsOrExternalUsers: { guestOrExternalUserTypes: "internalGuest,b2bCollaborationGuest", externalTenants: { "@odata.type": "#microsoft.graph.conditionalAccessAllExternalTenants", membershipKind: "all" } } }), applications: { includeApplications: [], includeUserActions: ["urn:user:registersecurityinfo"] }, locations: { includeLocations: ["All"], excludeLocations: ["AllTrusted"] }, grant: grant("OR", ["mfa"]) },
  ];
}

const DEPARTMENTS = ["Finance", "HR", "Sales", "Engineering", "Operations", "Legal", "Marketing"];

/**
 * `count` policies in Graph's response shape. The first 16 are distinct
 * baseline policies; later ones are department variants of them with their
 * own groups, as tenants with many policies usually have.
 */
export function syntheticConditionalAccessPolicies(count: number, now = Date.now()): Array<Record<string, unknown>> {
  const policies: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const base = archetypes(index);
    const archetype = base[index % base.length]!;
    const round = Math.floor(index / base.length);
    const id = syntheticId(index, 1);
    const department = round === 0 ? "" : ` - ${DEPARTMENTS[(index + round) % DEPARTMENTS.length]}`;
    const variantUsers = round === 0
      ? archetype.users
      : { ...archetype.users, includeUsers: [], includeRoles: [], includeGroups: [syntheticId(index, 88), syntheticId(index, 89)] };
    const ageDays = [3, 40, 200, 400, 800, 15, 120, 760][index % 8]!;
    policies.push({
      id,
      templateId: null,
      displayName: `CA${String(index + 1).padStart(3, "0")} - ${archetype.name}${department}`,
      createdDateTime: new Date(now - (ageDays + 30) * DAY_MS).toISOString(),
      modifiedDateTime: index % 9 === 4 ? null : new Date(now - ageDays * DAY_MS).toISOString(),
      state: archetype.state,
      partialEnablementStrategy: null,
      sessionControls: archetype.session === undefined || archetype.session === null ? null : {
        disableResilienceDefaults: null, applicationEnforcedRestrictions: null, cloudAppSecurity: null, persistentBrowser: null,
        continuousAccessEvaluation: null, secureSignInSession: null, signInFrequency: null, globalSecureAccessFilteringProfile: null,
        ...archetype.session,
      },
      conditions: {
        userRiskLevels: archetype.userRiskLevels ?? [],
        signInRiskLevels: archetype.signInRiskLevels ?? [],
        clientAppTypes: archetype.clientAppTypes ?? ["all"],
        servicePrincipalRiskLevels: [],
        insiderRiskLevels: null,
        locations: archetype.locations ?? null,
        times: null,
        deviceStates: null,
        devices: archetype.devices ?? null,
        clientApplications: null,
        agents: null,
        actionsAndDestinations: null,
        authenticationFlows: null,
        applications: {
          includeApplications: ["All"], excludeApplications: [], includeUserActions: [], includeAgentActions: [],
          includeAuthenticationContextClassReferences: [], applicationFilter: null, ...archetype.applications,
        },
        users: variantUsers,
        platforms: archetype.platforms ?? null,
      },
      grantControls: archetype.grant(id),
    });
  }
  return policies;
}
