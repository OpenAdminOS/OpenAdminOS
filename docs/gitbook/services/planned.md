---
title: "Planned services"
description: "Exchange, Teams, SharePoint and Jamf Pro are planned services. What that means today and why some of them need APIs beyond Microsoft Graph."
---

# Planned Services

OpenAdminOS connects Microsoft 365 one service at a time, starting with [Intune](../generated/services/intune.md), [Entra](../generated/services/entra.md) and [Defender](../generated/services/defender.md). Exchange, Teams and SharePoint are planned, and so is Jamf Pro, the first service outside Microsoft 365. There are no dates.

Planned means:

- The service is not listed in the connect dialog or in Settings.
- OpenAdminOS requests none of its permissions, and no agent can declare it.
- Chat does not answer questions about it from tenant data.

| Service | What it would cover |
| --- | --- |
| Exchange | Mailboxes, transport rules and mail flow. |
| Teams | Teams, channels and Teams policies. |
| SharePoint | Sites, sharing settings and storage. |

## Jamf Pro

Jamf Pro would cover computers, mobile devices, inventory, smart groups, policies and configuration profiles. It does not use Microsoft sign-in:

- You would create an API client in Jamf Pro under Settings, System, API roles and clients, and give its API role read privileges only.
- OpenAdminOS would store the client secret in the OS keychain, exchange it for a short-lived access token with OAuth client credentials, and send both only to your Jamf Pro URL.
- Each part would switch on only when a check proves the API role has the privileges it needs.
- Jamf Pro would belong to an organization alongside its Microsoft 365 tenant, or on its own when a company runs only Jamf.

## Why Some Of Them Need More Than Microsoft Graph

Intune, Entra and Defender are read entirely through Microsoft Graph, so one sign-in and one token audience cover them. Exchange, Teams and SharePoint are different: Microsoft Graph covers part of their data, and several admin settings are only available through the service's own admin APIs or PowerShell modules. Those APIs issue tokens for a different resource than Microsoft Graph, so they need their own consent and their own token.

The service registry already records the audience of every scope. Today every scope has the audience `graph`. When a planned service ships, its parts can add scopes for another audience without changing how Intune, Entra and Defender are stored or granted. Stored grants are qualified with their audience, for example `graph:User.Read.All`, for the same reason.

## What Stays The Same

When a planned Microsoft 365 service ships, it follows the same rules as the available ones:

- It is opt in, per tenant. Connecting one service never requests another service's permissions.
- Its permissions are delegated and read-only by default. Write agents request their write scopes when they run, and every write pauses for diff confirmation.
- With your own app registration, you add its permissions to the registration, grant admin consent, and choose **Check again**.

Jamf Pro does not use Microsoft sign-in or app registrations. It would be connected with a Jamf Pro API client, as described above, and its access would come from the privileges of that client's API role. Read-only by default and diff confirmation for every write apply to it as well.

## Related

- [Permissions by service](../generated/reference/permissions-by-service.md)
- [Authentication and permissions](../trust/authentication.md)
