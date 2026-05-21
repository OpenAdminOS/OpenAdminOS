# Releasing OpenAdminOS

This is the maintainer runbook for cutting a release. Day-to-day work doesn't touch any of this.

The release surface is two-channel:

- **Windows → Microsoft Store** (MSIX, signed by Microsoft post-upload).
- **macOS → GitHub Releases + electron-updater** (signed + notarized in CI with our Apple Developer cert + App Store Connect API key).

A single tag push cuts both. CI handles everything except (a) one-time Apple secret setup and (b) the manual Partner Center upload for new Windows builds.

---

## One-time setup

### macOS — Apple Developer secrets

Add these five repository secrets at https://github.com/OpenAdminOS/OpenAdminOS/settings/secrets/actions.

| Secret | What | How to get it |
|---|---|---|
| `CSC_LINK` | Base64 of your `Developer ID Application` `.p12`. | Keychain → export the cert + private key as `.p12` → `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | Password you set when exporting the `.p12`. | You picked it during the export. |
| `APPLE_API_KEY` | Contents of an App Store Connect `.p8` private key (the full file, BEGIN/END lines included). | https://appstoreconnect.apple.com/access/integrations/api → Generate API Key with **Developer** access. Download the `.p8` once (Apple doesn't show it again). |
| `APPLE_API_KEY_ID` | 10-char Key ID for the same key. | Shown next to the key after generation. |
| `APPLE_API_ISSUER` | UUID issuer ID for your App Store Connect team. | Shown at the top of the API Keys page (looks like `69a6de80-...`). |

The CI workflow detects when these are missing and falls back to an unsigned `.dmg`/`.zip` so the build still completes (useful for forks and dry runs). Don't ship an unsigned build.

### Windows — Microsoft Store

The first submission is manual via Partner Center. Every release after that is auto-submitted by `.github/workflows/store-publish.yml` when you click **Publish release** on the GitHub draft.

The values in `apps/desktop/package.json` `build.appx` are the Partner Center-assigned identity for this app:

| Field | Value |
|---|---|
| `identityName` | `OpenAdminOS.OpenAdminOS.OpenAdminOS` |
| `publisher` | `CN=E5B1EEE1-CB55-4BCF-9214-2A6446BB2580` |
| `publisherDisplayName` | `OpenAdminOS` |
| Seller ID | `82025760` |

These match the Partner Center reservation for the `OpenAdminOS` Store name. Don't change them — Microsoft validates the MSIX against the registered identity at upload time.

#### One-time setup to enable Store auto-publish

Do this once, after the first manual submission has been accepted by Partner Center.

1. **Associate an Azure AD tenant with Partner Center.**
   Partner Center → **Account settings** → **Tenants** → **Associate Azure AD**. Use the same tenant you use for everything else (or create a dedicated one if you prefer isolation).
2. **Create an Azure AD app registration.**
   In the Azure portal → Microsoft Entra ID → **App registrations** → **New registration**. Single tenant is fine. No redirect URI needed.
3. **Create a client secret.**
   App registration → **Certificates & secrets** → **New client secret**. Copy the value once — Azure won't show it again.
4. **Grant the app Manager access in Partner Center.**
   Partner Center → **Account settings** → **User management** → **Azure AD applications** → **Add Azure AD applications** → pick the registration → role **Manager**. Manager is required for the Submission API; lower roles can't push packages.
5. **Capture the Store App ID.**
   Partner Center → **Apps** → **OpenAdminOS** → **Product identity**. The 12-character Store ID (looks like `9NABCDEFGHIJ`) is what `MS_STORE_APP_ID` needs.
6. **Add the four secrets to GitHub.**
   Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

   | Secret | Value |
   |---|---|
   | `PARTNER_CENTER_TENANT_ID` | The Azure AD tenant directory (tenant) ID from step 1. |
   | `PARTNER_CENTER_CLIENT_ID` | The app registration's Application (client) ID from step 2. |
   | `PARTNER_CENTER_CLIENT_SECRET` | The client secret value from step 3. |
   | `MS_STORE_APP_ID` | The Store App ID from step 5. |

   (`Seller ID` is hardcoded as `82025760` in the workflow — it isn't secret.)

Until all four secrets exist, the workflow runs but logs a warning and exits. Once they're set, the next time you publish a GitHub release the `.appx` is submitted automatically. You can also re-run it by hand from the Actions tab against any tag.

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
   - `release.yml` fires on the tag → builds the signed installers → uploads them to a **draft** GitHub release.
   - You publish the macOS side from the GitHub UI; you upload the `.appx` to Partner Center for Windows.

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

### macOS — publish the release

1. Review the draft release on GitHub.
2. Smoke-test the DMG locally (download, open, drag-to-Applications, launch).
3. Click **Publish release** in the GitHub UI.

That's it. electron-updater on existing macOS installs picks up the new `latest-mac.yml` within 4 hours.

### Windows — Microsoft Store submission

**First submission (manual, once):**

1. Download the `.appx` (named like `OpenAdminOS-x.y.z.appx`) from the draft release.
2. Go to https://partner.microsoft.com/dashboard.
3. Apps → **OpenAdminOS** → Submissions → **New submission**.
4. **Packages** section → upload the `.appx`.
5. Fill in the per-submission fields (description, screenshots, age rating, privacy policy URL, etc.). Partner Center walks you through everything.
6. **Submit to the Store**.
7. After it's accepted, complete the **one-time setup to enable Store auto-publish** in the Windows section above so the next release goes out automatically.

**Subsequent submissions (automatic):**

Once the Store secrets are configured, clicking **Publish release** on the GitHub draft fires `store-publish.yml`, which downloads the `.appx` from the release assets and submits it via the `msstore` CLI. No Partner Center clicks needed. Release-notes copy still has to come from the GitHub release body — Partner Center reuses the previous submission's description fields automatically.

Certification typically takes 1–3 business days for the first submission and minutes-to-hours for updates. The Store handles distribution + auto-update on Windows; we don't need to ship anything else for Windows users.

---

## Why this shape

- **MSIX via Store, not signed sideload.** Microsoft signs the package after upload, which gives the app the Store's SmartScreen reputation from day one. A direct-download `.exe` signed with our own cert would trigger SmartScreen warnings for months until enough installs build reputation. The trade is one manual step per release (Partner Center upload) vs. paying for a code-signing cert + accepting the reputation cliff.
- **App Store Connect API key, not Apple ID + app-specific password.** Apple is phasing out the app-specific password path; the API key flow is the modern equivalent and works headlessly in CI.
- **Draft releases, not published.** Lets us eyeball the signed artifacts before they go live. Toggle `draft: true` to `draft: false` in `.github/workflows/release.yml` if you want auto-publish.
- **Apple Silicon only for v0.1.** macOS x64 + the per-arch manifest merge land in a follow-up when there's demand. Apple Silicon is the right default for new buyers; legacy Intel Macs are a smaller share each quarter.

## When to update this doc

Any time the secret list, the Partner Center identity, or the release workflow changes. Out-of-date release docs are how teams ship broken builds.
