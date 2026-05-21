# Find inactive devices

Read-only built-in agent that surfaces Intune-managed devices that have not synced recently and groups them into actionable inactivity bands.

## Required Graph permission

- `DeviceManagementManagedDevices.Read.All`

## Inactivity buckets

The agent reads `managedDevices` from the active tenant and assigns each device to a bucket based on days since `lastSyncDateTime`:

| Bucket   | Inactivity     | Suggested action |
| -------- | -------------- | ---------------- |
| Warn     | 30 to 89 days  | Schedule a check-in with the owner. |
| Stale    | 90 to 179 days | Contact owner before any cleanup action. |
| Retire   | 180+ days      | Review for retirement and reassignment. |

Devices that synced within the last 30 days are considered active and are excluded from the result.

## Result shape

```jsonc
{
  "totalDevices": 22,
  "totalInactive": 12,
  "buckets": {
    "warn":   [{ "id", "deviceName", "userPrincipalName", "operatingSystem", "lastSyncDateTime" }],
    "stale":  [...],
    "retire": [...]
  },
  "recommendations": ["..."],
  "thresholds": { "warnDays": 30, "staleDays": 90, "retireDays": 180 }
}
```

## How it runs today

The first runtime ships a synthetic `managedDevices` fixture inside `@openadminos/runtime`. The agent computes its result from that fixture deterministically; no Microsoft Graph or LLM call is made. The fixture will be swapped for a real Graph adapter when MSAL authentication lands.

## Files

- `manifest.json` — registry metadata used by the Agent Hub.
- `src/agent.ts` — the agent module, compiled to `dist/agent.js`.
- `tsconfig.json`, `package.json` — workspace package wiring.
