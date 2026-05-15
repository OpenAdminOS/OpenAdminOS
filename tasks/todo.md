# Multi-tenant UX

**Goal:** Polish the multi-tenant experience now that the MSAL read path is live. Users should be able to switch tenants from the sidebar in one click, pin a run to a specific tenant at start time, filter Activity by tenant, and notice when they're viewing a past run that executed against a different tenant than the one currently active.

**Status:** In progress.

---

## Scope for this pass

- [ ] **Sidebar tenant switcher dropdown.** Replace the sidebar tenant card's navigation-to-Settings behavior with a dropdown menu listing all connected tenants. Each row sets active inline. Includes a "Synthetic data" option (clears active), a footer "Manage tenants…" link routing to Settings → Tenants, and an empty-state "Connect tenant" CTA when none are connected. Closes on outside-click and Escape.
- [ ] **Per-run tenant pinning.** `startRun(slug, opts?: { tenantId?: string | null })` accepts an optional tenant override. The queued `RunRecord` is stamped with the chosen tenant id at queue time, and `driveRun` / `driveApply` read tenant from `run.tenantId` (passing `null` selects synthetic mode for this run regardless of active tenant). Closes the mid-run-switch race we had before.
- [ ] **Activity tenant filter.** A small chip row above the run table: "All tenants" / "Synthetic" / per connected tenant. Local component state; filters `state.runs` by stamped `tenantId` / `dataSource`. Count badge per chip.
- [ ] **`/runs/:id` drift label.** When the run's stamped `tenantId` doesn't match the current `activeTenantId`, surface a small inline note explaining the discrepancy.
- [ ] Typecheck, QA, and build stay green; CI passes.

## Out of scope for this pass

- Re-running a past run against a different tenant from `/runs/:id`.
- Run-against-all-connected-tenants scheduler.
- Tenant-scoped run history retention.
- Renaming / aliasing tenants in the UI.
- Tenant-aware sorting / grouping in the home page.

## Acceptance criteria

- [ ] `npm run typecheck`, `npm run qa`, `npm run build` all green; CI passes.
- [ ] Connect two tenants. Clicking the sidebar tenant card opens a dropdown with both tenants + Synthetic option. Selecting another tenant updates the active tenant inline (no Settings round-trip).
- [ ] After connecting a tenant, running `find-inactive-devices` stamps the run with that tenant id. If the user switches active tenants while the run is in-flight, the run still completes against the originally-pinned tenant (verified by the stamped `tenantId` not drifting and by inspecting the resulting `result` containing the original tenant's device IDs).
- [ ] Activity page shows a filter chip row. Selecting one tenant filters the table to that tenant's runs; counts on each chip update correctly. Synthetic-only filter shows only runs with `dataSource: "synthetic"`.
- [ ] On `/runs/:id`, viewing a past run whose `tenantId` differs from the current active tenant displays an inline "Active tenant differs from the one this run executed against" note (worded clearly, not alarming).
- [ ] No secrets committed.

## Review

(to fill in after implementation)
