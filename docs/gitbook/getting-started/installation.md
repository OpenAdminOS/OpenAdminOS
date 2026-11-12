---
title: "Installation"
description: "Install OpenAdminOS on a supported desktop."
---

# Installation

OpenAdminOS ships as a desktop app. The project does not publish an end-user CLI.

## macOS

Download the signed Apple Silicon `.dmg` from the [latest GitHub release](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest), drag OpenAdminOS to Applications, and launch it from Applications.

Managed deployments can use the signed Apple Silicon `.pkg` from the same release. The `.pkg` is intended for Intune, Jamf, Munki, and other MDM rollout tools.

## Windows

Download `OpenAdminOS-<version>-win-x64.exe` from the [latest GitHub release](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest) and run it. The installer is per-user, so it does not require local administrator rights, and it lets you change the install directory. Auto-update is handled by electron-updater from GitHub Releases.

The installer is code signed. Before running it, right-click the file, open **Properties → Digital Signatures**, and confirm the signer is `Ugurlabs UG (haftungsbeschränkt)`.

The installer is signed through Microsoft's Azure Artifact Signing program, which SmartScreen trusts faster than a conventional certificate. A brand-new release can still show a "Windows protected your PC" prompt briefly until its file hash accrues reputation. Check the signature as described above, then choose **More info** → **Run anyway**.

## Linux

Linux x64 packages are published as AppImage, `.deb`, and `.rpm`. Ubuntu and other Debian-family systems can install from the signed apt repository:

```bash
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://repo.openadminos.com/debian/openadminos-archive-keyring.pgp \
  | sudo tee /usr/share/keyrings/openadminos-archive-keyring.pgp >/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openadminos-archive-keyring.pgp] https://repo.openadminos.com/debian stable main" \
  | sudo tee /etc/apt/sources.list.d/openadminos.list
sudo apt update
sudo apt install openadminos
```

The OpenAdminOS Linux archive key fingerprint is:

```text
19CE B561 9FD8 BD30 4FFA  F281 8ED8 4B68 EAE8 5363
```

Direct AppImage, `.deb`, and `.rpm` downloads remain available from [GitHub Releases](https://github.com/OpenAdminOS/OpenAdminOS/releases/latest). These direct Linux artifacts are unsigned preview builds. Verify the SHA-256 hash from the release notes or `SHA256SUMS.txt` before installing.

Linux builds use Chromium software rendering by default. This avoids VAAPI and
3D acceleration failures on Debian/Ubuntu VMs and other systems where GPU
drivers are unavailable or incomplete.

Tenant sign-in on Linux requires an unlocked OS keyring because Microsoft
refresh tokens are stored through Electron `safeStorage`. On Debian or Ubuntu,
install `gnome-keyring` if your desktop session does not already provide Secret
Service. KDE users can use KWallet. OpenAdminOS refuses Electron's unprotected
`basic_text` fallback for tenant tokens.

## Nightly builds

Every change to `main` that touches the app is published as a signed nightly
prerelease, named like `v0.7.3-nightly.20261112175700` (the next stable version
plus the UTC build time). Nightlies are signed and notarized like stable
releases but get less testing, so try them on a test organization first.

- **Turn them on:** Settings > About > **Get nightly builds**. The app then
  updates to newer nightlies and to newer stable releases. A **Nightly** badge
  next to the OpenAdminOS name in the sidebar marks a nightly build. Write confirmation and every other safeguard work
  the same as in a stable release.
- **Go back to stable:** turn **Get nightly builds** off. The app installs the
  current stable release, even if it is older than the nightly.
- **Download one directly:** the [nightly releases on
  GitHub](https://github.com/OpenAdminOS/OpenAdminOS/releases?q=nightly&expanded=true).
  Linux packages are attached there only; the apt repository carries stable
  releases.

Each nightly's release notes describe that build only: the pull requests and
commits since the previous release, and the changelog entries they added. To
see everything waiting for the next stable release, read the `[Unreleased]`
section of [CHANGELOG.md](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/CHANGELOG.md).
Stable release notes list all changes since the previous stable release.

To try a change from a nightly, read its release notes, then follow the linked
pull request or the feature's page in these docs. Report problems on [GitHub
issues](https://github.com/OpenAdminOS/OpenAdminOS/issues) with the nightly's
version from Settings > About.

## Requirements

- A Microsoft 365 tenant where you can approve the required Graph permissions.
- An LLM provider: a local option (Ollama, LM Studio, or Apple Foundation on compatible Macs) or a hosted option (OpenAI through the Codex CLI, Anthropic through the Claude Code CLI, GitHub Copilot CLI, Gemini CLI, or Azure OpenAI). See the LLM provider matrix for data-flow details.
- Network access to Microsoft Graph and the GitHub-hosted agent registry.
