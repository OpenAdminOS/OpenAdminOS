# Desktop brand assets

The oa ligature mark uses ink (#1F1D1A) and paper (#FAF9F6). The vector
reference is `docs/brand/oa-mark.svg`. `icon-source.svg` places the paper mark
on an ink rounded tile with a transparent Dock margin. Electron Builder derives
ICO and ICNS from the 1024px `icon.png`. AppX square, wide, and splash assets
are checked in.

From the repository root, regenerate desktop, website favicon, and social PNGs:

```sh
node scripts/generate-brand-assets.mjs
tiffutil -cathidpicheck apps/desktop/build/background-1x.png apps/desktop/build/background-2x.png -out apps/desktop/build/background.tiff
```

The script uses Sharp already installed in the workspace. `tiffutil` ships
with macOS. On other systems, Pillow writes the same two-frame LZW TIFF (both
frames at 72 dpi; macOS picks the frame by pixel size):

```sh
python3 -c "from PIL import Image; d='apps/desktop/build/'; a=Image.open(d+'background-1x.png').convert('RGBA'); b=Image.open(d+'background-2x.png').convert('RGBA'); a.save(d+'background.tiff', save_all=True, append_images=[b], compression='tiff_lzw', dpi=(72,72))"
```

Commit generated assets so release builders need no rasterizer.
The DMG background is 660 by 440; icon centers remain (170,230) and (490,230).
Historical concepts in `icon-concepts/` are not production assets.
