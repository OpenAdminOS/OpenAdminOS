# MSAL interactive auth + real Graph adapter (read path)

**Goal:** Replace the synthetic Graph fixture with real Microsoft Graph against a real tenant when the user has connected one. Authentication via `@azure/msal-node` `acquireTokenInteractive` against the public Microsoft Graph CLI client id (`14d82eec-204b-4c2f-b7e8-296a70dab67e`) — opens the system browser to `login.microsoftonline.com`, uses a loopback redirect, and never has the user copy a code anywhere. Token cache encrypted with Electron `safeStorage`. Synthetic mode remains the default when no tenant is connected so the showcase demo keeps working.

**Status:** Implemented (build green; manual sign-in verified against my tenant).

---

## Scope for this pass

- [x] Add `@azure/msal-node` to `@openagents/runtime`. No `keytar`; we use Electron's `safeStorage` (built into Electron, no native binding to maintain).
- [x] `@openagents/agent-sdk` adds `TenantRecord`, `RunDataSource = "graph" | "synthetic"`. IPC additions on `OpenAgentsApi`: `listTenants`, `connectTenant`, `setActiveTenant`, `disconnectTenant`. `AppState` gains `tenants: TenantRecord[]` and `activeTenantId?: string`. `RunRecord` gains `dataSource: RunDataSource` and `tenantId?: string`. `TrustState` gains `dataSource` and `tenantDisplayName?`.
- [x] `@openagents/runtime` ships:
  - A `createMsalClient({ storage })` factory wrapping `PublicClientApplication` with the well-known Microsoft Graph CLI client id and a `TokenCacheStorage`-backed cache plugin.
  - A `runInteractiveFlow({ client, openBrowser })` helper invoking `acquireTokenInteractive` with the system browser via the injected `openBrowser` callback and branded success/error templates.
  - `acquireTokenSilent` mapping `InteractionRequiredAuthError` to a clear "reconnect the tenant" message.
  - A `createGraphAdapter({ tokenProvider })` implementing `RunGraphApi.listManagedDevices` via raw `fetch`, with `@odata.nextLink` paging and 429 / 5xx retry honoring `Retry-After`.
- [x] Electron main:
  - `tokens.bin` file storing the `safeStorage`-encrypted MSAL serialized cache. Loaded on app start, written after each MSAL cache mutation.
  - `AppStateStore` gains tenant methods (`listTenants`, `connectTenant`, `setActiveTenant`, `disconnectTenant`), all serialized through the existing write chain. `connectTenant` invokes the interactive flow with `shell.openExternal` injected as the `openBrowser` callback.
  - `driveRun`/`driveApply` construct `ctx.graph` per run: real Graph adapter when `activeTenantId` is set and a token is available; otherwise `createSyntheticGraph()`. The chosen mode is stamped onto `RunRecord.dataSource`.
- [x] Renderer:
  - New "Tenants" section in Settings: list connected tenants, add (interactive sign-in), set active, disconnect. The connect button shows "Waiting for sign-in…" while the browser handles consent.
  - Status strip / sidebar shows the active tenant or "Synthetic data".
  - `/runs/:id` header pill labels the run as real-tenant or synthetic.
- [x] Trust messaging update: `deriveTrustState` factors in tenant context. Four valid states: local-LLM + synthetic, local-LLM + real-tenant, hosted-LLM + synthetic, hosted-LLM + real-tenant.
- [x] Renamed `electron/preload.ts` to `electron/preload.mts` so tsc emits `preload.mjs`. Electron 28+ accepts ESM preloads via the `.mjs` extension; the previous `preload.js` failed to load with `ERR_REQUIRE_ESM` and silently broke renderer IPC.
- [x] QA gate continues to pass; CI continues to pass.

## Out of scope for this pass

- Real Graph **writes** — `retire-inactive-devices` apply phase keeps emitting synthetic steps. Real `POST /retire` is a follow-up slice with its own burn-in.
- Per-user custom Entra app registration UI.
- Conditional Access compliance handling.
- Multi-account-per-tenant.
- Background inventory sync.
- Onboarding tenant step (Settings is enough for v0.1; onboarding integration is a follow-up).
- Sidebar dropdown tenant switcher, per-run tenant pinning, and Activity filtering — see follow-up slice.

## Acceptance criteria

- [x] `npm install`, `npm run typecheck`, `npm run qa`, `npm run build` all stay green.
- [x] Manual verification: completing the interactive sign-in persists a tenant record. Running `find-inactive-devices` afterward produces a `RunRecord` with `dataSource: "graph"` and real device IDs / names from the connected tenant.
- [x] Manual verification: with no tenant connected, `find-inactive-devices` still completes with `dataSource: "synthetic"` and the existing fixture results.
- [x] `retire-inactive-devices` apply path emits steps without making any Graph write calls.
- [x] Disconnecting a tenant removes its entries from the MSAL cache.
- [x] 401 from Graph triggers silent token refresh via MSAL; if refresh fails, the run lands `failed` with an actionable message including "reconnect the tenant".
- [x] 429 from Graph is retried up to 3 times respecting `Retry-After`.
- [x] Status strip / `/runs/:id` pill correctly reflect tenant context across all four trust combinations.
- [x] No secrets committed; `tokens.bin` is gitignored; client id is the public well-known CLI value.

## Review

- `@openagents/agent-sdk` gained `TenantRecord` and `RunDataSource`, plus new fields on `AppState` (`tenants`, `activeTenantId?`), `RunRecord` (`dataSource?`, `tenantId?`), and `TrustState` (`dataSource`, `tenantDisplayName?`). `OpenAgentsApi` exposes `listTenants`, `connectTenant`, `setActiveTenant`, `disconnectTenant`. `deriveTrustState` now factors in tenant context so the four quadrants (local-LLM × synthetic-or-real-tenant) all produce honest labels.
- `@openagents/runtime` ships:
  - `msal.ts` wrapping `@azure/msal-node` `PublicClientApplication` with the well-known Microsoft Graph CLI client id (`14d82eec-204b-4c2f-b7e8-296a70dab67e`). Exposes `createMsalClient`, `runInteractiveFlow`, `acquireTokenSilent`, `removeAccount`, plus a `TokenCacheStorage` interface and a `createCachePlugin` adapter. `runInteractiveFlow` invokes `acquireTokenInteractive` with the system browser via the injected `openBrowser` callback and renders branded success/error templates.
  - `graph-adapter.ts` implementing `RunGraphApi.listManagedDevices` via raw `fetch` with `@odata.nextLink` paging, 30 s per-request `AbortController` timeout, 429 / 5xx retry with `Retry-After` respect, and 401 mapped to a "tenant needs reconnect" error.
  - `ExecuteRunInput.graph?` so the host injects either the real adapter or the synthetic fixture.
- Electron:
  - New `secret-store.ts` wrapping `safeStorage` + a per-file ciphertext blob (mode 0o600). Replaces the `keytar` plan from SPEC; no native binding to rebuild per Electron version.
  - `AppStateStore` gained tenant state and methods serialized through the existing write chain. `buildGraph` returns the real adapter when an `activeTenantId` is set and a cached token is available, otherwise `createSyntheticGraph()`. Each run is stamped with `dataSource` and (when graph-backed) `tenantId` before progress events fire, so the renderer's polling sees the labeling for free.
  - `main.ts` constructs the secret store under `userData`/`tokens.bin`, passes `shell.openExternal` as the MSAL `openBrowser` callback, and registers the four new IPC handlers.
  - `preload.mts` (renamed from `preload.ts`) exposes the new methods. The `.mjs` output is what Electron 28+ requires for an ESM preload; the previous `preload.js` failed silently with `ERR_REQUIRE_ESM` and broke renderer IPC in dev.
- Renderer:
  - New Settings → Tenants section with connect / set-active / disconnect, error surface, and a helper line clarifying the sign-in opens in the system browser.
  - Sidebar tenant card swapped from hardcoded "No tenant connected" to the active tenant pulled from state (clicking routes into Settings).
  - `/runs/:id` header now shows a "Tenant: …" pill when `run.dataSource === "graph"` and a "Synthetic data" pill otherwise.
- Trust messaging: `deriveTrustState` now returns labels like "Local Ollama · synthetic data" and "Hosted OpenAI · real tenant contoso.onmicrosoft.com". `TrustState.tenantDisplayName` is set when a tenant is active.
- Verified: `npm install`, `npm run typecheck`, `npm run qa`, `npm run build` all stay green; QA still 12 pass / 1 warn / 0 fail. Manual sign-in confirmed end-to-end.

## Known follow-ups

- Real Graph **writes** (`POST /retire`) — apply phase still emits synthetic steps; needs its own burn-in slice with a feature flag.
- Onboarding "Connect tenant" step — Settings is enough for v0.1 but the onboarding flow could surface this earlier.
- Multi-tenant UX polish: sidebar dropdown switcher, per-run tenant pinning at `startRun`, Activity-page tenant filter chip.
- Multi-account-per-tenant and tenant-scoped run-history filtering.
