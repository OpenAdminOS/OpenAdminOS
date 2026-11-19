import type { DataClass } from "@openadminos/agent-sdk";

// Source: docs/research/graph-field-classes.md and the decisions in docs/SPEC.md.
// [] matches an array element. * matches one property in a keyed object.
// Mapped containers set an inherited class. Unknown branches start at the resource default.
export const GRAPH_FIELD_CLASSES_VERSION = 1;

export const GRAPH_TEXT_FIELDS = /^(?:notes?|groupTag|publisher|rule|redirectUris?|.*(?:description|name|url|uri|reason)|comment|summary|details|title|message|oldValue|newValue)$/i;
export const GRAPH_DEVICE_NAME_FIELDS = /^(?:deviceName|managedDeviceName)$/i;

export const GRAPH_SECURITY_RESOURCES = new Set([
  "/identity/conditionalAccess/policies", "/identity/conditionalAccess/namedLocations",
  "/policies/authenticationMethodsPolicy", "/policies/authenticationStrengthPolicies",
  "/identity/conditionalAccess/authenticationStrength/policies",
  "/policies/identitySecurityDefaultsEnforcementPolicy", "/policies/crossTenantAccessPolicy",
  "/policies/crossTenantAccessPolicy/default", "/policies/crossTenantAccessPolicy/partners",
  "/directoryRoles", "/directoryRoleTemplates", "/roleManagement/directory/roleDefinitions",
  "/roleManagement/directory/roleAssignments", "/roleManagement/directory/transitiveRoleAssignments",
  "/roleManagement/directory/roleAssignmentScheduleRequests", "/roleManagement/directory/roleEligibilityScheduleRequests",
  "/roleManagement/directory/roleAssignmentSchedules",
  "/roleManagement/directory/roleEligibilitySchedules", "/roleManagement/directory/roleAssignmentScheduleInstances",
  "/roleManagement/directory/roleEligibilityScheduleInstances", "/policies/roleManagementPolicies",
  "/policies/roleManagementPolicyAssignments", "/privilegedAccess/group/assignmentSchedules",
  "/privilegedAccess/group/eligibilitySchedules", "/privilegedAccess/group/assignmentScheduleInstances",
  "/privilegedAccess/group/eligibilityScheduleInstances", "/deviceManagement/intents",
  "/deviceManagement/intents/{id}/settings", "/deviceManagement/templates",
  "/identityProtection/policies", "/policies/identityProtectionPolicies",
]);
export const GRAPH_FIELD_CLASSES: Readonly<Record<string, Partial<Record<DataClass, string>>>> = {
  "/deviceManagement/managedDevices": {
    credential: "activationLockBypassCode remoteAssistanceSessionUrl",
    identity: `
      userPrincipalName userId emailAddress enrolledByUserPrincipalName phoneNumber userDisplayName
      notes hardwareInformation.phoneNumber
      hardwareInformation.sharedDeviceCachedUsers[] usersLoggedOn[].userId
    `,
    device: `
      id deviceName managedDeviceName azureADDeviceId easDeviceId azureActiveDirectoryDeviceId imei serialNumber
      wiFiMacAddress meid iccid udid configurationManagerClientInformation ethernetMacAddress
      hardwareInformation.serialNumber hardwareInformation.imei hardwareInformation.meid
      hardwareInformation.wifiMac hardwareInformation.batterySerialNumber
      hardwareInformation.deviceFullQualifiedDomainName hardwareInformation.ipAddressV4
      hardwareInformation.subnetAddress hardwareInformation.esimIdentifier
      hardwareInformation.wiredIPv4Addresses[] chromeOSDeviceInfo[] supplementalDeviceDetails[]
    `,
    activity: `
      lastSyncDateTime enrolledDateTime easActivationDateTime exchangeLastSuccessfulSyncDateTime
      remoteAssistanceSessionErrorDetails preferMdmOverGroupPolicyAppliedDateTime deviceActionResults[]
      usersLoggedOn[].lastLogOnDateTime
    `,
    configuration: `
      operatingSystem osVersion isEncrypted complianceState managementState managedDeviceOwnerType
      deviceEnrollmentType manufacturer model ownerType chassisType deviceType jailBroken managementAgent
      easActivated aadRegistered azureADRegistered lostModeState deviceRegistrationState
      deviceCategoryDisplayName isSupervised exchangeAccessState exchangeAccessStateReason
      complianceGracePeriodExpirationDateTime androidSecurityPatchLevel
      configurationManagerClientEnabledFeatures deviceHealthAttestationState subscriberCarrier
      totalStorageSpaceInBytes freeStorageSpaceInBytes partnerReportedThreatState retireAfterDateTime
      autopilotEnrolled requireUserEnrollmentApproval managementCertificateExpirationDate
      roleScopeTagIds[] windowsActiveMalwareCount windowsRemediatedMalwareCount
      configurationManagerClientHealthState physicalMemoryInBytes processorArchitecture
      specificationVersion joinType skuFamily securityPatchLevel skuNumber managementFeatures
      enrollmentProfileName bootstrapTokenEscrowed deviceFirmwareConfigurationInterfaceManaged
      deviceIdentityAttestationDetail hardwareInformation.totalStorageSpace
      hardwareInformation.freeStorageSpace hardwareInformation.manufacturer hardwareInformation.model
      hardwareInformation.subscriberCarrier hardwareInformation.cellularTechnology
      hardwareInformation.operatingSystemLanguage hardwareInformation.isSupervised
      hardwareInformation.isEncrypted hardwareInformation.batteryHealthPercentage
      hardwareInformation.batteryChargeCycles hardwareInformation.isSharedDevice
      hardwareInformation.tpmSpecificationVersion hardwareInformation.operatingSystemEdition
      hardwareInformation.deviceGuardVirtualizationBasedSecurityHardwareRequirementState
      hardwareInformation.deviceGuardVirtualizationBasedSecurityState
      hardwareInformation.deviceGuardLocalSystemAuthorityCredentialGuardState
      hardwareInformation.osBuildNumber hardwareInformation.operatingSystemProductType
      hardwareInformation.systemManagementBIOSVersion hardwareInformation.tpmManufacturer
      hardwareInformation.tpmVersion hardwareInformation.batteryLevelPercentage
      hardwareInformation.residentUsersCount hardwareInformation.productName
      hardwareInformation.deviceLicensingStatus hardwareInformation.deviceLicensingLastErrorCode
      hardwareInformation.deviceLicensingLastErrorDescription
    `,
  },
  "/devices": {
    device: "id deviceId displayName",
    activity: "approximateLastSignInDateTime",
    configuration: "accountEnabled operatingSystem trustType isManaged",
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
    configuration: "id displayName mail securityEnabled groupTypes[] createdDateTime",
  },
  "/deviceManagement/deviceCompliancePolicies": {
    configuration: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceManagement/deviceConfigurations": {
    credential: `
      preSharedKey customData[].value customKeyValueData[].value customXml eapXml
      omaSettings[].secretReferenceValueId omaSettings[].value payload
    `,
    identity: "outerIdentityPrivacyTemporaryValue",
    configuration: `
      @odata.type id displayName description createdDateTime lastModifiedDateTime ssid networkName
      wifiSecurityType connectAutomatically connectWhenNetworkNameIsHidden proxySetting proxyManualAddress
      proxyManualPort proxyAutomaticConfigurationUrl preSharedKeyIsSet trustedServerCertificateNames[]
      connectionName connectionType servers[].address servers[].description servers[].isDefaultServer
      server.address loginGroupOrDomain realm role identifier customData[].key customKeyValueData[].name
      userDomain dnsSuffixes[] trustedNetworkDomains[] roleScopeTagIds[] supportsScopeTags
      deviceManagementApplicabilityRuleOsEdition deviceManagementApplicabilityRuleOsVersion
      deviceManagementApplicabilityRuleDeviceMode version omaSettings[].@odata.type
      omaSettings[].displayName omaSettings[].description omaSettings[].omaUri omaSettings[].isEncrypted
      omaSettings[].isReadOnly payloadName payloadFileName
    `,
  },
  "/deviceManagement/configurationPolicies": {
    configuration: `
      id name description platforms technologies createdDateTime lastModifiedDateTime settingCount
      isAssigned
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
      deviceDetail.isCompliant deviceDetail.isManaged deviceDetail.trustType
      appliedConditionalAccessPolicies[].sessionControlsNotSatisfied[]
      appliedConditionalAccessPolicies[].result appliedConditionalAccessPolicies[].conditionsSatisfied
      appliedConditionalAccessPolicies[].conditionsNotSatisfied
      appliedConditionalAccessPolicies[].authenticationStrength
      appliedConditionalAccessPolicies[].includeRulesSatisfied[].conditionalAccessCondition
      appliedConditionalAccessPolicies[].includeRulesSatisfied[].ruleSatisfied
      appliedConditionalAccessPolicies[].excludeRulesSatisfied[]
    `,
    security: `
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
      conditions.clientAppTypes[] conditions.locations conditions.times conditions.deviceStates
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
    configuration: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceAppManagement/iosManagedAppProtections": {
    configuration: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
  },
  "/deviceAppManagement/androidManagedAppProtections": {
    configuration: "@odata.type id displayName description createdDateTime lastModifiedDateTime",
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
    configuration: "id displayName description createdDateTime lastModifiedDateTime",
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
      deviceOperatingSystemSummary.chromeOSCount deviceExchangeAccessStateSummary.allowedDeviceCount
      deviceExchangeAccessStateSummary.blockedDeviceCount
      deviceExchangeAccessStateSummary.quarantinedDeviceCount
      deviceExchangeAccessStateSummary.unknownDeviceCount
      deviceExchangeAccessStateSummary.unavailableDeviceCount
    `,
  },
  "/deviceManagement/managedDeviceEncryptionStates": {
    identity: "userPrincipalName",
    device: "id deviceName",
    configuration: "encryptionState policyDetails[] policyDetails[].policyId policyDetails[].policyName fileVaultStates",
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
    configuration: `
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
    credential: "passwordCredentials[].secretText passwordCredentials[].hint keyCredentials[].key",
    configuration: `
      passwordCredentials[] keyCredentials[] id appId displayName createdDateTime publisherDomain signInAudience tags[] description
      identifierUris[] notes serviceManagementReference appRoles[] api.requestedAccessTokenVersion
      api.acceptMappedClaims api.knownClientApplications[] api.oauth2PermissionScopes[]
      api.preAuthorizedApplications[] api.tokenEncryptionSetting.scheme
      api.tokenEncryptionSetting.audience api.tokenEncryptionSetting.automatedTokenVersion.current
      api.tokenEncryptionSetting.automatedTokenVersion.available[] requiredResourceAccess[].resourceAppId
      requiredResourceAccess[].resourceAccess[].id requiredResourceAccess[].resourceAccess[].type
      passwordCredentials[].customKeyIdentifier passwordCredentials[].endDateTime
      passwordCredentials[].keyId passwordCredentials[].startDateTime passwordCredentials[].displayName
      keyCredentials[].customKeyIdentifier keyCredentials[].endDateTime keyCredentials[].keyId
      keyCredentials[].startDateTime keyCredentials[].type keyCredentials[].usage
      keyCredentials[].displayName keyCredentials[].hasExtendedValue web.redirectUris[] web.homePageUrl
      web.logoutUrl web.enabledResponseModes web.customAuthenticationUx web.redirectUriSettings[].uri
      web.redirectUriSettings[].index web.implicitGrantSettings.enableIdTokenIssuance
      web.implicitGrantSettings.enableAccessTokenIssuance spa.redirectUris[] spa.enabledResponseModes
      publicClient.redirectUris[] publicClient.enabledResponseModes appRoles[].id appRoles[].displayName
      appRoles[].description appRoles[].value appRoles[].isEnabled appRoles[].allowedMemberTypes[]
      appRoles[].adminConsentDescription appRoles[].adminConsentDisplayName
      appRoles[].userConsentDescription appRoles[].userConsentDisplayName appRoles[].type
      api.oauth2PermissionScopes[].id api.oauth2PermissionScopes[].displayName
      api.oauth2PermissionScopes[].description api.oauth2PermissionScopes[].value
      api.oauth2PermissionScopes[].isEnabled api.oauth2PermissionScopes[].allowedMemberTypes[]
      api.oauth2PermissionScopes[].adminConsentDescription
      api.oauth2PermissionScopes[].adminConsentDisplayName
      api.oauth2PermissionScopes[].userConsentDescription
      api.oauth2PermissionScopes[].userConsentDisplayName api.oauth2PermissionScopes[].type
    `,
  },
  "/servicePrincipals": {
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
  "/domains": {
    configuration: "id isDefault isInitial isVerified authenticationType",
  },
  "/security/alerts_v2": {
    activity: `
      id title severity status detectionSource serviceSource createdDateTime lastUpdateDateTime
    `,
  },
  "/security/incidents": {
    identity: "assignedTo",
    activity: `
      id displayName severity status classification determination createdDateTime lastUpdateDateTime
    `,
  },
  "/security/secureScores": {
    configuration: `
      id createdDateTime currentScore maxScore activeUserCount licensedUserCount azureTenantId
      enabledServices[] controlScores[].implementationStatus controlScores[].lastSynced controlScores[].on
      controlScores[].score controlScores[].scoreInPercentage controlScores[].count controlScores[].total
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
      controlScores[].controlName controlScores[].description vendorInformation.provider
      vendorInformation.providerVersion vendorInformation.subProvider vendorInformation.vendor
    `,
  },
  "/security/secureScoreControlProfiles": {
    identity: `
      controlStateUpdates[].assignedTo controlStateUpdates[].comment controlStateUpdates[].updatedBy
    `,
    activity: "controlStateUpdates[].updatedDateTime",
    configuration: "azureTenantId controlStateUpdates[].state",
    public: `
      id actionType actionUrl controlCategory title deprecated implementationCost lastModifiedDateTime
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
    device: "id deviceId",
    activity: "createdDateTime",
    configuration: "volumeType",
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
