---
title: "Agents"
description: "How OpenAdminOS agents are documented."
---

# Agents

OpenAdminOS agents are defined by repository manifests. The docs treat those manifests as the source of truth for mode, scopes, tenant data access, write behavior, model use, and settings.

The generated pages are rebuilt by `npm run docs:generate`.

## Documentation Rules

- Agent pages are generated from `agents/index.json` and `agents/*/manifest.yaml`.
- Public safety claims must come from structured manifest fields.
- Prose can explain behavior, but it must not contradict the manifest.
- New agents should not merge unless the generated docs are updated.

Start with the generated agent catalog for the current list.
