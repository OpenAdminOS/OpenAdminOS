---
title: "Workspaces"
description: "Local, tenant-scoped containers for investigation evidence."
---

# Workspaces

Workspaces are local, tenant-scoped investigation containers. They keep pinned evidence, linked Intune Chat conversations, linked agent runs, notes, and workspace-local instructions together for one tenant problem.

Workspaces are not multi-tenant projects. A workspace belongs to one tenant. Multi-tenant Intune Chat results can be exported locally or split into separate tenant-specific workspace evidence, but one workspace cannot mix evidence from multiple tenants.

## What a Workspace Stores

A workspace can contain:

- Pinned evidence from Graph cache rows, chat answers, run results, or split multi-tenant results.
- Notes written by the admin.
- Links to existing chat conversations.
- Links to existing agent runs.
- Local instructions for explicit prompt/context composition.

Linked chats and runs are not copied into a second store. Deleting a workspace removes workspace metadata, notes, pins, and links only. It does not delete tenant configuration, chat history, run history, Graph cache, connector audit records, or self-training records.

## Evidence Freshness

Pinned evidence keeps source metadata when available: tenant, resource kind, refreshed time, row count, cache/live status, and source reference. This makes stale evidence visible instead of treating an old cache row as current.

## Local Instructions

Workspace instructions are local text scoped to the workspace tenant. They cannot add Graph scopes, change an agent from read to write, alter connector delivery, or bypass write confirmation.

Workspace context is explicit. OpenAdminOS shows selected evidence, notes, and instructions before they are attached to a prompt. If a hosted provider is active, the hosted-provider confirmation names the workspace, tenant, provider, model, and included context before anything is sent.

## Export and Deletion

Workspace export creates a local Markdown dossier with notes, linked context, pinned evidence metadata, run links, and freshness. It does not upload anything.

Archiving or deleting a workspace only changes local workspace records. The underlying chats, runs, tenant connection, Graph cache, and connector audit history remain intact.
