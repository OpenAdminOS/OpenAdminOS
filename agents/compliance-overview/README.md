# compliance-overview

A read-mode Agent Template that gives Intune admins a one-shot snapshot
of compliance health across the tenant, including platform, ownership,
enrollment, and stale inventory caveats.

The agent ships as YAML only — there is no TypeScript companion. The
pipeline lives entirely in `manifest.yaml` and is interpreted by
`@openadminos/runtime` at run time.

## Pipeline

1. **Load managed device inventory** — `GET /deviceManagement/managedDevices` (one call, no paging knob).
2. **Count devices by compliance state** — the `count-by-field` transform tallies devices by `complianceState`. Buckets are pinned to `compliant` / `noncompliant` / `unknown` so the result shape is stable.
3. **Break down posture signals** — count by operating system, ownership, and enrollment type.
4. **Find stale inventory** — flag devices whose `lastSyncDateTime` is older than `staleSyncDays` (default 14).
5. **Summarise with LLM** — compact report with main finding, drift signals, and recommended next action.

## Result

```json
{
  "totalDevices": 22,
  "counts": { "compliant": 13, "noncompliant": 7, "unknown": 2 },
  "byOs": { "Windows": 15, "macOS": 4, "iOS": 3 },
  "byOwnerType": { "company": 18, "personal": 4 },
  "staleInventoryCount": 3,
  "llmSummary": "…",
  "llmModel": "llama3.1:8b"
}
```

Summary string: `7 of 22 managed devices are noncompliant (2 unknown).`

## Scopes

- `DeviceManagementManagedDevices.Read.All` — required by step 1.

## How to read the manifest

Open `manifest.yaml`. The shape is validated by
`schemas/agent-template.schema.json` and the YAML Language Server
directive at the top gives autocomplete + inline validation in any
editor that picks it up.
