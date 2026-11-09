---
title: "Authentication and permissions"
description: "How OpenAdminOS signs in to Microsoft 365, what it can read, and where tokens are kept. Written for security reviewers."
---

# Authentication And Permissions

This page describes how OpenAdminOS authenticates to a Microsoft 365 tenant. It is written for architects and security reviewers assessing the app.

## Summary

| Question | Answer |
|---|---|
| Client type | Public client (desktop app). No client secret or certificate exists or is accepted. |
| Sign-in flow | OAuth 2.0 Authorization Code with PKCE, through Microsoft Authentication Library (MSAL) for Node. |
| Where the user signs in | The system browser, on Microsoft's own sign-in page. OpenAdminOS never sees the password or MFA challenge. |
| Redirect | `http://localhost` loopback on a random free port. The listener accepts one response and closes on success, cancel, or a five-minute timeout. |
| Permission type | Delegated only. OpenAdminOS has no application permissions and cannot act without a signed-in admin. |
| Default permissions | The sign-in scopes `openid`, `profile`, `offline_access` and `User.Read`, plus read-only Microsoft Graph scopes for the services and parts you connect. Nothing else. |
| Write permissions | None by default. Each write agent requests its own scope when it runs, with its own Microsoft consent screen. |
| Graph endpoint | `https://graph.microsoft.com/beta`. Tokens are sent only to Microsoft. |
| Token storage | MSAL token cache on the device, encrypted with the operating system's secure storage (Keychain on macOS, DPAPI on Windows, libsecret on Linux). |

## Effective Access

Permissions are delegated, so every Graph call runs as the signed-in admin. Microsoft grants a request only when both of these allow it:

1. The scopes consented for the OpenAdminOS application in the tenant.
2. The signed-in user's own roles.

An Intune administrator whose role is limited by scope tags sees the same limited set of devices and policies in OpenAdminOS as in the Intune admin center. A user without an Entra or Intune admin role cannot read admin data through OpenAdminOS, even after a Global Administrator has consented to the scopes.

## Which Application Signs In

There are two options, offered as equal choices at the top of the connect dialog. Neither is preselected, and the admin must choose one before Approve is enabled. Connections and the organization menu show which one each tenant uses.

### The OpenAdminOS application (default)

OpenAdminOS publishes a multi-tenant app registration with application (client) ID `d1de0a94-f67a-421d-8804-a235955ffd69`. The first sign-in in a tenant needs tenant-wide admin consent for the delegated read scopes. A Privileged Role Administrator, Cloud Application Administrator, or Application Administrator can grant it, as can a Global Administrator.

After consent, the tenant contains an **enterprise application** (service principal) named OpenAdminOS. The app registration itself stays in the OpenAdminOS publisher tenant. To review or revoke access, open Entra admin center, go to Enterprise applications, and select OpenAdminOS. Its sign-ins appear in the Entra sign-in logs under that name.

### Your organization's own app registration

Organizations that do not allow third-party multi-tenant applications can create their own registration and enter its client ID in the connect dialog. It must be a public client with the platform **Mobile and desktop applications**, the redirect URI `http://localhost`, and **Allow public client flows** set to **Yes**. For a single-tenant registration, the directory (tenant) ID is entered too, so sign-in goes to that directory.

With an own registration, sign-in requests `https://graph.microsoft.com/.default` and `offline_access`. The token carries the delegated Microsoft Graph permissions the registration has been granted, and OpenAdminOS records those. If Microsoft lists only `.default` with the token, OpenAdminOS reads the permissions from the access token's `scp` claim; the token is decoded locally for that purpose only. **Check again** in Connections gets a new token after an administrator has added permissions.

OpenAdminOS cannot change the registration. For a missing service it shows the exact permissions, a PowerShell script that adds them to the existing app and extends its tenant-wide grant without removing anything, and a `requiredResourceAccess` JSON snippet to merge into the manifest. A separate script can create a new single-tenant registration for the selected services; it creates no secret and deletes the registration again if consent fails. [Own app registration](../getting-started/own-app-registration.md) describes both scripts step by step.

Do not create a client secret. OpenAdminOS signs in as a public client, so there is no secret to store on the device. Each custom registration gets its own token cache, separate from the default application's. Token refresh and scheduled Teams and Outlook delivery always use the registration the tenant was connected with.

After a successful connect, the client ID, directory ID, and an optional label are remembered in the local app state so the connect dialog can offer the registration again. These are public identifiers. They can be removed in Connections without affecting connected tenants.

## Services And Parts

OpenAdminOS connects Microsoft 365 by service: Intune, Entra and Defender today, with Exchange, Teams and SharePoint [planned](../services/planned.md). Each service is split into parts, and a part is the smallest set of scopes that can be granted on its own, for example Entra **Sign-in logs** (`AuditLog.Read.All`, `IdentityRiskyUser.Read.All`). One registry in the code defines every service, part, scope and the reason for it; the [Permissions by service](../generated/reference/permissions-by-service.md) reference is generated from it.

With the OpenAdminOS app, the connect dialog requires at least one service and nothing is preselected. Microsoft's consent screen lists the four sign-in scopes plus the scopes of the selected parts. Services share some scopes, such as `User.Read.All`; each is requested once. `Directory.Read.All` is not part of any service and is requested only when an agent that declares it runs.

OpenAdminOS records the scopes Microsoft returned in a token for each tenant, qualified with their audience (for example `graph:User.Read.All`), and nothing else. A part is on only when all of its scopes are granted. A service is connected when all its parts are on, partial when some are, and not connected when none are.

Chat and the cache only read from granted parts. A question that needs a service that is not connected is answered with its name, for example "Defender is not connected for this tenant. Add it in Connections.", without calling Microsoft Graph and without a consent prompt. Cache refreshes skip resources of services that are not connected. An agent cannot run while a service it declares is not connected. When a service is connected but a part or a run-time scope an agent needs is missing, starting the agent asks Microsoft for consent, and its run review says so first. Scheduled runs never open a sign-in. To add a service later, use **Add access** (OpenAdminOS app) or **Add permissions** and **Check again** (own registration) in Connections.

Chat and cache refreshes may ask you to sign in again when a session has expired, but only for scopes already granted.

## Disconnecting And Revoking

Disconnecting an organization in OpenAdminOS removes it at once and starts nothing new for it. Everything still working for it (running agents, cache refreshes, Chat, report deliveries, Nova and its Agent Team) is stopped, and nothing it was doing can still reach Microsoft or a connector, or save data, after that moment. OpenAdminOS then waits for that work to stop, removes the organization's account and tokens from the local cache and deletes its local data: the Graph cache and change history, run history and queued report deliveries, chats, workspaces and learning records, and Agent Team data. Multi-tenant chats and jobs that include the organization are deleted whole, including the results for the other organizations in them. Configuration audit entries are kept. The confirmation asks for an explicit check before anything is deleted.

If part of that cleanup cannot finish, for example because the sign-in or a local database cannot be changed, the organization stays removed and Connections shows **Disconnect cleanup pending** with the reason. Cleanup resumes the next time OpenAdminOS starts, before any background work, or when you choose **Retry cleanup**. The same organization can be connected again once its cleanup has finished.

Disconnecting does not change anything in the tenant. The app registration and the admin consent stay, and tokens that were already issued stay valid until they expire. How to revoke access depends on how the organization was connected.

### Revoking the OpenAdminOS app

The OpenAdminOS enterprise application (service principal) is shared by every OpenAdminOS user in the tenant. Deleting it, or removing its granted permissions, signs out every admin in the tenant who uses OpenAdminOS, not only you. To revoke access for everyone, open Entra admin center, go to Enterprise applications, select OpenAdminOS, and delete it or remove its permissions under Permissions. To end sessions that already have tokens, revoke the user's sessions in Entra admin center (Users, select the user, Revoke sessions) as well.

### Revoking your own app registration

An organization connected with your own app registration uses that registration, not the OpenAdminOS app. Open Entra admin center, go to Enterprise applications, select your registration by its name or application (client) ID, and remove the granted permissions or delete it. Delete the app registration itself under App registrations if nothing else uses it. Revoke the user's sessions as well to end tokens that were already issued.

## Pilot Mode

Pilot mode runs on fictional data served from inside the app. It has no Microsoft sign-in, no tokens, and makes no calls to Microsoft Graph.

## Related

- [Local-first guarantee](local-first.md)
- [Hosted providers](hosted-providers.md)
- [Write confirmation](write-confirmation.md)
- [Permissions by service](../generated/reference/permissions-by-service.md)
- [Roles](../guides/roles.md)
- [Graph scope matrix](../generated/reference/graph-scope-matrix.md)
