# os-update-posture

A read-mode Agent Template in the `updates` category. Gives Intune
admins a fleet-wide breakdown of operating systems and OS versions so
end-of-life builds (Windows 10, older macOS majors) surface
immediately.

Ships as YAML only — no companion TypeScript. The pipeline lives
entirely in `manifest.yaml` and is interpreted by `@openagents/runtime`
at run time. This is the third canonical Agent Template and the
shape an NL2Agent draft should aim for: load the inventory, count
twice with `count-by-field`, optionally let the LLM polish a
recommendation.

## Pipeline

1. **Load managed device inventory** — `GET /deviceManagement/managedDevices`.
2. **Tally by operating system** — `count-by-field` on `operatingSystem` (Windows / macOS / iOS / Android).
3. **Tally by full OS version** — `count-by-field` on `osVersion` so specific builds like `10.21H2` show up distinctly.
4. **Summarise** *(optional, gated on `ctx.llm.available`)* — two-sentence executive summary with one prioritised recommendation. Always factual; never invents numbers.

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
  }
}
```

Summary string: `Fleet of 22 devices spans 4 operating systems and 12 distinct OS builds.`

## Scopes

- `DeviceManagementManagedDevices.Read.All` — required by step 1.
