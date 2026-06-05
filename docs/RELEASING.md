# Releasing OpenAdminOS

This is the maintainer runbook for cutting a release. Day-to-day work doesn't touch any of this.

The release surface currently publishes macOS and Linux binaries:

- **macOS → GitHub Releases + electron-updater** (signed + notarized `.dmg` and `.pkg` in CI; `.zip` is published for electron-updater).
- **Linux → GitHub Releases** (unsigned x64 AppImage, `.deb`, and `.rpm` with SHA-256 checksums).
- **Windows → build validation only**. CI still creates the AppX package to keep the packaging path exercised, but it is not uploaded as a workflow artifact or attached to GitHub Releases until the signing/distribution path is ready.

A single tag push builds all three platform jobs. CI publishes macOS and Linux release files; Windows stays runner-local.

---

## One-time setup

### macOS — Apple Developer secrets

Add these seven repository secrets at https://github.com/OpenAdminOS/OpenAdminOS/settings/secrets/actions.

| Secret | What | How to get it |
|---|---|---|
| `CSC_LINK` | Base64 of your `Developer ID Application` `.p12`. This signs `OpenAdminOS.app`, the DMG, and the ZIP payload. | Keychain → export the cert + private key as `.p12` → `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | Password you set when exporting the `.p12`. | You picked it during the export. |
| `CSC_INSTALLER_LINK` | Base64 of your `Developer ID Installer` `.p12`. This signs the `.pkg` installer wrapper and is separate from `CSC_LINK`. | Keychain → export the installer cert + private key as `.p12` → `base64 -i installer-cert.p12 \| pbcopy`. |
| `CSC_INSTALLER_KEY_PASSWORD` | Password you set when exporting the installer `.p12`. | You picked it during the export. |
| `APPLE_API_KEY` | Contents of an App Store Connect `.p8` private key (the full file, BEGIN/END lines included). | https://appstoreconnect.apple.com/access/integrations/api → Generate API Key with **Developer** access. Download the `.p8` once (Apple doesn't show it again). |
| `APPLE_API_KEY_ID` | 10-char Key ID for the same key. | Shown next to the key after generation. |
| `APPLE_API_ISSUER` | UUID issuer ID for your App Store Connect team. | Shown at the top of the API Keys page (looks like `69a6de80-...`). |

The CI workflow detects when the app-signing secrets are missing and falls back to unsigned macOS artifacts so forks and dry runs still exercise the build path. If app-signing is enabled, `.pkg` publishing requires `CSC_INSTALLER_LINK` and `CSC_INSTALLER_KEY_PASSWORD`; the workflow fails early without them. Don't ship unsigned macOS artifacts.

For the installer certificate, a Keychain Access CSR is not required. A local OpenSSL CSR works as long as the private key is retained and paired with the downloaded Apple certificate:

```bash
mkdir -p ~/.openadminos/apple-signing
chmod 700 ~/.openadminos/apple-signing
openssl req -new -newkey rsa:2048 -nodes \
  -keyout ~/.openadminos/apple-signing/developer-id-installer.key \
  -out ~/.openadminos/apple-signing/developer-id-installer.csr \
  -subj "/emailAddress=support@openadminos.com/CN=OpenAdminOS Developer ID Installer/C=DE"
```

Upload the CSR to Apple, download the Developer ID Installer `.cer`, convert it to PEM if needed, export a `.p12` with a generated password, then set `CSC_INSTALLER_LINK` to the base64 `.p12` and `CSC_INSTALLER_KEY_PASSWORD` to that generated password.

### Windows — AppX build validation

The values in `apps/desktop/package.json` `build.appx` are the Partner Center-assigned identity for this app:

| Field | Value |
|---|---|
| `identityName` | `OpenAdminOS.OpenAdminOS.OpenAdminOS` |
| `publisher` | `CN=E5B1EEE1-CB55-4BCF-9214-2A6446BB2580` |
| `publisherDisplayName` | `OpenAdminOS` |
| Seller ID | `82025760` |

These match the Partner Center reservation for the `OpenAdminOS` Store name. Don't change them without updating the Windows distribution plan. The release workflow currently runs `electron-builder --win --publish never`, verifies that an `.appx` was produced under `apps/desktop/release/`, and leaves it on the runner.

---

## Cutting a release

The full flow is **two clicks in GitHub**. No local terminal needed.

1. **Run the Release prep workflow.**
   - Actions tab → **Release prep** → **Run workflow** → branch `main`.
   - Inputs: `bump` defaults to `patch` (the right answer for the v0.1.x line). Use `minor`/`major` or set `explicit_version` only when intentionally changing line.
   - On run: the workflow bumps every workspace `package.json`, rolls `CHANGELOG.md` so the `[Unreleased]` section becomes a dated `[X.Y.Z]` section, regenerates `package-lock.json`, and opens a `release: vX.Y.Z` PR.
2. **Review and merge the release PR.**
   - Skim the CHANGELOG roll (the most important review surface — make sure no entries are stuck under Unreleased that should have been edited).
   - Merge (squash). The squash-merge commit subject is `release: vX.Y.Z (#NN)`.
3. **The rest is automatic.**
   - `auto-tag.yml` fires on the `release: v*` commit landing on `main` → pushes the matching `vX.Y.Z` tag.
   - `release.yml` fires on the tag → builds macOS release files, Linux x64 packages, and the Windows AppX validation package.
   - The GitHub release receives macOS `.dmg`, `.pkg`, `.zip`, `latest-mac.yml`, Linux AppImage/`.deb`/`.rpm`, `latest-linux.yml`, and `SHA256SUMS.txt`. The AppX is not uploaded.

### Manual fallback (if the workflow ever breaks)

```bash
# 1. Confirm main is green.
git checkout main && git pull
npm run typecheck && npm run qa && npm run build

# 2. Bump locally with the same script the workflow uses.
BUMP_TYPE=patch node scripts/prepare-release.mjs

# 3. Open the PR by hand.
git checkout -b release/v0.1.X
git add -A
git commit -m "release: v0.1.X"
git push -u origin release/v0.1.X
gh pr create --title "release: v0.1.X" --body "Manual release prep."

# 4. After PR merges, auto-tag.yml still picks it up. (If that also
#    breaks, tag manually: git tag -a v0.1.X && git push origin v0.1.X.)
```

## Manual steps after CI

### macOS — smoke-test the release

1. Review the published release on GitHub.
2. Smoke-test the DMG locally (download, open, drag-to-Applications, launch).
3. Smoke-test the PKG locally (`sudo installer -pkg OpenAdminOS-*.pkg -target /`, then launch from Applications).

That's it. electron-updater on existing macOS installs picks up the new `latest-mac.yml` within 4 hours.

### v0.2.1 macOS PKG backfill

The already-published `v0.2.1` release was backfilled with
`OpenAdminOS-0.2.1-arm64.pkg` on June 5, 2026. The one-off workflow checked out
the immutable `v0.2.1` tag, patched only the CI-local Electron Builder config to
build the arm64 PKG, signed/notarized it with the Developer ID Application and
Developer ID Installer secrets, uploaded it to the existing release, and
refreshed `SHA256SUMS.txt` plus the checksum block in the release notes. The
temporary workflow was removed after the successful run; normal releases now use
the standard `release.yml` path.

### Windows — no published package yet

Do not upload AppX files to GitHub Releases until the Windows signing/distribution path is ready. The CI build output is intentionally runner-local.

---

## Why this shape

- **Build AppX, don't publish it yet.** Keeping the AppX build in CI catches packaging regressions early. With no current Windows signing path, publishing the file would create an unusable release asset.
- **App Store Connect API key, not Apple ID + app-specific password.** Apple is phasing out the app-specific password path; the API key flow is the modern equivalent and works headlessly in CI.
- **DMG stays primary, PKG supports managed deployment.** The DMG is the normal user-facing macOS installer. The PKG exists for MDM/fleet tooling and needs a separate Developer ID Installer certificate.
- **Apple Silicon only for v0.1.** macOS x64 + the per-arch manifest merge land in a follow-up when there's demand. Apple Silicon is the right default for new buyers; legacy Intel Macs are a smaller share each quarter.

## When to update this doc

Any time the secret list, the Partner Center identity, or the release workflow changes. Out-of-date release docs are how teams ship broken builds.
