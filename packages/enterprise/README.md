# @openadminos/enterprise

The extension point where optional team features plug into the OpenAdminOS desktop app. This package is MIT and contains no paid code. A build from this repository uses the no-op default module and is the complete free app.

The package holds:

- the versioned interface between the app and a team features module (`src/interface.ts`),
- the host APIs a module receives (`src/host.ts`),
- the offline licence check (`src/licence.ts`),
- the no-op default module (`src/stub.ts`).

## Interface version 1

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

`activate` is called once per launch, and only when the app holds a valid licence. Returning `undefined` keeps the module off; the host then removes anything it registered. The app refuses a module whose `interfaceVersion` is not the version it implements (`EnterpriseInterfaceVersionError`), logs it, and keeps working without team features.

`EnterpriseHost` gives a module host APIs only:

| Member | What it does | Bounds |
| --- | --- | --- |
| `entitlement()` | The licence: licensee id, features, validity window and state (`active`, `grace`, `expired`), checked against the clock on each call | |
| `registerIpc(name, handler)` | Registers `openadminos-enterprise:<name>` for the renderer. The handler gets the validated input only, never the IPC event or window | Lower case names, up to four dot separated parts; 32 handlers; plain JSON input up to 64 KiB and 16 levels deep, replies up to 256 KiB |
| `registerSettingsSection(section)` | A section for Settings while the module is active | 8 sections; title up to 60 and description up to 300 characters |
| `setStatusContribution(status)` | What the status strip shows while team features are on. With no entry the strip says "Team features on" | Label up to 80 characters, one line |
| `storage` | Key value storage of plain JSON, kept in its own file apart from app state | 256 keys, 64 KiB per value, 1 MiB in all |
| `log` | Writes to the app log, prefixed with `enterprise module:` | 500 characters per message |

The host object and every member are frozen. Nothing reachable from it exposes tenant tokens, provider credentials, the keychain or a secret store, and writes to a tenant still go through the app's diff confirmation. Graph calls and prompts stay on the admin's device.

`src/interface.test.ts` fails on any change to the interface: a compile-time check that a version 1 module and host still type check, and a comparison of the emitted declarations against `api/interface-v1.d.ts`. A compatible change updates the snapshot in the same commit; an incompatible one raises `ENTERPRISE_INTERFACE_VERSION` and adds a new snapshot.

## Licence

A licence is a token signed with Ed25519 by the team service: `<payload>.<signature>`, both base64url without padding. The signature covers `openadminos-licence-v1.` followed by the payload segment. The payload is JSON with `v` (1), `licenseeId`, `features`, `notBefore`, `expiresAt` and `graceSeconds`, times in whole seconds since the Unix epoch. `verifyLicence` checks it against the public key built into the app, with no network call. A licence is honoured from `notBefore` until `expiresAt` plus the grace period; between `expiresAt` and the end of the grace period its state is `grace`.

The key in `LICENCE_PUBLIC_KEY_PEM` is a placeholder whose private key was discarded, so no licence verifies against it until the release key replaces it.

## How the app loads a module

The desktop main process (`apps/desktop/electron/enterprise.ts`) reads `<user data>/enterprise/licence.token` once per launch.

- No licence, or a malformed, tampered, not yet valid or expired one: nothing else happens. No module is resolved or imported, and no IPC handler, listener, timer or socket is created. A refused licence is logged.
- A valid licence: the loader resolves `@openadminos/enterprise-module` from the app's node_modules. When it is not installed, which is every build from this repository, the no-op default module is used. When it is installed, its default export is checked and activated.

Contributor builds and CI never install `@openadminos/enterprise-module` and need no private access. The official release job adds it as a dependency of `apps/desktop` before packaging, so it ships inside the signed app and stays dormant without a licence.
