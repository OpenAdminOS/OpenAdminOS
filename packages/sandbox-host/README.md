# OpenAdminOS sandbox host

A sandbox is an always-on machine you run yourself, such as a mini PC in the office. The sandbox host is a service on that machine. It runs bundled, read-only OpenAdminOS agents on a schedule, signs in to your tenant with its own app registration and a certificate, and uses a model on the same machine (Ollama or LM Studio). Schedules keep running while your laptop is off.

It is a service, not an end-user tool. `openadminos-sandbox` is the service entry point: it is non-interactive, reads one config file and writes lines to stdout. `--once <agentId>` is a setup check. The desktop app stays the only user interface.

This first version is read-only. A sandbox cannot change anything in the tenant. Every change is still confirmed and applied on the desktop.

## What leaves the machine

- Microsoft sign-in (`https://login.microsoftonline.com`), for the app-only token.
- Microsoft Graph (`https://graph.microsoft.com`), for the reads the agents declare.
- The delivery destinations you configure (Slack or Discord), if any. Delivery is off unless you add it.

Nothing else. Nothing goes to OpenAdminOS. The model runs on this machine; the host refuses an endpoint that is not a loopback address and refuses Ollama cloud models. The model client sends only to the endpoint that was checked and never follows a redirect.

## What the host checks before every run

The run is refused, with a named reason in the log and in `health.json`, when any of these fail. When an identity check fails, no Graph read is made.

- Files: the config, the private key and the secrets file must be mode 0600 and owned by the service user. The data folder is created with mode 0700.
- Certificate: refused when expired or not yet valid; a warning on every run when it expires within 30 days.
- Agent: a bundled first-party agent, mode `read`, a template agent (script agents are refused), only Graph GET, transform and model steps, no `$batch`, no `/me`, and a manifest that matches the `templateSha256` you pinned.
- Model: the endpoint is on this machine, the server answers, the model is pulled, and it is not a cloud model.
- Identity, on a fresh token every run: an app-only token (`idtyp` app) for the configured tenant and app, for Microsoft Graph, with no directory roles (`wids`), at least one role, no role that can change the tenant, no role that reads secrets or personal content (local admin passwords, BitLocker keys, mail, files, chats, calendars, contacts, notes), and no role that no configured agent declares. The scopes come from the pinned manifests, read again on every run.

  The directory role check sees only what the token carries: tenant-wide directory roles, in the `wids` claim (the value every app-only token carries is ignored). A role scoped to an administrative unit or to an application, and permissions the service principal holds on other resources, are not visible in a Graph token. What contains those is the egress limit: the host sends only GET requests, and only to Microsoft Graph. Check the service principal's role assignments in Entra as part of the setup.

During the run, every Graph request is written to the audit log before it is sent (method, path and a digest of the query, never a body). Requests to any other host, any method but GET, `$batch` and `/me` are refused before they are sent, and redirects fail. A run that does not finish within `runDeadlineSeconds` is stopped. The deadline covers the execution of the agent; the checks before it are bounded by their own transport timeouts of about 30 seconds per request (10 seconds for the model checks), and each report delivery, response included, by 30 seconds and the host's shutdown.

## Minimum setup

1. Create a dedicated, single-purpose app registration in Microsoft Entra, single tenant, used by this sandbox only.
2. Under API permissions, add only the Microsoft Graph application permissions the agents you configure declare, and grant admin consent. For `find-inactive-devices` that is `DeviceManagementManagedDevices.Read.All`. Do not add a ReadWrite, Send or PrivilegedOperations permission: the host refuses to run. Do not assign a directory role to the service principal.
3. Note that application permissions apply to the whole tenant. Intune scope tags and Intune role assignments do not narrow what an app-only identity can read.
4. Create a certificate and upload its public part under Certificates & secrets:

   ```sh
   openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
     -subj "/CN=openadminos-sandbox" \
     -keyout sandbox.key -out sandbox.crt
   chmod 600 sandbox.key
   ```

5. Install Ollama, pull the model, and turn cloud models off for the Ollama service with `OLLAMA_NO_CLOUD=1`:

   ```sh
   ollama pull llama3.1:8b
   ```

6. Build the host from a release checkout: `npm ci && npm run build -w @openadminos/sandbox-host`. The bundled agents are read from the `agents` folder of that checkout: run the host from a release checkout, not a copy of `dist` alone. The folder is found from the host's own location, never from the current directory. The run uses the exact manifest text whose hash you pinned.
7. Create a service user (for example `openadminos`) that owns the config folder and the data folder, and nothing else.
8. Use full disk encryption on the machine. The private key and the run results are protected by file permissions only; disk encryption is a precondition.

## Config

`/etc/openadminos-sandbox/sandbox.json`, mode 0600, owned by the service user. Paths may be relative to the config file. The values below are placeholders.

```json
{
  "version": 1,
  "sandbox": { "id": "office-mini-pc", "name": "Office mini PC" },
  "organizationId": "your-organization-id",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "clientId": "00000000-0000-0000-0000-000000000000",
  "certificates": [
    { "certificatePath": "sandbox.crt", "privateKeyPath": "sandbox.key" }
  ],
  "model": { "provider": "ollama", "endpoint": "http://127.0.0.1:11434", "model": "llama3.1:8b" },
  "dataDir": "/var/lib/openadminos-sandbox",
  "runDeadlineSeconds": 1800,
  "agents": [
    {
      "id": "find-inactive-devices",
      "templateSha256": "<sha256 of agents/find-inactive-devices/manifest.yaml>",
      "intervalSeconds": 86400
    }
  ]
}
```

- `intervalSeconds` is at least 900 (15 minutes). After downtime an overdue agent runs once, then returns to its interval; missed runs are not made up.
- `templateSha256` pins the manifest you reviewed. Compute it with `sha256sum agents/<id>/manifest.yaml`. When an update changes the manifest, the host refuses the agent and prints both hashes until you pin the new one.
- `model.endpoint` is an http or https loopback URL. A Unix socket is refused.
- `model.provider` is `ollama` or `lm-studio`. `model.timeoutSeconds` is optional (default 300).

### Delivery (optional)

Off unless an agent has a `delivery` block. The destination is fixed in the config; the model never chooses it. The report holds the agent, the status, the run id and the values of the agent's declared result fields that are non-negative whole numbers or list lengths, taken only from expressions that do not read a model step. It never holds text the model wrote, numbers written as text, or tenant names. Mentions and links are neutralized, Slack link previews are off, and Discord messages suppress embeds and mentions. Each report is sent once; a failed delivery is recorded on the run and in `health.json`, and is not retried. The audit log records each delivery attempt and result with a digest of the payload, never the payload.

```json
"delivery": { "connector": "discord", "notifyOnSuccess": true, "notifyOnFailure": true, "failureNotice": true }
```

```json
"delivery": { "connector": "slack", "channel": "C0123456789" }
```

`failureNotice` sends a notice with the agent, the reason code and the time when a run is refused or fails, only when the reason differs from the last notice for that agent, and one notice when runs complete again. The last reason noticed is kept in `health.json`. Teams and Outlook are refused: they need a delegated sign-in, or Mail.Send, which can change the tenant.

The secrets go in `secrets.json` next to the config (or `secretsFile`), mode 0600:

```json
{
  "slack": { "botToken": "xoxb-your-bot-token" },
  "discord": { "webhookUrl": "https://discord.com/api/webhooks/your-webhook-id/your-webhook-token" }
}
```

## Setup check

Run one agent once, with every check, as the service user. The exit code is 0 when the run completed, 1 when it was refused or failed or its configured report was not delivered, 2 for a config problem, 3 when the service is already running on the same data folder. A failure notice or recovery notice that cannot be sent is logged and kept in `health.json`, but does not fail the setup check; only an undelivered report does.

```sh
sudo -u openadminos openadminos-sandbox --config /etc/openadminos-sandbox/sandbox.json --once find-inactive-devices
```

Stop the service first; the host takes a lock on the data folder so a setup check and the service never overlap. Run one host per data volume: the lock is a file and process ids in it, so it does not reach across containers, pid namespaces or machines that share the folder.

## Running it as a service

systemd (`/etc/systemd/system/openadminos-sandbox.service`):

```ini
[Unit]
Description=OpenAdminOS sandbox host
After=network-online.target ollama.service
Wants=network-online.target

[Service]
User=openadminos
ExecStart=/usr/bin/node /opt/openadminos/packages/sandbox-host/dist/bin.js --config /etc/openadminos-sandbox/sandbox.json
Restart=on-failure
RestartSec=60
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/openadminos-sandbox
UMask=0077

[Install]
WantedBy=multi-user.target
```

launchd (`/Library/LaunchDaemons/com.openadminos.sandbox.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openadminos.sandbox</string>
  <key>UserName</key><string>openadminos</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/openadminos/packages/sandbox-host/dist/bin.js</string>
    <string>--config</string>
    <string>/etc/openadminos-sandbox/sandbox.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/var/log/openadminos-sandbox.log</string>
  <key>StandardErrorPath</key><string>/var/log/openadminos-sandbox.log</string>
</dict>
</plist>
```

SIGINT and SIGTERM stop the schedule, stop a run in progress and record it. A run left running by a crash is marked interrupted at the next start. Node.js 22.13 or later is required, on Linux or macOS. The host refuses to start on Windows for now: it cannot check file permissions there yet.

## Where results are kept

In `dataDir`:

- `runs/<agent>/`: one JSON run record per run, the last 200 per agent, written atomically. Each record says where it ran (`executedOn`: sandbox id and name, organization, model and model digest; LM Studio reports no digest, so it is recorded as `unknown`).
- `openadminos.db`: the hash-chained audit log, the same format as the desktop's.
- `health.json`: the last run, last refusal and last delivery per agent.
- `sandbox.lock`: present while a host runs.

The log on stdout carries ids, reason codes and counts. It never carries tokens, secrets or tenant data.

## Certificate rotation and revocation

Rotation, without a gap:

1. Create the new certificate and upload its public part to the same app registration.
2. Add it as the second entry of `certificates`. The host uses the valid certificate that expires last, and warns 30 days before the old one expires.
3. After a successful run, remove the old certificate from the config and from the app registration.

Revocation, when the machine or the key may be compromised:

1. Delete the certificate from the app registration under Certificates & secrets. Sign-in fails at once with AADSTS700027.
2. If the machine is gone, also disable or delete the service principal under Enterprise applications.
3. Review the sign-in logs of the service principal and the Microsoft Graph activity logs for the app.
