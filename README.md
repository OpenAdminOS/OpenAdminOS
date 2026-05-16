# Open Agents

**Open-source, local-first agents for Microsoft 365 admins.**

Run AI agents against your Intune and Entra tenants from your own machine. Tenant data and prompts stay on-device when a local LLM is selected. Every agent ships its full pipeline as YAML — no opaque code paths, no hidden Graph calls.

> Pre-1.0. v0.1 (private preview showcase) is feature-complete; signed installers ship with v0.2. Star the repo to follow along.

---

## What it does

An Intune / Entra admin can:

1. **Connect a tenant** via MSAL interactive sign-in (Authorization Code + PKCE against the public Microsoft Graph CLI client). No client secret, no app registration — the user signs in with their own identity in their own browser.
2. **Pick an LLM provider** — local (Ollama, LM Studio) or hosted (Anthropic, OpenAI, Azure OpenAI). Trust messaging changes honestly with the choice.
3. **Browse a registry of agents.** Each agent declares the Graph scopes it needs and whether it reads or writes. The full pipeline (every Graph call, every transform, every LLM prompt) is visible before install.
4. **Run agents** — read agents run autonomously; **write agents always pause for typed diff confirmation** ("type `RETIRE 47 DEVICES` to proceed").
5. **Author new agents in plain English.** Describe what you want, the local LLM drafts a YAML manifest, the JSON Schema validates it, and you install it in one click.

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
    when: ctx.llm.available
    settings: { prompt: "...", maxTokens: 220 }

definition:
  settings:
    - { id: retireDays, type: integer, default: 180 }
  result:
    summary: "{{ buckets.retire | size }} devices ready to retire."
```

**Four step formats**: `graph` (read Microsoft Graph), `transform` (pure data shaping — `group-by-age`, `filter-by-age`, `count-by-field`), `llm` (optional, gated on provider availability), and `write` (emits one action per source item and pauses for typed phrase confirmation).

### Static QA gate

`npm run qa` validates every shipped manifest:
- **JSON Schema validation** of the YAML against [`schemas/agent-template.schema.json`](schemas/agent-template.schema.json).
- **Graph QA**: declared scopes are real, endpoints exist in the OpenAPI surface, `$select` fields exist on the resource, fixtures match the live schema. Uses the [`merill/msgraph`](https://github.com/merill/msgraph) skill — offline, no auth, no tenant calls.

A malformed manifest fails CI with a structured per-field diff.

### NL2Agent — describe an agent in English

The "New agent" button on the hub opens a two-pane flow. Type a description, the active LLM provider drafts a YAML manifest grounded in the schema and a worked example, the draft renders through the same Manifest Preview component as bundled agents, save & install routes you straight to the new agent's detail page. User-authored agents persist under `userData/agents/<slug>/` and appear in the merged registry without a restart.

### Trust model (non-negotiable)

- **Tenant data never leaves the device** when a local LLM is selected. No telemetry, no analytics, no error reporting that could include tenant content.
- **Write agents always pause for diff confirmation.** No "skip this prompt" toggle. Destructive operations require typed phrase confirmation.
- **Real Graph writes are gated twice**: an active tenant connection AND a global toggle the user has to flip. Until both, write agents emit a simulated trace instead of calling Graph.

### What's shipped vs what's coming

| | v0.1 | v0.2 |
|---|---|---|
| Tenant connect (read) | yes (MSAL interactive) | — |
| Real Graph writes (gated) | yes | — |
| Local LLM (Ollama) | yes | — |
| Hosted LLM (Anthropic / OpenAI) | no | yes |
| LM Studio | no | yes |
| Signed installers | no | yes |
| Code-signing + notarization | no | yes |
| Auto-update via electron-updater | no | yes |
| Cross-platform builds | dev-only | Win + macOS signed |

## Reference agents

| Agent | Category | Mode | What it does |
|---|---|---|---|
| `find-inactive-devices` | devices | read | Buckets managed devices by last-sync age. |
| `retire-inactive-devices` | devices | write | Plans retires for devices ≥180 days inactive, pauses for typed confirmation. |
| `compliance-overview` | compliance | read | Counts devices by `complianceState`. |
| `os-update-posture` | updates | read | Tallies fleet by OS + OS version; surfaces Windows 10 lines. |

Each lives at `agents/<slug>/manifest.yaml`. Read them — they are the documentation of what the runtime can do.

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/ugurkocde/OpenAgents.git
cd OpenAgents
npm install

# 2. (Optional) Pull a local LLM model so NL2Agent works
brew install ollama && ollama serve &
ollama pull llama3.1:8b

# 3. Run the desktop app
npm run dev

# 4. Verify everything
npm run typecheck   # types across the workspace
npm run qa          # JSON Schema + Graph QA
npm run build       # production bundle
```

The app comes up with four agents (three read-only, one write) pre-available against a synthetic Graph fixture. You can run every agent end-to-end without connecting a real tenant.

## Architecture

```
apps/
  desktop/        Electron host (main + preload + Vite/React renderer)
  marketing/      Next.js marketing site (openagents.sh)
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

definition:
  result:
    summary: "Loaded {{ load_devices.output | size }} devices."
```

Drop that at `agents/my-agent/manifest.yaml`, run `npm run qa`, and the agent shows up in the hub.

For the full schema, see [`schemas/agent-template.schema.json`](schemas/agent-template.schema.json) and [`schemas/README.md`](schemas/README.md). For deeper architecture, see [`docs/SPEC.md`](docs/SPEC.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, feature requests, and agent contributions all welcome.

## License

MIT. See [`LICENSE`](LICENSE).

## Who's behind it

Built by [Ugurlabs](https://ugurlabs.com). Free community project — sponsorships welcome, no paid tier planned for the platform itself.
