---
title: "Own app registration"
description: "Connect a tenant with an app registration your organization owns: create it, add services, read what was granted, and Check again."
---

# Own App Registration

Use your own app registration when your organization does not allow third-party multi-tenant apps, or when you want a tenant-owned registration for Conditional Access targeting, sign-in monitoring and consent governance. Sign-in logs show your app's name, and your consent rules apply to it.

With your own registration, the registration decides which services OpenAdminOS can use. There is no service picker: OpenAdminOS signs in, reads what the registration has been granted, and switches on each part whose permissions are all granted.

## Create The Registration

You can create the registration by hand or with the setup script below.

1. In the Microsoft Entra admin center, go to **App registrations** and create a new registration. Single-tenant (**Accounts in this organizational directory only**) or multi-tenant both work.
2. Under **Authentication**, add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`. OpenAdminOS signs in through the system browser and listens on a loopback port.
3. Under **Authentication**, set **Allow public client flows** to **Yes**. Without it, Microsoft asks for a client secret and sign-in fails with AADSTS7000218.
4. Under **API permissions**, add the delegated Microsoft Graph permissions for the services you want, listed below, then select **Grant admin consent**.
5. Do not create a client secret or certificate. OpenAdminOS is a public client that signs in with Authorization Code and PKCE, so it neither needs nor accepts a secret.

Microsoft documents the desktop platform settings in [Desktop app that calls web APIs: app registration](https://learn.microsoft.com/entra/identity-platform/scenario-desktop-app-configuration).

## Connect

1. In OpenAdminOS, start connecting a tenant and choose **Your own app registration**.
2. Enter the **Application (client) ID** from the registration overview.
3. For a single-tenant registration, also enter the **Directory (tenant) ID**, either the GUID or a verified domain such as `contoso.onmicrosoft.com`. Sign-in then goes to that directory instead of the common endpoint. A single-tenant app without it fails with AADSTS50194.
4. Optionally add a label so you recognise the registration later.
5. Choose **Sign in with your app registration**.

After a successful connect, OpenAdminOS remembers the registration on this device: client ID, directory ID and label, never a secret. The next time you choose **Your own app registration**, the most recently used one is selected. Remove saved registrations in Connections; tenants already connected with one are not affected.

## Permissions By Service

Every permission is delegated and read-only. Add the rows for the services you want. A part is on only when every permission in it is granted, so add whole parts. Permissions that two services share, such as `User.Read.All`, only need to be added once. The [Permissions by service](../generated/reference/permissions-by-service.md) reference gives the reason for each one.

### Intune

| Part | Permission | Permission ID |
| --- | --- | --- |
| Users and groups | `User.Read.All` | `a154be20-db9c-4678-8ab7-66f6cc099a59` |
| Users and groups | `GroupMember.Read.All` | `bc024368-1153-4739-b217-4326f2e966d0` |
| Users and groups | `Organization.Read.All` | `4908d5b9-3fb2-4b1e-9336-1888b7937185` |
| Devices and configuration | `DeviceManagementManagedDevices.Read.All` | `314874da-47d6-4978-88dc-cf0d37f0bb82` |
| Devices and configuration | `DeviceManagementConfiguration.Read.All` | `f1493658-876a-4c87-8fa7-edb559b3476a` |
| Devices and configuration | `DeviceManagementServiceConfig.Read.All` | `8696daa5-bce5-4b2e-83f9-51b6defc4e1e` |
| Devices and configuration | `DeviceManagementScripts.Read.All` | `d32381d8-ee89-4220-9c83-b672aa68d404` |
| Devices and configuration | `DeviceManagementRBAC.Read.All` | `49f0cc30-024c-4dfd-ab3e-82e137ee5431` |
| Devices and configuration | `Device.Read.All` | `951183d1-1a61-466f-a6d1-1fde911bfd95` |
| Apps | `DeviceManagementApps.Read.All` | `4edf5f54-4666-44af-9de9-0144fb4b6e8c` |

### Entra

| Part | Permission | Permission ID |
| --- | --- | --- |
| Users and groups | `User.Read.All` | `a154be20-db9c-4678-8ab7-66f6cc099a59` |
| Users and groups | `GroupMember.Read.All` | `bc024368-1153-4739-b217-4326f2e966d0` |
| Users and groups | `Organization.Read.All` | `4908d5b9-3fb2-4b1e-9336-1888b7937185` |
| Devices | `Device.Read.All` | `951183d1-1a61-466f-a6d1-1fde911bfd95` |
| App registrations | `Application.Read.All` | `c79f8feb-a9db-4090-85f9-90d820caa0eb` |
| Roles and domains | `RoleManagement.Read.Directory` | `741c54c3-0c1e-44a1-818b-3f97ab4e8c83` |
| Roles and domains | `AdministrativeUnit.Read.All` | `3361d15d-be43-4de6-b441-3c746d05163d` |
| Roles and domains | `Domain.Read.All` | `2f9ee017-59c1-4f1d-9472-bd5529a7b311` |
| Conditional Access and policies | `Policy.Read.All` | `572fea84-0151-49b2-9301-11cb16974376` |
| Sign-in logs | `AuditLog.Read.All` | `e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20` |
| Sign-in logs | `IdentityRiskyUser.Read.All` | `d04bb851-cb7c-4146-97c7-ca3e71baf56c` |

### Defender

| Part | Permission | Permission ID |
| --- | --- | --- |
| Alerts and incidents | `SecurityAlert.Read.All` | `bc257fb8-46b4-4b15-8713-01e91bfbe4ea` |
| Alerts and incidents | `SecurityIncident.Read.All` | `b9abcc4f-94fc-4457-9141-d20ce80ec952` |
| Secure Score | `SecurityEvents.Read.All` | `64733abd-851e-478a-bffb-e47a14b18235` |

The sign-in permissions `openid`, `profile`, `offline_access` and `User.Read` are needed for every service. The setup script and the JSON snippet add them for you.

`Directory.Read.All` and write permissions are not part of any service. An agent that declares one asks for consent when it runs. If you pre-consent, the [Graph scope matrix](../generated/reference/graph-scope-matrix.md) shows which agent needs which run-time permission.

## Setup Script For A New Registration

If you cannot create app registrations yourself, choose **Your own app registration** in the connect dialog, then **Generate a setup script for your admin**. Select the services, enter a display name that follows your naming convention, and choose **Generate setup script**. Copy or save the script and the message for your Entra administrator.

The script uses the Microsoft Graph PowerShell SDK. It:

1. Explains each change in a comment block at the top.
2. Stops without changes if the modules it uses (`Microsoft.Graph.Authentication`, `Microsoft.Graph.Applications`, `Microsoft.Graph.Identity.SignIns`) are missing. `Install-Module Microsoft.Graph -Scope CurrentUser` installs them.
3. Signs in with `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All`, which the administrator running it must be able to use.
4. Stops without changes if an application with the same display name already exists.
5. Creates a single-tenant public client registration with the `http://localhost` redirect URI.
6. Adds the delegated Microsoft Graph permissions for the selected services plus the four sign-in permissions, looking up their permission IDs in the tenant at run time.
7. Creates the enterprise application and grants tenant-wide admin consent for the same permissions. A new enterprise application can take a few seconds to replicate, so the consent grant is retried up to 6 times, 5 seconds apart, when Entra reports it as not found yet. If either step still fails, it deletes the registration it created.
8. Prints the Application (client) ID and Directory (tenant) ID to enter in OpenAdminOS.

## Add A Service To An Existing Registration

Connections lists each service for the tenant as **Connected**, **Partial** or **Not connected**, with the parts that are on and the exact permissions that are missing. For a service that is not fully granted, choose **Add permissions**. The dialog lets you pick the missing parts and offers three actions: **Copy script**, **Copy JSON snippet** and **Check again**. The same dialog opens from the "not connected" notices on agent pages, in run reviews and on pages that need a service.

OpenAdminOS cannot change your registration itself. Use one of these:

### Script for an existing app

**Copy script** gives a PowerShell script for the registration's client ID. It:

1. Stops without changes if a required module is missing, or if no application with this client ID exists in the tenant.
2. Adds the delegated permissions for the selected parts, plus the four sign-in permissions, to the app's existing Microsoft Graph entry. Every permission the app already has, for every resource, is kept. Nothing is removed.
3. Creates the enterprise application if it does not exist yet.
4. Grants tenant-wide admin consent for the added permissions. An existing tenant-wide grant is extended with the new permissions, never reduced. A new grant is retried up to 6 times, 5 seconds apart, while a new enterprise application replicates.
5. Prints what changed, then tells you to return to OpenAdminOS and choose **Check again**.

It does not create a client secret or certificate, and it does not change redirect URIs or other settings.

### requiredResourceAccess JSON snippet

**Copy JSON snippet** gives a `requiredResourceAccess` entry for the app manifest in the Entra admin center, built from the permission IDs above. For Defender it looks like this:

```json
[
  {
    "resourceAppId": "00000003-0000-0000-c000-000000000000",
    "resourceAccess": [
      { "id": "37f7f235-527c-4136-accd-4a02d197296e", "type": "Scope" },
      { "id": "14dad69e-099b-42c9-810b-d002981feec1", "type": "Scope" },
      { "id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", "type": "Scope" },
      { "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d", "type": "Scope" },
      { "id": "bc257fb8-46b4-4b15-8713-01e91bfbe4ea", "type": "Scope" },
      { "id": "b9abcc4f-94fc-4457-9141-d20ce80ec952", "type": "Scope" },
      { "id": "64733abd-851e-478a-bffb-e47a14b18235", "type": "Scope" }
    ]
  }
]
```

- Merge these entries into the existing `requiredResourceAccess` array. Do not replace the array: entries it already has must stay.
- If the array already has an entry for `00000003-0000-0000-c000-000000000000` (Microsoft Graph), add the missing `resourceAccess` items to that entry instead of adding a second one.
- Admin consent is still required after you save the manifest. Grant it under **API permissions**, then choose **Check again** in OpenAdminOS.

## How OpenAdminOS Reads What Was Granted

With your own registration, sign-in requests `https://graph.microsoft.com/.default` and `offline_access`. Microsoft returns a token for the permissions the registration has been granted, which is how `.default` works ([The .default scope](https://learn.microsoft.com/entra/identity-platform/scopes-oidc#the-default-scope)).

OpenAdminOS records the Microsoft Graph permissions listed with the token. If Microsoft lists only `.default`, it reads the permissions from the access token's `scp` claim instead. The token is only decoded to read your own grants; it is not sent anywhere. Sign-in scopes and `.default` itself are never recorded as permissions.

A part is on when every one of its permissions was granted. A service is **Connected** when all of its parts are on, **Partial** when some are, and **Not connected** when none are. Chat, the cache and agents use only connected parts: a question or agent that needs a missing service names it and points to Connections instead of failing.

## Check Again

After an administrator adds permissions and grants admin consent, choose **Check again** in Connections or in the **Add permissions** dialog. OpenAdminOS asks Microsoft for a new token instead of using a cached one, and replaces the recorded permissions with what the new token carries. If the stored session cannot be used, it opens a browser sign-in.

If nothing changed, OpenAdminOS says "Microsoft returned no new permissions. Admin consent can take a minute to appear." Wait a minute and try again. If it still finds nothing, see [Consent and sign-in errors](../troubleshooting/consent-errors.md).

## Related

- [Connect with the shared app](connect-shared-app.md)
- [Roles](../guides/roles.md)
- [Authentication and permissions](../trust/authentication.md)
- [Consent and sign-in errors](../troubleshooting/consent-errors.md)
