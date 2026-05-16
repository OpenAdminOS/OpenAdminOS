# compliance-overview

A read-mode Agent Template that gives Intune admins a one-shot snapshot
of compliance health across the tenant.

The agent ships as YAML only — there is no TypeScript companion. The
pipeline lives entirely in `manifest.yaml` and is interpreted by
`@openagents/runtime` at run time.

## Pipeline

1. **Load managed device inventory** — `GET /deviceManagement/managedDevices` (one call, no paging knob).
2. **Count devices by compliance state** — the `count-by-field` transform tallies devices by `complianceState`. Buckets are pinned to `compliant` / `noncompliant` / `unknown` so the result shape is stable even on tenants that happen to have zero of one state.
3. **Summarise with local LLM** *(optional, gated on `ctx.llm.available`)* — two-sentence executive summary plus one prioritised action. Skipped automatically when no LLM provider is configured.

## Result

```json
{
  "totalDevices": 22,
  "counts": { "compliant": 13, "noncompliant": 7, "unknown": 2 },
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
