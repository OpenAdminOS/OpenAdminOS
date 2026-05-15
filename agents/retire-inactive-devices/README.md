# Retire inactive devices

Write-mode built-in agent. Companion to Find inactive devices. Retires Intune-managed devices that have not synced in 180 or more days, after typed diff confirmation.

## Required Graph permissions

- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`

## How it runs

1. `plan(ctx)` reads `managedDevices`, selects the retire band (>= 180 days inactive), and produces one `retire-device` action per candidate.
2. The runtime persists the plan and pauses the run at `awaiting-confirmation`.
3. The user must type the exact confirmation phrase (`RETIRE N DEVICES`, where N is the action count) on the `/runs/:id` surface to proceed.
4. `apply(ctx, plan)` emits one completed step per device. The synthetic Graph fixture is not mutated in this build.

## Action shape

```jsonc
{
  "id": "retire:<deviceId>",
  "kind": "retire-device",
  "label": "Retire <deviceName>",
  "description": "<upn> - <os> - last sync <N days ago>",
  "severity": "destructive",
  "metadata": {
    "deviceId": "<deviceId>",
    "deviceName": "<deviceName>",
    "userPrincipalName": "<upn>",
    "operatingSystem": "<os>",
    "lastSyncDateTime": "<iso>"
  }
}
```

## Result shape

```jsonc
{
  "retiredDeviceIds": ["d-019", "d-020", "d-021", "d-022"],
  "count": 4
}
```
