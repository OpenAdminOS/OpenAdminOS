---
title: "Connect a tenant"
description: "Choose how OpenAdminOS signs in to a Microsoft 365 tenant: the shared OpenAdminOS app or your own app registration."
---

# Connect A Tenant

OpenAdminOS connects to a Microsoft 365 tenant with Microsoft sign-in and delegated Microsoft Graph permissions. You connect services one at a time, starting with Intune, Entra and Defender. The active tenant is part of every run, and no agent can start without it.

The connect dialog starts with two equal choices. Neither is selected for you.

| Choice | Use it when | Guide |
| --- | --- | --- |
| **OpenAdminOS app** | Your organization allows the published multi-tenant app. You pick services and parts before Microsoft consent. | [Connect with the shared app](connect-shared-app.md) |
| **Your own app registration** | You want a tenant-owned registration. Its granted permissions decide which services are on. | [Own app registration](own-app-registration.md) |

Neither choice uses a client secret, and in both cases tokens are stored on your device only. Settings, Tenants and the tenant menu show which app each tenant is connected with.

## Tenant Scope

Runs are pinned to the selected tenant when they start. If you switch tenants while a run is in progress, the run continues against the tenant it was started with.

## When Sign-In Fails

Every sign-in error names the app that was used and the fix. [Consent and sign-in errors](../troubleshooting/consent-errors.md) lists the AADSTS codes OpenAdminOS recognises.
