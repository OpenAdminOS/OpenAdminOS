---
title: "Roles"
description: "Least-privilege roles for reading each service through OpenAdminOS, and who can grant admin consent."
---

# Roles

OpenAdminOS uses delegated permissions only. Every Microsoft Graph call runs as the signed-in admin, and Microsoft allows it only when both the consented permission and the account's own roles allow it ([Microsoft Graph permissions overview](https://learn.microsoft.com/graph/permissions-overview)). Consent never adds rights. A user without an admin role cannot read admin data through OpenAdminOS, even after consent was granted for the tenant.

That gives two separate questions: who grants consent once, and which role the daily account needs.

## Who Can Grant Admin Consent

Every service scope needs admin consent. Grant it once per tenant, then sign in with a daily account that holds a read role.

| Role | Can grant consent for OpenAdminOS's delegated Graph scopes |
| --- | --- |
| Global Administrator | Yes. |
| Privileged Role Administrator | Yes, for any permission on any API. |
| Cloud Application Administrator | Yes. These roles can grant any permission except Microsoft Graph application permissions, and OpenAdminOS requests none. |
| Application Administrator | Yes, with the same exception. |

A custom role that includes the permission to grant tenant-wide consent also works. Source: [Grant tenant-wide admin consent to an application](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent).

With your own app registration, the administrator who runs the setup script needs to be able to use `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All`, because the script creates or updates the registration and grants consent in one go.

## Daily Read Roles By Service

Pick the narrowest role that covers the services you connected. Global Reader covers most of OpenAdminOS in one role.

### Intune

| Role | What it allows | Notes |
| --- | --- | --- |
| Read Only Operator (Intune role) | Views users, devices, enrollment, configuration and apps in Intune without changing them. | Assigned in the Intune admin center, not in Entra. Scope tags limit what it sees, in OpenAdminOS as in Intune. It includes the remote task to get FileVault keys. |
| Global Reader | Reads all Intune data and Intune audit data without changing anything. | Also covers most of Entra. |

Intune Administrator also reads everything, but it has global read and write across Intune and is a privileged role. Do not use it as a daily read role. Source: [Intune role-based access control](https://learn.microsoft.com/intune/fundamentals/role-based-access-control/overview) and [Intune built-in roles](https://learn.microsoft.com/intune/fundamentals/role-based-access-control/ref-built-in-roles).

### Entra

| Task | Least-privilege role | Also works |
| --- | --- | --- |
| Users, groups, devices, app registrations, roles, domains | Global Reader | |
| Conditional Access and related policies | Security Reader | Global Reader, Conditional Access Administrator |
| Sign-in logs | Reports Reader | Security Reader, Security Operator, Global Reader |
| Directory audit logs | Reports Reader | Security Reader, Security Administrator |
| Risky users | Security Reader | Global Reader, Security Operator |

Microsoft's Graph reference for listing directory audit logs does not name Global Reader. If an account with only Global Reader cannot read audit events, for example in Tenant change audit, add Reports Reader. Sources: [Least privileged roles by task](https://learn.microsoft.com/entra/identity/role-based-access-control/delegate-by-task), [List signIns](https://learn.microsoft.com/graph/api/signin-list), [List directoryAudits](https://learn.microsoft.com/graph/api/directoryaudit-list), [List Conditional Access policies](https://learn.microsoft.com/graph/api/conditionalaccessroot-list-policies), [List riskyUsers](https://learn.microsoft.com/graph/api/riskyuser-list).

### Defender

| Task | Least-privilege role | Also works |
| --- | --- | --- |
| Alerts and incidents | Security Reader | Global Reader, Security Operator |
| Secure Score | Security Reader | Security Operator |

Microsoft's pages disagree on whether Global Reader can read Secure Score, so use Security Reader for it. Sources: [List alerts_v2](https://learn.microsoft.com/graph/api/security-list-alerts_v2), [List incidents](https://learn.microsoft.com/graph/api/security-list-incidents), [Microsoft Secure Score](https://learn.microsoft.com/defender-xdr/microsoft-secure-score).

## A Common Setup

1. A Global Administrator or Privileged Role Administrator connects the tenant once and grants consent for the services the team uses.
2. Admins sign in with daily accounts that hold Global Reader, plus Security Reader when Defender is connected and Reports Reader when audit logs matter.
3. Intune teams with scope tags use an Intune Read Only Operator assignment with the right scope tags instead of Global Reader, so OpenAdminOS sees the same devices and policies they see in Intune.

Licences decide what data exists, separately from roles. Each service guide lists them: [Intune](../generated/services/intune.md), [Entra](../generated/services/entra.md), [Defender](../generated/services/defender.md).
