# Releasing Open Agents

This is the maintainer runbook for cutting a release. Day-to-day work doesn't touch any of this.

The release surface is two-channel:

- **Windows → Microsoft Store** (MSIX, signed by Microsoft post-upload).
- **macOS → GitHub Releases + electron-updater** (signed + notarized in CI with our Apple Developer cert + App Store Connect API key).

A single tag push cuts both. CI handles everything except (a) one-time Apple secret setup and (b) the manual Partner Center upload for new Windows builds.

---

## One-time setup

### macOS — Apple Developer secrets

Add these five repository secrets at https://github.com/ugurkocde/OpenAgents/settings/secrets/actions.

| Secret | What | How to get it |
|---|---|---|
| `CSC_LINK` | Base64 of your `Developer ID Application` `.p12`. | Keychain → export the cert + private key as `.p12` → `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | Password you set when exporting the `.p12`. | You picked it during the export. |
| `APPLE_API_KEY` | Contents of an App Store Connect `.p8` private key (the full file, BEGIN/END lines included). | https://appstoreconnect.apple.com/access/integrations/api → Generate API Key with **Developer** access. Download the `.p8` once (Apple doesn't show it again). |
| `APPLE_API_KEY_ID` | 10-char Key ID for the same key. | Shown next to the key after generation. |
| `APPLE_API_ISSUER` | UUID issuer ID for your App Store Connect team. | Shown at the top of the API Keys page (looks like `69a6de80-...`). |

The CI workflow detects when these are missing and falls back to an unsigned `.dmg`/`.zip` so the build still completes (useful for forks and dry runs). Don't ship an unsigned build.

### Windows — Microsoft Store

No secrets needed in GitHub. CI builds an unsigned MSIX; Microsoft signs it after Partner Center submission.

The values in `apps/desktop/package.json` `build.appx` are the Partner Center-assigned identity for this app:

| Field | Value |
|---|---|
| `identityName` | `UgurLabs.UgurLabs.OpenAgents` |
| `publisher` | `CN=E5B1EEE1-CB55-4BCF-9214-2A6446BB2580` |
| `publisherDisplayName` | `UgurLabs` |
| Seller ID (for future Submission API automation) | `82025760` |

These match the Partner Center reservation for the `OpenAgents` Store name. Don't change them — Microsoft validates the MSIX against the registered identity at upload time.

---

## Cutting a release

```bash
# 1. Make sure main is green.
git checkout main && git pull
npm run typecheck && npm run qa && npm run build

# 2. Bump versions if you haven't already. (The release-v0.1.0 PR
#    pattern is the template — edit every workspace package.json, roll
#    the [Unreleased] section in CHANGELOG.md under the new version
#    header, merge through CI.)

# 3. Tag and push. Workflow fires automatically.
git tag -a v0.1.1 -m "Open Agents v0.1.1"
git push origin v0.1.1
```

CI then:

1. Builds the Windows MSIX on `windows-latest`.
2. Builds the signed + notarized macOS DMG/ZIP + `latest-mac.yml` on `macos-14`.
3. Downloads both into the `publish-release` job and pushes them to a **draft** GitHub release for `v0.1.1`.

Visit https://github.com/ugurkocde/OpenAgents/releases. The draft has all four artifacts attached.

## Manual steps after CI

### macOS — publish the release

1. Review the draft release on GitHub.
2. Smoke-test the DMG locally (download, open, drag-to-Applications, launch).
3. Click **Publish release** in the GitHub UI.

That's it. electron-updater on existing macOS installs picks up the new `latest-mac.yml` within 4 hours.

### Windows — Microsoft Store submission

1. Download the `.appx` (named like `Open Agents-x.y.z.appx`) from the draft release.
2. Go to https://partner.microsoft.com/dashboard.
3. Apps → **OpenAgents** → Submissions → **New submission** (or **Update**).
4. **Packages** section → upload the `.appx`.
5. Fill in the per-submission fields (release notes, age rating, etc.). For the first submission Partner Center walks you through everything; later submissions only need the new package + release notes.
6. **Submit to the Store**.

Certification typically takes 1–3 business days for the first submission and minutes-to-hours for updates. The Store handles distribution + auto-update on Windows; we don't need to ship anything else for Windows users.

---

## Why this shape

- **MSIX via Store, not signed sideload.** Microsoft signs the package after upload, which gives the app the Store's SmartScreen reputation from day one. A direct-download `.exe` signed with our own cert would trigger SmartScreen warnings for months until enough installs build reputation. The trade is one manual step per release (Partner Center upload) vs. paying for a code-signing cert + accepting the reputation cliff.
- **App Store Connect API key, not Apple ID + app-specific password.** Apple is phasing out the app-specific password path; the API key flow is the modern equivalent and works headlessly in CI.
- **Draft releases, not published.** Lets us eyeball the signed artifacts before they go live. Toggle `draft: true` to `draft: false` in `.github/workflows/release.yml` if you want auto-publish.
- **Apple Silicon only for v0.1.** macOS x64 + the per-arch manifest merge land in a follow-up when there's demand. Apple Silicon is the right default for new buyers; legacy Intel Macs are a smaller share each quarter.

## When to update this doc

Any time the secret list, the Partner Center identity, or the release workflow changes. Out-of-date release docs are how teams ship broken builds.
