# Desktop brand assets

The OA monogram uses graphite (#17191D) and off-white (#F4F5F7). The vector
reference is `docs/brand/oa-mark.svg`. `icon-source.svg` adds the rounded tile
and transparent Dock margin. Electron Builder derives ICO and ICNS from the
1024px `icon.png`. AppX square, wide, and splash assets are checked in.

From the repository root, regenerate desktop, website favicon, and social PNGs:

```sh
node scripts/generate-brand-assets.mjs
tiffutil -cathidpicheck apps/desktop/build/background-1x.png apps/desktop/build/background-2x.png -out apps/desktop/build/background.tiff
```

The script uses Sharp already installed in the workspace. `tiffutil` ships
with macOS. Commit generated assets so release builders need no rasterizer.
The DMG background is 660 by 440; icon centers remain (170,230) and (490,230).
Historical concepts in `icon-concepts/` are not production assets.
