---
title: "Managed configuration"
description: "Roll out OpenAdminOS with a local policy file: which providers and public references are allowed, the default provider and model, a pre-seeded app registration, and locked settings."
---

# Managed Configuration

An IT team rolling OpenAdminOS out to many admins can set those choices once, in a policy file on each device, instead of every admin making them by hand on first launch. The policy can:

- allow only some AI providers, for example only local ones,
- set the provider and model,
- allow only some public references, or none,
- pre-seed your own Entra app registration for Microsoft 365 sign-in,
- skip the first-run model scan when the policy's provider is ready,
- lock any of these settings so they cannot be changed in the app.

Reading a policy file on one device is part of the free app. OpenAdminOS reads the file at launch and enforces it in the app's main process, not only in what the window shows: a provider or public reference the policy does not allow is refused for Chat, agents, schedules and provider tests even if something asks for it directly.

## Where the File Goes

OpenAdminOS reads two files. The machine file needs administrator rights to write and wins over the user file, key by key.

| OS | Machine file | User file |
| --- | --- | --- |
| macOS | `/Library/Application Support/OpenAdminOS/policy.json` | `~/Library/Application Support/OpenAdminOS/policy.json` |
| Windows | `%ProgramData%\OpenAdminOS\policy.json` | `%APPDATA%\OpenAdminOS\policy.json` |
| Linux | `/etc/openadminos/policy.json` | `~/.config/openadminos/policy.json` |

Deploy to the machine path for anything you need to enforce. The user file is writable by the signed-in user, so it suits defaults, not restrictions.

Changes to either file apply at the next launch of OpenAdminOS.

## Example

```json
{
  "$schema": "https://openadminos.com/schemas/policy/v1.schema.json",
  "version": 1,
  "allowedProviders": ["ollama", "lm-studio"],
  "defaultProvider": "ollama",
  "defaultModel": "llama3.1:8b",
  "allowedPublicReferences": ["microsoft-learn", "kql-search"],
  "appRegistration": {
    "clientId": "00000000-0000-0000-0000-000000000000",
    "tenantId": "contoso.onmicrosoft.com",
    "label": "Contoso OpenAdminOS"
  },
  "skipFirstRunScan": true,
  "lock": ["defaultProvider", "defaultModel", "appRegistration"]
}
```

With this file, only Ollama and LM Studio are offered anywhere in the app, Ollama with `llama3.1:8b` is set and cannot be changed, Chat can use Microsoft Learn and KQL Search but no other public reference, and Microsoft 365 sign-in uses only the Contoso registration.

The JSON Schema is in the repository at [`schemas/policy.schema.json`](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/schemas/policy.schema.json). Editors such as VS Code validate and complete the file when it names the schema in `$schema`.

## Keys

| Key | Value | What it does |
| --- | --- | --- |
| `version` | `1` | Optional. The policy format. Version 1 is the only one. |
| `allowedProviders` | List of provider ids | Only these providers are offered or selectable: in the first-run scan, Chat, Settings and the Run with menu. Any other provider is refused in the main process. |
| `defaultProvider` | Provider id | The provider to use. Must be in `allowedProviders` when both are set. |
| `defaultModel` | Model name | The model of `defaultProvider`, as the provider names it (for example `llama3.1:8b` in Ollama). Requires `defaultProvider`. |
| `allowedPublicReferences` | List of public reference ids | Only these public references are shown in the Marketplace and used by Chat. An empty list `[]` allows none. Any other one is refused before anything is sent. |
| `appRegistration` | Object with `clientId`, optional `tenantId` and `label` | Your own Entra app registration, added to the saved registrations. `tenantId` is the Directory (tenant) ID or a verified domain, required for a single-tenant app. See [Own app registration](own-app-registration.md) for how to create it. |
| `skipFirstRunScan` | `true` or `false` | With `true` and a `defaultProvider`, a fresh install checks only that provider at launch. When it is ready, the first-run model scan is skipped and the first run opens at Connect Microsoft 365, then Chat with the policy's model. When it is not ready, the scan runs as usual. |
| `novaVoiceModes` | List of `"local"` and `"openai"` | The voice modes Nova may use. With `["local"]`, OpenAI voice is refused in the main process and Nova offers only Local voice. An empty list `[]` turns Nova voice off. Without the key, both modes are allowed. |
| `novaInstructions` | Text, at most 4000 characters | Standing instructions for Nova. Locked, they replace the admin's own; unlocked, they apply until the admin writes their own. Nova's fixed safety rules always apply after them and cannot be changed by them. |
| `novaCapabilities` | Object with `webSearch`, `connectorSends`, `startAgents`, `navigation` | What Nova may do. `false` turns an ability off whether or not the key is locked. `true` is a default the admin can change, unless the key is locked. `connectorSends` also takes a list of connector ids, the only connectors Nova may prepare messages for. Sends and agent runs always wait for a click. |
| `novaMemory` | `"off"` | Turns Nova's notes off. Nova adds none, and saved notes stay on the device but never reach a prompt. |
| `lock` | List of setting keys | The settings the admin cannot change in the app. Without `lock`, every setting the file sets is locked. With `"lock": []`, the file only sets defaults. |
| `$schema` | Link | Optional. For editors. |

Provider ids: `ollama`, `apple-foundation` (Apple Intelligence), `lm-studio`, `anthropic` (Claude Code), `openai` (Codex), `copilot` (GitHub Copilot CLI), `gemini` (Gemini CLI), `azure-openai`.

Public reference ids: `microsoft-learn`, `kql-search`, `intuneautomation`, `release-communications`, `windowsforum`, `splashtop-kb` (Splashtop Docs MCP, the Help Center search), `splashtop-packr-kb` (Splashtop Agentic Packr Docs MCP), `endoflife-ai`.

### Locked and unlocked settings

- **Locked provider.** It is the only provider the app offers. The first-run scan, Chat's model choice and the provider list in Settings show it as **Set by your IT department**, and it cannot be changed.
- **Locked model.** It is the only model of that provider. If the provider does not list the model (for example it is not pulled in Ollama), the provider shows that it is missing and nothing runs until it is installed. CLI providers that do not list models are given the model by name.
- **Locked app registration.** Sign-in uses only this registration. The OpenAdminOS app and other saved registrations are not offered, and it cannot be removed under **Connections, Organizations**.
- **Unlocked provider or model.** Applies until the admin picks another one, then the admin's choice stays. A new unlocked default in a changed policy replaces only the policy's earlier default, never the admin's own choice.
- **Unlocked app registration.** Added to the saved registrations once. If the admin removes it, it stays removed until the policy names a different registration.

`allowedProviders`, `allowedPublicReferences`, `novaVoiceModes`, `novaMemory` and every `false` in `novaCapabilities` are always enforced, locked or not. The first-run scan checks only allowed providers, and with a `defaultProvider` it never selects another one for you.

### Nova

A Nova setting the policy sets is shown in Settings, **Nova** as **Set by your IT department**. Changes to Nova's settings are recorded in the audit log, with the full text of the standing instructions. Starting an OpenAI voice session records the consent to send audio and shared context to OpenAI in the audit log, before anything is sent.

Example: local voice only, no web search, sends only through Outlook.

```json
{
  "novaVoiceModes": ["local"],
  "novaCapabilities": { "webSearch": false, "connectorSends": ["outlook"] },
  "lock": ["novaVoiceModes", "novaCapabilities"]
}
```

## When the File Has a Problem

OpenAdminOS never ignores a problem silently. Settings, **Providers** shows an **IT policy** panel with the files read, the settings in force and every problem with the file, the line and the reason. The first time a set of problems appears, a notice across the app says so until it is dismissed.

- A file that is not valid JSON applies nothing from that file. The other file still applies.
- An invalid key is not applied. The rest of the file is. For example `"skipFirstRunScan": "yes"` is reported and the other keys stay in force.
- An unknown id in `allowedProviders` or `allowedPublicReferences` is reported and left out. The rest of the list stays in force, so a typo allows less, never more.
- An unknown key is reported, including keys with the wrong letter case.
- Comments, single quotes, trailing commas and unescaped backslashes are reported with their line. Write Windows paths with `\\`.

The file may be UTF-8 with or without a byte order mark, or UTF-16 as Windows PowerShell 5 writes it. Files over 64 KB are not read.

## Configuration Audit

Policy events go to the configuration audit log, exported from Settings, **General**, **Audit log export**, together with connection, provider and public reference changes:

| Event | When |
| --- | --- |
| `policy.loaded` | A launch finds a policy with valid settings where there was none. Records the keys, which are locked, which file each came from, and the values (ids and names only). |
| `policy.changed` | A launch finds different settings. Records the same details plus `changedKeys`. |
| `policy.removed` | A launch finds no policy where there was one. |
| `policy.invalid` | A launch finds problems that differ from the last ones. Records the count and up to 20 problems with file and line. |

A provider or model the policy sets is recorded as `provider.changed` or `model.changed` with `setByPolicy: true`. A launch with an unchanged policy records nothing.

## Deploy With Intune

Intune has no setting that places an arbitrary file, so deploy the policy with a script.

### Windows

Add a platform script under **Devices, Scripts and remediations, Platform scripts, Add, Windows 10 and later**. Set **Run this script using the logged on credentials** to **No**, so it runs as System, and **Run script in 64-bit PowerShell host** to **Yes**.

```powershell
$folder = Join-Path $env:ProgramData "OpenAdminOS"
New-Item -ItemType Directory -Path $folder -Force | Out-Null
# Only administrators and System may change the policy; users may read it.
icacls $folder /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null
$policy = @'
{
  "version": 1,
  "allowedProviders": ["ollama", "lm-studio"],
  "defaultProvider": "ollama",
  "defaultModel": "llama3.1:8b",
  "allowedPublicReferences": ["microsoft-learn"]
}
'@
[System.IO.File]::WriteAllText((Join-Path $folder "policy.json"), $policy, (New-Object System.Text.UTF8Encoding $false))
```

The `icacls` line matters: by default users can create folders under `%ProgramData%`, and a folder a user created first would stay writable for that user. The script replaces its permissions with Administrators and System (full control) and Users (read).

To deploy as an app with install reporting instead, package the same script as a Win32 app and detect the file `%ProgramData%\OpenAdminOS\policy.json`.

### macOS

Add a shell script under **Devices, macOS, Scripts, Add**. Set **Run script as signed-in user** to **No**, so it runs as root.

```sh
#!/bin/sh
set -e
dir="/Library/Application Support/OpenAdminOS"
mkdir -p "$dir"
cat > "$dir/policy.json" <<'EOF'
{
  "version": 1,
  "allowedProviders": ["ollama", "lm-studio", "apple-foundation"],
  "defaultProvider": "ollama",
  "defaultModel": "llama3.1:8b",
  "allowedPublicReferences": ["microsoft-learn"]
}
EOF
chown root:wheel "$dir" "$dir/policy.json"
chmod 755 "$dir"
chmod 644 "$dir/policy.json"
```

Set **Script frequency** if you want the file restored when someone changes it.

## Deploy With Jamf Pro

Use the same shell script as for Intune macOS: add it under **Settings, Computer management, Scripts**, then run it from a policy with the **Scripts** payload, scoped to the Macs that get OpenAdminOS. Jamf runs policy scripts as root. You can also build a package with Jamf Composer that installs `policy.json` to `/Library/Application Support/OpenAdminOS/` with owner `root:wheel` and mode `644`, and deploy it with the **Packages** payload.

## Linux

Write the file to `/etc/openadminos/policy.json` with your configuration management tool, owned by root with mode `644`.

## Check a Deployment

Open OpenAdminOS on a target device, then Settings, **Providers**. The **IT policy** panel lists the files it read (**Read** or **Not present**), each setting with **Locked** or **Default, can be changed** and the file it came from, and any problem with its line.
