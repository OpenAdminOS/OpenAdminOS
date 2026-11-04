---
title: "Permissions by service"
description: "Every delegated Microsoft Graph permission OpenAdminOS requests, by service and part, with the reason and the consent it needs."
---


# Permissions By Service

This page is generated from the service registry in `packages/agent-sdk/src/services.ts`, the same source the app uses for the connect dialog, Settings and the setup script. Every permission is delegated: OpenAdminOS acts as the signed-in admin and can only read what that account can read.

Consent shows who can approve a permission. **Admin** means an administrator has to grant consent for the tenant before anyone can use it. **User** means a user can consent for themselves. Permission IDs are the delegated permission IDs on the Microsoft Graph service principal (app ID `00000003-0000-0000-c000-000000000000`). They are listed for the `requiredResourceAccess` manifest snippet; the setup script resolves them again at run time.

## Sign-in

With the OpenAdminOS app, every connection requests these four scopes plus the scopes of the parts you choose, and nothing else. With your own app registration, sign-in requests `https://graph.microsoft.com/.default` and `offline_access`, and the token carries whatever the registration has been granted.

| Scope | Reason | Consent | Permission ID |
| --- | --- | --- | --- |
| `openid` | Signs you in. | User | `37f7f235-527c-4136-accd-4a02d197296e` |
| `profile` | Shows your name and account on the connected tenant. | User | `14dad69e-099b-42c9-810b-d002981feec1` |
| `offline_access` | Keeps you signed in between sessions with a refresh token. | User | `7427e0e9-2fba-42fe-b0c0-848c9e6a8182` |
| `User.Read` | Reads your own profile to confirm which account signed in. | User | `e1fe6dd8-ba31-4d61-89e7-88639da4683d` |

## Intune

Managed devices, compliance and configuration policies, apps, scripts and Autopilot. [Intune guide](../services/intune.md).

| Part | Scope | Reason | Consent | Permission ID |
| --- | --- | --- | --- | --- |
| Users and groups | `User.Read.All` | Reads users, their licence assignments, location and last sign-in, so assignments, owners and audit entries show names rather than object IDs. | Admin | `a154be20-db9c-4678-8ab7-66f6cc099a59` |
| Users and groups | `GroupMember.Read.All` | Reads groups and group membership, which policy, app and filter assignments target. | Admin | `bc024368-1153-4739-b217-4326f2e966d0` |
| Users and groups | `Organization.Read.All` | Reads the tenant profile and /subscribedSkus so the status strip shows the Entra ID tier and licences, and agents that need P1 or P2 are badged. | Admin | `4908d5b9-3fb2-4b1e-9336-1888b7937185` |
| Devices and configuration | `DeviceManagementManagedDevices.Read.All` | Reads Intune enrolled devices, detected apps, troubleshooting events and fleet status. Used by Compliance overview, Find inactive devices, OS update posture, Tenant health report and Chat device questions. | Admin | `314874da-47d6-4978-88dc-cf0d37f0bb82` |
| Devices and configuration | `DeviceManagementConfiguration.Read.All` | Reads compliance policies, configuration profiles, settings catalog policies, update policies, endpoint security policies, assignment filters, administrative templates and encryption states. | Admin | `f1493658-876a-4c87-8fa7-edb559b3476a` |
| Devices and configuration | `DeviceManagementServiceConfig.Read.All` | Reads Windows Autopilot devices, Autopilot deployment profiles and enrollment configurations. | Admin | `8696daa5-bce5-4b2e-83f9-51b6defc4e1e` |
| Devices and configuration | `DeviceManagementScripts.Read.All` | Reads remediations and platform scripts so Chat can explain assignment, execution and reporting gaps. | Admin | `d32381d8-ee89-4220-9c83-b672aa68d404` |
| Devices and configuration | `DeviceManagementRBAC.Read.All` | Reads Intune scope tags so Chat can explain policy visibility and scope tag targeting. | Admin | `49f0cc30-024c-4dfd-ab3e-82e137ee5431` |
| Devices and configuration | `Device.Read.All` | Reads Entra device objects for stale device checks, Autopilot matching and Intune versus Entra inventory comparisons. | Admin | `951183d1-1a61-466f-a6d1-1fde911bfd95` |
| Apps | `DeviceManagementApps.Read.All` | Reads Intune apps, managed app policies, app protection policies and app configuration policies so Chat can answer deployment and mobile app protection questions. | Admin | `4edf5f54-4666-44af-9de9-0144fb4b6e8c` |

### Intune Run-Time Scopes

Never requested when a tenant is connected. An agent that declares one of these asks for consent when it runs, and a write still pauses for diff confirmation.

| Scope | Reason |
| --- | --- |
| `DeviceManagementManagedDevices.ReadWrite.All` | Changes managed device properties. Requested only when a write agent that declares it runs. |
| `DeviceManagementManagedDevices.PrivilegedOperations.All` | Runs remote actions such as retire and wipe. Requested only when a write agent that declares it runs. |
| `DeviceManagementConfiguration.ReadWrite.All` | Changes compliance and configuration policies. Requested only when a write agent that declares it runs. |
| `DeviceManagementServiceConfig.ReadWrite.All` | Changes Autopilot and enrollment configuration. Requested only when a write agent that declares it runs. |
| `DeviceManagementScripts.ReadWrite.All` | Changes remediations and platform scripts. Requested only when a write agent that declares it runs. |
| `DeviceManagementRBAC.ReadWrite.All` | Changes Intune roles and scope tags. Requested only when a write agent that declares it runs. |
| `DeviceManagementApps.ReadWrite.All` | Changes Intune apps and app policies. Requested only when a write agent that declares it runs. |

## Entra

Users, groups, app registrations, roles, Conditional Access, sign-in logs and risk signals. [Entra guide](../services/entra.md).

| Part | Scope | Reason | Consent | Permission ID |
| --- | --- | --- | --- | --- |
| Users and groups | `User.Read.All` | Reads users, their licence assignments, location and last sign-in, so assignments, owners and audit entries show names rather than object IDs. | Admin | `a154be20-db9c-4678-8ab7-66f6cc099a59` |
| Users and groups | `GroupMember.Read.All` | Reads groups and group membership, which policy, app and filter assignments target. | Admin | `bc024368-1153-4739-b217-4326f2e966d0` |
| Users and groups | `Organization.Read.All` | Reads the tenant profile and /subscribedSkus so the status strip shows the Entra ID tier and licences, and agents that need P1 or P2 are badged. | Admin | `4908d5b9-3fb2-4b1e-9336-1888b7937185` |
| Devices | `Device.Read.All` | Reads Entra device objects for stale device checks, Autopilot matching and Intune versus Entra inventory comparisons. | Admin | `951183d1-1a61-466f-a6d1-1fde911bfd95` |
| App registrations | `Application.Read.All` | Reads app registrations and service principals so Dormant app registrations can flag apps that are no longer used. | Admin | `c79f8feb-a9db-4090-85f9-90d820caa0eb` |
| Roles and domains | `RoleManagement.Read.Directory` | Reads Entra directory roles so Chat can answer which admin roles exist and how policies target privileged users. Role assignments are never changed. | Admin | `741c54c3-0c1e-44a1-818b-3f97ab4e8c83` |
| Roles and domains | `AdministrativeUnit.Read.All` | Reads administrative units so scoped administration questions use the tenant's actual delegation structure. | Admin | `3361d15d-be43-4de6-b441-3c746d05163d` |
| Roles and domains | `Domain.Read.All` | Reads verified domains and their authentication type so Chat can explain federation and domain configuration. | Admin | `2f9ee017-59c1-4f1d-9472-bd5529a7b311` |
| Conditional Access and policies | `Policy.Read.All` | Reads Conditional Access and related tenant policies so the Conditional access explainer can describe what is enforced and why. | Admin | `572fea84-0151-49b2-9301-11cb16974376` |
| Sign-in logs | `AuditLog.Read.All` | Reads sign-in logs and directory audit events. Used by Sign-in failure explainer, Tenant change audit and Stale guest cleanup. | Admin | `e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20` |
| Sign-in logs | `IdentityRiskyUser.Read.All` | Reads Entra ID Protection risky user signals so Risky sign-in triage can group and explain risk events. Returns data only on Entra ID P2. | Admin | `d04bb851-cb7c-4146-97c7-ca3e71baf56c` |

### Entra Run-Time Scopes

Never requested when a tenant is connected. An agent that declares one of these asks for consent when it runs, and a write still pauses for diff confirmation.

| Scope | Reason |
| --- | --- |
| `Directory.Read.All` | Reads broad directory data. Never requested at connect, only when an agent that declares it runs. |
| `User.ReadWrite.All` | Changes users. Requested only when a write agent that declares it runs. |
| `Group.Read.All` | Reads all groups and their properties. Older agents declare it where GroupMember.Read.All is enough. Requested only when an agent that declares it runs. |
| `Group.ReadWrite.All` | Changes groups. Requested only when a write agent that declares it runs. |
| `GroupMember.ReadWrite.All` | Changes group memberships. Requested only when a write agent that declares it runs. |
| `IdentityRiskyUser.ReadWrite.All` | Confirms or dismisses risky users. Requested only when a write agent that declares it runs. |
| `Directory.ReadWrite.All` | Changes directory objects. Requested only when a write agent that declares it runs. |
| `Application.ReadWrite.All` | Changes app registrations. Requested only when a write agent that declares it runs. |
| `RoleManagement.ReadWrite.Directory` | Changes directory role assignments. Requested only when a write agent that declares it runs. |
| `AdministrativeUnit.ReadWrite.All` | Changes administrative units. Requested only when a write agent that declares it runs. |
| `Domain.ReadWrite.All` | Changes domains. Requested only when a write agent that declares it runs. |
| `Policy.ReadWrite.ConditionalAccess` | Changes Conditional Access policies. Requested only when a write agent that declares it runs. |

## Defender

Microsoft Defender alerts and incidents, and Secure Score. [Defender guide](../services/defender.md).

| Part | Scope | Reason | Consent | Permission ID |
| --- | --- | --- | --- | --- |
| Alerts and incidents | `SecurityAlert.Read.All` | Reads Microsoft Defender alerts so Chat can summarize open alerts by severity and service. Triage actions are never taken. | Admin | `bc257fb8-46b4-4b15-8713-01e91bfbe4ea` |
| Alerts and incidents | `SecurityIncident.Read.All` | Reads Microsoft Defender incidents so Chat can report incident status, classification and assignment. Incidents are never changed. | Admin | `b9abcc4f-94fc-4457-9141-d20ce80ec952` |
| Secure Score | `SecurityEvents.Read.All` | Reads Microsoft Secure Score and its controls so the Secure score prioritizer can rank improvement actions by impact. | Admin | `64733abd-851e-478a-bffb-e47a14b18235` |
| Advanced hunting (planned, never requested) | `ThreatHunting.Read.All` | Runs read-only advanced hunting queries across Microsoft Defender data. | Admin | `b152eca8-ea73-4a48-8c98-1a6742673d99` |

### Defender Run-Time Scopes

Never requested when a tenant is connected. An agent that declares one of these asks for consent when it runs, and a write still pauses for diff confirmation.

| Scope | Reason |
| --- | --- |
| `SecurityEvents.ReadWrite.All` | Changes Secure Score control states. Requested only when a write agent that declares it runs. |
| `SecurityAlert.ReadWrite.All` | Updates Defender alerts, for example status and classification. Requested only when a write agent that declares it runs. |
| `SecurityIncident.ReadWrite.All` | Updates Defender incidents, for example status and assignment. Requested only when a write agent that declares it runs. |

## Planned Services

Exchange, Teams, SharePoint are planned and request nothing today. See [Planned services](../../services/planned.md).
