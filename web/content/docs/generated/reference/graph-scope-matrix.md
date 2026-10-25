---
title: "Graph scope matrix"
description: "Microsoft Graph permission matrix for OpenAdminOS agents."
---


# Graph Scope Matrix

This reference shows which agents require each Microsoft Graph scope.

| Scope | Agents |
| --- | --- |
| `Application.Read.All` | [Dormant app registrations](../agents/dormant-app-registrations.md) |
| `AuditLog.Read.All` | [Sign-in failure explainer](../agents/sign-in-failure-explainer.md)<br>[Stale guest cleanup](../agents/stale-guest-cleanup.md)<br>[Tenant change audit](../agents/tenant-change-audit.md) |
| `Device.Read.All` | [Offboarding agent](../agents/offboarding-agent.md) |
| `DeviceManagementManagedDevices.PrivilegedOperations.All` | [Offboarding agent](../agents/offboarding-agent.md) |
| `DeviceManagementManagedDevices.Read.All` | [Compliance overview](../agents/compliance-overview.md)<br>[Find inactive devices](../agents/find-inactive-devices.md)<br>[Intune Device Posture Auditor](../agents/intune-device-posture-auditor.md)<br>[Offboarding agent](../agents/offboarding-agent.md)<br>[OS update posture](../agents/os-update-posture.md)<br>[Tenant health report](../agents/tenant-health-report.md) |
| `Directory.Read.All` | [Tenant change audit](../agents/tenant-change-audit.md) |
| `IdentityRiskyUser.Read.All` | [Risky user triage](../agents/risky-sign-in-triage.md) |
| `Policy.Read.All` | [Conditional Access explainer](../agents/conditional-access-explainer.md) |
| `SecurityEvents.Read.All` | [Secure Score prioritizer](../agents/secure-score-prioritizer.md) |
| `User.Read.All` | [Stale guest cleanup](../agents/stale-guest-cleanup.md)<br>[User license overview](../agents/user-license-overview.md) |
| `User.ReadWrite.All` | [Stale guest cleanup](../agents/stale-guest-cleanup.md) |
