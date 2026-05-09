# Open Agents

**Open-source, local-first agents for Microsoft 365 admins.**

Run AI agents against your Intune and Entra tenants from your own machine. Tenant data and prompts stay local by default. Community-contributed agents, browseable from inside the app.

> ⚠️ Pre-alpha. Not yet ready for production use. Star the repo to follow along.

---

## What it is

Open Agents is a desktop platform that lets a Microsoft 365 administrator:

1. Connect a tenant via MSAL.
2. Pick an LLM provider — local (Ollama, LM Studio) or hosted (Anthropic, OpenAI, Azure OpenAI).
3. Browse a community registry of agents (each declares the Graph scopes it needs and whether it reads or writes).
4. Run agents against the tenant — read agents run autonomously, write agents pause for diff confirmation.

It ships as a signed desktop app for Windows and macOS (Linux best-effort), built on Electron.

## Why

Most AI tools for IT admins are wrappers around ChatGPT — single-purpose, cloud-only, no extensibility. Open Agents is a **platform**: a runtime, a registry, a trust model. Contributions accumulate over time. Think Home Assistant, but for the Microsoft 365 admin surface.

## How to install

_Signed installers (Windows + macOS) coming with v0.2. v0.1 is a private preview — sign up at [openagents.sh](https://openagents.sh) to get early access._

## How to write an agent

_SDK docs coming soon. The agent contract is documented in [`docs/SPEC.md`](docs/SPEC.md) §2._

## How to contribute

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, feature requests, and agent contributions all welcome.

## License

MIT. See [`LICENSE`](LICENSE).

## Who's behind it

Built by [Ugurlabs](https://ugurlabs.com). Free community project — sponsorships welcome, no paid tier planned for the platform itself.
