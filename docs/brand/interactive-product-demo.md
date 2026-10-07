# Interactive product demo

The homepage product area is a scripted, in-memory simulation of the monochrome desktop app. The rest of the restored landing-page layout is unchanged.

## Interaction contract

- Eight sidebar areas: Chat, Agent Team, Agents, Changes, Cache, Settings, Workspaces, and Connectors.
- Chat opens on a completed device investigation with synthetic names and evidence. Device rows open details. The composer always identifies its response as scripted.
- Agents exposes Installed, Hub, Schedules, and Run history. Search filters the sample catalog; adding a hub item only updates in-memory demo state.
- The core journey is evidence, proposal, typed confirmation, then sample run history. Wrong or empty confirmation phrases cannot complete the simulation. Completion never claims a real retirement occurred.
- Agent Team supports a sample teammate. Settings switches the provider disclosure and the demo theme. Connector details explain desktop behavior without sign-in or delivery.
- Reloading the page clears all demo state. The app shell has no external demo label, walkthrough, or reset toolbar. There are no credentials, persisted records, provider requests, Graph operations, installations, or background jobs.
- Buttons, inputs, native disclosures, and native dialogs provide real keyboard interactions. Escape closes dialogs and returns focus. Reduced motion disables transitions. On small screens the navigation and tables scroll within the demo.
- With JavaScript disabled, the interactive shell is hidden and the existing desktop screenshot remains visible.

## Visual reference

Desktop screenshots in `docs/screenshots/app/brand-light-*.png` and `docs/mockups/22-monochrome-brand.html` provide the reference. Responsive HTML replaces test-run screenshot text and makes the controls usable without a screen-coordinate hotspot map.

- [Desktop demo](../screenshots/web/interactive-demo-desktop.png)
- [Mobile demo](../screenshots/web/interactive-demo-mobile.png)

## Verification

Run `npm --prefix web run typecheck` and `npm --prefix web run build`. Start the production site with `npm --prefix web run start -- --port 3017` and open `http://localhost:3017/#product-demo`.

Browser checks cover every sidebar area, catalog search and installation, teammate creation, local/hosted disclosure, dark appearance, valid and invalid confirmation, Escape/focus restoration, completion history, and the no-JavaScript fallback. Layouts were checked at 1280px and 375px. Reduced-motion styling was checked in an emulated reduced-motion context. The proposal-to-history journey made no fetch or XHR requests. Production browser checks reported no console errors.
