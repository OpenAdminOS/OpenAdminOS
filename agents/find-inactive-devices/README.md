# Find inactive devices

Read-only built-in agent that reviews Intune-managed device inactivity by last sync age, compliance state, operating system, ownership, enrollment type, and oldest-device evidence. It is intentionally review-first: stale sync is treated as an investigation signal, not automatic cleanup approval.

## Required Graph permission

- `DeviceManagementManagedDevices.Read.All`

## Inactivity buckets

The agent reads `managedDevices` from the active tenant and assigns each device to one bucket based on days since `lastSyncDateTime`:

| Bucket   | Inactivity     | Suggested action |
| -------- | -------------- | ---------------- |
| Warn     | 30 to 89 days  | Schedule a check-in with the owner. |
| Stale    | 90 to 179 days | Contact owner before any cleanup action. |
| Retire   | 180+ days      | Review for retirement and reassignment. |

Devices that synced within the warn threshold are considered active and are excluded from the inactive buckets.

## Additional signals

The report also includes:

- Compliance breakdown for stale and retirement-candidate devices.
- Warn-band operating system concentration.
- Retirement-candidate ownership breakdown where Graph provides `managedDeviceOwnerType`.
- Oldest retirement-candidate sample, sorted by `lastSyncDateTime`.
- Conservative LLM guidance on what to verify before cleanup.

## Result shape

```jsonc
{
  "totalDevices": 22,
  "inactiveCounts": { "warn": 4, "stale": 5, "retire": 3 },
  "buckets": {
    "warn":   [{ "id", "deviceName", "userPrincipalName", "operatingSystem", "lastSyncDateTime" }],
    "stale":  [...],
    "retire": [...]
  },
  "breakdowns": {
    "staleByCompliance": { "compliant": 2, "noncompliant": 1, "unknown": 2 },
    "retireByCompliance": { "compliant": 1, "noncompliant": 1, "unknown": 1 },
    "inactiveByOs": { "Windows": [...] },
    "retireByOwnerType": { "company": [...] }
  },
  "oldestRetireCandidates": [{ "deviceName", "lastSyncDateTime" }],
  "llmSummary": "...",
  "thresholds": { "warnDays": 30, "staleDays": 90, "retireDays": 180 }
}
```

## How it runs today

The desktop runtime calls Microsoft Graph through the active tenant session, runs deterministic transforms locally, and asks the selected LLM provider for the final short report.

## Files

- `manifest.yaml` — declarative agent pipeline interpreted by `@openadminos/runtime`.
