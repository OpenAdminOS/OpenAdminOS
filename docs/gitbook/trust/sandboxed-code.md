---
title: "Sandboxed code"
description: "How OpenAdminOS treats experimental MXC-backed arbitrary-code execution."
---

# Sandboxed code

OpenAdminOS currently runs normal agents as reviewed YAML Agent Templates. Those agents do not require Microsoft eXecution Containers (MXC); they keep using the manifest interpreter, Microsoft Graph preflight, and write-confirmation gates.

MXC is reserved for future arbitrary-code agents. That path fails closed when MXC is disabled, unavailable, or failing its probe. OpenAdminOS does not fall back to running untrusted code in the Electron process.

Settings -> About shows the sandbox state:

- `Disabled` means `OPENADMINOS_EXPERIMENTAL_MXC=1` is not set. YAML agents still work.
- `MXC available` means the SDK probe reported a usable backend on this host.
- `Unavailable` means the SDK or host backend is missing or unsupported.
- `Probe error` means the MXC probe threw an error and sandboxed code stays disabled.

MXC protects the local machine from untrusted code. It is not the tenant trust boundary. Sandboxed code never receives MSAL tokens, keychain secrets, provider credentials, connector credentials, clipboard access, unrestricted filesystem access, or direct network access.

Future sandboxed agents must talk to the trusted host through the sandbox broker:

- `graph.request` for declared read-only Graph calls.
- `llm.complete` for host-mediated model calls.
- `connector.invoke` for declared connector capabilities.
- `write.plan` for proposed write plans that still require typed confirmation.
- `log` for run logs.

The host validates every request against the installed manifest and active tenant. Graph writes are not allowed directly from sandboxed code. Write agents can only return a write plan; OpenAdminOS applies approved writes through the existing confirmation flow.

Enterprise host preparation is owned by the administrator. On Windows, MXC may require `wxc-host-prep.exe` from the MXC SDK for AppContainer-tier preparation. OpenAdminOS reports this as remediation text, but it does not elevate itself or run host-prep automatically. Linux and macOS preparation is also external: install the SDK/native backend for the fleet, then check Settings -> About again.
