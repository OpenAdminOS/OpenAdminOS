import {
  AVAILABLE_SERVICES,
  MICROSOFT_GRAPH_APP_ID,
  requestedScopes,
  servicePartById,
} from "../shared/openAdminOS";

export const DEFAULT_REGISTRATION_DISPLAY_NAME = "OpenAdminOS";
export const REGISTRATION_DISPLAY_NAME_MAX_LENGTH = 120;
export const AUTHENTICATION_TRUST_MODEL_URL =
  "https://docs.openadminos.com/trust-model/authentication";

/**
 * `create` makes a new tenant-owned registration. `extend` adds the chosen
 * services to an existing registration and never removes a permission.
 */
export type RegistrationSetupInput =
  | { mode: "create"; displayName: string; partIds: readonly string[] }
  | { mode: "extend"; clientId: string; partIds: readonly string[] };

export interface RegistrationSetupOutput {
  mode: RegistrationSetupInput["mode"];
  script: string;
  message: string;
  serviceTitles: string[];
  /** Every delegated scope the script adds, sign-in scopes included. */
  scopeNames: string[];
}

// PowerShell treats these as single-quote delimiters too, so they would
// end the quoted display name in the script. Only the ASCII apostrophe is
// allowed, and escapePowerShellSingleQuoted doubles it.
const POWERSHELL_QUOTE_VARIANTS = /[\u2018\u2019\u201A\u201B]/u;

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
  if (POWERSHELL_QUOTE_VARIANTS.test(displayName)) {
    return "Display name cannot contain typographic single quotes. Use a straight apostrophe (') instead.";
  }
  return null;
}

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value);
}

/**
 * A PowerShell expression for `value` written in printable ASCII only.
 * Windows PowerShell 5.1 reads a .ps1 without a byte order mark in the
 * system code page. Under Windows-1252 some UTF-8 bytes of ordinary
 * letters decode as single-quote delimiters, so every other character is
 * written as a [char] code.
 */
export function powerShellStringLiteral(value: string): string {
  if (isPrintableAscii(value)) return `'${escapePowerShellSingleQuoted(value)}'`;
  const parts: string[] = [];
  let run = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      run += value[index];
      continue;
    }
    if (run) parts.push(`'${escapePowerShellSingleQuoted(run)}'`);
    run = "";
    parts.push(`[char]0x${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  if (run) parts.push(`'${escapePowerShellSingleQuoted(run)}'`);
  return `-join @(${parts.join(", ")})`;
}

const CLIENT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function selectedServiceTitles(partIds: readonly string[]): string[] {
  const selected = new Set(
    partIds.flatMap((id) => {
      const part = servicePartById(id);
      return part && !part.planned ? [part.service] : [];
    }),
  );
  if (selected.size === 0) throw new Error("Select at least one service.");
  return AVAILABLE_SERVICES.filter((service) => selected.has(service.id)).map(
    (service) => service.title,
  );
}

// Shared by both modes: stop before any change when a module is missing,
// connect, then resolve each delegated permission ID at run time.
function preamble(stopMessage: string): string {
  return `$requiredModules = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications', 'Microsoft.Graph.Identity.SignIns')
$missingModules = @($requiredModules | Where-Object { -not (Get-Module -ListAvailable -Name $_) })
if ($missingModules.Count -gt 0) {
    throw "The Microsoft Graph PowerShell SDK is missing these modules: $($missingModules -join ', '). Run Install-Module Microsoft.Graph -Scope CurrentUser, then run this script again. No changes were made."
}
Import-Module $requiredModules

Connect-MgGraph -Scopes Application.ReadWrite.All, DelegatedPermissionGrant.ReadWrite.All
`.replace("No changes were made.", stopMessage);
}

function resolvePermissions(stopMessage: string): string {
  return `$graphServicePrincipals = @(Get-MgServicePrincipal -Filter "appId eq '$microsoftGraphAppId'" -Property Id,AppId,DisplayName,Oauth2PermissionScopes -All)
if ($graphServicePrincipals.Count -ne 1) {
    throw 'Microsoft Graph service principal could not be resolved uniquely in this tenant. ${stopMessage}'
}
$graphServicePrincipal = $graphServicePrincipals[0]
if (-not $graphServicePrincipal.Oauth2PermissionScopes) {
    throw 'Microsoft Graph did not return Oauth2PermissionScopes. Check Graph PowerShell permissions and try again. ${stopMessage}'
}

$resourceAccess = foreach ($scopeValue in $requestedScopeValues) {
    $permission = $graphServicePrincipal.Oauth2PermissionScopes |
        Where-Object { $_.Value -eq $scopeValue } |
        Select-Object -First 1
    if (-not $permission) {
        throw "Microsoft Graph delegated permission '$scopeValue' was not found. ${stopMessage}"
    }
    @{
        Id = $permission.Id
        Type = 'Scope'
    }
}
`;
}

export function generateRegistrationSetup(
  input: RegistrationSetupInput,
): RegistrationSetupOutput {
  const serviceTitles = selectedServiceTitles(input.partIds);
  const scopeNames = requestedScopes(input.partIds).map((scope) => scope.name);
  const scopeLines = scopeNames.map((scope) => `    '${scope}'`).join(",\n");
  const serviceList = serviceTitles.join(", ");
  const base = { mode: input.mode, serviceTitles, scopeNames };
  return input.mode === "create"
    ? { ...base, ...createScript(input.displayName, scopeLines, serviceList) }
    : { ...base, ...extendScript(input.clientId, scopeLines, serviceList) };
}

function createScript(
  displayNameInput: string,
  scopeLines: string,
  serviceList: string,
): { script: string; message: string } {
  const validationError = validateRegistrationDisplayName(displayNameInput);
  if (validationError) throw new Error(validationError);
  const displayName = displayNameInput.trim();
  const displayNameLiteral = powerShellStringLiteral(displayName);
  const headerName = isPrintableAscii(displayName)
    ? `named ${displayName}`
    : "with the display name set in $displayName below";

  const script = `<#
This script creates a tenant-owned Microsoft Entra app registration ${headerName} for OpenAdminOS.

It makes these changes:
1. Connects to Microsoft Graph with permission to create an application and grant delegated tenant-wide consent. An administrator must approve these setup permissions.
2. Stops before changing anything if a required Microsoft Graph PowerShell module is missing, or if an application with the same display name already exists. This avoids updating or duplicating an existing registration.
3. Creates a single-tenant public client application with the localhost redirect URI required by the OpenAdminOS desktop sign-in flow.
4. Adds delegated Microsoft Graph permissions for these OpenAdminOS services: ${serviceList}. It also adds openid, profile, offline_access and User.Read for sign-in and refresh tokens.
5. Creates the corresponding enterprise application and grants tenant-wide admin consent for the same delegated scope set. If either step fails, it deletes the application it created in step 3.

The script does not create a client secret or certificate. OpenAdminOS signs users in through the system browser and acts with the signed-in administrator's delegated access.
#>

$ErrorActionPreference = 'Stop'
$displayName = ${displayNameLiteral}
$microsoftGraphAppId = '${MICROSOFT_GRAPH_APP_ID}'
$requestedScopeValues = @(
${scopeLines}
)

${preamble("No changes were made.")}
$odataDisplayName = $displayName.Replace("'", "''")
$existingApplications = @(Get-MgApplication -Filter "displayName eq '$odataDisplayName'" -All)
if ($existingApplications.Count -gt 0) {
    throw "An application named '$displayName' already exists. No changes were made. Choose another display name or ask your Entra administrator to review the existing registration."
}

${resolvePermissions("No application was created.")}
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

try {
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
} catch {
    $setupError = $_.Exception.Message
    try {
        Remove-MgApplication -ApplicationId $application.Id
    } catch {
        throw "Admin consent could not be granted: $setupError The application '$displayName' (client ID $($application.AppId)) was created but could not be removed: $($_.Exception.Message) Delete it in the Microsoft Entra admin center under App registrations."
    }
    throw "Admin consent could not be granted: $setupError The application '$displayName' that this script created was removed. No changes were left in place."
}

$context = Get-MgContext
Write-Host ''
Write-Host 'OpenAdminOS registration created.'
Write-Host "Application (client) ID: $($application.AppId)"
Write-Host "Directory (tenant) ID: $($context.TenantId)"
Write-Host "Enter both values in OpenAdminOS under Use your organization's app registration."
Write-Host "Find the enterprise application in the Microsoft Entra admin center under Enterprise applications, named $displayName."
`;

  const message = `Please run the attached PowerShell script as an Entra administrator. It creates a tenant-owned OpenAdminOS public client registration, its enterprise application, and tenant-wide admin consent for these services: ${serviceList}. All requested Microsoft Graph permissions are delegated and read-only. The script creates no client secret or certificate. Authentication details: ${AUTHENTICATION_TRUST_MODEL_URL}`;

  return { script, message };
}

function extendScript(
  clientIdInput: string,
  scopeLines: string,
  serviceList: string,
): { script: string; message: string } {
  const clientId = clientIdInput.trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("The Application (client) ID must be a GUID from your app registration overview.");
  }

  const script = `<#
This script adds OpenAdminOS permissions to the existing Microsoft Entra app registration with client ID ${clientId}.

It makes these changes:
1. Connects to Microsoft Graph with permission to update an application and grant delegated tenant-wide consent. An administrator must approve these setup permissions.
2. Stops before changing anything if a required Microsoft Graph PowerShell module is missing, or if no application with this client ID exists in the tenant.
3. Adds delegated Microsoft Graph permissions for these OpenAdminOS services: ${serviceList}, plus openid, profile, offline_access and User.Read. Every permission the app already has is kept. Nothing is removed.
4. Creates the enterprise application if it does not exist yet.
5. Grants tenant-wide admin consent for the added scopes. An existing tenant-wide grant is extended, never reduced.
6. Prints what changed.

The script does not create a client secret or certificate, and it does not change the app's redirect URIs or other settings.
#>

$ErrorActionPreference = 'Stop'
$clientId = '${clientId}'
$microsoftGraphAppId = '${MICROSOFT_GRAPH_APP_ID}'
$requestedScopeValues = @(
${scopeLines}
)

${preamble("No changes were made.")}
$applications = @(Get-MgApplication -Filter "appId eq '$clientId'" -Property Id,AppId,DisplayName,RequiredResourceAccess -All)
if ($applications.Count -ne 1) {
    throw "No application with client ID $clientId was found in this tenant. No changes were made. Check the Application (client) ID in OpenAdminOS."
}
$application = $applications[0]

${resolvePermissions("No changes were made.")}
# Union the new delegated permissions into the existing list. Microsoft
# Graph replaces requiredResourceAccess as a whole, so every existing entry,
# for every resource and of every type, is sent back unchanged.
$addedPermissions = @()
$graphEntryFound = $false
$requiredResourceAccess = @(foreach ($resource in @($application.RequiredResourceAccess)) {
    $existingAccess = @($resource.ResourceAccess | ForEach-Object { @{ Id = $_.Id; Type = $_.Type } })
    if ($resource.ResourceAppId -eq $microsoftGraphAppId) {
        $graphEntryFound = $true
        $existingScopeIds = @($existingAccess | Where-Object { $_.Type -eq 'Scope' } | ForEach-Object { $_.Id })
        $addedPermissions = @($resourceAccess | Where-Object { $existingScopeIds -notcontains $_.Id })
        $existingAccess = @($existingAccess + $addedPermissions)
    }
    @{
        ResourceAppId = $resource.ResourceAppId
        ResourceAccess = $existingAccess
    }
})
if (-not $graphEntryFound) {
    $addedPermissions = @($resourceAccess)
    $requiredResourceAccess += @{
        ResourceAppId = $microsoftGraphAppId
        ResourceAccess = @($resourceAccess)
    }
}
if ($addedPermissions.Count -gt 0) {
    Update-MgApplication -ApplicationId $application.Id -BodyParameter @{
        RequiredResourceAccess = $requiredResourceAccess
    }
}

$servicePrincipals = @(Get-MgServicePrincipal -Filter "appId eq '$clientId'" -All)
$createdServicePrincipal = $false
if ($servicePrincipals.Count -gt 0) {
    $servicePrincipal = $servicePrincipals[0]
} else {
    $servicePrincipal = New-MgServicePrincipal -BodyParameter @{
        AppId = $clientId
    }
    $createdServicePrincipal = $true
}

# Extend the tenant-wide grant with the union of its scopes and the new ones.
$existingGrant = @(Get-MgOauth2PermissionGrant -Filter "clientId eq '$($servicePrincipal.Id)'" -All |
    Where-Object { $_.ConsentType -eq 'AllPrincipals' -and $_.ResourceId -eq $graphServicePrincipal.Id }) |
    Select-Object -First 1
if ($existingGrant) {
    $grantedScopes = @($existingGrant.Scope -split ' ' | Where-Object { $_ })
    $addedConsent = @($requestedScopeValues | Where-Object { $grantedScopes -notcontains $_ })
    if ($addedConsent.Count -gt 0) {
        Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existingGrant.Id -BodyParameter @{
            Scope = (@($grantedScopes + $addedConsent) -join ' ')
        }
    }
} else {
    $addedConsent = @($requestedScopeValues)
    New-MgOauth2PermissionGrant -BodyParameter @{
        ClientId = $servicePrincipal.Id
        ConsentType = 'AllPrincipals'
        ResourceId = $graphServicePrincipal.Id
        Scope = ($requestedScopeValues -join ' ')
    } | Out-Null
}

$addedNames = @($addedPermissions | ForEach-Object {
    $permissionId = $_.Id
    ($graphServicePrincipal.Oauth2PermissionScopes | Where-Object { $_.Id -eq $permissionId } | Select-Object -First 1).Value
})
Write-Host ''
Write-Host "OpenAdminOS permissions updated for $($application.DisplayName) (client ID $clientId)."
if ($addedNames.Count -gt 0) {
    Write-Host "Permissions added to the app: $($addedNames -join ', ')"
} else {
    Write-Host 'The app already listed every requested permission. Nothing was added to it.'
}
if ($createdServicePrincipal) {
    Write-Host 'Created the enterprise application.'
}
if ($addedConsent.Count -gt 0) {
    Write-Host "Admin consent granted for: $($addedConsent -join ', ')"
} else {
    Write-Host 'Admin consent already covered every requested permission.'
}
Write-Host 'Return to OpenAdminOS and choose Check again.'
`;

  const message = `Please run the attached PowerShell script as an Entra administrator. It adds delegated Microsoft Graph permissions for these OpenAdminOS services to the existing app registration with client ID ${clientId}: ${serviceList}. It keeps every permission the app already has and grants tenant-wide admin consent for the added scopes. All requested permissions are delegated and read-only. The script creates no client secret or certificate. Authentication details: ${AUTHENTICATION_TRUST_MODEL_URL}`;

  return { script, message };
}

export interface RequiredResourceAccessSnippet {
  json: string;
  notes: string[];
}

/**
 * A Graph-only `requiredResourceAccess` entry for the app manifest, built
 * from the registry's Lokka-verified permission IDs.
 */
export function generateRequiredResourceAccessSnippet(
  partIds: readonly string[],
): RequiredResourceAccessSnippet {
  selectedServiceTitles(partIds);
  const resourceAccess = [
    ...new Map(
      requestedScopes(partIds).map((scope) => [scope.permissionId, scope] as const),
    ).values(),
  ].map((scope) => ({ id: scope.permissionId, type: "Scope" }));
  const json = JSON.stringify(
    [{ resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceAccess }],
    null,
    2,
  );
  return {
    json,
    notes: [
      "Merge these entries into the existing requiredResourceAccess array in the app manifest. Do not replace the array: entries it already has must stay.",
      "If the array already has an entry for this resourceAppId, add the missing resourceAccess items to that entry instead of adding a second one.",
      "Admin consent is still required after you save the manifest. Grant it under API permissions, then choose Check again in OpenAdminOS.",
    ],
  };
}
