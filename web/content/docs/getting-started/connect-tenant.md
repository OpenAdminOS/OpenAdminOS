---
title: "Connect a tenant"
description: "How OpenAdminOS connects to Microsoft 365 through Graph."
---

# Connect A Tenant

OpenAdminOS uses Microsoft sign-in and Microsoft Graph permissions to connect to a tenant. The active tenant is part of the run context, and no agent can start without it.

## Consent

The app requests read scopes needed by bundled read-only agents during tenant connection. Write scopes are intentionally separate and are requested only when an installed write agent needs them.

## Choose Which App Signs In

The connect dialog starts with two equal choices, and neither is selected for you. **Approve** stays disabled until you choose one.

- **OpenAdminOS app**: the published multi-tenant app, client ID `d1de0a94-f67a-421d-8804-a235955ffd69`. It appears in your tenant's Enterprise applications and sign-in logs as OpenAdminOS. A Global Administrator consents once for the tenant.
- **Your own app registration**: an app your organization creates and owns, so no third-party multi-tenant app is added to the tenant. Sign-in logs show your app's name, and your Conditional Access and consent rules apply to it.

Neither choice uses a client secret, and in both cases tokens are stored on your device only. The read permissions are the same for both. Every way of connecting (the welcome screen, the tenant menu, Settings, Tenants, the pilot mode banner, and actions that need a tenant) opens the same dialog. The welcome screen's own registration link opens it with **Your own app registration** already chosen.

Settings, Tenants and the tenant menu show which app each tenant is connected with.

## Use Your Own App Registration

If your organization does not allow third-party multi-tenant apps, or you want a tenant-owned registration for Conditional Access targeting, sign-in monitoring, and consent governance, connect with your own registration.

1. In the Microsoft Entra admin center, go to **App registrations** and create a new registration. Single-tenant or multi-tenant both work.
2. Under **Authentication**, add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`.
3. Under **Authentication**, set **Allow public client flows** to **Yes**.
4. Under **API permissions**, add the delegated Microsoft Graph read permissions listed below (or only those for the permission areas your team needs), then grant admin consent. You can also skip this step and approve the permissions at first sign-in instead. The setup dialog always shows the current list with the reason for each scope.
5. In OpenAdminOS, start connecting a tenant, choose **Your own app registration**, and enter the **Application (client) ID**. Enter the **Directory (tenant) ID** only if the registration is single-tenant. An optional label helps you recognise the registration later.

If you cannot create app registrations yourself, the own-registration form can generate a PowerShell setup script for your Entra administrator. See [Authentication and permissions](../trust/authentication.md).

After a successful connect, OpenAdminOS remembers the registration on this device (client ID, directory ID, and label, never a secret). The next time you choose **Your own app registration**, the most recently used one is selected, and you can pick another or enter a new one. Remove saved registrations in Settings, Tenants. Removing one does not affect tenants already connected with it.

Delegated read permissions requested at sign-in:

- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementConfiguration.Read.All`
- `DeviceManagementApps.Read.All`
- `DeviceManagementServiceConfig.Read.All`
- `DeviceManagementScripts.Read.All`
- `DeviceManagementRBAC.Read.All`
- `Device.Read.All`
- `GroupMember.Read.All`
- `Organization.Read.All`
- `Directory.Read.All`
- `User.Read.All`
- `Policy.Read.All`
- `Application.Read.All`
- `AuditLog.Read.All`
- `IdentityRiskyUser.Read.All`
- `SecurityEvents.Read.All`
- `RoleManagement.Read.Directory`
- `AdministrativeUnit.Read.All`
- `Domain.Read.All`
- `SecurityAlert.Read.All`
- `SecurityIncident.Read.All`

Write agents request their write scopes when they first run. The [Graph scope matrix](../generated/reference/graph-scope-matrix.md) shows which agent needs which scope, so add those write permissions to your registration too if you pre-consent.

Do not create a client secret. OpenAdminOS is a public client that signs in with Authorization Code and PKCE, so it neither needs nor accepts a secret.

## Tenant Scope

Runs are pinned to the selected tenant when they start. If you switch tenants while a run is in progress, the run continues against the tenant it was started with.

## Recovery

If a token expires or consent is missing, OpenAdminOS shows a specific recovery path instead of allowing a silent failure. Sign-in errors name the app that was used, the OpenAdminOS app or your registration with its client ID, and the fix for the common setup mistakes with your own registration:

| Error | Fix |
|---|---|
| AADSTS50011 | Add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`. |
| AADSTS7000218 | Set **Allow public client flows** to **Yes**. |
| AADSTS700016 | The app was not found in the directory you signed in to. Check the Application (client) ID and, for a single-tenant app, the Directory (tenant) ID. |
| AADSTS50194 | The app is single-tenant. Enter its Directory (tenant) ID. |
| AADSTS65001 | Admin consent is missing. Grant admin consent under **API permissions**, or create a registration with the setup script. |

**Try again** retries with the same app. **Change sign-in options** returns to the choice with your entries kept, so you can correct a client ID or directory ID.
