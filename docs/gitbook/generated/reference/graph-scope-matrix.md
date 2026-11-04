---
title: "Graph scope matrix"
description: "Microsoft Graph permission matrix for OpenAdminOS agents, grouped by service."
---


# Graph Scope Matrix

This reference shows which agents require each Microsoft Graph scope, grouped by service. A scope that two services share, such as `User.Read.All`, is listed under both. Run-time scopes are never requested when a tenant is connected; they are requested when an agent that declares them runs. See [Permissions by service](permissions-by-service.md) for the reason behind each scope.

## Intune

| Scope | Part | Agents |
| --- | --- | --- |
| `User.Read.All` | Users and groups | [Stale guest cleanup](../agents/stale-guest-cleanup.md)<br>[User license overview](../agents/user-license-overview.md) |
| `GroupMember.Read.All` | Users and groups | None |
| `Organization.Read.All` | Users and groups | None |
| `DeviceManagementManagedDevices.Read.All` | Devices and configuration | [Compliance overview](../agents/compliance-overview.md)<br>[Find inactive devices](../agents/find-inactive-devices.md)<br>[Intune Device Posture Auditor](../agents/intune-device-posture-auditor.md)<br>[Offboarding agent](../agents/offboarding-agent.md)<br>[OS update posture](../agents/os-update-posture.md)<br>[Tenant health report](../agents/tenant-health-report.md) |
| `DeviceManagementConfiguration.Read.All` | Devices and configuration | None |
| `DeviceManagementServiceConfig.Read.All` | Devices and configuration | None |
| `DeviceManagementScripts.Read.All` | Devices and configuration | None |
| `DeviceManagementRBAC.Read.All` | Devices and configuration | None |
| `Device.Read.All` | Devices and configuration | [Offboarding agent](../agents/offboarding-agent.md) |
| `DeviceManagementApps.Read.All` | Apps | None |
| `DeviceManagementManagedDevices.PrivilegedOperations.All` | Run time only | [Offboarding agent](../agents/offboarding-agent.md) |

## Entra

| Scope | Part | Agents |
| --- | --- | --- |
| `User.Read.All` | Users and groups | [Stale guest cleanup](../agents/stale-guest-cleanup.md)<br>[User license overview](../agents/user-license-overview.md) |
| `GroupMember.Read.All` | Users and groups | None |
| `Organization.Read.All` | Users and groups | None |
| `Device.Read.All` | Devices | [Offboarding agent](../agents/offboarding-agent.md) |
| `Application.Read.All` | App registrations | [Dormant app registrations](../agents/dormant-app-registrations.md) |
| `RoleManagement.Read.Directory` | Roles and domains | None |
| `AdministrativeUnit.Read.All` | Roles and domains | None |
| `Domain.Read.All` | Roles and domains | None |
| `Policy.Read.All` | Conditional Access and policies | [Conditional Access explainer](../agents/conditional-access-explainer.md) |
| `AuditLog.Read.All` | Sign-in logs | [Sign-in failure explainer](../agents/sign-in-failure-explainer.md)<br>[Stale guest cleanup](../agents/stale-guest-cleanup.md)<br>[Tenant change audit](../agents/tenant-change-audit.md) |
| `IdentityRiskyUser.Read.All` | Sign-in logs | [Risky user triage](../agents/risky-sign-in-triage.md) |
| `Directory.Read.All` | Run time only | [Tenant change audit](../agents/tenant-change-audit.md) |
| `User.ReadWrite.All` | Run time only | [Stale guest cleanup](../agents/stale-guest-cleanup.md) |

## Defender

| Scope | Part | Agents |
| --- | --- | --- |
| `SecurityAlert.Read.All` | Alerts and incidents | None |
| `SecurityIncident.Read.All` | Alerts and incidents | None |
| `SecurityEvents.Read.All` | Secure Score | [Secure Score prioritizer](../agents/secure-score-prioritizer.md) |
| `ThreatHunting.Read.All` | Advanced hunting (planned) | None |
