# Brand assets

Press-kit-ish folder for OpenAdminOS visual identity. Sources are SVGs;
PNGs are rendered with `rsvg-convert` (`brew install librsvg`).

## Files

| File | Size | Purpose |
|---|---|---|
| `../../apps/desktop/build/icon-source.svg` | 1024x1024 | Canonical app icon source |
| `avatar-500.png` | 500x500 | GitHub org avatar (small uploads) |
| `avatar-1024.png` | 1024x1024 | GitHub org avatar (high-res), favicons, etc. |
| `social-preview.source.svg` | 1280x640 | Source for the repo social preview |
| `social-preview.png` | 1280x640 | GitHub repo social preview |

## Where to upload

### Organization avatar (`avatar-500.png` or `avatar-1024.png`)

1. Go to <https://github.com/organizations/OpenAdminOS/settings/profile>.
2. **Profile picture** -> **Upload a photo** -> pick the PNG.
3. Crop dialog: leave default (full image), confirm.

Avatar updates propagate everywhere on GitHub within a few minutes.

### Repository social preview (`social-preview.png`)

1. Go to <https://github.com/OpenAdminOS/OpenAdminOS/settings>.
2. Scroll to **Social preview**.
3. **Edit** -> **Upload an image** -> pick `social-preview.png`.
4. Save.

This is what shows up when the repo URL is shared on Twitter, Bluesky,
LinkedIn, Slack, Discord, etc.

> GitHub does not expose REST or GraphQL endpoints for either of these
> uploads, so they have to go through the web UI.

## Regenerating

After editing a source SVG, re-rasterize from the repo root:

```sh
rsvg-convert -w 500  -h 500  apps/desktop/build/icon-source.svg -o docs/branding/avatar-500.png
rsvg-convert -w 1024 -h 1024 apps/desktop/build/icon-source.svg -o docs/branding/avatar-1024.png
rsvg-convert -w 1280 -h 640  docs/branding/social-preview.source.svg -o docs/branding/social-preview.png
```
