# Releasing OpenAdminOS

This is the maintainer runbook for cutting a release. Day-to-day work doesn't touch any of this.

The release surface publishes Windows, macOS, and Linux binaries:

- **macOS → GitHub Releases + electron-updater** (signed + notarized `.dmg` and `.pkg` in CI; `.zip` is published for electron-updater).
- **Linux → GitHub Releases + apt** (unsigned x64 AppImage, `.deb`, and `.rpm` with SHA-256 checksums; the `.deb` is also published into a signed GitHub Pages-backed apt repository).
- **Windows → GitHub Releases + electron-updater** (x64 NSIS `.exe` installer, code signed through DigiCert KeyLocker; `latest.yml` is published for electron-updater). AppX packaging validation is still available as an opt-in manual job for the deferred Microsoft Store path, and that AppX is never published.

A single tag push builds the Windows, macOS, and Linux platform jobs, publishes their release files, and refreshes the apt repository from the latest `.deb`.

The macOS job also verifies the two bundled native helpers inside the packaged
app before uploading artifacts:

- Apple Foundation helper:
  `OpenAdminOS.app/Contents/Resources/native/apple-foundation-helper/openadminos-apple-foundation-helper`
- Menu bar login helper:
  `OpenAdminOS.app/Contents/Library/LoginItems/OpenAdminOS Menu Bar Helper.app`,
  including `Contents/Resources/OpenAdminOS.icns` and
  `CFBundleIconFile=OpenAdminOS`.
- Menu bar status item icon resource:
  `OpenAdminOS.app/Contents/Resources/app-icon.png`.
The macOS release job runs on GitHub's `macos-26` image because the bundled
Apple Foundation helper is built against `FoundationModels.framework`.

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

### Windows: DigiCert KeyLocker signing

The Windows installer is signed with an OV code signing certificate whose
subject organization is `Ugurlabs UG (haftungsbeschränkt)`. The private key is
held in DigiCert's cloud HSM (KeyLocker) and never reaches the runner: `smctl`
authenticates to DigiCert ONE and the signing operation happens remotely.

Configure these repository secrets:

| Secret | What |
|---|---|
| `SM_API_KEY` | DigiCert ONE service account API key. |
| `SM_CLIENT_CERT_FILE_B64` | Base64 of the KeyLocker client-authentication `.p12`. |
| `SM_CLIENT_CERT_PASSWORD` | Password for that `.p12`. |

Configure these repository variables:

| Variable | Value |
|---|---|
| `SM_HOST` | `https://clientauth.one.digicert.eu` |
| `SM_KEYPAIR_ALIAS` | Alias of the KeyLocker keypair to sign with. `smctl keypair list` prints it, and the release job also logs it. |

This DigiCert ONE tenant is the EU instance, so `SM_HOST` must be the EU
client-auth endpoint above. Pointing it at the wrong region surfaces as an
authentication error from `smctl healthcheck`.

Signing is driven per file by `apps/desktop/scripts/sign-windows.cjs`, which
electron-builder calls through `win.signtoolOptions.sign`. The hook refuses to
produce an unsigned build unless `OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1` is set
explicitly, and it treats a zero exit code from `smctl` as insufficient evidence
because some `smctl` versions report a failed signature on stdout and still exit
0.

`win.signtoolOptions.signingHashAlgorithms` is pinned to `["sha256"]`.
electron-builder otherwise defaults to `["sha1", "sha256"]` and calls the sign
hook once per algorithm, which would spend a second KeyLocker signature per file
and fail on a modern certificate. Each release consumes roughly three signatures
(app executable, uninstaller, installer) out of the certificate's purchased
allotment.

`win.signtoolOptions.publisherName` must match the certificate subject exactly.
electron-builder writes it into `latest.yml`, and electron-updater verifies
downloaded updates against it; if it is absent, update signature verification is
silently skipped. The release job asserts that `latest.yml` contains
`publisherName:`, checks the Authenticode status, and prints the actual signer
subject if the certificate common name does not match.

Because this is an OV rather than an EV certificate, Windows SmartScreen builds
reputation over download volume instead of trusting the signature immediately.
Early downloads may still show a "Windows protected your PC" prompt. Say so
plainly in release notes rather than implying a clean first run.

### Windows: AppX build validation

The values in `apps/desktop/package.json` `build.appx` are the Partner Center-assigned identity for this app:

| Field | Value |
|---|---|
| `identityName` | `OpenAdminOS.OpenAdminOS.OpenAdminOS` |
| `publisher` | `CN=E5B1EEE1-CB55-4BCF-9214-2A6446BB2580` |
| `publisherDisplayName` | `OpenAdminOS` |
| Seller ID | `82025760` |

These match the Partner Center reservation for the `OpenAdminOS` Store name. Don't change them without updating the Windows distribution plan. The Store path is deferred, so `appx` is no longer part of `build.win.target`. To validate it, run the **Release** workflow manually with `build_windows` enabled. That job runs `electron-builder --win=appx --publish never` with `OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1` (an AppX nobody installs isn't worth a KeyLocker signature), verifies that an `.appx` was produced under `apps/desktop/release/`, and leaves it on the runner. Version tags never schedule this job.

### Linux — apt repository

The apt repository is a static GitHub Pages deployment served at `https://repo.openadminos.com/debian`. It is regenerated from the release `.deb` on every `v*` tag. No package repository vendor, storage bucket, or checked-in package index is required.
The repository builder validates the `.deb` architecture from package control metadata, not from the release asset filename; Electron Builder names assets like `OpenAdminOS-X.Y.Z-linux-amd64.deb`, which is not the Debian `*_amd64.deb` suffix format.

One-time GitHub setup:

1. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
2. Configure the Pages custom domain as `repo.openadminos.com`.
3. In DNS, point `repo.openadminos.com` at GitHub Pages for the `OpenAdminOS` organization.
4. Enable HTTPS once GitHub has issued the Pages certificate.

One-time signing setup:

1. Create a dedicated OpenAdminOS Linux archive OpenPGP key. Use a long-lived RSA key for broad apt compatibility.
2. Add the ASCII-armored private key as the `APT_GPG_PRIVATE_KEY` repository secret.
3. If the key has a passphrase, add it as `APT_GPG_PASSPHRASE`.
4. Record the public fingerprint in release notes/docs after the first successful deployment.

Current archive key:

```text
OpenAdminOS Linux Archive <support@openadminos.com>
Fingerprint: 19CE B561 9FD8 BD30 4FFA  F281 8ED8 4B68 EAE8 5363
Expires: 2029-06-04
```

The workflow exports the public key to `https://repo.openadminos.com/debian/openadminos-archive-keyring.pgp`, generates `Packages` / `Packages.gz`, signs `Release` as both `InRelease` and `Release.gpg`, and deploys the static repository through first-party GitHub Pages actions.

To republish an existing release into apt without rebuilding the app, run the
**Release** workflow manually from `main` and set `backfill_apt_tag` to the
release tag, for example `v0.2.1`.

---

## Cutting a release

The normal flow needs only the release-prep run and PR merge in GitHub. No
local terminal is needed. A release that changes commit-derived documentation
can require merging the generated-doc follow-up before CI is green.

1. **Run the Release prep workflow.**
   - Actions tab → **Release prep** → **Run workflow** → branch `main`.
   - Inputs: `bump` defaults to `patch` (the right answer for the v0.1.x line). Use `minor`/`major` or set `explicit_version` only when intentionally changing line.
   - On run: the workflow bumps every workspace `package.json`, rolls `CHANGELOG.md` so the `[Unreleased]` section becomes a dated `[X.Y.Z]` section, regenerates `package-lock.json`, and opens a `release: vX.Y.Z` PR.
2. **Review and merge the release PR.**
   - Skim the CHANGELOG roll (the most important review surface — make sure no entries are stuck under Unreleased that should have been edited).
   - Merge the `release: vX.Y.Z` PR after its checks pass.
3. **Let main finish reconciling and pass CI.**
   - If the squash merge changes commit-derived GitBook metadata, the Documentation workflow opens a one-line generated-doc PR. Review and merge it before release tagging; the failed main CI run is expected to remain red until that generated update lands.
4. **The rest is automatic.**
   - After CI succeeds on the current `main` commit, `auto-tag.yml` reads the version from `package.json`. If that version has no tag yet, it tags that exact green commit as `vX.Y.Z`. A stale successful run is ignored when `main` has already advanced.
   - `release.yml` fires on the tag → builds the signed Windows x64 installer, macOS release files, and Linux x64 packages.
   - The GitHub release receives the Windows `.exe` and `latest.yml`, macOS `.dmg`, `.pkg`, `.zip`, `latest-mac.yml`, Linux AppImage/`.deb`/`.rpm`, `latest-linux.yml`, and `SHA256SUMS.txt`. The AppX is not uploaded.
   - The apt repository at `repo.openadminos.com` is regenerated from the release `.deb` and deployed to GitHub Pages.

### One-time branch packaging test

Use this when validating release workflow changes before they land on `main`.
Run the **Release** workflow manually from the Actions tab, choose the feature
branch, and leave `build_windows` off unless you also need AppX validation. The
manual branch run uploads Windows, macOS, and Linux artifacts as workflow
artifacts only; it does not create or publish a GitHub Release because
publishing is still gated to `refs/tags/v*`. A manual run without the DigiCert
settings configured produces an explicitly unsigned Windows installer and skips
signature verification; a tagged run fails outright if any of them is missing.

Every CI and tagged release run also executes `npm run release:check`. The gate
keeps the macOS application/update identity and Linux package/executable
identity stable, requires every versioned workspace to match the release
version, and requires matching release notes. The desktop host test suite opens
legacy JSON and SQLite fixtures and verifies that additive migrations preserve
tenant, run, agent, chat, and cache data.

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

# 4. After the PR (and any generated-doc follow-up) merges and main CI
#    passes, auto-tag.yml still picks it up. (If that also
#    breaks, tag manually: git tag -a v0.1.X && git push origin v0.1.X.)
```

## Manual steps after CI

### macOS — smoke-test the release

1. Review the published release on GitHub.
2. Smoke-test the DMG locally (download, open, drag-to-Applications, launch).
3. Smoke-test the PKG locally (`sudo installer -pkg OpenAdminOS-*.pkg -target /`, then launch from Applications).

That's it. electron-updater on existing macOS installs picks up the new `latest-mac.yml` within 4 hours.

### Windows: smoke-test the release

1. Review the published release on GitHub.
2. Download `OpenAdminOS-<version>-win-x64.exe` and `latest.yml`.
3. On a Windows test machine, verify the installer signature:

```powershell
$signature = Get-AuthenticodeSignature .\OpenAdminOS-<version>-win-x64.exe
$signature.Status
$signature.SignerCertificate.Subject
```

The status must be `Valid`, and the signer certificate subject must include
`CN=Ugurlabs UG (haftungsbeschränkt)`.

4. Run the installer as a normal user. It is a per-user NSIS install and should
   not require administrator rights.
5. Launch OpenAdminOS and confirm update metadata reads from GitHub Releases.

Because this is an OV certificate, Windows SmartScreen may still show "Windows
protected your PC" until the installer builds download reputation. That is not
the same as an unsigned installer. If the certificate publisher is correct, use
**More info** → **Run anyway** for the smoke test.

### Linux — smoke-test the apt repository

After a release, verify the repository metadata is reachable and signed:

```bash
curl -fsSL https://repo.openadminos.com/debian/dists/stable/InRelease >/tmp/openadminos-InRelease
curl -fsSL https://repo.openadminos.com/debian/openadminos-archive-keyring.pgp >/tmp/openadminos-archive-keyring.pgp
gpg --show-keys /tmp/openadminos-archive-keyring.pgp
```

On a disposable Ubuntu or Debian-family machine:

```bash
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://repo.openadminos.com/debian/openadminos-archive-keyring.pgp \
  | sudo tee /usr/share/keyrings/openadminos-archive-keyring.pgp >/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openadminos-archive-keyring.pgp] https://repo.openadminos.com/debian stable main" \
  | sudo tee /etc/apt/sources.list.d/openadminos.list
sudo apt update
apt-cache policy openadminos
```

### v0.2.1 macOS PKG backfill

The already-published `v0.2.1` release was backfilled with
`OpenAdminOS-0.2.1-arm64.pkg` on June 5, 2026. The one-off workflow checked out
the immutable `v0.2.1` tag, patched only the CI-local Electron Builder config to
build the arm64 PKG, signed/notarized it with the Developer ID Application and
Developer ID Installer secrets, uploaded it to the existing release, and
refreshed `SHA256SUMS.txt` plus the checksum block in the release notes. The
temporary workflow was removed after the successful run; normal releases now use
the standard `release.yml` path.

### Windows: AppX stays unpublished

The published Windows artifact is the signed NSIS installer. Do not upload AppX
files to GitHub Releases; that packaging validation is explicit, manual, and its
build output is intentionally runner-local until the Microsoft Store path is
actually pursued.

---

## Why this shape

- **NSIS installer, not AppX, as the shipped Windows artifact.** An `.exe` installs from a downloaded file without Store enrollment or sideloading policy, and it is the only Windows target electron-updater can auto-update. AppX remains built on request so the Store path doesn't rot.
- **Per-user install by default.** `nsis.perMachine` is false, so installing and auto-updating never prompt for elevation. An admin tool that demands local admin rights to update itself is a bad trade.
- **Signing key stays in DigiCert's HSM.** KeyLocker means no `.pfx` and no signing key material in GitHub secrets. The runner holds only an API key and a client-authentication certificate, both revocable from DigiCert ONE without reissuing the code signing certificate.
- **Validate AppX only when requested.** Keeping the AppX job available catches packaging regressions when maintainers need it, without spending a signature or publishing an unsigned package.
- **App Store Connect API key, not Apple ID + app-specific password.** Apple is phasing out the app-specific password path; the API key flow is the modern equivalent and works headlessly in CI.
- **DMG stays primary, PKG supports managed deployment.** The DMG is the normal user-facing macOS installer. The PKG exists for MDM/fleet tooling and needs a separate Developer ID Installer certificate.
- **GitHub Pages is enough for apt.** The apt repository is static metadata plus the latest `.deb`. GitHub Actions can regenerate and sign it on every tag, and GitHub Pages can serve it over HTTPS under `repo.openadminos.com` without a package-hosting vendor.
- **Apple Silicon only for v0.1.** macOS x64 + the per-arch manifest merge land in a follow-up when there's demand. Apple Silicon is the right default for new buyers; legacy Intel Macs are a smaller share each quarter.

## When to update this doc

Any time the secret list, the Partner Center identity, or the release workflow changes. Out-of-date release docs are how teams ship broken builds.
