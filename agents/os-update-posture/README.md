# os-update-posture

A read-mode Agent Template in the `updates` category. Gives Intune
admins a fleet-wide breakdown of operating systems, OS versions,
compliance state, ownership, enrollment type, and stale inventory
signals so update work can be prioritized without overstating support
status.

Ships as YAML only — no companion TypeScript. The pipeline lives
entirely in `manifest.yaml` and is interpreted by `@openadminos/runtime`
at run time. This is a canonical Agent Template shape for posture
dashboards: load inventory, derive deterministic breakdowns, sample
the evidence, then let the LLM write a compact administrator report.

## Pipeline

1. **Load managed device inventory** — `GET /deviceManagement/managedDevices`.
2. **Tally by operating system** — `count-by-field` on `operatingSystem` (Windows / macOS / iOS / Android).
3. **Tally by full OS version** — `count-by-field` on `osVersion` so version concentrations and outliers show up distinctly.
4. **Tally compliance state** — `count-by-field` on `complianceState`.
5. **Group by ownership and enrollment** — `group-by-field` on `managedDeviceOwnerType` and `deviceEnrollmentType`.
6. **Find stale inventory** — `filter-by-age` on `lastSyncDateTime`, using the configurable `staleSyncDays` threshold.
7. **Sample evidence** — `sort-by` returns the oldest stale inventory records first.
8. **Summarise** — compact report with main finding, update posture signals, and recommended next actions. Always factual; never invents lifecycle status.

## Result

```json
{
  "totalDevices": 22,
  "byOs": { "Windows": 12, "macOS": 5, "iOS": 3, "Android": 1 },
  "byOsVersion": {
    "11.23H2": 6, "10.22H2": 3, "10.21H2": 2, "11.22H2": 1,
    "14.4": 2, "13.6": 1, "12.7": 1, "12.6": 1,
    "17.4": 1, "17.2": 1, "16.5": 1,
    "14": 1
  },
  "byCompliance": { "compliant": 14, "noncompliant": 6, "unknown": 2 },
  "staleInventoryCount": 4,
  "staleInventoryByOs": { "Windows": [{ "deviceName": "WIN-042" }], "macOS": [{ "deviceName": "MAC-007" }] }
}
```

Summary string: `Windows is the largest update target, with three older version clusters and four stale inventory records that should be refreshed before remediation planning.`

## Settings

- `staleSyncDays` — default `14`. Devices that have not synced for at least this many days are flagged as stale inventory.

## Scopes

- `DeviceManagementManagedDevices.Read.All` — required by step 1.
