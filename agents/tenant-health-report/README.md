# tenant-health-report

A read-mode dashboard agent for scheduled or manual Intune health
updates. It reviews managed-device compliance, platform mix, ownership,
and stale inventory signals, then writes a compact report that can stay
local or be delivered through the app's per-agent Teams delivery rule.

This agent does not hard-code a Teams connector call. Delivery is a UI
setting on the installed agent, so the same report can be viewed only in
OpenAdminOS, sent to Teams after scheduled runs, or both.

## Pipeline

1. **Load managed device inventory** — `GET /deviceManagement/managedDevices`.
2. **Count compliance state** — compliant / noncompliant / unknown.
3. **Count operating systems and ownership** — platform and corporate/personal mix.
4. **Find stale inventory** — devices older than `staleSyncDays` (default 14).
5. **Summarise** — compact main finding, health signals, and next action.

## Result

```json
{
  "totalDevices": 22,
  "counts": { "compliant": 15, "noncompliant": 5, "unknown": 2 },
  "byOs": { "Windows": 17, "macOS": 3, "iOS": 2 },
  "byOwnerType": { "company": 19, "personal": 3 },
  "staleInventoryCount": 4,
  "llmSummary": "...",
  "llmModel": "llama3.1:8b"
}
```

## Scopes

- `DeviceManagementManagedDevices.Read.All`
