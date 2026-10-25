---
title: "Intune Chat"
description: "Ask read-only questions about a connected tenant and see exactly what ran."
---

# Intune Chat

Intune Chat is the front door for investigating a connected tenant in plain language. It answers read-only questions about Intune and Entra by making bounded Microsoft Graph calls against the active tenant, then explaining the result.

Chat is a top-level surface in OpenAdminOS. On first run, the Home checklist can hand a starter question straight into Chat so you get a real answer before installing anything.

## What Chat Can And Cannot Do

Chat is read-only. It never performs Graph writes and never triggers connector delivery. Questions that imply a change are answered as questions about current state, not carried out. To change tenant configuration you install and run a write agent, which still pauses for typed confirmation.

Every answer runs against the active tenant. If no tenant is connected, or the session is expired, Chat cannot start a run.

## Bounded Tool Calls

Chat works by calling a small set of read-only tools rather than free-forming Graph queries. Tool progress is streamed as the answer is built, and each run persists a "What ran" trace so you can see which tools were called and what they returned. When the model cannot produce a grounded answer, Chat falls back to a deterministic response instead of guessing.

Chat can also read the tenant drift timeline through the read-only `query_drift` tool. See [Changes and drift](changes.md) for how that history is recorded.

## Related Agents

When a question maps to an installed agent, Chat surfaces a conservative, locally matched hint pointing to that agent. The hint is deterministic keyword and synonym matching against your installed agents, shown as a dismissible card in the transcript. It never installs or runs anything on its own.

## Providers And Data Flow

Chat uses the active LLM provider. With a local provider, tenant data and prompts stay on the device. With a hosted provider, OpenAdminOS shows the hosted-provider data-flow message before tenant context is sent. See [Hosted providers](../trust/hosted-providers.md) and the LLM provider matrix.

For read-only investigations that span more than one connected tenant, see [Multi-tenant Intune Chat](multi-tenant-intune-chat.md).
