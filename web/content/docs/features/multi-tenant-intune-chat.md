---
title: "Multi-tenant Intune Chat"
description: "Read-only investigations across more than one connected tenant."
---

# Multi-tenant Intune Chat

Multi-tenant Intune Chat is for read-only MSP-style investigations across connected tenants. The default chat scope remains the active tenant. When a prompt asks for all tenants, every connected tenant, selected tenants, or all customers, OpenAdminOS opens a scope review before it refreshes Graph cache data or builds a model prompt.

The scope review shows the resolved tenant list, selected tenant groups, planned Graph resources, cache freshness, provider and model, missing scopes, expired sessions, throttling warnings, and any tenant that will be skipped. Tenant groups are local shortcuts only; they expand into explicit tenant ids before the run starts.

## Saved queries

Saved queries prefill common read-only investigations, including Windows compliance, stale Windows devices, BitLocker gaps, risky sign-ins, and Conditional Access gaps. They do not silently broaden the scope. You can edit the prompt and must still review the selected tenants before running.

## Result artifacts

For Windows compliance prompts, OpenAdminOS computes tenant counts and device rows deterministically from the local Graph cache. The assistant summary explains the result, but the table and export are the source of truth.

The result artifact includes:

- Tenant readiness and progress.
- Summary counts for tenants, failed tenants, Windows devices, compliant devices, non-compliant devices, unknown devices, and stale data.
- Tenant comparison rows.
- Expandable device rows with tenant, device name, compliance state, OS, OS version, last sync, owner, and source freshness.
- Filters for tenant, readiness, compliance state, OS, and stale data.

One expired, throttled, or failed tenant does not fail the whole answer. Failed and skipped tenants stay visible in the result and in exported dossiers.

## Exports and Workspaces

Exports are explicit local file saves. Multi-tenant results can be exported as CSV, JSON, or a Markdown dossier containing the original query, resolved tenant scope, provider/model, freshness, skipped tenants, summary, and detail rows.

Multi-tenant results can also be split into Workspaces. This creates or links separate tenant-specific evidence entries. A single Workspace cannot contain mixed-tenant evidence.

## Hosted providers

With a local provider, tenant data, prompts, answer packs, and exports stay on the device. With a hosted provider, OpenAdminOS requires a fresh batch confirmation naming the selected tenants and provider before retrieved tenant context is sent to that provider.

Multi-tenant chat never performs Graph writes or connector delivery. Cross-tenant agent batches queue one normal tenant-pinned run per ready tenant. Write agents still require per-run plan review and typed confirmation; there is no confirm-all-tenants shortcut.
