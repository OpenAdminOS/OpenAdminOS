---
title: "Entra"
description: "What the Entra service covers in OpenAdminOS, its permissions, roles and licences."
---


# Entra

Users, groups, app registrations, roles, Conditional Access, sign-in logs and risk signals.

Connecting Entra requests 11 delegated Microsoft Graph read scopes on top of the four sign-in scopes. Choose all of its parts or only some of them in the connect dialog, and add the rest later in Settings, Tenants. A part is on only when every one of its scopes is granted. With your own app registration, OpenAdminOS reads the granted permissions from the token and switches on each part that is fully granted; see [Own app registration](../../getting-started/own-app-registration.md).

## Parts And Permissions

### Users and groups

Users, guests, groups and the tenant licence profile.

| Scope | Reason | Consent |
| --- | --- | --- |
| `User.Read.All` | Reads users, their licence assignments, location and last sign-in, so assignments, owners and audit entries show names rather than object IDs. | Admin |
| `GroupMember.Read.All` | Reads groups and group membership, which policy, app and filter assignments target. | Admin |
| `Organization.Read.All` | Reads the tenant profile and /subscribedSkus so the status strip shows the Entra ID tier and licences, and agents that need P1 or P2 are badged. | Admin |

Chat questions this part answers:

- Which guests have not signed in for 90 days?
- Which users have no licence assigned?

### Devices

Entra device objects and their join type and activity.

| Scope | Reason | Consent |
| --- | --- | --- |
| `Device.Read.All` | Reads Entra device objects for stale device checks, Autopilot matching and Intune versus Entra inventory comparisons. | Admin |

Chat questions this part answers:

- Which Entra devices have been inactive for 90 days?

### App registrations

App registrations and enterprise applications.

| Scope | Reason | Consent |
| --- | --- | --- |
| `Application.Read.All` | Reads app registrations and service principals so Dormant app registrations can flag apps that are no longer used. | Admin |

Chat questions this part answers:

- Which app registrations have credentials that expire this month?

### Roles and domains

Directory roles, administrative units and verified domains.

| Scope | Reason | Consent |
| --- | --- | --- |
| `RoleManagement.Read.Directory` | Reads Entra directory roles so Chat can answer which admin roles exist and how policies target privileged users. Role assignments are never changed. | Admin |
| `AdministrativeUnit.Read.All` | Reads administrative units so scoped administration questions use the tenant's actual delegation structure. | Admin |
| `Domain.Read.All` | Reads verified domains and their authentication type so Chat can explain federation and domain configuration. | Admin |

Chat questions this part answers:

- Who holds the Global Administrator role?

### Conditional Access and policies

Conditional Access, named locations, authentication methods, authorization and cross-tenant access policies.

| Scope | Reason | Consent |
| --- | --- | --- |
| `Policy.Read.All` | Reads Conditional Access and related tenant policies so the Conditional access explainer can describe what is enforced and why. | Admin |

Chat questions this part answers:

- Which Conditional Access policies exclude break-glass accounts?

### Sign-in logs

Sign-in logs, directory audit logs and risky users.

| Scope | Reason | Consent |
| --- | --- | --- |
| `AuditLog.Read.All` | Reads sign-in logs and directory audit events. Used by Sign-in failure explainer, Tenant change audit and Stale guest cleanup. | Admin |
| `IdentityRiskyUser.Read.All` | Reads Entra ID Protection risky user signals so Risky sign-in triage can group and explain risk events. Returns data only on Entra ID P2. | Admin |

Chat questions this part answers:

- Why did this user's sign-in fail?
- What changed in the directory yesterday?

## Run-Time Scopes

Agents may declare these. They are never requested when a tenant is connected, only when an agent that declares them runs. Writes always pause for diff confirmation.

| Scope | Reason |
| --- | --- |
| `Directory.Read.All` | Reads broad directory data. Never requested at connect, only when an agent that declares it runs. |
| `User.ReadWrite.All` | Changes users. Requested only when a write agent that declares it runs. |
| `Group.ReadWrite.All` | Changes groups. Requested only when a write agent that declares it runs. |
| `Directory.ReadWrite.All` | Changes directory objects. Requested only when a write agent that declares it runs. |
| `Application.ReadWrite.All` | Changes app registrations. Requested only when a write agent that declares it runs. |
| `RoleManagement.ReadWrite.Directory` | Changes directory role assignments. Requested only when a write agent that declares it runs. |
| `AdministrativeUnit.ReadWrite.All` | Changes administrative units. Requested only when a write agent that declares it runs. |
| `Domain.ReadWrite.All` | Changes domains. Requested only when a write agent that declares it runs. |
| `Policy.ReadWrite.ConditionalAccess` | Changes Conditional Access policies. Requested only when a write agent that declares it runs. |

## Roles

Delegated permissions never add rights: OpenAdminOS can only read what the signed-in account can read. These roles let the account read this service without permission to change it, or with the narrowest permission that covers it. See [Roles](../../guides/roles.md) for who can grant admin consent.

| Role | Why |
| --- | --- |
| Global Reader | Reads users, groups, apps, roles and policies without permission to change them. |
| Security Reader | Reads sign-in logs, Conditional Access and risky users. |
| Reports Reader | Reads sign-in and audit logs. |

## Licences

- Microsoft Entra ID Free for users, groups, app registrations, roles and domains.
- Microsoft Entra ID P1 for sign-in logs and Conditional Access.
- Microsoft Entra ID P2 for risky users.

## Agents

Agents in the registry that declare this service. An agent cannot run while a service it declares is not connected.

| Agent | Mode | Scopes |
| --- | --- | --- |
| [Conditional Access explainer](../agents/conditional-access-explainer.md) | `read` | `Policy.Read.All` |
| [Dormant app registrations](../agents/dormant-app-registrations.md) | `read` | `Application.Read.All` |
| [Risky user triage](../agents/risky-sign-in-triage.md) | `read` | `IdentityRiskyUser.Read.All` |
| [Sign-in failure explainer](../agents/sign-in-failure-explainer.md) | `read` | `AuditLog.Read.All` |
| [Stale guest cleanup](../agents/stale-guest-cleanup.md) | `write` | `User.Read.All`<br>`AuditLog.Read.All`<br>`User.ReadWrite.All` |
| [Tenant change audit](../agents/tenant-change-audit.md) | `read` | `AuditLog.Read.All`<br>`Directory.Read.All` |
| [User license overview](../agents/user-license-overview.md) | `read` | `User.Read.All` |

See also [Permissions by service](../reference/permissions-by-service.md).
