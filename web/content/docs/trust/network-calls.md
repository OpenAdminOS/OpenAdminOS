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
| Update checks | `github.com` (OpenAdminOS releases) | 15 seconds after launch, then every 4 hours, in packaged Windows and macOS builds. Linux packages, Microsoft Store builds, and development builds skip these checks. Downloads require your action. | Release metadata request with a randomly generated UUID saved on the device and sent in the `x-user-staging-id` header. | Turn off **Automatic network requests**. |
| Agent registry refresh | `raw.githubusercontent.com` by default. The configured registry host receives the request if you change the source in Settings. | At startup, every 6 hours, and when the app regains focus at least 1 hour after the last background refresh. | Request for `agents/index.json` (the public agent catalog). | Turn off **Automatic network requests**. |
| Docs index auto-install | GitHub Releases and `registry.ollama.ai` (through your local Ollama server). | At launch when local Ollama is reachable. The app checks the index pointer and downloads about 264 MB if the index is missing, retrying at most daily. Local Ollama pulls the `nomic-embed-text` model if needed. | Index pointer and asset requests to GitHub, plus an Ollama registry request for the embedding model. Questions are embedded on your device. | Turn off docs index auto-install in **Settings > Privacy**, or turn off **Automatic network requests**. |
| Registry install counts | `openadminos.com/api/install` | When you install a public registry agent in a packaged production build. On by default. The app avoids sending duplicate counts from the same device. | Agent slug, app version, and platform. The server briefly uses your IP address to limit requests and stores aggregate daily counts without a per-install identifier. | Turn off registry install counts in **Settings > Privacy**, or turn off **Automatic network requests**. |

<!-- TODO(ugur): Confirm the final policy key names in the automatic network requests change. -->

## Requests enabled by your choices

- **Public references.** After you install and enable a reference, the app can contact `learn.microsoft.com`, `www.kqlsearch.com`, `www.intuneautomation.com`, `mcp.windowsforum.com`, `mcp.endoflife.ai`, `support-splashtopbusiness.splashtop.com`, `support-splashtopagenticpackr.splashtop.com`, or `www.microsoft.com`, depending on the reference. An enabled reference can receive a filtered query based on your current question. Disable the reference in Marketplace or use the `allowedPublicReferences` policy key to restrict the list. See [Marketplace](../features/marketplace.md) for query filtering and each operator.
- **Connected services and delivery.** Microsoft 365, Sophos Central, Splashtop, and delivery connectors such as Teams, Slack, and WhatsApp contact their services after you connect them. This includes background activity you enable, such as scheduled runs, cache refreshes for connected organizations, and saved delivery rules. The WhatsApp connector also requests a version file from `raw.githubusercontent.com` as part of connecting. Disconnect a service or disable its schedules and delivery rules to stop that activity.
- **Hosted models and tools.** Selecting a hosted provider or using a hosted CLI for a model request sends the prompt and its context to the configured destination. The app names the destination. A local model keeps model processing on this device. See [Hosted providers](hosted-providers.md).
- **Manual actions.** Checking for or downloading an update, refreshing or installing an agent, and installing the docs index can contact the corresponding host. Support reports and agent submissions reach the OpenAdminOS website only when you submit them. GitHub receives the issue content for public publication. See the [privacy policy](https://openadminos.com/privacy) for the data and retention details.

## Local checks

The app probes local Ollama, LM Studio, and Lemonade on loopback. It runs `claude --version`, `claude auth status`, and `codex login status`, and reads the Codex model cache and `config.toml` to list local choices. The CLI tools may check their sign-in with their providers. OpenAdminOS processes those discovery results on your computer and sends none of them to us.

The desktop app has no analytics or crash-reporting SDK or crash upload. Registry install counts are the limited measurement described above.
