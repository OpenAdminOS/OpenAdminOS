import type { DataClass } from "@openadminos/agent-sdk";

// Source: docs/research/graph-field-classes.md and the decisions in docs/SPEC.md.
// [] matches an array element. * matches one property in a keyed object.
// Mapped containers set an inherited class. Unknown branches start at the resource default.
export const GRAPH_FIELD_CLASSES_VERSION = 8;

/** Equivalent paths in the bundled Graph index, with route parameters normalized by the classifier. */
export const GRAPH_ROUTE_ALIASES = {
  "/deviceManagement/comanagedDevices/{id}/getFileVaultKey": "/deviceManagement/managedDevices/{id}/getFileVaultKey",
  "/me/managedDevices/{id}/getFileVaultKey": "/deviceManagement/managedDevices/{id}/getFileVaultKey",
  "/users/{id}/managedDevices/{id}/getFileVaultKey": "/deviceManagement/managedDevices/{id}/getFileVaultKey",
  "/deviceManagement/comanagedDevices": "/deviceManagement/managedDevices",
  "/me/managedDevices": "/deviceManagement/managedDevices",
  "/users/{id}/managedDevices": "/deviceManagement/managedDevices",
  "/deviceManagement/comanagedDevices/{id}/windowsProtectionState": "/deviceManagement/managedDevices/{id}/windowsProtectionState",
  "/me/managedDevices/{id}/windowsProtectionState": "/deviceManagement/managedDevices/{id}/windowsProtectionState",
  "/users/{id}/managedDevices/{id}/windowsProtectionState": "/deviceManagement/managedDevices/{id}/windowsProtectionState",
  "/deviceManagement/comanagedDevices/{id}/windowsProtectionState/detectedMalwareState": "/deviceManagement/managedDevices/{id}/windowsProtectionState/detectedMalwareState",
  "/me/managedDevices/{id}/windowsProtectionState/detectedMalwareState": "/deviceManagement/managedDevices/{id}/windowsProtectionState/detectedMalwareState",
  "/users/{id}/managedDevices/{id}/windowsProtectionState/detectedMalwareState": "/deviceManagement/managedDevices/{id}/windowsProtectionState/detectedMalwareState",
  "/deviceManagement/comanagedDevices/{id}/deviceCompliancePolicyStates": "/deviceManagement/managedDevices/{id}/deviceCompliancePolicyStates",
  "/me/managedDevices/{id}/deviceCompliancePolicyStates": "/deviceManagement/managedDevices/{id}/deviceCompliancePolicyStates",
  "/users/{id}/managedDevices/{id}/deviceCompliancePolicyStates": "/deviceManagement/managedDevices/{id}/deviceCompliancePolicyStates",
  "/me/informationProtection/bitlocker/recoveryKeys": "/informationProtection/bitlocker/recoveryKeys",
  "/users/{id}/informationProtection/bitlocker/recoveryKeys": "/informationProtection/bitlocker/recoveryKeys",
  "/sites/{id}/informationProtection/bitlocker/recoveryKeys": "/informationProtection/bitlocker/recoveryKeys",
  "/groups/{id}/sites/{id}/informationProtection/bitlocker/recoveryKeys": "/informationProtection/bitlocker/recoveryKeys",
  "/directory/deviceLocalCredentials/{id}": "/directory/deviceLocalCredentials",
  "/applications/{id}/microsoft.graph.agentIdentityBlueprint/addPassword": "/applications/{id}/addPassword",
  "/servicePrincipals/{id}/addPassword": "/applications/{id}/addPassword",
  "/applications/{id}/appRoleAssignedTo": "/appRoleAssignments",
  "/applications/{id}/appRoleAssignments": "/appRoleAssignments",
  "/servicePrincipals/{id}/appRoleAssignedTo": "/appRoleAssignments",
  "/servicePrincipals/{id}/appRoleAssignments": "/appRoleAssignments",
  "/users/{id}/appRoleAssignments": "/appRoleAssignments",
  "/me/appRoleAssignments": "/appRoleAssignments",
  "/groups/{id}/appRoleAssignments": "/appRoleAssignments",
  "/servicePrincipals/{id}/oauth2PermissionGrants": "/oauth2PermissionGrants",
  "/users/{id}/oauth2PermissionGrants": "/oauth2PermissionGrants",
  "/me/oauth2PermissionGrants": "/oauth2PermissionGrants",
} as const;

/** Security fields carry a mask role. Unlisted settings use "setting". */
const SECURITY_MASK_NAMES = /^(?:name|id|.*(?:Name|Id|Ids)|.*ConsentDescription|description|cidrAddress|rolePermissions|permissionGrantPolicyIdsAssignedToDefaultUserRole)$/i;
const SECURITY_PERMISSION_NAMES = /\/(?:(?:approles|oauth2permissionscopes)\/\[\]\/value|oauth2permissiongrants\/\[\]\/scope)$/;
const SECURITY_LOCATION_RANGES = /\/ipranges\//;
const POSTURE_IDENTIFIERS = /(?:\/devicehealthattestationstate\/(?:securebootconfigurationpolicyfingerprint|codeintegritypolicy)|\/(?:settingstates|compliancesettingstates)\/\[\]\/setting|\/controlscores\/\[\]\/controlname|\/applicationguardcertificatethumbprints\/\[\])$/;
const CONDITIONAL_ACCESS_IDENTIFIERS = /^\/(?:conditions\/(?:locations\/(?:include|exclude)locations|users\/(?:include|exclude)roles)|grantcontrols\/(?:termsofuse|customauthenticationfactors))\/\[\]$/;
const GRAPH_GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function graphSecurityMaskRole(field: string, path: string, route: string, value: unknown): SecurityMaskRole {
  const conditionalAccessId = route === "/identity/conditionalaccess/policies" &&
    CONDITIONAL_ACCESS_IDENTIFIERS.test(path) && typeof value === "string" && GRAPH_GUID.test(value);
  return conditionalAccessId || SECURITY_MASK_NAMES.test(field) || SECURITY_PERMISSION_NAMES.test(path) || POSTURE_IDENTIFIERS.test(path) ||
    SECURITY_LOCATION_RANGES.test(path) || field.toLowerCase() === "scope" && route === "/oauth2permissiongrants"
    ? "nameOrIdentifier" : "setting";
}
export type SecurityMaskRole = "nameOrIdentifier" | "setting";

export const GRAPH_TEXT_FIELDS = /^(?:notes?|groupTag|publisher|rule|redirectUris?|.*(?:description|name|url|uri|reason)|comment|summary|details|title|message|oldValue|newValue)$/i;
export const GRAPH_DEVICE_NAME_FIELDS = /^(?:deviceName|managedDeviceName)$/i;
export const GRAPH_LEGACY_ENDPOINT_SECURITY_FIELDS = /^\/(?:(?:bitLocker|fileVault|firewall|defender|windowsDefender|advancedThreatProtection|deviceGuard|applicationGuard|appLocker|dmaGuard|gatekeeper|localSecurityOptions|lanManager|smartScreen)[^/]+|allowSampleSharing|enableExpeditedTelemetryReporting|securityBlockAzureADJoinedDevicesAutoEncryption|storageRequireMobileDeviceEncryption)$/i;

export const GRAPH_SECURITY_RESOURCES = new Set([
  "/identity/conditionalAccess/policies", "/identity/conditionalAccess/namedLocations",
  "/policies/authenticationMethodsPolicy", "/policies/authenticationStrengthPolicies",
  "/identity/conditionalAccess/authenticationStrength/policies",
  "/policies/identitySecurityDefaultsEnforcementPolicy", "/policies/crossTenantAccessPolicy",
  "/policies/crossTenantAccessPolicy/default", "/policies/crossTenantAccessPolicy/partners",
  "/policies/authorizationPolicy", "/deviceManagement/deviceCompliancePolicies",
  "/deviceAppManagement/managedAppPolicies", "/deviceAppManagement/iosManagedAppProtections",
  "/deviceAppManagement/androidManagedAppProtections",
  "/appRoleAssignments", "/oauth2PermissionGrants",
  "/directoryRoles", "/directoryRoleTemplates", "/roleManagement/directory/roleDefinitions",
  "/roleManagement/directory/roleAssignments", "/roleManagement/directory/transitiveRoleAssignments",
  "/roleManagement/directory/roleAssignmentScheduleRequests", "/roleManagement/directory/roleEligibilityScheduleRequests",
  "/roleManagement/directory/roleAssignmentSchedules",
  "/roleManagement/directory/roleEligibilitySchedules", "/roleManagement/directory/roleAssignmentScheduleInstances",
  "/roleManagement/directory/roleEligibilityScheduleInstances", "/policies/roleManagementPolicies",
  "/policies/roleManagementPolicyAssignments", "/identityGovernance/privilegedAccess/group", "/deviceManagement/intents",
  "/deviceManagement/intents/{id}/settings", "/deviceManagement/templates",
  "/identityProtection/policies", "/policies/identityProtectionPolicies",
]);

const malwareFields = {
  identity: "tenantDisplayName tenantId",
  device: "managedDeviceId managedDeviceName",
  activity: "deviceDeleted initialDetectionDateTime lastRefreshedDateTime lastStateChangeDateTime",
  security: "id additionalInformationUrl detectionCount malwareCategory malwareDisplayName malwareExecutionState malwareId malwareSeverity malwareThreatState",
};

const malwareArray = "detectedMalwareState[]";
const windowsProtectionFields = {
  identity: `tenantDisplayName tenantId ${under(malwareArray, malwareFields.identity)}`,
  device: `managedDeviceId managedDeviceName ${under(malwareArray, malwareFields.device)}`,
  activity: `
    deviceDeleted devicePropertyRefreshDateTime lastFullScanDateTime lastQuickScanDateTime lastRefreshedDateTime lastReportedDateTime
    ${under(malwareArray, malwareFields.activity)}
  `,
  security: `
    id antiMalwareVersion attentionRequired engineVersion fullScanOverdue fullScanRequired
    lastFullScanSignatureVersion lastQuickScanSignatureVersion malwareProtectionEnabled managedDeviceHealthState
    networkInspectionSystemEnabled quickScanOverdue realTimeProtectionEnabled rebootRequired signatureUpdateOverdue
    signatureVersion ${under(malwareArray, malwareFields.security)}
  `,
};

const compliancePolicyStateFields = {
  identity: "settingStates[].userName settingStates[].userEmail",
  security: "id displayName version platformType state settingCount settingStates[]",
};

function under(prefix: string, fields: string): string {
  return fields.trim().split(/\s+/).map(field => `${prefix}.${field}`).join(" ");
}

export const GRAPH_FIELD_CLASSES: Readonly<Record<string, Partial<Record<DataClass, string>>>> = {
  "/deviceManagement/managedDevices": {
    credential: "activationLockBypassCode remoteAssistanceSessionUrl",
    identity: `
      userPrincipalName userId emailAddress enrolledByUserPrincipalName phoneNumber userDisplayName
      notes hardwareInformation.phoneNumber
      hardwareInformation.sharedDeviceCachedUsers[] usersLoggedOn[].userId
      ${under("windowsProtectionState", windowsProtectionFields.identity)}
      ${under("deviceCompliancePolicyStates[]", compliancePolicyStateFields.identity)}
    `,
    device: `
      id deviceName managedDeviceName azureADDeviceId easDeviceId azureActiveDirectoryDeviceId imei serialNumber
      wiFiMacAddress meid iccid udid configurationManagerClientInformation ethernetMacAddress
      hardwareInformation.serialNumber hardwareInformation.imei hardwareInformation.meid
      hardwareInformation.wifiMac hardwareInformation.batterySerialNumber
      hardwareInformation.deviceFullQualifiedDomainName hardwareInformation.ipAddressV4
      hardwareInformation.subnetAddress hardwareInformation.esimIdentifier
      hardwareInformation.wiredIPv4Addresses[] chromeOSDeviceInfo[] supplementalDeviceDetails[]
      ${under("windowsProtectionState", windowsProtectionFields.device)}
    `,
    activity: `
      lastSyncDateTime enrolledDateTime easActivationDateTime exchangeLastSuccessfulSyncDateTime
      remoteAssistanceSessionErrorDetails preferMdmOverGroupPolicyAppliedDateTime deviceActionResults[]
      usersLoggedOn[].lastLogOnDateTime
      ${under("windowsProtectionState", windowsProtectionFields.activity)}
    `,
    security: `
      isEncrypted hardwareInformation.isEncrypted partnerReportedThreatState windowsActiveMalwareCount
      windowsRemediatedMalwareCount hardwareInformation.deviceGuardVirtualizationBasedSecurityHardwareRequirementState
      hardwareInformation.deviceGuardVirtualizationBasedSecurityState
      hardwareInformation.deviceGuardLocalSystemAuthorityCredentialGuardState
      hardwareInformation.tpmSpecificationVersion hardwareInformation.tpmManufacturer hardwareInformation.tpmVersion
      hardwareInformation.systemManagementBIOSVersion deviceHealthAttestationState deviceIdentityAttestationDetail
      complianceState complianceGracePeriodExpirationDateTime jailBroken lostModeState exchangeAccessState
      exchangeAccessStateReason androidSecurityPatchLevel securityPatchLevel bootstrapTokenEscrowed
      deviceFirmwareConfigurationInterfaceManaged managementCertificateExpirationDate
      configurationManagerClientHealthState
      ${under("windowsProtectionState", windowsProtectionFields.security)}
      ${under("deviceCompliancePolicyStates[]", compliancePolicyStateFields.security)}
    `,
    configuration: `
      operatingSystem osVersion managementState managedDeviceOwnerType
      deviceEnrollmentType manufacturer model ownerType chassisType deviceType managementAgent
      easActivated aadRegistered azureADRegistered deviceRegistrationState
      deviceCategoryDisplayName isSupervised configurationManagerClientEnabledFeatures subscriberCarrier
      totalStorageSpaceInBytes freeStorageSpaceInBytes retireAfterDateTime
      autopilotEnrolled requireUserEnrollmentApproval
      roleScopeTagIds[]
      physicalMemoryInBytes processorArchitecture
      specificationVersion joinType skuFamily skuNumber managementFeatures
      enrollmentProfileName hardwareInformation.totalStorageSpace
      hardwareInformation.freeStorageSpace hardwareInformation.manufacturer hardwareInformation.model
      hardwareInformation.subscriberCarrier hardwareInformation.cellularTechnology
      hardwareInformation.operatingSystemLanguage hardwareInformation.isSupervised
      hardwareInformation.batteryHealthPercentage
      hardwareInformation.batteryChargeCycles hardwareInformation.isSharedDevice
      hardwareInformation.operatingSystemEdition
      hardwareInformation.osBuildNumber hardwareInformation.operatingSystemProductType
      hardwareInformation.batteryLevelPercentage
      hardwareInformation.residentUsersCount hardwareInformation.productName
      hardwareInformation.deviceLicensingStatus hardwareInformation.deviceLicensingLastErrorCode
      hardwareInformation.deviceLicensingLastErrorDescription
    `,
  },
  "/deviceManagement/managedDevices/{id}/windowsProtectionState": windowsProtectionFields,
  "/deviceManagement/managedDevices/{id}/windowsProtectionState/detectedMalwareState": malwareFields,
  "/deviceManagement/managedDevices/{id}/deviceCompliancePolicyStates": compliancePolicyStateFields,
  "/devices": {
    device: "id deviceId displayName",
    activity: "approximateLastSignInDateTime",
    configuration: "accountEnabled operatingSystem",
    security: "isCompliant complianceExpirationDateTime isManaged trustType isRooted isManagementRestricted",
  },
  "/users": {
    credential: "passwordProfile.password",
    identity: "id displayName userPrincipalName mail usageLocation",
    activity: `
      createdDateTime signInActivity.lastSignInDateTime signInActivity.lastSignInRequestId
      signInActivity.lastNonInteractiveSignInDateTime signInActivity.lastNonInteractiveSignInRequestId
      signInActivity.lastSuccessfulSignInDateTime signInActivity.lastSuccessfulSignInRequestId
      externalUserStateChangeDateTime
    `,
    configuration: `
      accountEnabled userType assignedLicenses[] assignedLicenses[].skuId assignedLicenses[].disabledPlans[]
      externalUserState passwordProfile.forceChangePasswordNextSignIn
    `,
  },
  "/groups": {
    identity: "mail mailNickname proxyAddresses[]",
    configuration: "id displayName securityEnabled groupTypes[] createdDateTime",
  },
  "/deviceManagement/deviceCompliancePolicies": {
    identity: "deviceStatuses[].userName userStatuses[].userName",
    security: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceManagement/deviceConfigurations": {
    credential: `
      preSharedKey customData[].value customKeyValueData[].value customXml eapXml
      omaSettings[].secretReferenceValueId omaSettings[].value payload
    `,
    identity: "outerIdentityPrivacyTemporaryValue",
    security: "omaSettings[].isEncrypted",
    configuration: `
      @odata.type id displayName description createdDateTime lastModifiedDateTime ssid networkName
      wifiSecurityType connectAutomatically connectWhenNetworkNameIsHidden proxySetting proxyManualAddress
      proxyManualPort proxyAutomaticConfigurationUrl preSharedKeyIsSet trustedServerCertificateNames[]
      connectionName connectionType servers[].address servers[].description servers[].isDefaultServer
      server.address loginGroupOrDomain realm role identifier customData[].key customKeyValueData[].name
      userDomain dnsSuffixes[] trustedNetworkDomains[] roleScopeTagIds[] supportsScopeTags
      deviceManagementApplicabilityRuleOsEdition deviceManagementApplicabilityRuleOsVersion
      deviceManagementApplicabilityRuleDeviceMode version omaSettings[].@odata.type
      omaSettings[].displayName omaSettings[].description omaSettings[].omaUri
      omaSettings[].isReadOnly payloadName payloadFileName
    `,
  },
  "/deviceManagement/configurationPolicies": {
    configuration: `
      id name description platforms technologies createdDateTime lastModifiedDateTime settingCount
      isAssigned settings[]
    `,
  },
  "/auditLogs/signIns": {
    identity: `
      userDisplayName userPrincipalName ipAddress location.city location.state location.countryOrRegion
      location.geoCoordinates.altitude location.geoCoordinates.latitude location.geoCoordinates.longitude
      userId location
    `,
    device: "deviceDetail.deviceId deviceDetail.displayName",
    activity: `
      id createdDateTime appDisplayName clientAppUsed conditionalAccessStatus isInteractive riskDetail
      riskLevelAggregated riskLevelDuringSignIn riskState resourceDisplayName status.errorCode
      status.failureReason status.additionalDetails deviceDetail.operatingSystem deviceDetail.browser
      appliedConditionalAccessPolicies[].sessionControlsNotSatisfied[]
      appliedConditionalAccessPolicies[].result appliedConditionalAccessPolicies[].conditionsSatisfied
      appliedConditionalAccessPolicies[].conditionsNotSatisfied
      appliedConditionalAccessPolicies[].authenticationStrength
      appliedConditionalAccessPolicies[].includeRulesSatisfied[].conditionalAccessCondition
      appliedConditionalAccessPolicies[].includeRulesSatisfied[].ruleSatisfied
      appliedConditionalAccessPolicies[].excludeRulesSatisfied[]
    `,
    security: `
      deviceDetail.isCompliant deviceDetail.isManaged deviceDetail.trustType
      appliedConditionalAccessPolicies[].id appliedConditionalAccessPolicies[].displayName
      appliedConditionalAccessPolicies[].enforcedGrantControls[]
      appliedConditionalAccessPolicies[].enforcedSessionControls[]
    `,
  },
  "/auditLogs/directoryAudits": {
    identity: `
      initiatedBy.user.ipAddress initiatedBy.user.id initiatedBy.user.displayName initiatedBy.user.userPrincipalName
      initiatedBy.linkableIdentifiers targetResources[].id targetResources[].displayName
      targetResources[].userPrincipalName targetResources[].modifiedProperties[].oldValue
      targetResources[].modifiedProperties[].newValue additionalDetails[].value
    `,
    activity: `
      id category activityDisplayName activityDateTime result resultReason operationType loggedByService
      targetResources[].type targetResources[].modifiedProperties[].displayName additionalDetails[].key
    `,
    configuration: `
      initiatedBy.app.appId initiatedBy.app.displayName initiatedBy.app.servicePrincipalId
      initiatedBy.app.servicePrincipalName targetResources[].groupType
    `,
  },
  "/deviceManagement/auditEvents": {
    identity: `
      actor.ipAddress actor.userPrincipalName actor.userId actor.remoteUserId resources[].modifiedProperties[].oldValue
      resources[].modifiedProperties[].newValue
    `,
    device: "resources[].resourceId",
    activity: `
      id displayName componentName activityDateTime activityType activityOperationType activityResult
      category correlationId actor.type actor.auditActorType resources[].displayName resources[].type
      resources[].auditResourceType resources[].modifiedProperties[].displayName
    `,
    configuration: `
      actor.userPermissions[] actor.applicationId actor.applicationDisplayName actor.servicePrincipalName
      actor.remoteTenantId actor.userRoleScopeTags[]
    `,
  },
  "/identity/conditionalAccess/policies": {
    identity: "conditions.users.includeUsers[] conditions.users.excludeUsers[] conditions.users.includeGroups[] conditions.users.excludeGroups[]",
    security: `
      id templateId displayName createdDateTime modifiedDateTime state deletedDateTime
      partialEnablementStrategy sessionControls conditions.userRiskLevels[] conditions.signInRiskLevels[]
      conditions.clientAppTypes[] conditions.locations conditions.locations.includeLocations[]
      conditions.locations.excludeLocations[] conditions.times conditions.deviceStates
      conditions.devices conditions.clientApplications conditions.agents conditions.actionsAndDestinations
      conditions.applications.includeApplications[] conditions.applications.excludeApplications[]
      conditions.applications.includeUserActions[] conditions.applications.includeAgentActions[]
      conditions.applications.includeAuthenticationContextClassReferences[]
      conditions.applications.applicationFilter conditions.users.includeRoles[] conditions.users.excludeRoles[]
      conditions.users.includeGuestsOrExternalUsers conditions.users.excludeGuestsOrExternalUsers
      conditions.platforms.includePlatforms[] conditions.platforms.excludePlatforms[]
      grantControls.operator grantControls.builtInControls[] grantControls.customAuthenticationFactors[]
      grantControls.termsOfUse[] grantControls.authenticationStrength
    `,
  },
  "/deviceAppManagement/mobileApps": {
    configuration: `
      @odata.type id displayName description createdDateTime lastModifiedDateTime publisher isAssigned
      publishingState
    `,
  },
  "/deviceManagement/detectedApps": {
    configuration: "id displayName version sizeInByte deviceCount publisher platform",
  },
  "/deviceAppManagement/managedAppPolicies": {
    security: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceAppManagement/iosManagedAppProtections": {
    security: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceAppManagement/androidManagedAppProtections": {
    security: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceAppManagement/mobileAppConfigurations": {
    credential: "encodedSettingXml settings[].appConfigKeyValue",
    configuration: `
      @odata.type id displayName description createdDateTime lastModifiedDateTime targetedMobileApps[]
    `,
  },
  "/deviceManagement/deviceHealthScripts": {
    credential: "detectionScriptContent remediationScriptContent",
    identity: "publisher",
    configuration: `
      id displayName description createdDateTime lastModifiedDateTime runAsAccount runAs32Bit
      enforceSignatureCheck
    `,
  },
  "/deviceManagement/deviceManagementScripts": {
    credential: "scriptContent",
    configuration: `
      id displayName description createdDateTime lastModifiedDateTime runAsAccount runAs32Bit
      enforceSignatureCheck
    `,
  },
  "/deviceManagement/windowsAutopilotDeviceIdentities": {
    credential: "productKey deviceAccountPassword",
    identity: "addressableUserName userPrincipalName resourceName deviceAccountUpn",
    device: `
      id serialNumber azureActiveDirectoryDeviceId azureAdDeviceId managedDeviceId displayName
      deviceFriendlyName
    `,
    activity: `
      deploymentProfileAssignedDateTime lastContactedDateTime remediationStateLastModifiedDateTime
    `,
    configuration: `
      deploymentProfileAssignmentStatus deploymentProfileAssignmentDetailedStatus groupTag
      purchaseOrderIdentifier manufacturer model enrollmentState skuNumber systemFamily remediationState
      userlessEnrollmentStatus
    `,
  },
  "/deviceManagement/autopilotEvents": {
    identity: "userId userPrincipalName",
    device: "deviceId deviceSerialNumber managedDeviceName",
    activity: `
      id eventDateTime deviceRegisteredDateTime enrollmentStartDateTime enrollmentState deploymentState
      deviceSetupStatus accountSetupStatus deploymentStartDateTime deploymentEndDateTime
      enrollmentFailureDetails
    `,
    configuration: `
      enrollmentType windowsAutopilotDeploymentProfileDisplayName
      windows10EnrollmentCompletionPageConfigurationDisplayName osVersion
    `,
  },
  "/deviceManagement/windowsAutopilotDeploymentProfiles": {
    configuration: `
      @odata.type id displayName description createdDateTime lastModifiedDateTime deviceNameTemplate
      deviceType
    `,
  },
  "/deviceManagement/deviceEnrollmentConfigurations": {
    configuration: "@odata.type id displayName description createdDateTime lastModifiedDateTime priority",
  },
  "/deviceManagement/windowsQualityUpdateProfiles": {
    configuration: "id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceManagement/windowsFeatureUpdateProfiles": {
    configuration: "id displayName description createdDateTime lastModifiedDateTime featureUpdateVersion",
  },
  "/deviceManagement/intents": {
    security: "id displayName description templateId lastModifiedDateTime isAssigned",
  },
  "/deviceManagement/groupPolicyConfigurations": {
    configuration: "id displayName description createdDateTime lastModifiedDateTime definitionValues[]",
  },
  "/deviceManagement/configurationPolicies/{id}/settings": {
    configuration: "id settingInstance",
  },
  "/deviceManagement/intents/{id}/settings": {
    security: "id definitionId valueJson value",
  },
  "/deviceManagement/groupPolicyConfigurations/{id}/definitionValues": {
    configuration: "id enabled configurationType definition presentationValues[]",
  },
  "/deviceManagement/groupPolicyConfigurations/{id}/definitionValues/{id}/presentationValues": {
    configuration: "id value values[] presentation",
  },
  "/deviceManagement/assignmentFilters": {
    device: "rule",
    configuration: `
      id displayName description platform assignmentFilterManagementType createdDateTime
      lastModifiedDateTime
    `,
  },
  "/deviceManagement/roleScopeTags": {
    configuration: "id displayName description",
  },
  "/deviceManagement/managedDeviceOverview": {
    security: "deviceExchangeAccessStateSummary",
    configuration: `
      id enrolledDeviceCount mdmEnrolledCount dualEnrolledDeviceCount managedDeviceModelsAndManufacturers
      lastModifiedDateTime deviceOperatingSystemSummary.androidCount deviceOperatingSystemSummary.iosCount
      deviceOperatingSystemSummary.macOSCount deviceOperatingSystemSummary.windowsMobileCount
      deviceOperatingSystemSummary.windowsCount deviceOperatingSystemSummary.unknownCount
      deviceOperatingSystemSummary.androidDedicatedCount
      deviceOperatingSystemSummary.androidDeviceAdminCount
      deviceOperatingSystemSummary.androidFullyManagedCount
      deviceOperatingSystemSummary.androidWorkProfileCount
      deviceOperatingSystemSummary.androidCorporateWorkProfileCount
      deviceOperatingSystemSummary.configMgrDeviceCount deviceOperatingSystemSummary.aospUserlessCount
      deviceOperatingSystemSummary.aospUserAssociatedCount deviceOperatingSystemSummary.linuxCount
      deviceOperatingSystemSummary.chromeOSCount
    `,
  },
  "/deviceManagement/managedDeviceEncryptionStates": {
    identity: "userPrincipalName",
    device: "id deviceName",
    configuration: "deviceType osVersion",
    security: `
      encryptionReadinessState encryptionState encryptionPolicySettingState advancedBitLockerStates
      fileVaultStates tpmSpecificationVersion policyDetails[] policyDetails[].policyId policyDetails[].policyName
    `,
  },
  "/deviceManagement/troubleshootingEvents": {
    activity: `
      id eventDateTime correlationId troubleshootingErrorDetails troubleshootingErrorDetails.context
      troubleshootingErrorDetails.failure troubleshootingErrorDetails.failureDetails
    `,
    public: `
      troubleshootingErrorDetails.remediation troubleshootingErrorDetails.resources[].text
      troubleshootingErrorDetails.resources[].link
    `,
  },
  "/identity/conditionalAccess/namedLocations": {
    security: "id displayName createdDateTime modifiedDateTime isTrusted ipRanges[] countriesAndRegions[] includeUnknownCountriesAndRegions countryLookupMethod",
  },
  "/policies/authenticationMethodsPolicy": {
    identity: `
      registrationEnforcement.authenticationMethodsRegistrationCampaign.excludeTargets[].id
      registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].id
      systemCredentialPreferences.excludeTargets[] systemCredentialPreferences.includeTargets[].id
      reportSuspiciousActivitySettings.includeTarget.id
      authenticationMethodConfigurations[].excludeTargets[]
      authenticationMethodConfigurations[].includeTargets[].id
      authenticationMethodConfigurations[].featureSettings.*.includeTarget.id
      authenticationMethodConfigurations[].featureSettings.*.excludeTarget.id
      authenticationMethodConfigurations[].excludeTargets[].id
    `,
    security: `
      id displayName description lastModifiedDateTime policyVersion policyMigrationState optOutSettings
      registrationEnforcement.authenticationMethodsRegistrationCampaign.snoozeDurationInDays
      registrationEnforcement.authenticationMethodsRegistrationCampaign.enforceRegistrationAfterAllowedSnoozes
      registrationEnforcement.authenticationMethodsRegistrationCampaign.state
      registrationEnforcement.authenticationMethodsRegistrationCampaign.excludeTargets[].targetType
      registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].targetType
      registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].targetedAuthenticationMethod
      systemCredentialPreferences.state systemCredentialPreferences.includeTargets[].targetType
      reportSuspiciousActivitySettings.state reportSuspiciousActivitySettings.voiceReportingCode
      reportSuspiciousActivitySettings.includeTarget.targetType
      authenticationMethodConfigurations[].@odata.type authenticationMethodConfigurations[].id
      authenticationMethodConfigurations[].state
      authenticationMethodConfigurations[].includeTargets[].targetType
      authenticationMethodConfigurations[].includeTargets[].isRegistrationRequired
      authenticationMethodConfigurations[].callerIdNumber
      authenticationMethodConfigurations[].isSelfServiceRegistrationAllowed
      authenticationMethodConfigurations[].isAttestationEnforced
      authenticationMethodConfigurations[].defaultPasskeyProfile
      authenticationMethodConfigurations[].isSoftwareOathEnabled
      authenticationMethodConfigurations[].isOfficePhoneAllowed
      authenticationMethodConfigurations[].isCustomGreetingEnabled
      authenticationMethodConfigurations[].defaultLifetimeInMinutes
      authenticationMethodConfigurations[].defaultLength
      authenticationMethodConfigurations[].minimumLifetimeInMinutes
      authenticationMethodConfigurations[].maximumLifetimeInMinutes
      authenticationMethodConfigurations[].isUsableOnce
      authenticationMethodConfigurations[].allowPasswordChangeAfterSecureSignIn
      authenticationMethodConfigurations[].allowExternalIdToUseEmailOtp
      authenticationMethodConfigurations[].requireCertificateSidAlignment
      authenticationMethodConfigurations[].issuerHintsConfiguration.state
      authenticationMethodConfigurations[].certificateAuthorityScopes[]
      authenticationMethodConfigurations[].identityVerificationEventsConfiguration.isEnabled
      authenticationMethodConfigurations[].standardQRCodeLifetimeInDays
      authenticationMethodConfigurations[].pinLength authenticationMethodConfigurations[].profiles[]
      authenticationMethodConfigurations[].includeTargets[].authenticationMode
      authenticationMethodConfigurations[].includeTargets[].isUsableForSignIn
      authenticationMethodConfigurations[].includeTargets[].verificationMode
      authenticationMethodConfigurations[].includeTargets[].allowedPasskeyProfiles[]
      authenticationMethodConfigurations[].includeTargets[].verifiedIdProfiles[]
      authenticationMethodConfigurations[].includeTargets[].allowedProfiles[]
      authenticationMethodConfigurations[].featureSettings.*.state
      authenticationMethodConfigurations[].featureSettings.*.includeTarget.targetType
      authenticationMethodConfigurations[].featureSettings.*.excludeTarget.targetType
    `,
  },
  "/policies/authorizationPolicy": {
    security: `
      id allowInvitesFrom allowedToSignUpEmailBasedSubscriptions allowedToUseSSPR
      allowEmailVerifiedUsersToJoinOrganization allowUserConsentForRiskyApps blockMsolPowerShell
      description displayName enabledPreviewFeatures[] guestUserRoleId
      permissionGrantPolicyIdsAssignedToDefaultUserRole[] defaultUserRolePermissions.allowedToCreateApps
      defaultUserRolePermissions.allowedToCreateAgentIdentityBlueprints
      defaultUserRolePermissions.allowedToCreateSecurityGroups
      defaultUserRolePermissions.allowedToCreateTenants
      defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice
      defaultUserRolePermissions.allowedToReadOtherUsers
    `,
  },
  "/policies/crossTenantAccessPolicy": {
    security: `
      id definition[] displayName applyDefaultsToDomainBasedOrganizations allowedCloudEndpoints[]
    `,
  },
  "/directoryRoles": {
    security: "id displayName description roleTemplateId",
  },
  "/roleManagement/directory/roleDefinitions": {
    security: "id displayName description templateId isBuiltIn isEnabled rolePermissions[]",
  },
  "/roleManagement/directory/roleAssignments": {
    identity: "principalId principal",
    security: "id roleDefinitionId directoryScopeId appScopeId",
  },
  "/policies/identitySecurityDefaultsEnforcementPolicy": {
    security: "id displayName description isEnabled",
  },
  "/policies/authenticationStrengthPolicies": {
    security: "id displayName description policyType requirementsSatisfied allowedCombinations[]",
  },
  "/administrativeUnits": {
    configuration: "id displayName description visibility",
  },
  "/applications": {
    security: "requiredResourceAccess[] appRoles[] oauth2PermissionScopes[] api.oauth2PermissionScopes[] api.preAuthorizedApplications[].delegatedPermissionIds[] appRoleAssignments[] appRoleAssignedTo[] oauth2PermissionGrants[]",
    credential: "passwordCredentials[].secretText passwordCredentials[].hint keyCredentials[].key",
    configuration: `
      passwordCredentials[] keyCredentials[] id appId displayName createdDateTime publisherDomain signInAudience tags[] description
      identifierUris[] notes serviceManagementReference api.requestedAccessTokenVersion
      api.acceptMappedClaims api.knownClientApplications[]
      api.preAuthorizedApplications[] api.tokenEncryptionSetting.scheme
      api.tokenEncryptionSetting.audience api.tokenEncryptionSetting.automatedTokenVersion.current
      api.tokenEncryptionSetting.automatedTokenVersion.available[]
      passwordCredentials[].customKeyIdentifier passwordCredentials[].endDateTime
      passwordCredentials[].keyId passwordCredentials[].startDateTime passwordCredentials[].displayName
      keyCredentials[].customKeyIdentifier keyCredentials[].endDateTime keyCredentials[].keyId
      keyCredentials[].startDateTime keyCredentials[].type keyCredentials[].usage
      keyCredentials[].displayName keyCredentials[].hasExtendedValue web.redirectUris[] web.homePageUrl
      web.logoutUrl web.enabledResponseModes web.customAuthenticationUx web.redirectUriSettings[].uri
      web.redirectUriSettings[].index web.implicitGrantSettings.enableIdTokenIssuance
      web.implicitGrantSettings.enableAccessTokenIssuance spa.redirectUris[] spa.enabledResponseModes
      publicClient.redirectUris[] publicClient.enabledResponseModes
    `,
  },
  "/servicePrincipals": {
    security: "requiredResourceAccess[] appRoles[] oauth2PermissionScopes[] api.oauth2PermissionScopes[] appRoleAssignments[] appRoleAssignedTo[] oauth2PermissionGrants[]",
    credential: "passwordCredentials[].secretText passwordCredentials[].hint keyCredentials[].key",
    configuration: `
      passwordCredentials[] keyCredentials[] id appId displayName accountEnabled servicePrincipalType appOwnerOrganizationId
      passwordCredentials[].customKeyIdentifier passwordCredentials[].endDateTime
      passwordCredentials[].keyId passwordCredentials[].startDateTime passwordCredentials[].displayName
      keyCredentials[].customKeyIdentifier keyCredentials[].endDateTime keyCredentials[].keyId
      keyCredentials[].startDateTime keyCredentials[].type keyCredentials[].usage
      keyCredentials[].displayName keyCredentials[].hasExtendedValue
    `,
  },
  "/applications/{id}/addPassword": {
    credential: "secretText hint passwordCredential.secretText passwordCredential.hint",
  },
  "/appRoleAssignments": {
    identity: "principalId principalDisplayName",
    security: "id appRoleId resourceId resourceDisplayName principalType createdDateTime",
  },
  "/oauth2PermissionGrants": {
    identity: "principalId",
    security: "id clientId resourceId consentType scope",
  },
  "/domains": {
    configuration: "id isDefault isInitial isVerified authenticationType",
  },
  "/security/alerts_v2": {
    security: `
      id alertPolicyId detectorId incidentId providerAlertId severity status investigationState
      classification determination evidence[].defenderAvStatus evidence[].healthStatus evidence[].onboardingStatus
      evidence[].riskScore evidence[].rbacGroupId evidence[].rbacGroupName
    `,
    device: "evidence[].azureAdDeviceId evidence[].mdeDeviceId evidence[].deviceDnsName evidence[].hostName",
    activity: `
      title detectionSource serviceSource createdDateTime lastUpdateDateTime
    `,
  },
  "/security/incidents": {
    identity: "assignedTo",
    security: "id displayName redirectIncidentId severity status classification determination priorityScore",
    activity: `
      createdDateTime lastUpdateDateTime
    `,
  },
  "/security/secureScores": {
    security: `
      id currentScore maxScore enabledServices[] controlScores[].controlName controlScores[].implementationStatus
      controlScores[].on controlScores[].score controlScores[].scoreInPercentage controlScores[].count controlScores[].total
    `,
    configuration: `
      createdDateTime activeUserCount licensedUserCount azureTenantId controlScores[].lastSynced
    `,
    public: `
      averageComparativeScores[].SeatSizeRangeLowerValue
      averageComparativeScores[].SeatSizeRangeUpperValue averageComparativeScores[].appsScore
      averageComparativeScores[].appsScoreMax averageComparativeScores[].averageScore
      averageComparativeScores[].basis averageComparativeScores[].dataScore
      averageComparativeScores[].dataScoreMax averageComparativeScores[].deviceScore
      averageComparativeScores[].deviceScoreMax averageComparativeScores[].identityScore
      averageComparativeScores[].identityScoreMax averageComparativeScores[].infrastructureScore
      averageComparativeScores[].infrastructureScoreMax controlScores[].controlCategory
      controlScores[].description vendorInformation.provider
      vendorInformation.providerVersion vendorInformation.subProvider vendorInformation.vendor
    `,
  },
  "/security/secureScoreControlProfiles": {
    identity: `
      controlStateUpdates[].assignedTo controlStateUpdates[].comment controlStateUpdates[].updatedBy
    `,
    activity: "controlStateUpdates[].updatedDateTime",
    configuration: "azureTenantId",
    security: "controlStateUpdates[].state",
    public: `
      id actionType actionUrl controlCategory controlName title deprecated implementationCost lastModifiedDateTime
      maxScore rank remediation remediationImpact service threats[] tier userImpact
      vendorInformation.provider vendorInformation.providerVersion vendorInformation.subProvider
      vendorInformation.vendor complianceInformation[]
    `,
  },
  "/identityProtection/riskyUsers": {
    identity: "id userPrincipalName userDisplayName",
    activity: "riskLevel riskState riskDetail riskLastUpdatedDateTime",
    configuration: "isDeleted isProcessing",
  },
  "/informationProtection/bitlocker/recoveryKeys": {
    credential: "key",
    device: "deviceId",
    activity: "createdDateTime",
    security: "id volumeType",
  },
  "/directory/deviceLocalCredentials": {
    credential: "credentials[].passwordBase64",
    device: "id deviceName credentials[].accountName credentials[].accountSid",
    activity: "lastBackupDateTime credentials[].backupDateTime",
    configuration: "refreshDateTime",
  },
  "/deviceManagement/managedDevices/{id}/getFileVaultKey": {
    credential: "value",
  },
  "/deviceManagement/deviceConfigurations/{id}/getOmaSettingPlainTextValue": {
    credential: "value",
  },
};
