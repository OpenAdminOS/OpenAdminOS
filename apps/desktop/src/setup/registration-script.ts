import {
  PERMISSION_AREAS,
  normalizePermissionAreaIds,
  scopesForPermissionAreas,
  type PermissionAreaId,
} from "../shared/openAdminOS";

export const DEFAULT_REGISTRATION_DISPLAY_NAME = "OpenAdminOS";
export const REGISTRATION_DISPLAY_NAME_MAX_LENGTH = 120;
export const AUTHENTICATION_TRUST_MODEL_URL =
  "https://docs.openadminos.com/trust-model/authentication";

export interface RegistrationSetupOutput {
  script: string;
  message: string;
  areaTitles: string[];
  scopeNames: string[];
}

export function validateRegistrationDisplayName(value: string): string | null {
  const displayName = value.trim();
  if (!displayName) return "Enter a display name.";
  if (displayName.length > REGISTRATION_DISPLAY_NAME_MAX_LENGTH) {
    return `Display name must be ${REGISTRATION_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (/\p{Cc}/u.test(displayName)) {
    return "Display name cannot contain control characters.";
  }
  if (displayName.includes("<#") || displayName.includes("#>")) {
    return "Display name cannot contain PowerShell comment delimiters.";
  }
  return null;
}

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

export function generateRegistrationSetup(
  displayNameInput: string,
  areaIds: readonly PermissionAreaId[],
): RegistrationSetupOutput {
  const validationError = validateRegistrationDisplayName(displayNameInput);
  if (validationError) throw new Error(validationError);

  const displayName = displayNameInput.trim();
  const selectedIds = normalizePermissionAreaIds(areaIds);
  const selected = new Set(selectedIds);
  const areaTitles = PERMISSION_AREAS.filter((area) => selected.has(area.id)).map(
    (area) => area.title,
  );
  const scopeNames = scopesForPermissionAreas(selectedIds);
  const allScopes = [...scopeNames, "openid", "profile", "offline_access"];
  const escapedDisplayName = escapePowerShellSingleQuoted(displayName);
  const scopeLines = allScopes.map((scope) => `    '${scope}'`).join(",\n");
  const areaList = areaTitles.join(", ");

  const script = `<#
This script creates a tenant-owned Microsoft Entra app registration named ${displayName} for OpenAdminOS.

It makes these changes:
1. Connects to Microsoft Graph with permission to create an application and grant delegated tenant-wide consent. An administrator must approve these setup permissions.
2. Stops before changing anything if an application with the same display name already exists. This avoids updating or duplicating an existing registration.
3. Creates a single-tenant public client application with the localhost redirect URI required by the OpenAdminOS desktop sign-in flow.
4. Adds delegated Microsoft Graph permissions for these OpenAdminOS areas: ${areaList}. It also adds openid, profile, and offline_access for sign-in and refresh tokens.
5. Creates the corresponding enterprise application and grants tenant-wide admin consent for the same delegated scope set.

The script does not create a client secret or certificate. OpenAdminOS signs users in through the system browser and acts with the signed-in administrator's delegated access.
#>

$ErrorActionPreference = 'Stop'
$displayName = '${escapedDisplayName}'
$microsoftGraphAppId = '00000003-0000-0000-c000-000000000000'
$requestedScopeValues = @(
${scopeLines}
)

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Applications)) {
    throw 'The Microsoft Graph PowerShell SDK is not installed. Run Install-Module Microsoft.Graph -Scope CurrentUser, then run this script again. No changes were made.'
}

Connect-MgGraph -Scopes Application.ReadWrite.All, DelegatedPermissionGrant.ReadWrite.All

$odataDisplayName = $displayName.Replace("'", "''")
$existingApplications = @(Get-MgApplication -Filter "displayName eq '$odataDisplayName'" -All)
if ($existingApplications.Count -gt 0) {
    throw "An application named '$displayName' already exists. No changes were made. Choose another display name or ask your Entra administrator to review the existing registration."
}

$graphServicePrincipals = @(Get-MgServicePrincipal -Filter "appId eq '$microsoftGraphAppId'" -Property Id,AppId,DisplayName,Oauth2PermissionScopes -All)
if ($graphServicePrincipals.Count -ne 1) {
    throw 'Microsoft Graph service principal could not be resolved uniquely in this tenant. No application was created.'
}
$graphServicePrincipal = $graphServicePrincipals[0]
if (-not $graphServicePrincipal.Oauth2PermissionScopes) {
    throw 'Microsoft Graph did not return Oauth2PermissionScopes. Check Graph PowerShell permissions and try again. No application was created.'
}

$resourceAccess = foreach ($scopeValue in $requestedScopeValues) {
    $permission = $graphServicePrincipal.Oauth2PermissionScopes |
        Where-Object { $_.Value -eq $scopeValue } |
        Select-Object -First 1
    if (-not $permission) {
        throw "Microsoft Graph delegated permission '$scopeValue' was not found. No application was created."
    }
    @{
        Id = $permission.Id
        Type = 'Scope'
    }
}

$application = New-MgApplication -BodyParameter @{
    DisplayName = $displayName
    SignInAudience = 'AzureADMyOrg'
    IsFallbackPublicClient = $true
    PublicClient = @{
        RedirectUris = @('http://localhost')
    }
    RequiredResourceAccess = @(
        @{
            ResourceAppId = $microsoftGraphAppId
            ResourceAccess = @($resourceAccess)
        }
    )
}

$servicePrincipal = New-MgServicePrincipal -BodyParameter @{
    AppId = $application.AppId
}

$scopeString = $requestedScopeValues -join ' '
New-MgOauth2PermissionGrant -BodyParameter @{
    ClientId = $servicePrincipal.Id
    ConsentType = 'AllPrincipals'
    ResourceId = $graphServicePrincipal.Id
    Scope = $scopeString
} | Out-Null

$context = Get-MgContext
Write-Host ''
Write-Host 'OpenAdminOS registration created.'
Write-Host "Application (client) ID: $($application.AppId)"
Write-Host "Directory (tenant) ID: $($context.TenantId)"
Write-Host "Enter both values in OpenAdminOS under Use your organization's app registration."
Write-Host "Find the enterprise application in the Microsoft Entra admin center under Enterprise applications, named $displayName."
`;

  const message = `Please run the attached PowerShell script as an Entra administrator. It creates a tenant-owned OpenAdminOS public client registration, its enterprise application, and tenant-wide admin consent for these areas: ${areaList}. All requested Microsoft Graph permissions are delegated and read-only. The script creates no client secret or certificate. Authentication details: ${AUTHENTICATION_TRUST_MODEL_URL}`;

  return { script, message, areaTitles, scopeNames };
}
