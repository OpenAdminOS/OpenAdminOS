<div align="center">

<h1>OpenAdminOS</h1>

<p><strong>Open-source, local-first AI agents for Microsoft 365 admins.</strong></p>

<p>Run agents against your Intune and Entra tenants from your own machine. Tenant data and prompts stay on-device when a local LLM is selected.</p>

[![CI](https://github.com/OpenAdminOS/OpenAdminOS/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenAdminOS/OpenAdminOS/actions/workflows/ci.yml)
[![Release](https://github.com/OpenAdminOS/OpenAdminOS/actions/workflows/release.yml/badge.svg)](https://github.com/OpenAdminOS/OpenAdminOS/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/OpenAdminOS/OpenAdminOS?include_prereleases&sort=semver&label=release)](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/OpenAdminOS/OpenAdminOS/total?label=downloads)](https://github.com/OpenAdminOS/OpenAdminOS/releases)
[![License: MIT](https://img.shields.io/github/license/OpenAdminOS/OpenAdminOS)](LICENSE)
[![Stars](https://img.shields.io/github/stars/OpenAdminOS/OpenAdminOS?style=flat)](https://github.com/OpenAdminOS/OpenAdminOS/stargazers)
[![Issues](https://img.shields.io/github/issues/OpenAdminOS/OpenAdminOS)](https://github.com/OpenAdminOS/OpenAdminOS/issues)
[![Last commit](https://img.shields.io/github/last-commit/OpenAdminOS/OpenAdminOS)](https://github.com/OpenAdminOS/OpenAdminOS/commits/main)

[**Download**](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest) · [**Website**](https://openadminos.com) · [**Docs**](docs/SPEC.md) · [**Contributing**](CONTRIBUTING.md) · [**Changelog**](CHANGELOG.md)

![OpenAdminOS desktop app](docs/demo.png)

</div>

---

## Why OpenAdminOS

- **Local-first by default.** Pick a local LLM (Ollama, LM Studio) and tenant data plus prompts never leave the device. No telemetry, no analytics, no error reporting that could carry tenant content. Switching to a hosted provider changes the trust banner honestly.
- **Every agent is auditable YAML.** No opaque code paths, no hidden Graph calls. Read the full pipeline — every Graph endpoint, every transform, every prompt — before you install.
- **Write agents always pause for typed diff confirmation.** No "trust this agent" toggle. Destructive changes require typing the phrase shown against the live diff (`type RETIRE 47 DEVICES to proceed`), every time.
- **No app registration required.** Sign in with your own admin identity via MSAL (Authorization Code + PKCE against the public Microsoft Graph CLI client). No client secrets, no consent dance with a third-party multi-tenant app.
- **Author agents in plain English.** Describe what you want; the local LLM drafts a manifest grounded in the JSON Schema; one click installs it.

> Pre-1.0. v0.1.8 ships the desktop surface end-to-end against local Ollama. Hosted LLM providers (Anthropic, OpenAI, Azure OpenAI), LM Studio, and the GitHub-hosted agent registry land in v0.2. Star the repo to follow along.

## Download

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | [`OpenAdminOS-<version>-arm64.dmg`](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest) — signed with Developer ID, notarized |
| Windows | [`OpenAdminOS.<version>.appx`](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest) — Microsoft Store package |
| From source | See [Quickstart](#quickstart) below |

---

## What's in the box (v0.1)

### Agent Templates — agents as YAML pipelines

Every shipped agent is a declarative `manifest.yaml`. No companion TypeScript needed. The runtime interprets the manifest top-to-bottom.

```yaml
descriptor:
  id: find-inactive-devices
  mode: read
  category: devices

skills:
  - id: load_devices
    format: graph
    settings: { method: GET, path: /deviceManagement/managedDevices, scopes: [...] }

  - id: by_age
    format: transform
    settings: { kind: group-by-age, source: "{{ load_devices.output }}", ... }

  - id: summarize
    format: llm
    settings: { prompt: "...", maxTokens: 220 }

definition:
  settings:
    - { id: retireDays, type: integer, default: 180 }
  result:
    summary: '{{ summarize.output.text | default("Summary unavailable.") }}'
```

**Four step formats**: `graph` (read Microsoft Graph), `transform` (pure data shaping — `group-by-age`, `filter-by-age`, `count-by-field`), `llm` (required — every agent invokes the model at least once to produce the headline summary), and `write` (emits one action per source item and pauses for typed phrase confirmation).

### Static QA gate

`npm run qa` validates every shipped manifest:
- **JSON Schema validation** of the YAML against [`schemas/agent-template.schema.json`](schemas/agent-template.schema.json).
- **Graph QA**: declared scopes are real, endpoints exist in the OpenAPI surface, `$select` fields exist on the resource, fixtures match the live schema. Uses the [`merill/msgraph`](https://github.com/merill/msgraph) skill — offline, no auth, no tenant calls.

A malformed manifest fails CI with a structured per-field diff.

### NL2Agent — describe an agent in English

The "New agent" button on the hub opens a two-pane flow. Type a description, the active LLM provider drafts a YAML manifest grounded in the schema and a worked example, the draft renders through the same Manifest Preview component as bundled agents, save & install routes you straight to the new agent's detail page. User-authored agents persist under `userData/agents/<slug>/` and appear in the merged registry without a restart.

### Trust model (non-negotiable)

- **Tenant data never leaves the device** when a local LLM is selected. No telemetry, no analytics, no error reporting that could include tenant content.
- **Write agents always pause for diff confirmation.** No "skip this prompt" toggle. Destructive operations require typed-phrase confirmation against the live diff, every time.
- **Graph writes follow the tenant binding.** Connect a real tenant and write agents call Microsoft Graph for real after you approve their plan. Run against synthetic mode (no tenant) and the apply phase emits a simulated trace. There is no separate global "enable writes" toggle — the typed-phrase confirmation per run is the only gate.

### What's shipped vs what's coming

| | v0.1.5 | v0.2 |
|---|---|---|
| Tenant connect (read) | yes (MSAL interactive) | — |
| Real Graph writes | live POSTs after typed-phrase diff confirm | additional write surface (assignment changes, policy edits) |
| Local LLM (Ollama) | yes, with `think: false` for reasoning models | — |
| LM Studio / Anthropic / OpenAI / Azure OpenAI | toggles disabled, "Coming in 0.2" | yes |
| Per-run schedules | yes (in-process tick while app is open) | OS-level via launchd / Task Scheduler |
| Auto-update via electron-updater | yes (banner + native dialog) | — |
| Signed installers + notarization | workflows ready, certs not yet purchased | yes |
| GitHub-hosted agent registry | local `./agents` only | yes |
| SQLite run history | JSON-file backed | yes |
| Secrets in OS keychain (keytar) | Electron `safeStorage` only | yes |

## Reference agents

| Agent | Category | Mode | What it does |
|---|---|---|---|
| `find-inactive-devices` | devices | read | Buckets managed devices by last-sync age. |
| `retire-inactive-devices` | devices | write | Plans retires for devices ≥180 days inactive, pauses for typed confirmation. |
| `compliance-overview` | compliance | read | Counts devices by `complianceState`. |
| `os-update-posture` | updates | read | Tallies fleet by OS + OS version; surfaces end-of-life build risk via LLM summary. |

Each lives at `agents/<slug>/manifest.yaml`. Read them — they are the documentation of what the runtime can do.

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/OpenAdminOS/OpenAdminOS.git
cd OpenAdminOS
npm install

# 2. Install Ollama and pull a model (required — every agent uses the LLM at least once)
brew install ollama && ollama serve &
ollama pull llama3.2:3b   # lightweight default; or pull whichever model you prefer

# 3. Run the desktop app
npm run dev

# 4. Verify everything
npm run typecheck   # types across the workspace
npm run qa          # JSON Schema + Graph QA
npm run build       # production bundle
```

The app comes up with four agents (three read-only, one write) discoverable in the Agent Hub. Without a connected tenant, agents run in synthetic mode against an empty Graph fixture — the pipeline executes end-to-end but produces zero records. Connect a real tenant in Settings → Tenants to see actual device data.

## Architecture

```
apps/
  desktop/        Electron host (main + preload + Vite/React renderer)
  marketing/      Next.js marketing site (openadminos.com)
agents/
  <slug>/         manifest.yaml + manifest.json (+ optional TS)
packages/
  agent-sdk/      Shared types (no runtime)
  runtime/        Agent Template interpreter, LLM providers, MSAL, synthetic Graph
  qa-graph/       Offline manifest QA (schema + msgraph)
schemas/
  agent-template.schema.json    The canonical contract for manifest.yaml
docs/
  SPEC.md         Source of truth for product decisions
  mockups/        8 reference HTML mockups + design system tokens
```

Stack: TypeScript, npm workspaces + Turborepo, Electron 42, Vite + React + React Router, Tailwind, MSAL (`@azure/msal-node`), `js-yaml`, `ajv`. SQLite + `keytar` arrive in v0.2 with persistence + secrets hardening.

## Writing an agent by hand

```yaml
# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: my-agent
  name: My Agent
  description: One sentence.
  version: 1.0.0
  author: { name: Your Name, handle: yourhandle }
  category: devices  # devices | apps | policies | compliance | updates
  mode: read

skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      scopes: [DeviceManagementManagedDevices.Read.All]

  - id: summarize
    format: llm
    label: Summarize what we found
    settings:
      system: Be concise. Two sentences max.
      prompt: |-
        Total devices: {{ load_devices.output | size }}.
        Write an executive summary an admin can paste into a ticket.
      maxTokens: 180

definition:
  result:
    summary: '{{ summarize.output.text | default("Summary unavailable.") }}'
```

Every agent must include at least one `format: llm` step — the runtime enforces this and `npm run qa` flags violations. Use the LLM step's output as the run's headline summary.

Drop that at `agents/my-agent/manifest.yaml`, run `npm run qa`, and the agent shows up in the hub.

For the full schema, see [`schemas/agent-template.schema.json`](schemas/agent-template.schema.json) and [`schemas/README.md`](schemas/README.md). For deeper architecture, see [`docs/SPEC.md`](docs/SPEC.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, feature requests, and agent contributions all welcome.

## License

MIT. See [`LICENSE`](LICENSE).

## Who's behind it

Free community project — sponsorships welcome, no paid tier planned for the platform itself.
