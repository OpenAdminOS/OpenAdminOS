---
title: "Agent catalog"
description: "Catalog of OpenAdminOS agents and dashboards."
---


# Agent Catalog

This catalog lists the current OpenAdminOS agents and dashboards. Mode, scopes, tenant data access, and write behavior are taken from each agent's reviewed metadata.

Last updated: 2026-08-06 · `8cff22a`.

| Agent | Mode | Tier | Category | Required Entra tier | Scopes |
| --- | --- | --- | --- | --- | --- |
| [Compliance overview](agents/compliance-overview.md) | `read` | `dashboard` | `compliance` | `free` | `DeviceManagementManagedDevices.Read.All` |
| [Conditional Access explainer](agents/conditional-access-explainer.md) | `read` | `agent` | `policies` | `p1` | `Policy.Read.All` |
| [Dormant app registrations](agents/dormant-app-registrations.md) | `read` | `agent` | `apps` | `free` | `Application.Read.All` |
| [Find inactive devices](agents/find-inactive-devices.md) | `read` | `agent` | `devices` | `free` | `DeviceManagementManagedDevices.Read.All` |
| [Intune Device Posture Auditor](agents/intune-device-posture-auditor.md) | `read` | `agent` | `devices` | `free` | `DeviceManagementManagedDevices.Read.All` |
| [Offboarding agent](agents/offboarding-agent.md) | `write` | `agent` | `devices` | `free` | `DeviceManagementManagedDevices.Read.All`<br>`Device.Read.All`<br>`DeviceManagementManagedDevices.PrivilegedOperations.All` |
| [OS update posture](agents/os-update-posture.md) | `read` | `dashboard` | `updates` | `free` | `DeviceManagementManagedDevices.Read.All` |
| [Risky user triage](agents/risky-sign-in-triage.md) | `read` | `agent` | `policies` | `p2` | `IdentityRiskyUser.Read.All` |
| [Secure Score prioritizer](agents/secure-score-prioritizer.md) | `read` | `agent` | `policies` | `free` | `SecurityEvents.Read.All` |
| [Sign-in failure explainer](agents/sign-in-failure-explainer.md) | `read` | `agent` | `policies` | `p1` | `AuditLog.Read.All` |
| [Stale guest cleanup](agents/stale-guest-cleanup.md) | `write` | `agent` | `policies` | `p1` | `User.Read.All`<br>`AuditLog.Read.All`<br>`User.ReadWrite.All` |
| [Tenant change audit](agents/tenant-change-audit.md) | `read` | `agent` | `policies` | `p1` | `AuditLog.Read.All`<br>`Directory.Read.All` |
| [Tenant health report](agents/tenant-health-report.md) | `read` | `dashboard` | `compliance` | `free` | `DeviceManagementManagedDevices.Read.All` |
| [User license overview](agents/user-license-overview.md) | `read` | `dashboard` | `apps` | `free` | `User.Read.All` |
