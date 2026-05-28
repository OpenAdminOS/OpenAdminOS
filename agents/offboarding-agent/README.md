# Offboarding agent

Open-source replacement for Microsoft's retired Intune Device Offboarding Agent. Identifies stale devices across Intune last sync and Entra ID last sign-in, enriches the plan with ownership, compliance, OS, trust, and inactivity-day evidence, then offboards selected candidates via Intune retire after typed confirmation.

Unlike the Microsoft agent — which only produced a suggestion list and asked the admin to execute the retire manually elsewhere — this one actually performs the Intune retire. The admin still controls the gate: nothing happens until the exact confirmation phrase is typed.

## What it does

1. Reads `/deviceManagement/managedDevices` (Intune) and `/devices` (Entra) for the active tenant.
2. Correlates the two inventories by Intune `azureADDeviceId` ↔ Entra `deviceId`.
3. Selects candidates whose inactivity exceeds the threshold under the configured strategy.
4. Excludes devices already in flight (`retirePending`, `retireIssued`, `wipePending`, etc.).
5. Excludes personal/BYOD devices by default before a destructive plan is built.
6. Adds evidence: compliance state, ownership, enrollment type, OS/version, Entra trust type, account state, and Intune/Entra inactivity days.
7. Generates a plain-language rationale via the selected LLM, honoring any custom admin instructions.
8. Pauses for typed confirmation (`OFFBOARD N DEVICES`).
9. On confirm: issues `POST /deviceManagement/managedDevices/{id}/retire` for each candidate.

## What it does not do (yet)

- It does **not** disable the corresponding Entra device object. That requires `Device.ReadWrite.All` plus a second write step in the plan; the v0.1 runtime currently allows one write step per agent. Tracked for a follow-up.
- It does **not** remediate downstream systems (Microsoft Defender, Apple Business Manager). The rationale step lists what the admin should clean up next.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `staleDays` | `180` | Inactivity threshold in days. |
| `strategy` | `both` | `both` requires staleness on both Intune sync and Entra sign-in. `intune-only` and `entra-only` rely on one signal. |
| `excludePersonalDevices` | `true` | Drops Intune devices whose `managedDeviceOwnerType` is `personal` before the retire plan is built. |
| `instructions` | `""` | Free-text guidance fed to the rationale LLM step. Use this to encode org-specific rules. |

## Required Graph permissions

- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`
- `Device.Read.All` (Entra device records for correlation)

## Caveats

- Entra `approximateLastSignInDateTime` can lag up to ~14 days per Microsoft's documentation. The rationale step surfaces this when the strategy uses the Entra signal.
- `strategy: both` is the safest default. `entra-only` will miss Intune-only devices (no Entra record); `intune-only` will miss devices whose Intune agent stopped reporting but where the user still actively signs in.
- The default personal-device exclusion is conservative. Disable it only when your org deliberately wants BYOD records included in a retire plan.
