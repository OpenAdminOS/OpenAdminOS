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
| Default permissions | Read-only Microsoft Graph scopes, plus the standard `openid`, `profile`, and `offline_access` sign-in scopes. |
| Write permissions | None by default. Each write agent requests its own scope when it is installed or first run, with its own Microsoft consent screen. |
| Graph endpoint | `https://graph.microsoft.com/beta`. Tokens are sent only to Microsoft. |
| Token storage | MSAL token cache on the device, encrypted with the operating system's secure storage (Keychain on macOS, DPAPI on Windows, libsecret on Linux). |

## Effective Access

Permissions are delegated, so every Graph call runs as the signed-in admin. Microsoft grants a request only when both of these allow it:

1. The scopes consented for the OpenAdminOS application in the tenant.
2. The signed-in user's own roles.

An Intune administrator whose role is limited by scope tags sees the same limited set of devices and policies in OpenAdminOS as in the Intune admin center. A user without an Entra or Intune admin role cannot read admin data through OpenAdminOS, even after a Global Administrator has consented to the scopes.

## Which Application Signs In

There are two options.

### The OpenAdminOS application (default)

OpenAdminOS publishes a multi-tenant app registration with application (client) ID `d1de0a94-f67a-421d-8804-a235955ffd69`. The first sign-in in a tenant needs tenant-wide admin consent for the delegated read scopes. A Privileged Role Administrator, Cloud Application Administrator, or Application Administrator can grant it, as can a Global Administrator.

After consent, the tenant contains an **enterprise application** (service principal) named OpenAdminOS. The app registration itself stays in the OpenAdminOS publisher tenant. To review or revoke access, open Entra admin center, go to Enterprise applications, and select OpenAdminOS. Its sign-ins appear in the Entra sign-in logs under that name.

### Your organization's own app registration

Organizations that do not allow third-party multi-tenant applications can create their own registration and enter its client ID in the connect dialog:

1. In Entra admin center, create an app registration with supported account type **Accounts in this organizational directory only**.
2. Under Authentication, add the platform **Mobile and desktop applications** with redirect URI `http://localhost`, and enable **Allow public client flows**.
3. Under API permissions, add the delegated Microsoft Graph permissions listed in the [Graph scope matrix](../generated/reference/graph-scope-matrix.md) that you want to allow, then grant admin consent.
4. In OpenAdminOS, choose **Use your organization's app registration** and enter the application (client) ID and the directory (tenant) ID.

Do not create a client secret. OpenAdminOS signs in as a public client, so there is no secret to store on the device. Each custom registration gets its own token cache, separate from the default application's.

## Consent Prompts

The default read scopes are requested together at first sign-in, so Chat and the bundled read agents do not raise further consent prompts later. Microsoft's consent screen lists every scope. The connect dialog in OpenAdminOS shows the same list, grouped by area, with the reason each scope is needed, before the browser opens.

OpenAdminOS never widens scopes during a Chat answer. A request for data outside the consented scopes is refused by name instead of raising an unexpected consent prompt.

## Disconnecting And Revoking

Disconnecting a tenant in OpenAdminOS removes its account and tokens from the local cache and deletes its local run history and cached data. It does not remove the enterprise application or the consent from the tenant. To revoke access in the tenant, delete the OpenAdminOS enterprise application or remove its granted permissions in Entra admin center.

## Pilot Mode

Pilot mode runs on fictional data served from inside the app. It has no Microsoft sign-in, no tokens, and makes no calls to Microsoft Graph.

## Related

- [Local-first guarantee](local-first.md)
- [Hosted providers](hosted-providers.md)
- [Write confirmation](write-confirmation.md)
- [Graph scope matrix](../generated/reference/graph-scope-matrix.md)
