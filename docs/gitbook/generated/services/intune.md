---
title: "Intune"
description: "What the Intune service covers in OpenAdminOS, its permissions, roles and licences."
---


# Intune

Managed devices, compliance and configuration policies, apps, scripts and Autopilot.

Connecting Intune requests 10 delegated Microsoft Graph read scopes on top of the four sign-in scopes. Choose all of its parts or only some of them in the connect dialog, and add the rest later in Settings, Tenants. A part is on only when every one of its scopes is granted. With your own app registration, OpenAdminOS reads the granted permissions from the token and switches on each part that is fully granted; see [Own app registration](../../getting-started/own-app-registration.md).

## Parts And Permissions

### Users and groups

Users and groups that Intune assignments target, and the tenant licence profile.

| Scope | Reason | Consent |
| --- | --- | --- |
| `User.Read.All` | Reads users, their licence assignments, location and last sign-in, so assignments, owners and audit entries show names rather than object IDs. | Admin |
| `GroupMember.Read.All` | Reads groups and group membership, which policy, app and filter assignments target. | Admin |
| `Organization.Read.All` | Reads the tenant profile and /subscribedSkus so the status strip shows the Entra ID tier and licences, and agents that need P1 or P2 are badged. | Admin |

Chat questions this part answers:

- Which groups is this policy assigned to?
- Which devices belong to members of the Sales group?

### Devices and configuration

Managed devices, compliance and configuration policies, update rings, scripts, Autopilot and scope tags.

| Scope | Reason | Consent |
| --- | --- | --- |
| `DeviceManagementManagedDevices.Read.All` | Reads Intune enrolled devices, detected apps, troubleshooting events and fleet status. Used by Compliance overview, Find inactive devices, OS update posture, Tenant health report and Chat device questions. | Admin |
| `DeviceManagementConfiguration.Read.All` | Reads compliance policies, configuration profiles, settings catalog policies, update policies, endpoint security policies, assignment filters, administrative templates and encryption states. | Admin |
| `DeviceManagementServiceConfig.Read.All` | Reads Windows Autopilot devices, Autopilot deployment profiles and enrollment configurations. | Admin |
| `DeviceManagementScripts.Read.All` | Reads remediations and platform scripts so Chat can explain assignment, execution and reporting gaps. | Admin |
| `DeviceManagementRBAC.Read.All` | Reads Intune scope tags so Chat can explain policy visibility and scope tag targeting. | Admin |
| `Device.Read.All` | Reads Entra device objects for stale device checks, Autopilot matching and Intune versus Entra inventory comparisons. | Admin |

Chat questions this part answers:

- Which devices have not synced in 30 days?
- Why is this device noncompliant?
- Which configuration profiles are assigned to All devices?

### Apps

Intune app deployments, app protection and app configuration policies.

| Scope | Reason | Consent |
| --- | --- | --- |
| `DeviceManagementApps.Read.All` | Reads Intune apps, managed app policies, app protection policies and app configuration policies so Chat can answer deployment and mobile app protection questions. | Admin |

Chat questions this part answers:

- Which apps are required for all users?
- Which app protection policies apply to iOS?

## Run-Time Scopes

Agents may declare these. They are never requested when a tenant is connected, only when an agent that declares them runs. Writes always pause for diff confirmation.

| Scope | Reason |
| --- | --- |
| `DeviceManagementManagedDevices.ReadWrite.All` | Changes managed device properties. Requested only when a write agent that declares it runs. |
| `DeviceManagementManagedDevices.PrivilegedOperations.All` | Runs remote actions such as retire and wipe. Requested only when a write agent that declares it runs. |
| `DeviceManagementConfiguration.ReadWrite.All` | Changes compliance and configuration policies. Requested only when a write agent that declares it runs. |
| `DeviceManagementServiceConfig.ReadWrite.All` | Changes Autopilot and enrollment configuration. Requested only when a write agent that declares it runs. |
| `DeviceManagementScripts.ReadWrite.All` | Changes remediations and platform scripts. Requested only when a write agent that declares it runs. |
| `DeviceManagementRBAC.ReadWrite.All` | Changes Intune roles and scope tags. Requested only when a write agent that declares it runs. |
| `DeviceManagementApps.ReadWrite.All` | Changes Intune apps and app policies. Requested only when a write agent that declares it runs. |

## Roles

Delegated permissions never add rights: OpenAdminOS can only read what the signed-in account can read. These roles let the account read this service without permission to change it, or with the narrowest permission that covers it. See [Roles](../../guides/roles.md) for who can grant admin consent.

| Role | Why |
| --- | --- |
| Intune Administrator | Reads every Intune object, including devices, policies, apps and scripts. |
| Global Reader | Reads Intune and Entra configuration without permission to change it. |

## Licences

- Microsoft Intune Plan 1, included in Microsoft 365 E3, E5, F3, Business Premium and EMS E3 or E5.

## Agents

Agents in the registry that declare this service. An agent cannot run while a service it declares is not connected.

| Agent | Mode | Scopes |
| --- | --- | --- |
| [Compliance overview](../agents/compliance-overview.md) | `read` | `DeviceManagementManagedDevices.Read.All` |
| [Find inactive devices](../agents/find-inactive-devices.md) | `read` | `DeviceManagementManagedDevices.Read.All` |
| [Intune Device Posture Auditor](../agents/intune-device-posture-auditor.md) | `read` | `DeviceManagementManagedDevices.Read.All` |
| [Offboarding agent](../agents/offboarding-agent.md) | `write` | `DeviceManagementManagedDevices.Read.All`<br>`Device.Read.All`<br>`DeviceManagementManagedDevices.PrivilegedOperations.All` |
| [OS update posture](../agents/os-update-posture.md) | `read` | `DeviceManagementManagedDevices.Read.All` |
| [Team evidence review](../agents/team-evidence-review.md) | `read` | None |
| [Team PowerShell draft](../agents/team-script-draft.md) | `read` | None |
| [Tenant health report](../agents/tenant-health-report.md) | `read` | `DeviceManagementManagedDevices.Read.All` |

See also [Permissions by service](../reference/permissions-by-service.md).
