---
title: "Network calls"
description: "Which hosts OpenAdminOS contacts automatically, what it sends, and how to turn those requests off."
---

# Network calls

The desktop app can contact the hosts below even when you use a local model. Local model processing keeps tenant data and prompts on your computer. The requests in this table carry no tenant content, prompts, or run results.

## Network calls the app makes on its own

Each remote host receives your IP address and standard request headers. **Settings > Privacy > Automatic network requests** controls all four activities below. An IT team can manage the same setting and registry install counts separately using a [policy file](../getting-started/managed-configuration.md).

| Activity | Host | When | What is sent | How to turn it off |
| --- | --- | --- | --- | --- |
| Update checks | `github.com` (OpenAdminOS releases) | 15 seconds after launch, then every 4 hours, in packaged Windows and macOS builds. Linux packages, Microsoft Store builds, and development builds skip these checks. An available update downloads in the background from GitHub. It installs when you restart or quit the app. | Release metadata request with a randomly generated UUID saved on the device and sent in the `x-user-staging-id` header. | Turn off **Automatic network requests**. |
| Agent registry refresh | `raw.githubusercontent.com` by default. The configured registry host receives the request if you change the source in Settings. | At startup, every 6 hours, and when the app regains focus at least 1 hour after the last background refresh. | Request for `agents/index.json` (the public agent catalog). | Turn off **Automatic network requests**. |
| Docs index auto-install | GitHub Releases and `registry.ollama.ai` (through your local Ollama server). | When local Ollama is reachable, the app checks the index pointer at launch. Downloads about 264 MB when the index is missing or outdated, at most one automatic download attempt per 24 hours. Local Ollama pulls the `nomic-embed-text` model if needed. | Index pointer and asset requests to GitHub, plus an Ollama registry request for the embedding model. Questions are embedded on your device. | Turn off **Automatically install the documentation index** in **Settings > Privacy**, or turn off **Automatic network requests**. |
| Registry install counts | `openadminos.com/api/install`, redirected to `www.openadminos.com`. | When you install a public registry agent in a packaged build (stable or nightly). On by default. The app records one attempt per agent and UTC calendar year on your device, including failed requests. | Agent slug, app version, and platform. The server uses your IP address to derive a short-lived rate-limit key. Supabase stores daily totals by agent slug without a per-install identifier. | Turn off **Registry install counts** in **Settings > Privacy**, or turn off **Automatic network requests**. |

Turning off **Automatic network requests** also cancels automatic registry refreshes and documentation downloads in progress. The app remembers your individual preferences.

Our processor, Supabase (Supabase Pte. Ltd.), hosts the website's database in Frankfurt, Germany. The website publishes aggregate counts hourly to GitHub. The public totals and daily aggregates in the Git commit history contain no personal data and are kept indefinitely.

## Requests enabled by your choices

- **Public references.** After you install and enable a reference, the app can contact `learn.microsoft.com`, `www.kqlsearch.com`, `www.intuneautomation.com`, `mcp.windowsforum.com`, `mcp.endoflife.ai`, `support-splashtopbusiness.splashtop.com`, `support-splashtopagenticpackr.splashtop.com`, or `www.microsoft.com`, depending on the reference. An enabled reference can receive a filtered query based on your current question. Disable the reference in Marketplace or use the `allowedPublicReferences` policy key to restrict the list. See [Marketplace](../features/marketplace.md) for query filtering and each operator.
- **Connected services and delivery.** Microsoft 365, Sophos Central, Splashtop, and delivery connectors such as Teams, Slack, and WhatsApp contact their services after you connect them. This includes background activity you enable, such as scheduled runs, cache refreshes for connected organizations, and saved delivery rules. The WhatsApp connector also requests a version file from `raw.githubusercontent.com` as part of connecting. Disconnect a service or disable its schedules and delivery rules to stop that activity.
- **Hosted models and tools.** Selecting a hosted provider or using a hosted CLI for a model request sends the prompt and its context to the configured destination. The app names the destination. A local model keeps model processing on this device. See [Hosted providers](hosted-providers.md).
- **Manual actions.** You can still use **Check for updates** on supported builds, refresh the registry, install an agent, or install the docs index when **Automatic network requests** is off. These actions can contact the corresponding hosts. Support reports and agent submissions reach the OpenAdminOS website only when you submit them. GitHub receives the issue content for public publication. See the [privacy policy](https://openadminos.com/privacy) for the data and retention details.

## Model discovery and provider checks

The first-run scan probes Ollama, LM Studio, and Lemonade on loopback, checks the Apple Foundation helper, and reads saved Azure settings. It runs `claude --version`, `codex --version`, `copilot --version`, and `gemini --version` to check local installations. It reads the Codex model cache and `config.toml` and runs `codex login status` to check saved authentication. It asks Claude Code for sign-in status with `claude auth status --text`. Claude Code handles that check and may contact its configured service. The scan sends no model prompts.

Outside the scan, the full Copilot check starts the CLI's RPC server and checks sign-in. If signed in, the CLI contacts GitHub for the available model catalog. Gemini discovery still checks only the version and the result of any previous request in this session. Using **Test** for a hosted provider sends a test prompt to its configured service. OpenAdminOS processes discovery results on your computer and sends none of them to us.

The desktop app has no analytics or crash-reporting SDK or crash upload. Registry install counts are the limited measurement described above.
