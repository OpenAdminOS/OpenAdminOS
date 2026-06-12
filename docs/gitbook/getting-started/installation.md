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

Windows packaging is part of the release pipeline. The Windows signing and distribution path is still being hardened, so use release notes for the current installer status.

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

## Requirements

- A Microsoft 365 tenant where you can approve the required Graph permissions.
- An LLM provider: Ollama locally, or OpenAI Codex through the local Codex CLI in the current preview.
- Network access to Microsoft Graph and the GitHub-hosted agent registry.
