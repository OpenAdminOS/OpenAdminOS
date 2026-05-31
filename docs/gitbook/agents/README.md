---
title: "Agents"
description: "How OpenAdminOS agents are classified and reviewed."
---

# Agents

OpenAdminOS agents are reviewed units of automation for Microsoft 365 administration. Each agent declares what it reads, whether it can write, which Microsoft Graph scopes it needs, and which model behavior it expects.

The agent catalog is the fastest way to inspect what an agent can do before installing or running it.

## What To Check

- **Mode** tells you whether the agent is read-only or can prepare write operations.
- **Graph scopes** show the Microsoft permissions the agent may request.
- **Tenant data access** lists the Graph endpoints used by the agent.
- **Write behavior** lists the operation and confirmation requirement for write agents.
- **Required Entra tier** shows whether the tenant needs Entra ID Free, P1, or P2 features.

Start with the agent catalog for the current list.
