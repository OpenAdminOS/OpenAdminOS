---
title: "Installation"
description: "Install OpenAdminOS on a supported desktop."
---

# Installation

OpenAdminOS ships as a desktop app. The project does not publish an end-user CLI.

## macOS

Download the signed `.dmg` from the latest GitHub release, drag OpenAdminOS to Applications, and launch it from Applications. Managed deployments can use the signed `.pkg` from the same release.

## Windows

Windows packaging is part of the release pipeline. The Windows signing and distribution path is still being hardened, so use release notes for the current installer status.

## Linux

Linux x64 packages are published as AppImage, `.deb`, and `.rpm`. Verify the SHA-256 hash from the release notes or `SHA256SUMS.txt` before installing.

## Requirements

- A Microsoft 365 tenant where you can approve the required Graph permissions.
- An LLM provider: Ollama locally, or OpenAI Codex through the local Codex CLI in the current preview.
- Network access to Microsoft Graph and the GitHub-hosted agent registry.
