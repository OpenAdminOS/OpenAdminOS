---
title: "Connect a tenant"
description: "How OpenAdminOS connects to Microsoft 365 through Graph."
---

# Connect A Tenant

OpenAdminOS uses Microsoft sign-in and Microsoft Graph permissions to connect to a tenant. The active tenant is part of the run context, and no agent can start without it.

## Consent

The app requests read scopes needed by bundled read-only agents during tenant connection. Write scopes are intentionally separate and are requested only when an installed write agent needs them.

## Use Your Own App Registration

By default, OpenAdminOS signs in with the OpenAdminOS multi-tenant app registration, and it appears by that name in your tenant's sign-in and audit logs. If your organization does not allow third-party multi-tenant apps, or you want a tenant-owned registration for Conditional Access targeting, sign-in monitoring, and consent governance, connect with your own registration instead.

1. In the Microsoft Entra admin center, go to **App registrations** and create a new registration. Single-tenant or multi-tenant both work.
2. Under **Authentication**, add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`.
3. Under **Authentication**, set **Allow public client flows** to **Yes**.
4. Under **API permissions**, add the delegated Microsoft Graph read permissions listed below, then grant admin consent. You can also skip this step and approve the permissions at first sign-in instead. The setup dialog always shows the current list with the reason for each scope.
5. In OpenAdminOS, start connecting a tenant, choose **Connect with your own app registration**, and enter the **Application (client) ID**. Enter the **Directory (tenant) ID** only if the registration is single-tenant.

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

If a token expires or consent is missing, OpenAdminOS shows a specific recovery path instead of allowing a silent failure.
