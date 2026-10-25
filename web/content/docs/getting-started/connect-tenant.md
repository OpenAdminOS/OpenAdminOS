---
title: "Connect a tenant"
description: "How OpenAdminOS connects to Microsoft 365 through Graph."
---

# Connect A Tenant

OpenAdminOS uses Microsoft sign-in and Microsoft Graph permissions to connect to a tenant. The active tenant is part of the run context, and no agent can start without it.

## Consent

The app requests read scopes needed by bundled read-only agents during tenant connection. Write scopes are intentionally separate and are requested only when an installed write agent needs them.

## Tenant Scope

Runs are pinned to the selected tenant when they start. If you switch tenants while a run is in progress, the run continues against the tenant it was started with.

## Recovery

If a token expires or consent is missing, OpenAdminOS shows a specific recovery path instead of allowing a silent failure.
