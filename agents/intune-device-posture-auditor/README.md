# Intune Device Posture Auditor

Read-only built-in agent that demonstrates MXC-backed code execution. The
manifest declares the allowed Graph and LLM operations, then OpenAdminOS runs
`agent.mjs` inside an MXC sandbox with no direct tenant token, provider
credential, network, clipboard, or unrestricted filesystem access.

## What it checks

The auditor reads `/deviceManagement/managedDevices` and computes:

- Compliance counts by `complianceState`
- Platform, ownership, enrollment, and management-state breakdowns
- Devices that have not synced in 30, 60, and 90 days
- Devices missing a primary user
- Duplicate device names
- Oldest stale-sync samples for review

The script then asks the active host LLM to write a concise summary from those
computed metrics. The LLM call is brokered by OpenAdminOS; the sandboxed process
does not choose the model or receive provider credentials.

## Required Graph scopes

- `DeviceManagementManagedDevices.Read.All`

## MXC behavior

This agent only runs when the experimental MXC runner is enabled and available.
If MXC is disabled or the host probe fails, OpenAdminOS fails closed instead of
falling back to in-process script execution. Normal YAML Agent Templates are not
affected by this agent.

## Output shape

```json
{
  "llmSummary": "...",
  "llmModel": "llama3.1:8b",
  "totalDevices": 120,
  "compliance": {
    "compliant": 91,
    "noncompliant": 17,
    "unknown": 12
  },
  "staleSync": {
    "days30": 9,
    "days60": 4,
    "days90": 1
  },
  "missingPrimaryUser": {
    "count": 7
  },
  "duplicateNames": {
    "count": 2
  }
}
```

## Files

- `manifest.yaml` - permission manifest and MXC execution declaration.
- `agent.mjs` - sandboxed script entrypoint.
