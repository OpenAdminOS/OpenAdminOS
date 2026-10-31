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

## Schedule usage preview

In an agent's Schedule section, choose an interval to preview expected runs per
30 days before turning on Automatic runs. For an existing schedule, select an
interval and choose Save interval. Custom intervals update the preview as you
edit. The Schedules list also shows a compact forecast.

Usage estimates use the latest 20 completed runs for that agent, tenant, provider,
and selected model. The range runs from typical usage (median) to the 90th
percentile, scaled to 30 days. The preview shows its sample count. One run gives
equal bounds; more runs make the history more representative. Older runs without
complete usage remain readable but cannot supply an estimate. Run the agent once
with a provider that reports tokens to start collecting usage.

Local providers have no API charges. Subscription CLI providers show tokens and
subscription-limit guidance without currency. Per-token providers show a currency
estimate only when previous runs include provider-reported USD cost. Otherwise,
check the vendor's pricing. There is no built-in price table. Actual usage depends
on future data, provider settings, and computer availability; the forecast is not
a spending limit. History and forecasts stay on this device.

## Authoring And Sharing

Use Build your own Agent when you need a local agent that is not already in the catalog. The builder drafts a manifest, validates it, runs a preflight check, and saves it as a local user-authored agent.

User-authored agents can be shared with the community through a reviewed GitHub issue. Sharing does not publish the agent to Agent Hub. Maintainers decide whether it becomes part of the public registry.
