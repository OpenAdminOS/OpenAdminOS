# Desktop build assets

## App icon

- `icon-source.svg` — vector source of the OpenAdminOS app icon.
- `icon.png` — 1024×1024 PNG, consumed by `electron-builder` to derive `.icns` / `.ico`.

## Microsoft Store / AppX tile assets

`electron-builder`'s AppX target auto-discovers these by filename from
`build/`. They replace the default Electron placeholder tiles which
otherwise get flagged under Store policy **10.1.1.11 On Device Tiles**
("Tile icons must uniquely represent the product").

| File | Size | Where it shows |
|---|---|---|
| `StoreLogo.png` | 50×50 | Microsoft Store product page |
| `Square44x44Logo.png` | 44×44 | App list, taskbar |
| `Square71x71Logo.png` | 71×71 | Small Start tile |
| `Square150x150Logo.png` | 150×150 | Medium Start tile |
| `Square310x310Logo.png` | 310×310 | Large Start tile |
| `Wide310x150Logo.png` | 310×150 | Wide Start tile |
| `SplashScreen.png` | 620×300 | Launch splash |

Square tiles are rendered directly from `icon-source.svg`. The wide tile
and splash use small inline SVGs that put the icon on the brand dark
canvas (`#0a0a0c`).

### Regenerating

Requires `rsvg-convert` (`brew install librsvg`):

```sh
cd apps/desktop/build
SRC=icon-source.svg
rsvg-convert -w 50  -h 50  $SRC -o StoreLogo.png
rsvg-convert -w 44  -h 44  $SRC -o Square44x44Logo.png
rsvg-convert -w 71  -h 71  $SRC -o Square71x71Logo.png
rsvg-convert -w 150 -h 150 $SRC -o Square150x150Logo.png
rsvg-convert -w 310 -h 310 $SRC -o Square310x310Logo.png
rsvg-convert -w 310 -h 150 Wide310x150Logo.source.svg -o Wide310x150Logo.png
rsvg-convert -w 620 -h 300 SplashScreen.source.svg     -o SplashScreen.png
```

`Wide310x150Logo.source.svg` and `SplashScreen.source.svg` are the
on-brand sources for the two non-square tiles. Edit them, then rerun
the rasterize commands above.

## macOS DMG install window

The DMG install screen is styled to match the dark OpenAdminOS brand: dark
gradient background, a headline that tells the user what to do, and a tinted
arrow pointing from the app icon slot to the Applications shortcut. See
`docs/SPEC.md` for the trust story this aesthetic supports.

Files:

- `dmg-background.svg` — source of the install window background (660×440).
- `background-1x.png`, `background-2x.png` — rendered at 1× and 2× from the SVG.
- `background.tiff` — multi-resolution TIFF combining both PNGs. This is the file
  `electron-builder` actually reads (`build.dmg.background` in `package.json`).

Icon positions in `package.json` (`build.dmg.contents`) are calibrated to match
the arrow in the SVG. If you change the SVG layout, update both.

### Regenerating the background

Requires `rsvg-convert` (`brew install librsvg`) and macOS `tiffutil`:

```sh
cd apps/desktop/build
rsvg-convert -w 660  -h 440 dmg-background.svg -o background-1x.png
rsvg-convert -w 1320 -h 880 dmg-background.svg -o background-2x.png
tiffutil -cathidpicheck background-1x.png background-2x.png -out background.tiff
```

Commit the resulting `background.tiff` (and the two PNGs) so CI builds don't
need `rsvg-convert` installed.
