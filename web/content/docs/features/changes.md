---
title: "Changes and drift"
description: "How OpenAdminOS records tenant configuration drift over time."
---

# Changes And Drift

The Changes page is a tenant drift timeline. It shows how the active tenant's configuration has moved over time, computed from local cache snapshots taken as OpenAdminOS reads the tenant.

Changes is a top-level surface and is scoped to the active tenant. Switching tenants shows that tenant's own timeline.

## Snapshots And Diffs

OpenAdminOS keeps versioned configuration snapshots. Each new snapshot is compared field by field against the previous one, so the timeline shows exactly which fields changed rather than a vague "something changed" entry. Newest snapshot changes appear first.

The first snapshot for a tenant is a baseline reference point, not a list of additions. Later snapshots compare against that baseline to detect drift. Each entry carries audit attribution where the underlying Graph data provides it.

Snapshots are built from the local Graph cache, so the timeline reflects what OpenAdminOS has read, with each entry's snapshot id and freshness visible.

## Using Drift In Chat

The read-only `query_drift` tool lets [Intune Chat](intune-chat.md) answer questions about recorded changes without leaving the app. Like the rest of Chat, it is read-only and never writes back to the tenant.

## Evidence And Export

A drift diff can be split into tenant-scoped [Workspace](workspaces.md) evidence, keeping the snapshot id and freshness with the pinned entry. Individual entries export to a local Markdown record that includes the snapshot reference. Nothing is uploaded.

## Retention

Drift history is stored locally under configurable retention controls, alongside run-history retention in Settings. Pruning is local only and does not touch tenant configuration, chat history, or connector audit records.
