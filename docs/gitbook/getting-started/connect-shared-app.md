---
title: "Connect with the shared app"
description: "Connect a tenant with the published OpenAdminOS app, choose services and parts, and add services later."
---

# Connect With The Shared App

The OpenAdminOS app is a published multi-tenant app registration with client ID `d1de0a94-f67a-421d-8804-a235955ffd69`. After consent it appears in your tenant's Enterprise applications and sign-in logs as OpenAdminOS. If your organization does not allow third-party multi-tenant apps, use [your own app registration](own-app-registration.md) instead.

## Choose Services

1. Start connecting a tenant from the Connect Microsoft 365 step on first launch, Chat's not-connected card, the tenant menu, Settings, Tenants, or any action that needs a tenant. They all open the same dialog.
2. Choose **OpenAdminOS app**.
3. Under **Services**, select at least one of Intune, Entra and Defender. From Chat's not-connected card, the service and part the question needs are already selected; from anywhere else nothing is preselected.
4. Expand a service to review its parts, each exact Microsoft Graph scope, and why it is needed. Clear the parts your team should not read. A service checkbox shows a mixed state when only some of its parts are selected.
5. Choose **Approve N read scopes and continue to Microsoft**. Microsoft's consent screen then lists the sign-in scopes plus the scopes of the selected parts, and nothing else.

Services share some scopes. Intune and Entra both have a **Users and groups** part with the same three scopes, and Entra **Devices** uses `Device.Read.All`, which Intune **Devices and configuration** also requests. When the scopes of a part are already requested by another selected service, the part shows as checked and disabled with a line such as "Included with Intune", and each scope is requested once. The scope count on the button counts each scope once.

What each service and part reads is listed in the [Intune](../generated/services/intune.md), [Entra](../generated/services/entra.md) and [Defender](../generated/services/defender.md) guides and in [Permissions by service](../generated/reference/permissions-by-service.md).

## Admin Consent

Every service scope needs admin consent. An administrator who can grant tenant-wide consent approves once for the tenant; after that, admins with a daily read role use OpenAdminOS without consent prompts. [Roles](../guides/roles.md) lists which roles can grant consent and which roles are enough for daily use.

Consent does not add rights. Permissions are delegated, so OpenAdminOS can only read what the signed-in account can read.

## Add A Service Later

Settings, Tenants lists each service as **Connected**, **Partial** or **Not connected**. Choose **Add access** on a service, pick the parts, and choose **Continue to Microsoft**. Microsoft asks for consent to that service's scopes only, and they are added to the scopes the tenant already has. Your other services stay as they are.

The same dialog opens from the "not connected" notices on agent pages, in run reviews and on pages that need a service. Chat answers a question about a service that is not connected with its name, for example "Defender is not connected for this tenant. Add it in Settings, Tenants.", without calling Microsoft Graph.

## Agents And Run-Time Consent

An agent declares the services it needs. It cannot run while one of them is not connected; the run review names the service and offers **Add**. When a service is connected but an agent needs a part or a scope that was not granted, such as a write scope or `Directory.Read.All`, Microsoft asks for consent when the run starts, and the run review says so first. Scheduled runs never open a sign-in.

OpenAdminOS records only the scopes Microsoft actually returned in a token. A scope an agent declares is never marked as granted unless Microsoft granted it.

## Revoke

Disconnecting a tenant in OpenAdminOS removes its tokens and local data from this device. It does not remove the consent from the tenant. To revoke access, delete the OpenAdminOS enterprise application or remove its granted permissions in the Microsoft Entra admin center.

## Related

- [Own app registration](own-app-registration.md)
- [Authentication and permissions](../trust/authentication.md)
- [Consent and sign-in errors](../troubleshooting/consent-errors.md)
