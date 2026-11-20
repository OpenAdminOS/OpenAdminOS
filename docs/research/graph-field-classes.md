# Graph field classes for the local data policy

Research for the data policy that classifies every Graph field at the moment it returns. The maintainer's lab tenant, Lokka app-only connection, 2026-11-18. All app and agent Graph traffic goes to `https://graph.microsoft.com/beta` (packages/runtime/src/graph-adapter.ts defaults to beta; the cache client pins beta), so every call below used beta unless noted.

No secret values are reproduced. Values are replaced by their type; for credential fields only presence is stated. Person names, IPs and device names seen in the lab are described, not quoted.

The tables below are the historical record from 2026-11-18. For current
classifications and mask roles, including Conditional Access identifiers and
controls, see the [runtime field map](../../packages/runtime/src/graph-field-classes.ts)
and [the specification](../SPEC.md#data-policy-data-classes-and-classification-2026-11-18).

## Method

- Endpoint list: every entry of `GRAPH_CACHE_RESOURCES` (45 resources) in apps/desktop/electron/intune-chat/planner.ts with its `pathForResource` path and `$select`, plus every `graph` step `path`/`select` in agents/*/manifest.yaml, plus the one script agent (agents/intune-device-posture-auditor/agent.mjs, same managedDevices path and fields as its manifest).
- Agents with no Graph read: team-evidence-review, team-script-draft. team-script-draft only emits PowerShell text that calls `v1.0/deviceManagement/managedDevices?$select=id,deviceName,complianceState,lastSyncDateTime`; the app does not execute it. stale-guest-cleanup also has a write step (`PATCH /users/{id}`), out of scope.
- Schemas for unverified endpoints come from the msgraph skill (`api-docs-search --resource`).
- Original research classes: credential, identity, device, activity, configuration, public. The runtime map and SPEC also define Security for policy and posture objects. A `?` after a class marks an ambiguous field explained in the notes. Field paths use dot notation for nested objects and `[]` for arrays.
- Classing rule applied to log records (signIns, audits, alerts): fields that do not identify a person or device are activity, because the record as a whole says who did what when. In configuration objects, non-identifying fields are configuration. Device posture attributes (OS, version, model, compliance) do not identify a device, so they are configuration.

## Historical field map v3

The runtime recorded a mask role for each Security leaf. The default role was
`setting`. Policy and role names, IDs, descriptions, location IP ranges and
permission scope names used `nameOrIdentifier`. User and group IDs inside these
objects stayed Identity and secrets stayed Credential. For example:

| Security resource or property | Name or identifier | Setting |
|---|---|---|
| Conditional Access and named locations | `id`, `displayName`, `ipRanges[].cidrAddress` | `state`, `isTrusted`, `grantControls.operator` |
| Device compliance policies | `id`, `displayName`, `description` | `@odata.type`, `passwordRequired`, `scheduledActionsForRule` fields carrying rules or timing |
| Authorization policy | `id`, `displayName`, `guestUserRoleId`, `permissionGrantPolicyIdsAssignedToDefaultUserRole[]` | `allowInvitesFrom`, `defaultUserRolePermissions.allowedToCreateApps` |
| Application and service principal permissions | `requiredResourceAccess[].resourceAppId`, nested permission IDs, `appRoles[].value`, `oauth2PermissionScopes[].value` | `appRoles[].isEnabled`, `allowedMemberTypes[]`, `requiredResourceAccess[].resourceAccess[].type` |
| App role assignments and OAuth2 permission grants | `id`, `appRoleId`, `clientId`, `resourceId`, `scope` | `principalType`, `consentType` |

The bundled Graph index listed FileVault under managed devices, co-managed
devices, `/me/managedDevices` and `/users/{id}/managedDevices`. Their function
result `value` shared the Credential rule. BitLocker navigation under `/me`,
users, sites and group sites shared the canonical recovery key schema for
collection and item reads. LAPS had one indexed route family at
`/directory/deviceLocalCredentials`. Both collection and keyed forms applied its
`credentials[].passwordBase64` rule. Application `addPassword` returned the
password credential directly. The same schema covered the service principal
action and the agent identity blueprint cast in the bundled documentation index.
`removePassword` had no credential response body. These route checks
used synthetic fixtures and the bundled index.

## Endpoints

### PIM for Groups and expanded policy settings

- PIM for Groups schedules and requests under `/identityGovernance/privilegedAccess/group` use Security for policy values and Identity for `principalId` and `groupId`. The endpoint is documented and has a synthetic fixture with `<principal ID>` and `<group ID>` placeholders. [Microsoft Graph PIM for Groups schema](https://learn.microsoft.com/en-us/graph/api/resources/privilegedaccessgroup?view=graph-rest-1.0)
- Settings Catalog secret setting types and the `encryptedValueToken` state mark `<setting value>` as Credential, including when the metadata is carried in `additionalData`. Expanded Configuration Policies and Group Policy definitions have synthetic coverage. [Microsoft Graph Intune settings schemas](https://learn.microsoft.com/en-us/graph/utcm-intune-resources)

### managedDevices (cache and agents $select)

- Path: `/deviceManagement/managedDevices`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/managedDevices?$top=1&$select=id,deviceName,userPrincipalName,operatingSystem,osVersion,isEncrypted,lastSyncDateTime,enrolledDateTime,complianceState,azureADDeviceId,managementState,managedDeviceOwnerType,deviceEnrollmentType,manufacturer,model`
- Used by: cache `managedDevices`; agents compliance-overview, find-inactive-devices, intune-device-posture-auditor (agent.mjs, $top=999), offboarding-agent, os-update-posture, tenant-health-report (all subsets of this list)

| Property path | Class |
|---|---|
| `id` | device |
| `deviceName` | device (ambiguous) |
| `userPrincipalName` | identity |
| `operatingSystem` | configuration |
| `osVersion` | configuration |
| `isEncrypted` | configuration |
| `lastSyncDateTime` | activity |
| `enrolledDateTime` | activity |
| `complianceState` | configuration |
| `azureADDeviceId` | device |
| `managementState` | configuration |
| `managedDeviceOwnerType` | configuration |
| `deviceEnrollmentType` | configuration |
| `manufacturer` | configuration |
| `model` | configuration |
| `@odata.nextLink` | device (ambiguous) |

Notes:

- `deviceName` is classed device, but users and Apple setup routinely put a person's name in it (for example "<FirstName>'s MacBook"). The Entra record of a lab device in this tenant had the owner's first name in its name. Treat as device with an identity pattern check, or as identity.
- `@odata.nextLink` is not a field, but on this endpoint its `$skiptoken` carries `LastDeviceName='<deviceName>'` in clear text. If paging links are ever logged, cached or shown to a model, they leak the device name.
- Device posture attributes (OS, version, model, compliance) do not identify a device on their own, so they are classed configuration. There is no "device state" class; the policy may want one, or accept configuration.

### managedDevices (full default projection)

- Path: `/deviceManagement/managedDevices`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/managedDevices?$top=1 (no $select)`
- Used by: not used by the cache; reachable by chat tools that issue raw Graph reads without `$select`

| Property path | Class |
|---|---|
| `id` | device |
| `userId` | identity |
| `deviceName` | device (ambiguous) |
| `ownerType` | configuration |
| `managedDeviceOwnerType` | configuration |
| `managementState` | configuration |
| `enrolledDateTime` | activity |
| `lastSyncDateTime` | activity |
| `chassisType` | configuration |
| `operatingSystem` | configuration |
| `deviceType` | configuration |
| `complianceState` | configuration |
| `jailBroken` | configuration |
| `managementAgent` | configuration |
| `osVersion` | configuration |
| `easActivated` | configuration |
| `easDeviceId` | device |
| `easActivationDateTime` | activity |
| `aadRegistered` | configuration |
| `azureADRegistered` | configuration |
| `deviceEnrollmentType` | configuration |
| `lostModeState` | configuration |
| `activationLockBypassCode` | credential |
| `emailAddress` | identity |
| `azureActiveDirectoryDeviceId` | device |
| `azureADDeviceId` | device |
| `deviceRegistrationState` | configuration |
| `deviceCategoryDisplayName` | configuration |
| `isSupervised` | configuration |
| `exchangeLastSuccessfulSyncDateTime` | activity |
| `exchangeAccessState` | configuration |
| `exchangeAccessStateReason` | configuration |
| `remoteAssistanceSessionUrl` | credential (ambiguous) |
| `remoteAssistanceSessionErrorDetails` | activity |
| `isEncrypted` | configuration |
| `userPrincipalName` | identity |
| `enrolledByUserPrincipalName` | identity |
| `model` | configuration |
| `manufacturer` | configuration |
| `imei` | device |
| `complianceGracePeriodExpirationDateTime` | configuration |
| `serialNumber` | device |
| `phoneNumber` | identity |
| `androidSecurityPatchLevel` | configuration |
| `userDisplayName` | identity |
| `configurationManagerClientEnabledFeatures` | configuration |
| `wiFiMacAddress` | device |
| `deviceHealthAttestationState` | configuration |
| `subscriberCarrier` | configuration |
| `meid` | device |
| `totalStorageSpaceInBytes` | configuration |
| `freeStorageSpaceInBytes` | configuration |
| `managedDeviceName` | device |
| `partnerReportedThreatState` | configuration |
| `retireAfterDateTime` | configuration |
| `preferMdmOverGroupPolicyAppliedDateTime` | activity |
| `autopilotEnrolled` | configuration |
| `requireUserEnrollmentApproval` | configuration |
| `managementCertificateExpirationDate` | configuration |
| `iccid` | device |
| `udid` | device |
| `roleScopeTagIds[]` | configuration |
| `windowsActiveMalwareCount` | configuration |
| `windowsRemediatedMalwareCount` | configuration |
| `notes` | identity (ambiguous) |
| `configurationManagerClientHealthState` | configuration |
| `configurationManagerClientInformation` | device (ambiguous) |
| `ethernetMacAddress` | device |
| `physicalMemoryInBytes` | configuration |
| `processorArchitecture` | configuration |
| `specificationVersion` | configuration |
| `joinType` | configuration |
| `skuFamily` | configuration |
| `securityPatchLevel` | configuration |
| `skuNumber` | configuration |
| `managementFeatures` | configuration |
| `enrollmentProfileName` | configuration |
| `bootstrapTokenEscrowed` | configuration |
| `deviceFirmwareConfigurationInterfaceManaged` | configuration |
| `deviceIdentityAttestationDetail` | configuration |
| `hardwareInformation.serialNumber` | device |
| `hardwareInformation.totalStorageSpace` | configuration |
| `hardwareInformation.freeStorageSpace` | configuration |
| `hardwareInformation.imei` | device |
| `hardwareInformation.meid` | device |
| `hardwareInformation.manufacturer` | configuration |
| `hardwareInformation.model` | configuration |
| `hardwareInformation.phoneNumber` | identity |
| `hardwareInformation.subscriberCarrier` | configuration |
| `hardwareInformation.cellularTechnology` | configuration |
| `hardwareInformation.wifiMac` | device |
| `hardwareInformation.operatingSystemLanguage` | configuration |
| `hardwareInformation.isSupervised` | configuration |
| `hardwareInformation.isEncrypted` | configuration |
| `hardwareInformation.batterySerialNumber` | device |
| `hardwareInformation.batteryHealthPercentage` | configuration |
| `hardwareInformation.batteryChargeCycles` | configuration |
| `hardwareInformation.isSharedDevice` | configuration |
| `hardwareInformation.tpmSpecificationVersion` | configuration |
| `hardwareInformation.operatingSystemEdition` | configuration |
| `hardwareInformation.deviceFullQualifiedDomainName` | device |
| `hardwareInformation.deviceGuardVirtualizationBasedSecurityHardwareRequirementState` | configuration |
| `hardwareInformation.deviceGuardVirtualizationBasedSecurityState` | configuration |
| `hardwareInformation.deviceGuardLocalSystemAuthorityCredentialGuardState` | configuration |
| `hardwareInformation.osBuildNumber` | configuration |
| `hardwareInformation.operatingSystemProductType` | configuration |
| `hardwareInformation.ipAddressV4` | device |
| `hardwareInformation.subnetAddress` | device |
| `hardwareInformation.esimIdentifier` | device |
| `hardwareInformation.systemManagementBIOSVersion` | configuration |
| `hardwareInformation.tpmManufacturer` | configuration |
| `hardwareInformation.tpmVersion` | configuration |
| `hardwareInformation.wiredIPv4Addresses[]` | device |
| `hardwareInformation.batteryLevelPercentage` | configuration |
| `hardwareInformation.residentUsersCount` | configuration |
| `hardwareInformation.productName` | configuration |
| `hardwareInformation.deviceLicensingStatus` | configuration |
| `hardwareInformation.deviceLicensingLastErrorCode` | configuration |
| `hardwareInformation.deviceLicensingLastErrorDescription` | configuration |
| `hardwareInformation.sharedDeviceCachedUsers[]` | identity |
| `deviceActionResults[]` | activity |
| `usersLoggedOn[].userId` | identity |
| `usersLoggedOn[].lastLogOnDateTime` | activity |
| `chromeOSDeviceInfo[]` | device (ambiguous) |
| `supplementalDeviceDetails[]` | device (ambiguous) |

Notes:

- `activationLockBypassCode` was present (null in the lab). Microsoft documents that the real value is only returned when it is named in `$select` on a single device, so a list response looking clean does not mean the field is safe.
- `remoteAssistanceSessionUrl` is a live remote session link. Classed credential (ambiguous) because whoever has it can join the session.
- `managedDeviceName` embeds the enrolling user's object id, OS and enrollment timestamp (`<userObjectId>_MacOS_<date>`). Device class, but it also leaks a user id.
- `easDeviceId` embeds the serial number on Apple devices (`Appl<serial>`).
- `notes` is free text typed by admins. Default identity.
- `chromeOSDeviceInfo[]`, `supplementalDeviceDetails[]` and `configurationManagerClientInformation` were empty or null; documented contents include device identifiers.

### entraDevices

- Path: `/devices`
- API version: beta
- Status: verified
- Lokka call: `GET /devices?$top=1&$select=id,deviceId,displayName,accountEnabled,approximateLastSignInDateTime,operatingSystem,trustType,isManaged`
- Used by: cache `entraDevices`; agent offboarding-agent

| Property path | Class |
|---|---|
| `id` | device |
| `deviceId` | device |
| `displayName` | device (ambiguous) |
| `accountEnabled` | configuration |
| `approximateLastSignInDateTime` | activity |
| `operatingSystem` | configuration |
| `trustType` | configuration |
| `isManaged` | configuration |

Notes:

- `displayName` in the lab record contained the owner's first name in a German phrase ("virtual machine of <FirstName>"). Same identity leak as `deviceName`.

### users

- Path: `/users`
- API version: beta
- Status: verified
- Lokka call: `GET /users?$top=1&$select=id,displayName,userPrincipalName,mail,accountEnabled,userType,createdDateTime,usageLocation,assignedLicenses,signInActivity,externalUserState,externalUserStateChangeDateTime`
- Used by: cache `users` (first 7 fields); agents stale-guest-cleanup (adds signInActivity, externalUserState, externalUserStateChangeDateTime), user-license-overview (adds usageLocation, assignedLicenses)

| Property path | Class |
|---|---|
| `id` | identity |
| `displayName` | identity |
| `userPrincipalName` | identity |
| `mail` | identity |
| `accountEnabled` | configuration |
| `userType` | configuration |
| `createdDateTime` | activity |
| `usageLocation` | identity (ambiguous) |
| `assignedLicenses[].skuId` | configuration |
| `assignedLicenses[].disabledPlans[]` | configuration |
| `signInActivity.lastSignInDateTime` | activity |
| `signInActivity.lastSignInRequestId` | activity |
| `signInActivity.lastNonInteractiveSignInDateTime` | activity |
| `signInActivity.lastNonInteractiveSignInRequestId` | activity |
| `signInActivity.lastSuccessfulSignInDateTime` | activity |
| `signInActivity.lastSuccessfulSignInRequestId` | activity |
| `externalUserState` | configuration |
| `externalUserStateChangeDateTime` | activity |
| `@odata.nextLink` | identity (ambiguous) |

Notes:

- `usageLocation` is a country code per person. Low precision, but personal data; classed identity (ambiguous, could be configuration).
- `@odata.nextLink` `$skiptoken` is base64 that decodes to the last user's UPN.
- `accountEnabled` and `userType` describe a person record but do not identify anyone alone, so configuration.

### groups

- Path: `/groups`
- API version: beta
- Status: verified
- Lokka call: `GET /groups?$top=1&$select=id,displayName,mail,securityEnabled,groupTypes,createdDateTime`
- Used by: cache `groups`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration (ambiguous) |
| `mail` | identity |
| `mailNickname` | identity |
| `proxyAddresses[]` | identity |
| `securityEnabled` | configuration |
| `groupTypes[]` | configuration |
| `createdDateTime` | configuration |

Notes:

- Group names often carry person names ("Team <Manager>", "<User> test devices"). Configuration with a name pattern check.
- Field map v6 classifies group addresses and aliases as Identity, including aliases that do not look like email addresses.

### deviceCompliancePolicies

- Path: `/deviceManagement/deviceCompliancePolicies`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/deviceCompliancePolicies?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `deviceCompliancePolicies`

| Property path | Class |
|---|---|
| `@odata.type` | security |
| `id` | security |
| `displayName` | security |
| `description` | security (ambiguous) |
| `createdDateTime` | security |
| `lastModifiedDateTime` | security |

Notes:

- `description` is free text. Lab values were baseline ids; in other tenants it can hold names or ticket text.

### deviceConfigurations (cache $select)

- Path: `/deviceManagement/deviceConfigurations`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/deviceConfigurations?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `deviceConfigurations`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `@odata.nextLink` | configuration |

Notes:

- The cache only takes metadata. The full objects are where pre-shared keys and secrets live; see the credential section below.

### configurationPolicies

- Path: `/deviceManagement/configurationPolicies`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/configurationPolicies?$top=1&$select=id,name,description,platforms,technologies,createdDateTime,lastModifiedDateTime,settingCount,isAssigned`
- Used by: cache `configurationPolicies`

| Property path | Class |
|---|---|
| `id` | configuration |
| `name` | configuration |
| `description` | configuration (ambiguous) |
| `platforms` | configuration |
| `technologies` | configuration |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `settingCount` | configuration |
| `isAssigned` | configuration |

Notes:

- Settings catalog `settings` (not selected) can hold secret values (for example simpleSettingValue strings marked secret). Not fetched by the cache.

### signIns

- Path: `/auditLogs/signIns`
- API version: beta
- Status: verified
- Lokka call: `GET /auditLogs/signIns?$top=1&$select=<the 18 fields in pathForResource>`
- Used by: cache `signIns`; agent sign-in-failure-explainer (subset, with $filter status/errorCode ne 0, $orderby, ConsistencyLevel: eventual)

| Property path | Class |
|---|---|
| `id` | activity |
| `createdDateTime` | activity |
| `userDisplayName` | identity |
| `userPrincipalName` | identity |
| `appDisplayName` | activity |
| `ipAddress` | device |
| `clientAppUsed` | activity |
| `conditionalAccessStatus` | activity |
| `isInteractive` | activity |
| `riskDetail` | activity |
| `riskLevelAggregated` | activity |
| `riskLevelDuringSignIn` | activity |
| `riskState` | activity |
| `resourceDisplayName` | activity |
| `status.errorCode` | activity |
| `status.failureReason` | activity |
| `status.additionalDetails` | activity (ambiguous) |
| `deviceDetail.deviceId` | device |
| `deviceDetail.displayName` | device (ambiguous) |
| `deviceDetail.operatingSystem` | activity |
| `deviceDetail.browser` | activity |
| `deviceDetail.isCompliant` | activity |
| `deviceDetail.isManaged` | activity |
| `deviceDetail.trustType` | activity |
| `location.city` | activity |
| `location.state` | activity |
| `location.countryOrRegion` | activity |
| `location.geoCoordinates.altitude` | activity |
| `location.geoCoordinates.latitude` | activity (ambiguous) |
| `location.geoCoordinates.longitude` | activity (ambiguous) |
| `appliedConditionalAccessPolicies[].id` | configuration |
| `appliedConditionalAccessPolicies[].displayName` | configuration |
| `appliedConditionalAccessPolicies[].enforcedGrantControls[]` | configuration |
| `appliedConditionalAccessPolicies[].enforcedSessionControls[]` | configuration |
| `appliedConditionalAccessPolicies[].sessionControlsNotSatisfied[]` | activity |
| `appliedConditionalAccessPolicies[].result` | activity |
| `appliedConditionalAccessPolicies[].conditionsSatisfied` | activity |
| `appliedConditionalAccessPolicies[].conditionsNotSatisfied` | activity |
| `appliedConditionalAccessPolicies[].authenticationStrength` | activity |
| `appliedConditionalAccessPolicies[].includeRulesSatisfied[].conditionalAccessCondition` | activity |
| `appliedConditionalAccessPolicies[].includeRulesSatisfied[].ruleSatisfied` | activity |
| `appliedConditionalAccessPolicies[].excludeRulesSatisfied[]` | activity |

Notes:

- `ipAddress` is classed device per the brief, but here it is the user's public IP at sign-in, which is closer to identity plus location. Consider identity for sign-in IPs.
- `location.geoCoordinates.latitude/longitude` are city-level coordinates (4 decimal places). Activity per the brief; ambiguous because combined with the UPN they place a person.
- `status.additionalDetails` is free text from Microsoft; it can name the user or device.
- In the lab row, `status.failureReason` read "Other." with errorCode 0, so failure text is not a reliable signal on success rows.

### directoryAudits

- Path: `/auditLogs/directoryAudits`
- API version: beta
- Status: verified
- Lokka call: `GET /auditLogs/directoryAudits?$top=2&$select=<the 11 fields in pathForResource>`
- Used by: cache `directoryAudits`; agent tenant-change-audit (id, activityDateTime, activityDisplayName, category, result, initiatedBy, targetResources)

| Property path | Class |
|---|---|
| `id` | activity |
| `category` | activity |
| `activityDisplayName` | activity |
| `activityDateTime` | activity |
| `result` | activity |
| `resultReason` | activity |
| `operationType` | activity |
| `loggedByService` | activity |
| `initiatedBy.user.id` | identity |
| `initiatedBy.user.displayName` | identity |
| `initiatedBy.user.userPrincipalName` | identity |
| `initiatedBy.user.ipAddress` | device |
| `initiatedBy.linkableIdentifiers` | identity (ambiguous) |
| `initiatedBy.app.appId` | configuration |
| `initiatedBy.app.displayName` | configuration |
| `initiatedBy.app.servicePrincipalId` | configuration |
| `initiatedBy.app.servicePrincipalName` | configuration |
| `targetResources[].id` | identity (ambiguous) |
| `targetResources[].displayName` | identity (ambiguous) |
| `targetResources[].type` | activity |
| `targetResources[].userPrincipalName` | identity |
| `targetResources[].groupType` | configuration |
| `targetResources[].modifiedProperties[].displayName` | activity |
| `targetResources[].modifiedProperties[].oldValue` | identity (ambiguous) |
| `targetResources[].modifiedProperties[].newValue` | identity (ambiguous) |
| `additionalDetails[].key` | activity |
| `additionalDetails[].value` | identity (ambiguous) |

Notes:

- `initiatedBy.user` was null in both lab rows (app-initiated); its shape is from the documented `userIdentity` type, so those 4 paths are unverified.
- `targetResources[].id` and `.displayName` are a user, group, app, device or policy depending on `.type`. Default identity; downgrade by `type`.
- `modifiedProperties[].oldValue/newValue` are JSON strings with arbitrary content. The lab rows carried service principal credential metadata (`CredentialType`, `KeyStoreId`, `KeyGroupId`, no secret). For user updates they carry phone numbers, mail and names. Default identity; scan for credential patterns.
- `additionalDetails[].value` is free text (lab: app ids, user agents in other rows are common).

### intuneAuditEvents

- Path: `/deviceManagement/auditEvents`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/auditEvents?$top=1&$select=<the 11 fields in pathForResource>`
- Used by: cache `intuneAuditEvents`

| Property path | Class |
|---|---|
| `id` | activity |
| `displayName` | activity |
| `componentName` | activity |
| `activityDateTime` | activity |
| `activityType` | activity |
| `activityOperationType` | activity |
| `activityResult` | activity |
| `category` | activity |
| `correlationId` | activity |
| `actor.type` | activity |
| `actor.auditActorType` | activity |
| `actor.userPermissions[]` | configuration |
| `actor.applicationId` | configuration |
| `actor.applicationDisplayName` | configuration |
| `actor.userPrincipalName` | identity |
| `actor.servicePrincipalName` | configuration |
| `actor.ipAddress` | device |
| `actor.userId` | identity |
| `actor.remoteTenantId` | configuration |
| `actor.remoteUserId` | identity |
| `actor.userRoleScopeTags[]` | configuration |
| `resources[].displayName` | activity (ambiguous) |
| `resources[].type` | activity |
| `resources[].auditResourceType` | activity |
| `resources[].resourceId` | device (ambiguous) |
| `resources[].modifiedProperties[].displayName` | activity |
| `resources[].modifiedProperties[].oldValue` | identity (ambiguous) |
| `resources[].modifiedProperties[].newValue` | identity (ambiguous) |

Notes:

- `resources[].resourceId` is a managed device id when `type` is ManagedDevice (lab row), a policy id otherwise. Class by `type`.
- `modifiedProperties` values are free text. For profile edits Intune writes the changed property values; for Wi-Fi or VPN profile edits this could include a pre-shared key unless Intune masks it. Not verifiable in this lab (no such profiles). Scan for credentials.
- `actor.userPrincipalName` in the lab row was from a different domain than the tenant's default, so UPN-domain heuristics are not enough.

### conditionalAccessPolicies

- Path: `/identity/conditionalAccess/policies`
- API version: beta
- Status: verified
- Lokka call: `GET /identity/conditionalAccess/policies?$top=1 (no $select, matching the cache)`
- Used by: cache `conditionalAccessPolicies`; agent conditional-access-explainer ($select id, displayName, createdDateTime, modifiedDateTime, state, conditions, grantControls, sessionControls)

| Property path | Class |
|---|---|
| `id` | configuration |
| `templateId` | configuration |
| `displayName` | configuration |
| `createdDateTime` | configuration |
| `modifiedDateTime` | configuration |
| `state` | configuration |
| `deletedDateTime` | configuration |
| `partialEnablementStrategy` | configuration |
| `sessionControls` | configuration |
| `conditions.userRiskLevels[]` | configuration |
| `conditions.signInRiskLevels[]` | configuration |
| `conditions.clientAppTypes[]` | configuration |
| `conditions.locations` | configuration |
| `conditions.times` | configuration |
| `conditions.deviceStates` | configuration |
| `conditions.devices` | configuration (ambiguous) |
| `conditions.clientApplications` | configuration |
| `conditions.agents` | configuration |
| `conditions.actionsAndDestinations` | configuration |
| `conditions.applications.includeApplications[]` | configuration |
| `conditions.applications.excludeApplications[]` | configuration |
| `conditions.applications.includeUserActions[]` | configuration |
| `conditions.applications.includeAgentActions[]` | configuration |
| `conditions.applications.includeAuthenticationContextClassReferences[]` | configuration |
| `conditions.applications.applicationFilter` | configuration |
| `conditions.users.includeUsers[]` | identity |
| `conditions.users.excludeUsers[]` | identity |
| `conditions.users.includeGroups[]` | configuration |
| `conditions.users.excludeGroups[]` | configuration |
| `conditions.users.includeRoles[]` | configuration |
| `conditions.users.excludeRoles[]` | configuration |
| `conditions.users.includeGuestsOrExternalUsers` | configuration |
| `conditions.users.excludeGuestsOrExternalUsers` | configuration |
| `conditions.platforms.includePlatforms[]` | configuration |
| `conditions.platforms.excludePlatforms[]` | configuration |
| `grantControls.operator` | configuration |
| `grantControls.builtInControls[]` | configuration |
| `grantControls.customAuthenticationFactors[]` | configuration |
| `grantControls.termsOfUse[]` | configuration |
| `grantControls.authenticationStrength` | configuration |

Notes:

- `conditions.users.includeUsers[]/excludeUsers[]` hold user object ids (or the keywords All, None, GuestsOrExternalUsers). Identity inside configuration. Break-glass account ids land here in almost every tenant.
- `conditions.devices.deviceFilter.rule` (null in lab) is a filter expression that often names devices or users. Ambiguous.
- `sessionControls`, `locations`, `times`, `deviceStates`, `clientApplications`, `agents`, `actionsAndDestinations` were null in the lab row; their documented subfields are configuration.

### mobileApps

- Path: `/deviceAppManagement/mobileApps`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceAppManagement/mobileApps?$top=1&$select=id,displayName,description,publisher,createdDateTime,lastModifiedDateTime,isAssigned,publishingState`
- Used by: cache `mobileApps`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `publisher` | configuration (ambiguous) |
| `isAssigned` | configuration |
| `publishingState` | configuration |
| `@odata.nextLink` | configuration |

Notes:

- `publisher` is free text for LOB and Win32 apps and is sometimes the packaging admin's name.
- nextLink skiptoken carries the last app name.

### detectedApps

- Path: `/deviceManagement/detectedApps`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/detectedApps?$top=1&$select=id,displayName,version,sizeInByte,deviceCount,publisher,platform`
- Used by: cache `detectedApps`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration (ambiguous) |
| `version` | configuration |
| `sizeInByte` | configuration |
| `deviceCount` | configuration |
| `publisher` | configuration (ambiguous) |
| `platform` | configuration |

Notes:

- Tenant-wide aggregate, no per-device link in this projection. Per-user installs occasionally carry a user name in `displayName` (for example per-user Python or a profile path). Configuration with a pattern check.

### managedAppPolicies

- Path: `/deviceAppManagement/managedAppPolicies`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceAppManagement/managedAppPolicies?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `managedAppPolicies`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

### iosManagedAppProtections

- Path: `/deviceAppManagement/iosManagedAppProtections`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceAppManagement/iosManagedAppProtections?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `iosManagedAppProtections`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

### androidManagedAppProtections

- Path: `/deviceAppManagement/androidManagedAppProtections`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceAppManagement/androidManagedAppProtections?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `androidManagedAppProtections`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

### mobileAppConfigurations

- Path: `/deviceAppManagement/mobileAppConfigurations`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceAppManagement/mobileAppConfigurations?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime,targetedMobileApps`
- Used by: cache `mobileAppConfigurations`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `targetedMobileApps[]` | configuration |

Notes:

- Not selected: `settings[].appConfigKeyValue` and `encodedSettingXml`. These often carry API keys, enrollment tokens or server passwords for third-party apps. If ever fetched, treat values as credential candidates.

### deviceHealthScripts

- Path: `/deviceManagement/deviceHealthScripts`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/deviceHealthScripts?$top=1&$select=id,displayName,description,publisher,createdDateTime,lastModifiedDateTime,runAsAccount,runAs32Bit,enforceSignatureCheck`
- Used by: cache `deviceHealthScripts`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `publisher` | identity (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `runAsAccount` | configuration |
| `runAs32Bit` | configuration |
| `enforceSignatureCheck` | configuration |

Notes:

- `publisher` held the creating admin's full name in the lab. The Intune portal pre-fills it with the signed-in admin's name, so this is identity in most tenants.
- Not selected: `detectionScriptContent`, `remediationScriptContent` (base64). Admins embed passwords, SAS tokens and API keys in these. Treat as credential candidates if fetched.

### deviceManagementScripts

- Path: `/deviceManagement/deviceManagementScripts`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/deviceManagementScripts?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime,runAsAccount,runAs32Bit,enforceSignatureCheck`
- Used by: cache `deviceManagementScripts`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `runAsAccount` | configuration |
| `runAs32Bit` | configuration |
| `enforceSignatureCheck` | configuration |

Notes:

- Not selected: `scriptContent` (base64). Same credential risk as remediation scripts.

### windowsAutopilotDevices

- Path: `/deviceManagement/windowsAutopilotDeviceIdentities`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/windowsAutopilotDeviceIdentities?$top=1 (no $select; the cache sends none because $select returns HTTP 500)`
- Used by: cache `windowsAutopilotDevices`

| Property path | Class |
|---|---|
| `id` | device |
| `deploymentProfileAssignmentStatus` | configuration |
| `deploymentProfileAssignmentDetailedStatus` | configuration |
| `deploymentProfileAssignedDateTime` | activity |
| `groupTag` | configuration (ambiguous) |
| `purchaseOrderIdentifier` | configuration |
| `serialNumber` | device |
| `productKey` | credential |
| `manufacturer` | configuration |
| `model` | configuration |
| `enrollmentState` | configuration |
| `lastContactedDateTime` | activity |
| `addressableUserName` | identity |
| `userPrincipalName` | identity |
| `resourceName` | identity (ambiguous) |
| `skuNumber` | configuration |
| `systemFamily` | configuration |
| `azureActiveDirectoryDeviceId` | device |
| `azureAdDeviceId` | device |
| `managedDeviceId` | device |
| `displayName` | device (ambiguous) |
| `deviceAccountUpn` | identity |
| `deviceAccountPassword` | credential |
| `deviceFriendlyName` | device (ambiguous) |
| `remediationState` | configuration |
| `remediationStateLastModifiedDateTime` | activity |
| `userlessEnrollmentStatus` | configuration |
| `@odata.nextLink` | device |

Notes:

- Because the cache cannot use `$select`, it receives every default field, including `productKey` and `deviceAccountPassword` (Surface Hub / Teams Rooms device account password). Both were present as keys; `deviceAccountPassword` was null and `productKey` held a value shaped like the serial (lab VM). On OEM hardware `productKey` is a Windows license key.
- `groupTag` is free text and often encodes a user, site or department.
- `@odata.nextLink` skiptoken carries `LastSerialNumber='<serial>'` in clear text.

### autopilotEvents

- Path: `/deviceManagement/autopilotEvents`
- API version: beta
- Status: unverified (call succeeded, empty collection)
- Lokka call: `GET /deviceManagement/autopilotEvents?$top=1&$select=<the 20 fields in pathForResource> returned value: []`
- Used by: cache `autopilotEvents`

| Property path | Class |
|---|---|
| `id` | activity |
| `deviceId` | device |
| `userId` | identity |
| `eventDateTime` | activity |
| `deviceRegisteredDateTime` | activity |
| `enrollmentStartDateTime` | activity |
| `enrollmentType` | configuration |
| `deviceSerialNumber` | device |
| `managedDeviceName` | device |
| `userPrincipalName` | identity |
| `windowsAutopilotDeploymentProfileDisplayName` | configuration |
| `enrollmentState` | activity |
| `windows10EnrollmentCompletionPageConfigurationDisplayName` | configuration |
| `deploymentState` | activity |
| `deviceSetupStatus` | activity |
| `accountSetupStatus` | activity |
| `osVersion` | configuration |
| `deploymentStartDateTime` | activity |
| `deploymentEndDateTime` | activity |
| `enrollmentFailureDetails` | activity (ambiguous) |

Notes:

- Schema from msgraph `deviceManagementAutopilotEvent`. `enrollmentFailureDetails` is free text that can include the device or user name.

### windowsAutopilotProfiles

- Path: `/deviceManagement/windowsAutopilotDeploymentProfiles`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/windowsAutopilotDeploymentProfiles?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime,deviceNameTemplate,deviceType`
- Used by: cache `windowsAutopilotProfiles`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `deviceNameTemplate` | configuration |
| `deviceType` | configuration |

Notes:

- `deviceNameTemplate` is a pattern (lab: %SERIAL%), not a device name.

### deviceEnrollmentConfigurations

- Path: `/deviceManagement/deviceEnrollmentConfigurations`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/deviceEnrollmentConfigurations?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime,priority`
- Used by: cache `deviceEnrollmentConfigurations`

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `priority` | configuration |

### windowsQualityUpdateProfiles

- Path: `/deviceManagement/windowsQualityUpdateProfiles`
- API version: beta
- Status: unverified (call succeeded, empty collection)
- Lokka call: `GET /deviceManagement/windowsQualityUpdateProfiles?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime returned value: []`
- Used by: cache `windowsQualityUpdateProfiles`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

### windowsFeatureUpdateProfiles

- Path: `/deviceManagement/windowsFeatureUpdateProfiles`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/windowsFeatureUpdateProfiles?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime,featureUpdateVersion`
- Used by: cache `windowsFeatureUpdateProfiles`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |
| `featureUpdateVersion` | configuration |

### endpointSecurityIntents

- Path: `/deviceManagement/intents`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/intents?$top=1&$select=id,displayName,description,templateId,lastModifiedDateTime,isAssigned`
- Used by: cache `endpointSecurityIntents`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `templateId` | configuration |
| `lastModifiedDateTime` | configuration |
| `isAssigned` | configuration |

### groupPolicyConfigurations

- Path: `/deviceManagement/groupPolicyConfigurations`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/groupPolicyConfigurations?$top=1&$select=id,displayName,description,createdDateTime,lastModifiedDateTime`
- Used by: cache `groupPolicyConfigurations`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

### assignmentFilters

- Path: `/deviceManagement/assignmentFilters`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/assignmentFilters?$top=1&$select=id,displayName,description,platform,rule,assignmentFilterManagementType,createdDateTime,lastModifiedDateTime`
- Used by: cache `assignmentFilters`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |
| `platform` | configuration |
| `rule` | device (ambiguous) |
| `assignmentFilterManagementType` | configuration |
| `createdDateTime` | configuration |
| `lastModifiedDateTime` | configuration |

Notes:

- `rule` in the lab was `(device.deviceName -eq "<a device name>")`. Filter rules routinely name devices, serials or enrollment profile names. Device data inside configuration.

### roleScopeTags

- Path: `/deviceManagement/roleScopeTags`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/roleScopeTags?$top=1&$select=id,displayName,description`
- Used by: cache `roleScopeTags`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration (ambiguous) |

### managedDeviceOverview

- Path: `/deviceManagement/managedDeviceOverview`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/managedDeviceOverview (singleton, no query)`
- Used by: cache `managedDeviceOverview`

| Property path | Class |
|---|---|
| `id` | configuration |
| `enrolledDeviceCount` | configuration |
| `mdmEnrolledCount` | configuration |
| `dualEnrolledDeviceCount` | configuration |
| `managedDeviceModelsAndManufacturers` | configuration |
| `lastModifiedDateTime` | configuration |
| `deviceOperatingSystemSummary.androidCount` | configuration |
| `deviceOperatingSystemSummary.iosCount` | configuration |
| `deviceOperatingSystemSummary.macOSCount` | configuration |
| `deviceOperatingSystemSummary.windowsMobileCount` | configuration |
| `deviceOperatingSystemSummary.windowsCount` | configuration |
| `deviceOperatingSystemSummary.unknownCount` | configuration |
| `deviceOperatingSystemSummary.androidDedicatedCount` | configuration |
| `deviceOperatingSystemSummary.androidDeviceAdminCount` | configuration |
| `deviceOperatingSystemSummary.androidFullyManagedCount` | configuration |
| `deviceOperatingSystemSummary.androidWorkProfileCount` | configuration |
| `deviceOperatingSystemSummary.androidCorporateWorkProfileCount` | configuration |
| `deviceOperatingSystemSummary.configMgrDeviceCount` | configuration |
| `deviceOperatingSystemSummary.aospUserlessCount` | configuration |
| `deviceOperatingSystemSummary.aospUserAssociatedCount` | configuration |
| `deviceOperatingSystemSummary.linuxCount` | configuration |
| `deviceOperatingSystemSummary.chromeOSCount` | configuration |
| `deviceExchangeAccessStateSummary.allowedDeviceCount` | configuration |
| `deviceExchangeAccessStateSummary.blockedDeviceCount` | configuration |
| `deviceExchangeAccessStateSummary.quarantinedDeviceCount` | configuration |
| `deviceExchangeAccessStateSummary.unknownDeviceCount` | configuration |
| `deviceExchangeAccessStateSummary.unavailableDeviceCount` | configuration |

Notes:

- Counts only. No personal or device-identifying data.

### managedDeviceEncryptionStates

- Path: `/deviceManagement/managedDeviceEncryptionStates`
- API version: beta
- Status: verified
- Lokka call: `GET /deviceManagement/managedDeviceEncryptionStates?$top=1&$select=id,deviceName,userPrincipalName,encryptionState,policyDetails,fileVaultStates`
- Used by: cache `managedDeviceEncryptionStates`

| Property path | Class |
|---|---|
| `id` | device |
| `deviceName` | device (ambiguous) |
| `userPrincipalName` | identity |
| `encryptionState` | configuration |
| `policyDetails[].policyId` | configuration |
| `policyDetails[].policyName` | configuration |
| `fileVaultStates` | configuration |
| `@odata.nextLink` | device |

Notes:

- `fileVaultStates` is a flags enum (null in lab), not key material. No recovery key is returned by this endpoint.
- `policyDetails[]` was empty; subfields from msgraph `encryptionReportPolicyDetails`.
- nextLink skiptoken carries `<deviceId>/<deviceName>`.

### troubleshootingEvents

- Path: `/deviceManagement/troubleshootingEvents`
- API version: beta
- Status: unverified (call succeeded, empty collection)
- Lokka call: `GET /deviceManagement/troubleshootingEvents?$top=1&$select=id,eventDateTime,correlationId,troubleshootingErrorDetails returned value: []`
- Used by: cache `troubleshootingEvents`

| Property path | Class |
|---|---|
| `id` | activity |
| `eventDateTime` | activity |
| `correlationId` | activity |
| `troubleshootingErrorDetails.context` | activity (ambiguous) |
| `troubleshootingErrorDetails.failure` | activity (ambiguous) |
| `troubleshootingErrorDetails.failureDetails` | activity (ambiguous) |
| `troubleshootingErrorDetails.remediation` | public |
| `troubleshootingErrorDetails.resources[].text` | public |
| `troubleshootingErrorDetails.resources[].link` | public |

Notes:

- Subtypes (`enrollmentTroubleshootingEvent`) add `deviceId`, `managedDeviceIdentifier`, `userId` when not restricted by `$select`. The `failureDetails` and `context` strings can mention device or user names.

### namedLocations

- Path: `/identity/conditionalAccess/namedLocations`
- API version: beta
- Status: unverified (call succeeded, empty collection)
- Lokka call: `GET /identity/conditionalAccess/namedLocations?$top=1&$select=id,displayName,createdDateTime,modifiedDateTime returned value: []`
- Used by: cache `namedLocations`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `createdDateTime` | configuration |
| `modifiedDateTime` | configuration |

Notes:

- Not selected: `ipRanges[].cidrAddress` (ipNamedLocation) and `countriesAndRegions[]`. Corporate egress ranges are configuration, but a named location for one person's home IP is identity. The cache does not fetch them.

### authenticationMethodsPolicy

- Path: `/policies/authenticationMethodsPolicy`
- API version: beta
- Status: verified
- Lokka call: `GET /policies/authenticationMethodsPolicy (singleton, no query)`
- Used by: cache `authenticationMethodsPolicy`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration |
| `description` | configuration |
| `lastModifiedDateTime` | configuration |
| `policyVersion` | configuration |
| `policyMigrationState` | configuration |
| `optOutSettings` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.snoozeDurationInDays` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.enforceRegistrationAfterAllowedSnoozes` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.state` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.excludeTargets[].id` | identity (ambiguous) |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.excludeTargets[].targetType` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].id` | identity (ambiguous) |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].targetType` | configuration |
| `registrationEnforcement.authenticationMethodsRegistrationCampaign.includeTargets[].targetedAuthenticationMethod` | configuration |
| `systemCredentialPreferences.state` | configuration |
| `systemCredentialPreferences.excludeTargets[]` | identity (ambiguous) |
| `systemCredentialPreferences.includeTargets[].id` | identity (ambiguous) |
| `systemCredentialPreferences.includeTargets[].targetType` | configuration |
| `reportSuspiciousActivitySettings.state` | configuration |
| `reportSuspiciousActivitySettings.voiceReportingCode` | configuration |
| `reportSuspiciousActivitySettings.includeTarget.id` | identity (ambiguous) |
| `reportSuspiciousActivitySettings.includeTarget.targetType` | configuration |
| `authenticationMethodConfigurations[].@odata.type` | configuration |
| `authenticationMethodConfigurations[].id` | configuration |
| `authenticationMethodConfigurations[].state` | configuration |
| `authenticationMethodConfigurations[].excludeTargets[]` | identity (ambiguous) |
| `authenticationMethodConfigurations[].includeTargets[].id` | identity (ambiguous) |
| `authenticationMethodConfigurations[].includeTargets[].targetType` | configuration |
| `authenticationMethodConfigurations[].includeTargets[].isRegistrationRequired` | configuration |
| `authenticationMethodConfigurations[].includeTargets[].<method-specific: authenticationMode, isUsableForSignIn, verificationMode, allowedPasskeyProfiles[], verifiedIdProfiles[], allowedProfiles[]>` | configuration |
| `authenticationMethodConfigurations[].<Fido2: isSelfServiceRegistrationAllowed, isAttestationEnforced, defaultPasskeyProfile, keyRestrictions.*, passkeyProfiles[].*>` | configuration |
| `authenticationMethodConfigurations[].<MicrosoftAuthenticator: isSoftwareOathEnabled, featureSettings.*.state, featureSettings.*.includeTarget.*, featureSettings.*.excludeTarget.*>` | configuration |
| `authenticationMethodConfigurations[].<Sms/Voice: telecomProviderSettings, isOfficePhoneAllowed, isCustomGreetingEnabled>` | configuration |
| `authenticationMethodConfigurations[].callerIdNumber` | configuration (ambiguous) |
| `authenticationMethodConfigurations[].<TemporaryAccessPass: defaultLifetimeInMinutes, defaultLength, minimumLifetimeInMinutes, maximumLifetimeInMinutes, isUsableOnce>` | configuration |
| `authenticationMethodConfigurations[].<Password: allowPasswordChangeAfterSecureSignIn>` | configuration |
| `authenticationMethodConfigurations[].<Email: allowExternalIdToUseEmailOtp>` | configuration |
| `authenticationMethodConfigurations[].<X509Certificate: requireCertificateSidAlignment, certificateUserBindings[].*, authenticationModeConfiguration.*, issuerHintsConfiguration.state, certificateAuthorityScopes[], crlValidationConfiguration.*>` | configuration |
| `authenticationMethodConfigurations[].<VerifiableCredentials: identityVerificationEventsConfiguration.isEnabled>` | configuration |
| `authenticationMethodConfigurations[].<QRCodePin: standardQRCodeLifetimeInDays, pinLength>` | configuration |
| `authenticationMethodConfigurations[].<FederatedIdentityCredential: profiles[]>` | configuration |

Notes:

- Every `*Targets[].id` is a group id, the keyword `all_users`, or a user object id depending on the sibling `targetType`. The lab policy had one user-type exclude target in the registration campaign. Class by `targetType`: user means identity, group means configuration.
- `callerIdNumber` (Voice) is a tenant phone number, configuration; ambiguous if an admin used a personal number.
- Method-specific blocks are grouped to keep the list readable; all their leaves are configuration.

### authorizationPolicy

- Path: `/policies/authorizationPolicy`
- API version: beta
- Status: verified
- Lokka call: `GET /policies/authorizationPolicy (no query)`
- Used by: cache `authorizationPolicy`

| Property path | Class |
|---|---|
| `id` | security |
| `allowInvitesFrom` | security |
| `allowedToSignUpEmailBasedSubscriptions` | security |
| `allowedToUseSSPR` | security |
| `allowEmailVerifiedUsersToJoinOrganization` | security |
| `allowUserConsentForRiskyApps` | security |
| `blockMsolPowerShell` | security |
| `description` | security |
| `displayName` | security |
| `enabledPreviewFeatures[]` | security |
| `guestUserRoleId` | security |
| `permissionGrantPolicyIdsAssignedToDefaultUserRole[]` | security |
| `defaultUserRolePermissions.allowedToCreateApps` | security |
| `defaultUserRolePermissions.allowedToCreateAgentIdentityBlueprints` | security |
| `defaultUserRolePermissions.allowedToCreateSecurityGroups` | security |
| `defaultUserRolePermissions.allowedToCreateTenants` | security |
| `defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice` | security |
| `defaultUserRolePermissions.allowedToReadOtherUsers` | security |

Notes:

- On beta this returns a collection (`value[]` with one item), not a bare object. The planner comment calls it a singleton; `fetchGraphCachePages` unwraps both, so no bug, but the classifier must walk `value[]`.

### crossTenantAccessPolicy

- Path: `/policies/crossTenantAccessPolicy`
- API version: beta
- Status: verified
- Lokka call: `GET /policies/crossTenantAccessPolicy (no query)`
- Used by: cache `crossTenantAccessPolicy`

| Property path | Class |
|---|---|
| `id` | configuration |
| `definition[]` | configuration (ambiguous) |
| `displayName` | configuration |
| `applyDefaultsToDomainBasedOrganizations` | configuration |
| `allowedCloudEndpoints[]` | configuration |

Notes:

- `definition[]` is a JSON string blob. It can list partner tenant ids; configuration.

### directoryRoles

- Path: `/directoryRoles`
- API version: beta
- Status: verified
- Lokka call: `GET /directoryRoles?$select=id,displayName,description,roleTemplateId (with $top=1 Graph returns 400 Request_UnsupportedQuery)`
- Used by: cache `directoryRoles`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | public |
| `description` | public |
| `roleTemplateId` | public |

Notes:

- Built-in role names, descriptions and template ids are Microsoft public reference content. `id` is tenant specific.
- This endpoint rejects `$top`. The cache path does not send one, so fine, but any generic `$top` injection would break it.

### administrativeUnits

- Path: `/administrativeUnits`
- API version: beta
- Status: unverified (call succeeded, empty collection)
- Lokka call: `GET /administrativeUnits?$top=1&$select=id,displayName,description,visibility returned value: []`
- Used by: cache `administrativeUnits`

| Property path | Class |
|---|---|
| `id` | configuration |
| `displayName` | configuration (ambiguous) |
| `description` | configuration (ambiguous) |
| `visibility` | configuration |

Notes:

- Admin units are often named after a person (executive AU) or a site.

### applications

- Path: `/applications`
- API version: beta
- Status: verified
- Lokka call: `GET /applications?$top=8&$select=<the 19 fields of agent dormant-app-registrations>`
- Used by: cache `applications` (id, appId, displayName, createdDateTime, signInAudience, passwordCredentials, keyCredentials); agent dormant-app-registrations (all fields below, $top=200)

| Property path | Class |
|---|---|
| `id` | configuration |
| `appId` | configuration |
| `displayName` | configuration |
| `createdDateTime` | configuration |
| `publisherDomain` | configuration |
| `signInAudience` | configuration |
| `tags[]` | configuration |
| `description` | configuration (ambiguous) |
| `identifierUris[]` | configuration |
| `notes` | configuration (ambiguous) |
| `serviceManagementReference` | configuration |
| `appRoles[]` | security |
| `api.requestedAccessTokenVersion` | configuration |
| `api.acceptMappedClaims` | configuration |
| `api.knownClientApplications[]` | configuration |
| `api.oauth2PermissionScopes[]` | security |
| `api.preAuthorizedApplications[]` | configuration |
| `api.tokenEncryptionSetting.scheme` | configuration |
| `api.tokenEncryptionSetting.audience` | configuration |
| `api.tokenEncryptionSetting.automatedTokenVersion.current` | configuration |
| `api.tokenEncryptionSetting.automatedTokenVersion.available[]` | configuration |
| `requiredResourceAccess[].resourceAppId` | security |
| `requiredResourceAccess[].resourceAccess[].id` | security |
| `requiredResourceAccess[].resourceAccess[].type` | security |
| `passwordCredentials[].customKeyIdentifier` | configuration |
| `passwordCredentials[].endDateTime` | configuration |
| `passwordCredentials[].keyId` | configuration |
| `passwordCredentials[].startDateTime` | configuration |
| `passwordCredentials[].secretText` | credential |
| `passwordCredentials[].hint` | credential |
| `passwordCredentials[].displayName` | configuration |
| `keyCredentials[].customKeyIdentifier` | configuration |
| `keyCredentials[].endDateTime` | configuration |
| `keyCredentials[].keyId` | configuration |
| `keyCredentials[].startDateTime` | configuration |
| `keyCredentials[].type` | configuration |
| `keyCredentials[].usage` | configuration |
| `keyCredentials[].key` | credential (ambiguous) |
| `keyCredentials[].displayName` | configuration |
| `keyCredentials[].hasExtendedValue` | configuration |
| `web.redirectUris[]` | configuration |
| `web.homePageUrl` | configuration |
| `web.logoutUrl` | configuration |
| `web.enabledResponseModes` | configuration |
| `web.customAuthenticationUx` | configuration |
| `web.redirectUriSettings[].uri` | configuration |
| `web.redirectUriSettings[].index` | configuration |
| `web.implicitGrantSettings.enableIdTokenIssuance` | configuration |
| `web.implicitGrantSettings.enableAccessTokenIssuance` | configuration |
| `spa.redirectUris[]` | configuration |
| `spa.enabledResponseModes` | configuration |
| `publicClient.redirectUris[]` | configuration (ambiguous) |
| `publicClient.enabledResponseModes` | configuration |

Notes:

- `passwordCredentials[].secretText` came back null on every row, as documented (only returned at creation). Still classed credential.
- `passwordCredentials[].hint` was present with a value on every secret: it is the first 3 characters of the client secret. Partial secret material; credential.
- `keyCredentials[].key` was returned on a list call, unasked beyond the `keyCredentials` select, as the full base64 certificate. For `AsymmetricX509Cert` this is the public certificate, not a private key, so it does not grant access. Classed credential (ambiguous) because `type` can be `Symmetric`/`Password`, the blob is large, and it should never reach a model. A reasonable alternative is configuration when `type` is `AsymmetricX509Cert` and `usage` is `Verify`.
- `publicClient.redirectUris[]` in the lab held private LAN IP addresses (`exp://<private IP>:8081`) and a bundle id containing the developer's name. Device and identity leak inside configuration.
- `notes` and `description` are free text; the lab rows had internal product notes.
- `appRoles[]` and `api.oauth2PermissionScopes[]` were empty in the sample; documented subfields (displayName, description, value, id, isEnabled, allowedMemberTypes) are Security.

### servicePrincipals

- Path: `/servicePrincipals`
- API version: beta
- Status: verified (shape); credential subfields verified on /applications
- Lokka call: `GET /servicePrincipals?$top=3&$select=id,appId,displayName,accountEnabled,servicePrincipalType,appOwnerOrganizationId,passwordCredentials,keyCredentials&$filter=tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')`
- Used by: cache `servicePrincipals`

| Property path | Class |
|---|---|
| `id` | configuration |
| `appId` | configuration |
| `displayName` | configuration |
| `accountEnabled` | configuration |
| `servicePrincipalType` | configuration |
| `appOwnerOrganizationId` | configuration |
| `passwordCredentials[].customKeyIdentifier` | configuration |
| `passwordCredentials[].endDateTime` | configuration |
| `passwordCredentials[].keyId` | configuration |
| `passwordCredentials[].startDateTime` | configuration |
| `passwordCredentials[].secretText` | credential |
| `passwordCredentials[].hint` | credential |
| `passwordCredentials[].displayName` | configuration |
| `keyCredentials[].customKeyIdentifier` | configuration |
| `keyCredentials[].endDateTime` | configuration |
| `keyCredentials[].keyId` | configuration |
| `keyCredentials[].startDateTime` | configuration |
| `keyCredentials[].type` | configuration |
| `keyCredentials[].usage` | configuration |
| `keyCredentials[].key` | credential (ambiguous) |
| `keyCredentials[].displayName` | configuration |
| `keyCredentials[].hasExtendedValue` | configuration |

Notes:

- The 3 rows returned had empty `passwordCredentials[]` and `keyCredentials[]`. The item types are the same `passwordCredential` and `keyCredential` complex types as on applications, so the credential subfield classes carry over. Filters on `passwordCredentials/$count` and `appOwnerOrganizationId` are rejected by Graph (400), which is why no populated row was targeted.
- Enterprise apps with SAML SSO carry signing certificates in `keyCredentials[]` (usage Sign). Microsoft does not return private key material on GET, but `key` should still be withheld.

### domains

- Path: `/domains`
- API version: beta
- Status: verified
- Lokka call: `GET /domains?$select=id,isDefault,isInitial,isVerified,authenticationType`
- Used by: cache `domains`

| Property path | Class |
|---|---|
| `id` | configuration (ambiguous) |
| `isDefault` | configuration |
| `isInitial` | configuration |
| `isVerified` | configuration |
| `authenticationType` | configuration |

Notes:

- Domain names are tenant configuration, but they identify the organization and sometimes a person (vanity domains). Ambiguous.

### securityAlerts

- Path: `/security/alerts_v2`
- API version: beta
- Status: unverified (403)
- Lokka call: `GET /security/alerts_v2?$top=1&$select=<the 8 fields in pathForResource> returned 403 Forbidden: Missing application roles. API required roles: SecurityAlert.Read.All, SecurityAlert.ReadWrite.All`
- Used by: cache `securityAlerts`

| Property path | Class |
|---|---|
| `id` | activity |
| `title` | activity (ambiguous) |
| `severity` | activity |
| `status` | activity |
| `detectionSource` | activity |
| `serviceSource` | activity |
| `createdDateTime` | activity |
| `lastUpdateDateTime` | activity |

Notes:

- Schema from msgraph `alert` (security). `title` is usually generic, but some detection sources put the user or host name in it. Not selected: `evidence[]`, `actorDisplayName`, `assignedTo`, `comments[]`, `description` (all identity or device rich).

### securityIncidents

- Path: `/security/incidents`
- API version: beta
- Status: unverified (403)
- Lokka call: `GET /security/incidents?$top=1&$select=<the 9 fields in pathForResource> returned 403 Forbidden: Missing application roles. API required roles: SecurityIncident.Read.All, SecurityIncident.ReadWrite.All`
- Used by: cache `securityIncidents`

| Property path | Class |
|---|---|
| `id` | activity |
| `displayName` | activity (ambiguous) |
| `severity` | activity |
| `status` | activity |
| `classification` | activity |
| `determination` | activity |
| `assignedTo` | identity |
| `createdDateTime` | activity |
| `lastUpdateDateTime` | activity |

Notes:

- Documented schema. `displayName` is generated by Defender and often names the involved user or endpoint ("... on one endpoint", "... involving <user>"). `assignedTo` is the analyst UPN.

### secureScores

- Path: `/security/secureScores`
- API version: beta
- Status: verified
- Lokka call: `GET /security/secureScores?$top=1&$select=id,createdDateTime,currentScore,maxScore,activeUserCount,licensedUserCount`
- Used by: cache `secureScores` ($top=90)

| Property path | Class |
|---|---|
| `id` | configuration |
| `createdDateTime` | configuration |
| `currentScore` | configuration |
| `maxScore` | configuration |
| `activeUserCount` | configuration |
| `licensedUserCount` | configuration |
| `azureTenantId` | configuration |
| `enabledServices[]` | configuration |
| `averageComparativeScores[].SeatSizeRangeLowerValue` | public |
| `averageComparativeScores[].SeatSizeRangeUpperValue` | public |
| `averageComparativeScores[].appsScore` | public |
| `averageComparativeScores[].appsScoreMax` | public |
| `averageComparativeScores[].averageScore` | public |
| `averageComparativeScores[].basis` | public |
| `averageComparativeScores[].dataScore` | public |
| `averageComparativeScores[].dataScoreMax` | public |
| `averageComparativeScores[].deviceScore` | public |
| `averageComparativeScores[].deviceScoreMax` | public |
| `averageComparativeScores[].identityScore` | public |
| `averageComparativeScores[].identityScoreMax` | public |
| `averageComparativeScores[].infrastructureScore` | public |
| `averageComparativeScores[].infrastructureScoreMax` | public |
| `controlScores[].controlCategory` | public |
| `controlScores[].controlName` | public |
| `controlScores[].description` | public |
| `controlScores[].implementationStatus` | configuration (ambiguous) |
| `controlScores[].lastSynced` | configuration |
| `controlScores[].on` | configuration |
| `controlScores[].score` | configuration |
| `controlScores[].scoreInPercentage` | configuration |
| `controlScores[].count` | configuration |
| `controlScores[].total` | configuration |
| `vendorInformation.provider` | public |
| `vendorInformation.providerVersion` | public |
| `vendorInformation.subProvider` | public |
| `vendorInformation.vendor` | public |

Notes:

- `$select` is ignored here: the response carried `azureTenantId`, `enabledServices`, `averageComparativeScores`, `controlScores` and `vendorInformation` although only 6 fields were requested. One row was about 72 KB. The classifier cannot rely on `$select` to bound what arrives.
- `controlScores[].implementationStatus` is Microsoft-generated text with counts ("You have <enabled count> of <user count> users ..."). In the lab it never named a person; ambiguous because some controls may list accounts.

### secureScoreControlProfiles

- Path: `/security/secureScoreControlProfiles`
- API version: beta
- Status: verified
- Lokka call: `GET /security/secureScoreControlProfiles?$top=1&$select=id,title,controlCategory,actionType,service,maxScore,rank,deprecated,implementationCost,userImpact,tier,threats,remediation`
- Used by: cache `secureScoreControlProfiles` ($top=250); agent secure-score-prioritizer (adds threats, remediation)

| Property path | Class |
|---|---|
| `id` | public |
| `azureTenantId` | configuration |
| `actionType` | public |
| `actionUrl` | public |
| `controlCategory` | public |
| `title` | public |
| `deprecated` | public |
| `implementationCost` | public |
| `lastModifiedDateTime` | public |
| `maxScore` | public |
| `rank` | public |
| `remediation` | public |
| `remediationImpact` | public |
| `service` | public |
| `threats[]` | public |
| `tier` | public |
| `userImpact` | public |
| `vendorInformation.provider` | public |
| `vendorInformation.providerVersion` | public |
| `vendorInformation.subProvider` | public |
| `vendorInformation.vendor` | public |
| `complianceInformation[]` | public |
| `controlStateUpdates[].assignedTo` | identity |
| `controlStateUpdates[].comment` | identity (ambiguous) |
| `controlStateUpdates[].state` | configuration |
| `controlStateUpdates[].updatedBy` | identity |
| `controlStateUpdates[].updatedDateTime` | activity |

Notes:

- `$select` is ignored here too: `azureTenantId`, `actionUrl`, `remediationImpact`, `vendorInformation`, `complianceInformation` and `controlStateUpdates` came back unrequested.
- The control catalog itself is Microsoft public content. `controlStateUpdates[]` is tenant state: who marked a control as accepted risk or third party, with a free-text comment. Identity inside otherwise public data.

### riskyUsers (agent only)

- Path: `/identityProtection/riskyUsers`
- API version: beta
- Status: unverified (403)
- Lokka call: `GET /identityProtection/riskyUsers?$top=1&$select=id,userPrincipalName,userDisplayName,riskLevel,riskState,riskDetail,riskLastUpdatedDateTime,isDeleted,isProcessing returned 403 Forbidden: You cannot perform the requested operation, required scopes are missing in the token (needs IdentityRiskyUser.Read.All)`
- Used by: agent risky-sign-in-triage ($filter riskLevel ne 'none', $top=50)

| Property path | Class |
|---|---|
| `id` | identity |
| `userPrincipalName` | identity |
| `userDisplayName` | identity |
| `riskLevel` | activity |
| `riskState` | activity |
| `riskDetail` | activity |
| `riskLastUpdatedDateTime` | activity |
| `isDeleted` | configuration |
| `isProcessing` | configuration |

Notes:

- Schema from msgraph `riskyUser`. `id` is the user's object id.

### BitLocker recovery keys

- Path: `/informationProtection/bitlocker/recoveryKeys and /{id}?$select=key`
- API version: beta and v1.0
- Status: unverified (403 on both versions)
- Lokka call: `GET /informationProtection/bitlocker/recoveryKeys?$top=1 on beta and on v1.0: both 403 authorization_error "Failed to authorize, token doesn't have the required permissions." The by-id `$select=key` call was not possible without a key id from the list.`
- Used by: none today; credential reference

| Property path | Class |
|---|---|
| `id` | device |
| `createdDateTime` | activity |
| `deviceId` | device |
| `volumeType` | configuration |
| `key` | credential |

Notes:

- Schema from msgraph `bitlockerRecoveryKey`. Needs BitlockerKey.Read.All for `key` (BitlockerKey.ReadBasic.All returns everything except `key`). The lab app registration holds neither. `key` is only returned when `$select=key` is set on a single item; list calls never include it.

### Windows LAPS

- Path: `/directory/deviceLocalCredentials and /{deviceId}?$select=credentials`
- API version: beta
- Status: partly verified (list call succeeded, empty)
- Lokka call: `GET /directory/deviceLocalCredentials?$top=1 returned value: [] (no device has a LAPS backup in the lab, so no id for the by-id `$select=credentials` call)`
- Used by: none today; credential reference

| Property path | Class |
|---|---|
| `id` | device |
| `deviceName` | device (ambiguous) |
| `lastBackupDateTime` | activity |
| `refreshDateTime` | configuration |
| `credentials[].accountName` | device (ambiguous) |
| `credentials[].accountSid` | device |
| `credentials[].backupDateTime` | activity |
| `credentials[].passwordBase64` | credential |

Notes:

- Schema from msgraph `deviceLocalCredentialInfo` and `deviceLocalCredential`. List and by-id without `$select=credentials` need DeviceLocalCredential.ReadBasic.All and never include passwords; `credentials` needs DeviceLocalCredential.Read.All, which the lab app holds. `accountName` is the local admin account name: device scoped, but custom names sometimes match the user.

### FileVault personal recovery key

- Path: `/deviceManagement/managedDevices/{id}/getFileVaultKey`
- API version: beta
- Status: unverified (404)
- Lokka call: `GET /deviceManagement/managedDevices/<device id>/getFileVaultKey returned 404 ResourceNotFound (device has no escrowed key; last check-in <month>)`
- Used by: none today; credential reference

| Property path | Class |
|---|---|
| `value` | credential |

Notes:

- Documented read function, needs DeviceManagementManagedDevices.PrivilegedOperations.All. Returns `{ value: <recovery key string> }`.

### Wi-Fi profiles

- Path: `/deviceManagement/deviceConfigurations (Wi-Fi @odata.types)`
- API version: beta
- Status: unverified (no Wi-Fi profiles in lab)
- Lokka call: `GET /deviceManagement/deviceConfigurations?$filter=isof(<Wi-Fi and VPN types>)&$select=id,displayName returned []; GET ?$top=100&$select=id listed all <profile count> profiles and none is a Wi-Fi or VPN type`
- Used by: none today (cache selects metadata only); credential reference

| Property path | Class |
|---|---|
| `ssid` | configuration |
| `networkName` | configuration |
| `wifiSecurityType` | configuration |
| `connectAutomatically` | configuration |
| `connectWhenNetworkNameIsHidden` | configuration |
| `proxySetting` | configuration |
| `proxyManualAddress` | configuration |
| `proxyManualPort` | configuration |
| `proxyAutomaticConfigurationUrl` | configuration |
| `preSharedKey` | credential |
| `preSharedKeyIsSet` | configuration |
| `outerIdentityPrivacyTemporaryValue` | identity (ambiguous) |
| `trustedServerCertificateNames[]` | configuration |

Notes:

- Schema from msgraph `windowsWifiConfiguration`, `iosWiFiConfiguration`, `macOSWiFiConfiguration`, `androidWorkProfileWiFiConfiguration`, `androidDeviceOwnerWiFiConfiguration`, `windowsWifiEnterpriseEAPConfiguration`. All document `preSharedKey` as a readable String. Whether GET returns it in clear or null could not be verified here. Android types add `preSharedKeyIsSet` (boolean, safe).

### VPN profiles

- Path: `/deviceManagement/deviceConfigurations (VPN @odata.types)`
- API version: beta
- Status: unverified (no VPN profiles in lab)
- Lokka call: same calls as Wi-Fi above
- Used by: none today; credential reference

| Property path | Class |
|---|---|
| `connectionName` | configuration |
| `connectionType` | configuration |
| `servers[].address` | configuration |
| `servers[].description` | configuration |
| `servers[].isDefaultServer` | configuration |
| `server.address` | configuration |
| `loginGroupOrDomain` | configuration |
| `realm` | configuration |
| `role` | configuration |
| `identifier` | configuration |
| `customData[].key` | configuration |
| `customData[].value` | credential (ambiguous) |
| `customKeyValueData[].name` | configuration |
| `customKeyValueData[].value` | credential (ambiguous) |
| `customXml` | credential (ambiguous) |
| `eapXml` | credential (ambiguous) |
| `userDomain` | configuration |
| `dnsSuffixes[]` | configuration |
| `trustedNetworkDomains[]` | configuration |

Notes:

- Schema from msgraph `windows10VpnConfiguration`, `iosVpnConfiguration`, `appleVpnConfiguration`. No dedicated secret field, but `customXml`, `eapXml` and custom key/value data are where admins put shared secrets for third-party VPN clients. Credential candidates; scan their content.

### Custom profiles (OMA-URI and Apple mobileconfig)

- Path: `/deviceManagement/deviceConfigurations/{id}`
- API version: beta
- Status: verified (windows10CustomConfiguration); macOS payload unverified
- Lokka call: `GET /deviceManagement/deviceConfigurations/<a windows10CustomConfiguration id> (full object)`
- Used by: none today; credential reference

| Property path | Class |
|---|---|
| `@odata.type` | configuration |
| `id` | configuration |
| `lastModifiedDateTime` | configuration |
| `roleScopeTagIds[]` | configuration |
| `supportsScopeTags` | configuration |
| `deviceManagementApplicabilityRuleOsEdition` | configuration |
| `deviceManagementApplicabilityRuleOsVersion` | configuration |
| `deviceManagementApplicabilityRuleDeviceMode` | configuration |
| `createdDateTime` | configuration |
| `description` | configuration (ambiguous) |
| `displayName` | configuration |
| `version` | configuration |
| `omaSettings[].@odata.type` | configuration |
| `omaSettings[].displayName` | configuration |
| `omaSettings[].description` | configuration (ambiguous) |
| `omaSettings[].omaUri` | configuration |
| `omaSettings[].secretReferenceValueId` | credential (ambiguous) |
| `omaSettings[].isEncrypted` | configuration |
| `omaSettings[].value` | credential (ambiguous) |
| `omaSettings[].isReadOnly` | configuration |
| `payloadName` | configuration |
| `payloadFileName` | configuration |
| `payload` | credential (ambiguous) |

Notes:

- Lab OMA settings were booleans and integers with `isEncrypted: false`. For `omaSettingString` with `isEncrypted: true`, `value` is ciphertext and `secretReferenceValueId` is the handle for `GET /deviceManagement/deviceConfigurations/{id}/getOmaSettingPlainTextValue(secretReferenceValueId='...')` (confirmed in the msgraph OpenAPI index), which returns the plaintext. Classify `value` as credential when `isEncrypted` is true or the OMA-URI is known to carry secrets; the plaintext function result is always credential.
- macOS `payload` is a base64 mobileconfig. It can embed Wi-Fi PSKs, VPN shared secrets and certificate passwords. `$select=payloadName` on the collection fails with 400 because the base type lacks it; the schema comes from msgraph `macOSCustomConfiguration`.

## Summary

| Endpoint | Verified | credential | identity | device | activity | configuration | public | ambiguous |
|---|---|---|---|---|---|---|---|---|
| managedDevices (cache and agents $select) | verified | 0 | 1 | 4 | 2 | 9 | 0 | 2 |
| managedDevices (full default projection) | verified | 2 | 10 | 26 | 8 | 79 | 0 | 6 |
| entraDevices | verified | 0 | 0 | 3 | 1 | 4 | 0 | 1 |
| users | verified | 0 | 6 | 0 | 8 | 5 | 0 | 2 |
| groups | verified | 0 | 3 | 0 | 0 | 5 | 0 | 1 |
| deviceCompliancePolicies | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| deviceConfigurations (cache $select) | verified | 0 | 0 | 0 | 0 | 7 | 0 | 1 |
| configurationPolicies | verified | 0 | 0 | 0 | 0 | 9 | 0 | 1 |
| signIns | verified | 0 | 2 | 3 | 33 | 4 | 0 | 4 |
| directoryAudits | verified | 0 | 10 | 1 | 11 | 5 | 0 | 6 |
| intuneAuditEvents | verified | 0 | 5 | 2 | 15 | 6 | 0 | 4 |
| conditionalAccessPolicies | verified | 0 | 2 | 0 | 0 | 38 | 0 | 1 |
| mobileApps | verified | 0 | 0 | 0 | 0 | 10 | 0 | 2 |
| detectedApps | verified | 0 | 0 | 0 | 0 | 7 | 0 | 2 |
| managedAppPolicies | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| iosManagedAppProtections | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| androidManagedAppProtections | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| mobileAppConfigurations | verified | 0 | 0 | 0 | 0 | 7 | 0 | 1 |
| deviceHealthScripts | verified | 0 | 1 | 0 | 0 | 8 | 0 | 2 |
| deviceManagementScripts | verified | 0 | 0 | 0 | 0 | 8 | 0 | 1 |
| windowsAutopilotDevices | verified | 2 | 4 | 8 | 3 | 11 | 0 | 4 |
| autopilotEvents | unverified (call succeeded, empty collection) | 0 | 2 | 3 | 11 | 4 | 0 | 1 |
| windowsAutopilotProfiles | verified | 0 | 0 | 0 | 0 | 8 | 0 | 1 |
| deviceEnrollmentConfigurations | verified | 0 | 0 | 0 | 0 | 7 | 0 | 1 |
| windowsQualityUpdateProfiles | unverified (call succeeded, empty collection) | 0 | 0 | 0 | 0 | 5 | 0 | 1 |
| windowsFeatureUpdateProfiles | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| endpointSecurityIntents | verified | 0 | 0 | 0 | 0 | 6 | 0 | 1 |
| groupPolicyConfigurations | verified | 0 | 0 | 0 | 0 | 5 | 0 | 1 |
| assignmentFilters | verified | 0 | 0 | 1 | 0 | 7 | 0 | 2 |
| roleScopeTags | verified | 0 | 0 | 0 | 0 | 3 | 0 | 1 |
| managedDeviceOverview | verified | 0 | 0 | 0 | 0 | 27 | 0 | 0 |
| managedDeviceEncryptionStates | verified | 0 | 1 | 3 | 0 | 4 | 0 | 1 |
| troubleshootingEvents | unverified (call succeeded, empty collection) | 0 | 0 | 0 | 6 | 0 | 3 | 3 |
| namedLocations | unverified (call succeeded, empty collection) | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| authenticationMethodsPolicy | verified | 0 | 7 | 0 | 0 | 35 | 0 | 8 |
| authorizationPolicy | verified | 0 | 0 | 0 | 0 | 18 | 0 | 0 |
| crossTenantAccessPolicy | verified | 0 | 0 | 0 | 0 | 5 | 0 | 1 |
| directoryRoles | verified | 0 | 0 | 0 | 0 | 1 | 3 | 0 |
| administrativeUnits | unverified (call succeeded, empty collection) | 0 | 0 | 0 | 0 | 4 | 0 | 2 |
| applications | verified | 3 | 0 | 0 | 0 | 50 | 0 | 4 |
| servicePrincipals | verified (shape); credential subfields verified on /applications | 3 | 0 | 0 | 0 | 19 | 0 | 1 |
| domains | verified | 0 | 0 | 0 | 0 | 5 | 0 | 1 |
| securityAlerts | unverified (403) | 0 | 0 | 0 | 8 | 0 | 0 | 1 |
| securityIncidents | unverified (403) | 0 | 1 | 0 | 8 | 0 | 0 | 1 |
| secureScores | verified | 0 | 0 | 0 | 0 | 15 | 21 | 1 |
| secureScoreControlProfiles | verified | 0 | 3 | 0 | 1 | 2 | 21 | 1 |
| riskyUsers (agent only) | unverified (403) | 0 | 3 | 0 | 4 | 2 | 0 | 0 |
| BitLocker recovery keys | unverified (403 on both versions) | 1 | 0 | 2 | 1 | 1 | 0 | 0 |
| Windows LAPS | partly verified (list call succeeded, empty) | 1 | 0 | 4 | 2 | 1 | 0 | 2 |
| FileVault personal recovery key | unverified (404) | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| Wi-Fi profiles | unverified (no Wi-Fi profiles in lab) | 1 | 1 | 0 | 0 | 11 | 0 | 1 |
| VPN profiles | unverified (no VPN profiles in lab) | 4 | 0 | 0 | 0 | 15 | 0 | 4 |
| Custom profiles (OMA-URI and Apple mobileconfig) | verified (windows10CustomConfiguration); macOS payload unverified | 3 | 0 | 0 | 0 | 20 | 0 | 5 |
| **Total** | | **21** | **59** | **60** | **122** | **537** | **48** | **93** |

Counts are property paths as listed above (grouped method-specific blocks in authenticationMethodsPolicy count as one row each). `@odata.nextLink` rows are included where the skiptoken carries data.

## Fields that should be credential

Fields the app reads today (cache or agents):

- `applications.passwordCredentials[].hint` (verified present: first 3 characters of each client secret)
- `applications.passwordCredentials[].secretText` (verified null on read; keep as credential)
- `applications.keyCredentials[].key` (verified present on list calls: full base64 certificate; public X.509 in the lab, but see note)
- `servicePrincipals.passwordCredentials[].hint`, `.secretText`, `servicePrincipals.keyCredentials[].key` (same types)
- `windowsAutopilotDeviceIdentities.productKey` (verified present, value present; the cache cannot `$select` this endpoint away)
- `windowsAutopilotDeviceIdentities.deviceAccountPassword` (verified present as key, null in lab)

Fields on endpoints the app does not read today but chat tools could reach:

- `managedDevices.activationLockBypassCode` (verified key present, null on list; real value only with explicit `$select` on one device)
- `managedDevices.remoteAssistanceSessionUrl` (ambiguous; live session link)
- `bitlockerRecoveryKey.key` (unverified, 403)
- `deviceLocalCredentialInfo.credentials[].passwordBase64` (unverified, no backups in lab)
- `getFileVaultKey` result `value` (unverified, 404)
- Wi-Fi `preSharedKey` on all Wi-Fi configuration types (unverified, no profiles)
- VPN `customXml`, `eapXml`, `customData[].value`, `customKeyValueData[].value` (credential candidates, content scan)
- OMA-URI `omaSettings[].value` when `isEncrypted` is true, `omaSettings[].secretReferenceValueId`, and any `getOmaSettingPlainTextValue` result
- macOS custom profile `payload` (credential candidate)
- Script bodies: `deviceHealthScripts.detectionScriptContent`, `.remediationScriptContent`, `deviceManagementScripts.scriptContent` (credential candidates)
- App configuration `settings[].appConfigKeyValue`, `encodedSettingXml` (credential candidates)
- Free-text audit values `directoryAudits.targetResources[].modifiedProperties[].newValue/oldValue` and `auditEvents.resources[].modifiedProperties[].newValue/oldValue`: default identity, but run a credential pattern scan on them

## Surprises and cross-class leaks

- Failed or empty calls: `security/alerts_v2` and `security/incidents` 403 (app lacks SecurityAlert/SecurityIncident roles); `identityProtection/riskyUsers` 403 (no IdentityRiskyUser.Read.All); BitLocker recovery keys 403 on beta and v1.0 (no BitlockerKey role); `getFileVaultKey` 404; `directoryRoles` with `$top` 400 (the cache does not send `$top`); autopilotEvents, troubleshootingEvents, namedLocations, administrativeUnits, windowsQualityUpdateProfiles and deviceLocalCredentials returned empty collections; no Wi-Fi or VPN profiles exist in the lab.
- `$select` is not a boundary. `secureScores` and `secureScoreControlProfiles` ignored it and returned extra objects, including `controlStateUpdates[].updatedBy/assignedTo/comment` (identity). `windowsAutopilotDeviceIdentities` cannot take `$select` at all, so the cache receives `productKey` and `deviceAccountPassword`. Classification has to run on what arrives, not on what was requested.
- Paging links carry data. `@odata.nextLink` skiptokens contained a device name (managedDevices), a serial number (Autopilot), a device id plus name (encryption states), an app name (mobileApps) and a base64-encoded UPN (users). Strip or classify them before anything is persisted or shown to a model.
- Identity inside device data: Entra device `displayName` contained the owner's first name; `managedDeviceName` embeds the enrolling user's object id; `easDeviceId` embeds the serial; `hardwareInformation.sharedDeviceCachedUsers[]` and `usersLoggedOn[]` carry user ids.
- Identity inside configuration: Conditional Access `includeUsers[]/excludeUsers[]` are user object ids; authentication methods policy targets mix user and group ids under the same `id` key; remediation script `publisher` held the creating admin's full name; Secure Score control state updates name who changed them.
- Device data inside configuration: an assignment filter `rule` named a specific device; app registration `publicClient.redirectUris[]` held private LAN IP addresses.
- Credential metadata inside activity: directory audit `modifiedProperties` for service principal creation carried `Credential` entries (`KeyStoreId`, `KeyGroupId`, no secret). Other audit types can carry raw values, so audit free text needs a content scan.
- `applications.passwordCredentials[].hint` is easy to miss: it is returned on every list read and is part of the secret.
- Sign-in IP addresses and audit actor IP addresses are Identity because they identify the person's activity.
- authorizationPolicy is a one-item collection on beta, not a bare singleton.
