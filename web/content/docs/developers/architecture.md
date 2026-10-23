---
title: "Architecture"
description: "High-level OpenAdminOS architecture."
---

# Architecture

OpenAdminOS is a TypeScript monorepo centered on an Electron desktop app.

## Main Areas

- `apps/desktop` contains Electron main, preload, and the Vite React renderer.
- `packages/runtime` runs agents, handles provider adapters, and talks to Graph through runtime abstractions.
- `packages/agent-sdk` exposes the agent and connector contracts used by community agents.
- `packages/qa-graph` validates agent manifests and Microsoft Graph usage.
- `packages/connector-*` implement the outbound connectors (Teams, Outlook, Slack, Discord, WhatsApp Web, Signal).
- `agents` contains the registry-backed agent manifests and documentation.
- `web` is the Next.js marketing site deployed to openadminos.com.
- `remotion` holds the pre-rendered marketing hero demo video project.
- `docs/gitbook` contains public documentation synced to GitBook.

## Boundaries

The desktop app is the only end-user surface. Scripts in the repo are contributor tooling, not a product CLI.

Tenant data is scoped to the active tenant session, and every run is pinned to a tenant before execution starts.
