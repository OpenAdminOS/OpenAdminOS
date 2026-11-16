# @openadminos/enterprise

The extension point where optional team features plug into the OpenAdminOS desktop app. This package is MIT and contains no paid code. A build from this repository uses the no-op default module and is the complete free app.

The package holds:

- the versioned interface between the app and a team features module (`src/interface.ts`),
- the host APIs a module receives (`src/host.ts`),
- the offline licence check (`src/licence.ts`),
- the no-op default module (`src/stub.ts`).

## Interface version 1

Version 1 is still open: no release has loaded a module yet. It may change until the first release that loads one, with `api/interface-v1.d.ts` updated in the same commit; from then on a change that is not compatible needs version 2.

A module's default export is an `EnterpriseModule`:

```ts
import type { EnterpriseModule } from "@openadminos/enterprise";

const module: EnterpriseModule = {
  interfaceVersion: 1,
  activate(host) {
    host.registerIpc("team.status", () => ({ joined: false }));
    host.setStatusContribution({ label: "Team service · Frankfurt · end-to-end encrypted" });
    return { deactivate: () => undefined };
  },
};
export default module;
```

`activate` is called once per launch, and only when the app holds a valid licence. Returning `undefined` keeps the module off; the host then removes anything it registered. A module whose `interfaceVersion` is not the version the app implements is not activated (`EnterpriseInterfaceVersionError`, logged), and the app keeps working without team features. The check reads the export, so the module has already been imported and its top-level code has run.

`EnterpriseHost` gives a module host APIs only:

| Member | What it does | Bounds |
| --- | --- | --- |
| `entitlement()` | The licence: licensee id, features, validity window and state (`active`, `grace`, `expired`), checked against the clock on each call | |
| `registerIpc(name, handler)` | Registers `openadminos-enterprise:<name>` for the renderer. The handler gets the validated input only, never the IPC event or window | Lower case names, up to four dot separated parts; 32 handlers; plain JSON input up to 64 KiB and 16 levels deep, replies up to 256 KiB |
| `registerSettingsSection(section)` | A section for Settings while the module is active, with an optional declarative `body` | 8 sections; title up to 60 and description up to 300 characters; a body as below |
| `updateSettingsSection(id, body)` | Replaces or clears the body of a registered section; the window draws it at once | A body as below |
| `registerUiAction(name, handler)` | Registers `openadminos-enterprise-ui:<name>` for buttons and schedule targets, in a registry of its own apart from `registerIpc`; the input is checked against the UI the window was given before the handler runs, and the reply before the window draws it | 32 UI actions; register an action before a body or targets name it |
| `setScheduleTargets(targets)` | Sets or clears where else an agent's schedule can run, with `current`, where each agent's schedule runs now; the agent schedule card offers them next to This computer | 8 targets, 500 agents in `current` |
| `setStatusContribution(status)` | What the status strip shows while team features are on. With no entry the strip says "Team features on" | Label up to 80 characters, one line |
| `storage` | Key value storage of plain JSON, kept in its own file apart from app state | 256 keys, 64 KiB per value, 1 MiB in all |
| `log` | Writes to the app log, prefixed with `enterprise module:` | 500 characters per message |
| `organizations.list()` | The organizations whose Microsoft 365 tenant is connected now: id, name and tenant id only | |
| `agents.readOnlyCatalog()` | Bundled read-only agents a sandbox can run: id, name, scopes and the SHA-256 of `manifest.yaml` | |
| `sandboxes` | `list`, `pair({ address, code, organizationId })`, `sync(id)`, `assign(id, entries)`, `unpair(id)` and `status(id)` for sandboxes paired with this desktop | Sandbox ids of up to 64 characters; address, code and organization id one line each; at most 50 assignment entries of `agentId` and a whole `intervalSeconds`; replies up to 256 KiB |

The sandbox calls answer `{ ok: true, value }` or `{ ok: false, error: { code, message } }` with a named code; a failure inside the app becomes `internal-error` and is logged. Malformed input throws `invalid-value`, and every call throws `disposed` or `expired` like `storage` once team features are off. Without the app's sandbox support (a host built without it) the calls answer `sandboxes-unavailable` and the lists are empty.

The keys and the verification stay in the public app: the desktop's device key and TLS client certificate are in the app's secret store, and the app pins the sandbox's TLS key, runs the pairing proof, verifies the signed pairing record, checks every audit batch with `verifySignedContinuation` from `@openadminos/pairing`, and signs schedule assignments. A run is attested only when the newest verified finished or rewritten event for it names the digest of the record as received. A sync reads at most 500 runs, 64 MiB of run records and 50 audit batches, saves its place page by page, and lists at most 20 problems and a count of the rest; the next sync goes on from there. Sandbox calls need the sandbox's organization connected, not active, and Disconnect stops them. Unpairing removes the pairing's verified audit rows from the desktop; imported runs keep their attestation. A module decides only when to call. No call crosses a token, key or secret, and nothing runs on a timer: without a call the app opens no connection to a sandbox.

### Declarative UI

Module UI reaches the window as data, never as code: the app's own renderer draws it with its design system, so no module code runs in the window. A body is an ordered list of at most 40 elements from a closed set:

| Element | Fields |
| --- | --- |
| `status` | `label`, `value`, `tone` (neutral, success, warning, danger) |
| `text` | `text`, a paragraph of up to 1000 characters |
| `notice` | `tone`, `title`, `message`, optional `recovery` |
| `field` | `id`, `label`, `kind` (`text`, or `code` for a monospace value such as an address), optional `placeholder`, `maxLength` (1 to 2000, default 200) and `value`. Fields never hold secrets |
| `select` | `id`, `label`, 1 to 50 `options` of `value` and `label`, optional `value` |
| `button` | `id`, `label`, `kind` (primary, secondary, danger), `action`, optional `confirm` with `title`, `message` and a `typedPhrase` of upper case words and digits the admin types exactly |
| `list` | up to 50 `rows` of `label` and an optional `status` of `value` and `tone` |

Any other type or field is refused (`invalid-value`). Text is plain text: control characters, invisible formatting characters (bidirectional overrides and isolates, zero-width characters, the byte order mark) and anything that looks like markup are refused, and nothing is drawn as a link. Text that uses This computer or one of the app's own trust phrases (`ENTERPRISE_UI_RESERVED_PHRASES`) is refused, in element text, section titles and descriptions and typed phrases, so a module cannot speak in the app's voice about where data goes. The match runs on normalized text (NFKC, format and ignorable characters removed, punctuation and symbols such as hyphens, dots, middle dots, slashes and underscores read as spaces, whitespace runs as one space, any case); format and ignorable characters, such as a soft hyphen or a word joiner, are refused outright. A look-alike from another script is not caught, which is why the app marks module UI as the module's. A danger button must have a `confirm`, and a danger notice must have a `recovery`. Labels are up to 80 characters, values up to 120, messages up to 500.

A button calls its `action` with `{ kind: "button", sectionId, buttonId, values, confirmedPhrase? }`, where `values` holds the section's field and select values by id. Before the handler runs the host checks that the button is in the section's current body and calls this action, that each value belongs to a field or select there and fits it (one line within `maxLength`, or one of the options), and that a button with a typed phrase carries it as `confirmedPhrase`. A schedule choice calls the targets' `action` with `{ kind: "schedule", agentId, targetId, intervalSeconds }`, for a target or for `this-computer`; the target must be offered for the agent and not disabled, and the interval is 60 seconds to 31 days. The handler returns `{ body?, notice? }`: a new body becomes the section's body in the host and the window draws it from there, and a notice is shown above it. Each body has a revision; a reply to a body that changed while the handler ran keeps the newer body and says so.

A schedule runs in one place, and the move is one step in the main process. The module's handler takes the choice and reports the new place in `current`; only when `current` then names the chosen place does the host turn the schedule on this computer off (moved away) or back on (moved back), in place, keeping its organization, interval and notification settings. A refusal, or a reply without that report, changes nothing on this computer and is answered with a danger notice that says so. If this computer cannot follow, the notice says the schedule runs in both places and how to fix it. Choosing This computer for an agent with no schedule here is refused before the module is asked, so its place stays. The host words its own notices with "here", so they pass the same text check as module text; the status strip label and detail pass it too. When `current` names another place while the schedule on this computer is on, for example after a restart, the card shows "Turned on here and on" that place with a button to turn the one here off, and the scheduler does not run it here until that is resolved. The card claims only what `current` and the schedule on this computer say; each place the module offers carries a Team features mark. A handler that throws, or a reply the app does not draw, is answered with a danger notice that gives the reason and the step that fixes it, and is logged; a reason that fails the text check is replaced with a plain one. `checkUiBody`, `checkUiReply`, `checkUiActionInput` and `checkScheduleTargets` are the checks the host runs.

The host object and every member are frozen. Nothing reachable from it exposes tenant tokens, provider credentials, the keychain or a secret store, and writes to a tenant still go through the app's diff confirmation. Graph calls and prompts stay on the admin's device.

This is a boundary by contract. The module runs in the app's main process, so code that ignored the interface could import app internals itself; the tests cover the host surface, not the process. Review of the module enforces the contract until the module runs in a separate process.

`src/interface.test.ts` fails on any change to the interface: a compile-time check that a version 1 module and host still type check, and a comparison of the emitted declarations against `api/interface-v1.d.ts`. A compatible change updates the snapshot in the same commit; an incompatible one raises `ENTERPRISE_INTERFACE_VERSION` and adds a new snapshot.

## Licence

A licence is a token signed with Ed25519 by the team service: `<payload>.<signature>`, both base64url without padding. The signature covers `openadminos-licence-v1.` followed by the payload segment. The payload is JSON with `v` (1), `licenseeId`, `features`, `notBefore`, `expiresAt` and `graceSeconds`, times in whole seconds since the Unix epoch. `verifyLicence` checks it against the public key built into the app, with no network call. A licence is honoured from `notBefore` until `expiresAt` plus the grace period; between `expiresAt` and the end of the grace period its state is `grace`.

The key in `LICENCE_PUBLIC_KEY_PEM` is a placeholder whose private key was discarded, so no licence verifies against it until the release key replaces it.

## How the app loads a module

The desktop main process (`apps/desktop/electron/enterprise.ts`) reads `<user data>/enterprise/licence.token` once per launch, after checking on the open file that it is a file of at most 8192 bytes.

- No licence, or a malformed, tampered, not yet valid or expired one: nothing else happens. No module is resolved or imported, and no IPC handler, listener, timer or socket is created. A refused licence is logged.
- A valid licence: the loader resolves `@openadminos/enterprise-module` from the app's node_modules. When it is not installed, which is every build from this repository, the no-op default module is used. When it is installed, its default export is checked and activated.

While the module is active, one unref'd timer checks the whole licence window (notBefore to the end of the grace period) against the clock at least every 15 minutes, and again when the device wakes from sleep, so a system clock moved past the end or back before the start is noticed within one step. When the window closes, the module's handlers are removed and the status strip changes at once, and then its `deactivate` runs, bounded to two seconds; IPC calls are refused as soon as the licence state is `expired`. The licence is also checked again just before `activate`, so a licence that lapsed while the module was imported does not activate it.

The status the renderer reads says why team features are off when that needs attention (a refused or unreadable licence, a licensed build without the module, another interface version, a load error or a failed start) with the step that fixes it. With no licence it says nothing.

Contributor builds and CI never install `@openadminos/enterprise-module` and need no private access. The official release job adds it as a dependency of `apps/desktop` before packaging, so it ships inside the signed app and stays dormant without a licence.
