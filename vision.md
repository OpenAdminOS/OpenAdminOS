# OpenAdminOS Menu Bar Vision

Status: product vision for a macOS-only companion surface. This is not a
replacement for the full OpenAdminOS desktop app and not a second independent
product.

Implementation checkpoint: the first build uses the signed OpenAdminOS app
itself as the menu bar host through Electron Tray, a frameless `#/companion`
route, shared preload IPC, `--menu-bar` launch mode, and Settings controls.
Packaged macOS builds now generate and embed `OpenAdminOS Menu Bar Helper.app`
under `OpenAdminOS.app/Contents/Library/LoginItems`; Electron registers that
helper as the login item so it starts the main app in tray-only mode.

## Summary

OpenAdminOS should have a macOS menu bar companion that gives administrators a
fast operational view of the current tenant, cache freshness, scheduled agent
runs, recent failures, and lightweight Intune Chat prompts.

The companion should ship in the same macOS package as OpenAdminOS. The user
installs one OpenAdminOS app. The package may include a nested macOS login item
helper, but all tenant state, Graph access, LLM provider access, chat history,
run history, write confirmation, and scheduler state stay owned by the same
OpenAdminOS host runtime.

The guiding rule: the menu bar companion is a small control surface for the
same app, not a separate app with separate behavior.

## Why This Fits

OpenAdminOS is moving from "agent launcher" toward an operating surface for
Microsoft 365 administration. Intune Chat, scheduled cache refresh, scheduled
agent runs, OS notifications, and run history already create background state
that admins need to glance at without opening the full window.

A menu bar companion makes sense when it answers these questions quickly:

- Which tenant am I scoped to?
- Is OpenAdminOS using a local or hosted provider?
- Is the tenant cache fresh enough?
- What is running now?
- What is due next?
- Did the latest scheduled work fail or change?
- Can I ask a quick read-only Intune question?
- What needs the full app before it can continue?

It should not become a second full workspace. Deep investigation, write
confirmation, provider setup, tenant connection, agent installation, and long
chat review belong in the full desktop app.

## Product Boundaries

The companion must preserve the existing OpenAdminOS trust model.

- Local provider selected: tenant data, prompts, answer packs, chat history,
  cache rows, and run results remain on the device.
- Hosted provider selected: the UI must clearly state that retrieved tenant
  context will be sent to the hosted provider before generation.
- No agent run can start without an active tenant.
- Write agents still pause for diff confirmation every time.
- Destructive writes still require typed confirmation in the full app.
- The companion cannot approve write diffs.
- The companion cannot bypass hosted-provider confirmation.
- The companion cannot create a separate chat history or state store.
- Silent failures are still forbidden; every blocked state needs recovery copy.

The menu bar companion may show "Needs confirmation" and route the user to the
full OpenAdminOS window. It must not compress high-risk flows into a tiny
popover.

## UX Shape

### Menu Bar Icon

Use the OpenAdminOS app icon as the menu bar status item so the companion reads
as part of the same installed app. The status item should stay compact and
recognizable at menu bar size; if future state indicators are needed, they
should be subtle and must not obscure the prompt icon.

- Normal: idle and healthy.
- Busy: one or more chat requests, cache refreshes, or scheduled runs active.
- Attention: auth expired, provider unavailable, scheduler error, failed run,
  or write confirmation waiting.

Avoid noisy animation. This is an admin tool, not a notification toy.

### Popover Layout

The popover should be compact, dense, and dark, using the same production design
tokens as the desktop renderer. A good target is roughly 360-420 px wide and
520-640 px tall, with responsive height based on available screen space.

Top region:

- OpenAdminOS title and status.
- Active tenant name.
- Provider trust chip, for example `Ollama - local` or `OpenAI - hosted`.
- Cache freshness, for example `Intune cache refreshed 12m ago`.
- Scheduler state, for example `OS scheduler on - next wake 08:30`.

The popover should not behave like a second dashboard. Ask is the primary flow.
Schedules and activity should appear as compact secondary sections below the
prompt, and activity should be hidden entirely when there is no in-flight or
recent work to inspect.

### Ask View

The Ask view is a compact Intune Chat entry point.

Elements:

- Tenant/provider/freshness header stays visible.
- A small prompt composer with placeholder copy like `Ask about this tenant`.
- Send and Stop controls.
- Streaming answer preview.
- Source/freshness summary.
- Open in OpenAdminOS action.

Expected behavior:

- Prompt sends through the same Intune Chat service used by the full app.
- The answer streams in the popover when possible.
- The final assistant message is persisted to the same local chat conversation
  store.
- The user can open the full conversation in the desktop app.
- If the prompt maps to a write action, the companion refuses direct execution
  and offers to open the full app.
- If hosted-provider confirmation is required and not already remembered for
  the tenant/provider pair, the companion opens the full app confirmation flow.

The companion should not expose the full chat history rail. It may show the
current exchange and a small "Continue in app" action.

### Schedules View

The Schedules view is a glanceable queue.

Show:

- Next 3-5 scheduled agents.
- Due time.
- Read/write badge.
- Last outcome.
- Change state: new, changed, unchanged.
- Notification preference summary where useful.

Quick actions:

- Run due read schedules.
- Open Schedules.
- Open an individual agent.
- Open latest scheduled run.
- Refresh active tenant cache.

Write schedules can be listed and can be queued only if the normal write flow
will open in the full app before any change is made. The companion should make
that explicit.

### Activity View

The Activity view shows recent operational events.

Show:

- In-flight chat requests.
- In-flight agent runs.
- Latest scheduled run outcomes.
- Latest cache refresh outcome.
- Latest scheduler wake.
- Latest failure with recovery action.

Failures should use the same error taxonomy and recovery copy as the full app.
No generic "something went wrong" copy.

### Quick Actions

The companion can expose these actions:

- Open OpenAdminOS.
- Open Intune Chat.
- Open Schedules.
- Open Settings.
- Refresh active tenant cache.
- Run due read schedules.
- Reconnect tenant.
- Test provider connection.
- Open latest failed run.
- Open pending write confirmation.
- Quit menu bar companion.

Any action that changes tenant data, confirms hosted egress, installs agents, or
changes provider secrets should route to the full app.

## Architecture

### Single Package, macOS Only

The macOS distribution should remain one user-facing package:

- `OpenAdminOS.app`
- Optional nested helper at
  `OpenAdminOS.app/Contents/Library/LoginItems/OpenAdminOS Menu Bar Helper.app`

The helper exists only to participate in macOS Login Items and start the main
app in menu bar mode. It should not own product logic. It should be signed and
notarized with the main app bundle.

Use Apple's modern Service Management model for login items on macOS 13+:

- `SMAppService.loginItem(identifier:)`
- Helper bundle lives under `Contents/Library/LoginItems`
- Helper has `LSUIElement=true`

Reference:

- https://developer.apple.com/documentation/servicemanagement/smappservice
- https://developer.apple.com/documentation/servicemanagement/smappservice/loginitem%28identifier%3A%29

Settings should expose:

- `Show OpenAdminOS in the menu bar`
- `Start menu bar companion at login`

This should be unavailable on Windows and Linux until a separate tray design is
explicitly approved.

### One Runtime

The safest design is not two apps talking to two separate runtimes. The main
OpenAdminOS Electron process should own the runtime services in all modes:

- Tenant service
- Provider service
- Intune Chat service
- Graph cache service
- Agent run service
- Scheduler service
- Notification service
- Storage service

When launched with a menu bar flag, for example `--menu-bar`, the main process
should:

- Acquire the existing single-instance lock.
- Initialize the same host services.
- Create the macOS menu bar `Tray`.
- Create no full desktop window by default.
- Hide the Dock icon while only the menu bar companion is active.
- Create the full desktop window when the user chooses Open OpenAdminOS.

When the full app is launched while menu bar mode is already running, the
single-instance handler should focus or create the normal window in the same
process.

This avoids duplicate MSAL token use, duplicate SQLite connections, duplicate
scheduler logic, and mismatched chat behavior.

### Renderer Structure

Use the same renderer application and design system, but add a companion route
or entry point:

- Full app route: normal React Router app shell.
- Companion route: narrow menu bar popover shell.

The companion can run in a frameless `BrowserWindow` or equivalent popover
window anchored near the tray icon. It should use the same Tailwind tokens and
shared UI primitives as the full desktop app, with compact variants where
needed.

Do not create a separate web tree.

### Shared Host API

The companion should call the same typed preload/IPC bridge as the desktop
renderer. If the bridge grows, it should grow as shared contracts, not as
companion-only special cases.

The main process should expose a small read model for the companion:

```ts
type CompanionSnapshot = {
  activeTenant: {
    id: string;
    displayName: string;
  } | null;
  provider: {
    id: string;
    label: string;
    isLocal: boolean;
    trustLabel: string;
    model?: string;
  } | null;
  cache: {
    latestRefreshAt?: string;
    stale: boolean;
    refreshing: boolean;
    lastError?: string;
  };
  scheduler: {
    enabled: boolean;
    supported: boolean;
    nextWakeAt?: string;
    lastWakeAt?: string;
    lastError?: string;
  };
  inFlight: Array<{
    id: string;
    kind: "chat" | "run" | "cache-refresh";
    label: string;
    status: string;
  }>;
  upcomingSchedules: Array<{
    agentSlug: string;
    agentName: string;
    mode: "read" | "write";
    nextRunAt: string;
    lastStatus?: string;
    changeState?: "new" | "changed" | "unchanged";
  }>;
  attention: Array<{
    id: string;
    severity: "info" | "warning" | "danger";
    title: string;
    body: string;
    actionRoute?: string;
  }>;
};
```

Potential host methods:

```ts
type CompanionApi = {
  getCompanionSnapshot(): Promise<CompanionSnapshot>;
  subscribeCompanionSnapshot(
    listener: (snapshot: CompanionSnapshot) => void,
  ): () => void;
  submitCompanionChatPrompt(input: {
    tenantId: string;
    prompt: string;
    conversationId?: string;
    hostedProviderAcknowledgementId?: string;
  }): Promise<{ conversationId: string; messageId: string }>;
  stopCompanionChat(messageId: string): Promise<void>;
  refreshActiveTenantCache(): Promise<void>;
  runDueReadSchedules(): Promise<{ queued: number }>;
  openMainWindow(route?: string): Promise<void>;
};
```

These methods should be backed by existing services. For example,
`submitCompanionChatPrompt` must call the same Intune Chat pipeline that the
full chat page uses. It must not build prompts, retrieve Graph data, or invoke
providers through a parallel path.

### Shared Functions and Ownership

Shared logic should remain in the existing host/runtime packages and desktop
shared contracts.

Use existing shared services for:

- Tenant lookup and active tenant validation.
- Provider trust labels.
- Hosted-provider confirmation checks.
- Graph cache planning and refresh.
- Intune Chat persistence and streaming.
- Agent run preflight.
- Schedule due-time calculation.
- Notification and failure classification.
- Error recovery copy.

The companion may add a presentation-specific read model, but it should not
duplicate business rules.

Good rule of thumb: if the same answer would be wrong in the full app and the
menu bar companion, the logic belongs in the host service, not in React
components.

### Chat Flow From Menu Bar

1. User opens the menu bar popover.
2. Companion asks host for `CompanionSnapshot`.
3. User enters a prompt.
4. Renderer sends `submitCompanionChatPrompt`.
5. Host validates active tenant and provider.
6. If hosted egress confirmation is required, host rejects with a typed recovery
   state instructing the companion to open the full app confirmation.
7. Host runs the normal Intune Chat planner.
8. Host refreshes prompt-relevant Graph resources if needed.
9. Host builds the compact answer pack.
10. Host invokes the active LLM provider.
11. Host streams deltas through the existing chat event channel or a compatible
    scoped companion channel.
12. Host persists the final assistant message in the same SQLite chat store.
13. Companion shows the answer preview and source/freshness summary.
14. User can continue in the full app.

This keeps the companion prompt behavior identical to full Intune Chat.

### Scheduler Flow From Menu Bar

1. Host computes due schedules from installed agents and schedule state.
2. Companion displays the next due items from `CompanionSnapshot`.
3. User clicks Run due read schedules.
4. Host validates active tenant, provider, and scheduler state.
5. Host queues only read schedules from this shortcut.
6. Write schedules show "Needs confirmation" and route to full app if queued.
7. Run records are written to the same local run history.
8. Notifications and change-state detection use the existing scheduler/run
   services.

## Packaging and Signing

The signed macOS artifact should include everything needed:

- Main Electron app.
- Menu bar login helper, if needed.
- Apple Foundation helper, if present.
- Shared assets and renderer bundle.
- Entitlements needed for the main app and helpers.

The DMG and PKG should both install one user-facing OpenAdminOS app. The helper
should not appear as a second app in `/Applications`. It may appear in macOS
Login Items / Background Items with clear OpenAdminOS naming.

Release verification should include:

- Fresh install.
- Enable menu bar companion.
- Register login helper.
- Reboot or log out/in.
- Confirm the menu bar companion appears.
- Confirm full app opens from the companion.
- Confirm single-instance behavior.
- Confirm Intune Chat prompt works with local provider.
- Confirm hosted-provider prompt routes to confirmation when needed.
- Confirm scheduled state and cache refresh state are accurate.
- Confirm helper and main app are signed/notarized.

## MVP Scope

First useful version:

- macOS only.
- Menu bar icon.
- Compact popover.
- Active tenant/provider/cache/scheduler status.
- Ask view for read-only Intune Chat prompts.
- Streaming answer preview.
- Open full conversation in OpenAdminOS.
- Upcoming schedules list.
- Run due read schedules.
- Refresh active tenant cache.
- Attention states for auth, provider, scheduler, cache, and failed runs.
- Settings toggle for menu bar and login behavior.

Defer:

- Full chat history in the popover.
- Agent install/update flows.
- Write confirmation inside the popover.
- Hosted-provider first-use confirmation inside the popover.
- Multi-tenant management inside the popover.
- Windows/Linux tray equivalent.
- A separate standalone menu bar app distributed outside OpenAdminOS.

## Open Questions

- Final public name: "OpenAdminOS Menu Bar", "Companion", or just "Menu Bar".
- Whether the Ask view should create one dedicated "Menu Bar" conversation or a
  fresh conversation per prompt.
- Whether due write schedules can be queued from the companion if the full app
  opens immediately into confirmation.
- Whether the Dock icon should hide when OpenAdminOS is launched only in menu
  bar mode, and show again when the full window opens.
- Whether the helper is a tiny native login item or an Electron helper. Native
  is likely cleaner, but it adds a small Swift/Xcode-maintained target.

## Product Copy Direction

Use plain admin-facing copy.

Good examples:

- `Ask about this tenant`
- `Local provider - no tenant context leaves this device`
- `Hosted provider - tenant context is sent to OpenAI`
- `Write action requires the full confirmation flow`
- `Scheduler is off. Schedules run while OpenAdminOS is open.`
- `Cache refreshed 12m ago`
- `Open in OpenAdminOS`

Avoid:

- Hype language.
- Exclamation marks.
- "Smart", "magic", or "supercharge" framing.
- Generic failure copy.

## Decision

Proceed with the concept as a macOS-only bundled companion surface. The menu bar
companion can include a compact Intune Chat prompt interface, provided it calls
the same host-owned Intune Chat service and preserves all trust, tenant,
provider, and write-confirmation gates.
