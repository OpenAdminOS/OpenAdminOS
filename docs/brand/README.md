# OpenAdminOS monochrome identity

The oa ligature mark uses ink `#1F1D1A` and paper `#FAF9F6`. Use the inverse
for dark surfaces. Keep success, warning, error, information, and reasoning
colors meaningful; they are not alternative brand accents.

- `oa-mark.svg`: vector geometry, no tile background.
- `../../apps/desktop/build/icon-source.svg`: packaged app icon with Dock margin.
- `../mockups/28-logo-explorations.html`: approved ligature design reference.
- `../screenshots/app/brand-dark-*.png` and `brand-light-*.png`: synthetic desktop
  evidence across the current route families. No real tenant data is included.

Desktop tokens live in `apps/desktop/src/styles/globals.css`; website tokens
live in `web/src/styles/globals.css`. See the design-system section of SPEC.md.

To regenerate raster icons, run `node scripts/generate-brand-assets.mjs`.
To refresh theme screenshots, run `OPENADMINOS_BRAND_CAPTURE=1 npm run screenshots`.
The ordinary screenshot command retains its width and reduced-motion matrix.
