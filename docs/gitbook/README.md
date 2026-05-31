---
title: "OpenAdminOS documentation"
description: "Open-source, local-first agents for Microsoft 365 admins."
---

# OpenAdminOS

OpenAdminOS is an open-source desktop app for Microsoft 365 administrators who need to run reviewed agents against Intune and Entra tenants.

The app is local-first by default. Tenant data and prompts stay on the device when a local provider such as Ollama is selected. Hosted providers are available only with explicit provider selection and visible data-flow messaging.

## What OpenAdminOS Does

- Connects to a Microsoft 365 tenant through Microsoft sign-in and Graph consent.
- Runs manifest-declared agents from the OpenAdminOS registry.
- Uses a configured LLM provider for each agent run.
- Blocks every write operation behind a confirmation step.
- Keeps run history and configuration on the local machine.

## Current Scope

OpenAdminOS v0.2 focuses on Intune and Entra administrators. The current agent catalog includes investigators, advisors, dashboards, and cleanup agents built on Microsoft Graph.

Use the agent catalog when you need the authoritative list of agents, scopes, and write behavior.
