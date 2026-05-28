# Tenant change audit

Read-only investigator. Pulls the last 100 directory audit entries from
Microsoft Graph, tallies them by activity, category, result, and actor,
keeps a recent sample, and asks the LLM to separate the routine
baseline from entries that warrant a closer look.

## Why this earns its keep

A PowerShell script can dump the audit log and a dashboard can chart
it. Neither can tell you "in this tenant, a `Set delegated permission
grant` outside business hours is unusual." The LLM compares the
high-frequency activities (routine) to the long tail (potentially
interesting) and writes a two-paragraph readout an admin can read in
ninety seconds.

## Required Graph permissions

- `AuditLog.Read.All`
- `Directory.Read.All`

## Result shape

```jsonc
{
  "total": 100,
  "byActivity": { "Update user": 32, "Add member to group": 12, ... },
  "byCategory": { "UserManagement": 44, "GroupManagement": 21, ... },
  "byResult": { "success": 96, "failure": 4 },
  "byActor": { "admin@tenant.com": 18 },
  "recentSample": [{ "activityDisplayName": "Add app role assignment to service principal" }],
  "llmModel": "llama3.1:8b"
}
```

The `summary` field carries the LLM's two-paragraph readout. The
structured `data` block backs the per-activity table on the run result
page.

## How it stays honest

- The LLM is told never to invent counts; it only references the
  buckets handed to it by the transforms.
- When no LLM is configured, the run still completes and the structured
  counts are rendered without a narrative.
- Window size is fixed at 100 entries today — large tenants may want a
  scheduled variant that walks pages. A follow-up agent.
