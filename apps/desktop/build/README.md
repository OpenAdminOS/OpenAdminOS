# Desktop build assets

## App icon

- `icon-source.svg` — vector source of the Open Agents app icon.
- `icon.png` — 1024×1024 PNG, consumed by `electron-builder` to derive `.icns` / `.ico`.

## macOS DMG install window

The DMG install screen is styled to match the dark Open Agents brand: dark
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
