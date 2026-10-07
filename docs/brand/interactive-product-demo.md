# Clickable desktop screenshots

The homepage preview displays actual screenshots from the built Electron app. It does not reimplement the app's layout or controls in HTML.

## Capture

```sh
npm run build -w @openadminos/desktop
node scripts/capture-website-demo.mjs
```

The capture script serves the compiled `apps/desktop/dist` assets on a temporary loopback port, launches Electron with the existing isolated screenshot fixture, captures the app's pages and selected dialogs, then closes the process and deletes its temporary user profile. It does not use the operator's app profile. Only the unpackaged screenshot harness can invoke this capture path.

`web/public/product-demo/*.png` are unedited Electron `capturePage()` outputs. `screens.json` records each image's dimensions and the DOM bounds and accessible labels of its visible controls. Hidden or occluded controls are excluded. No tenant or model credentials are required.

## Website behavior

- Sidebar navigation, agent tabs and details, settings sections, change tabs, and captured dialogs switch between the real screenshots.
- Buttons are transparent overlays at the recorded percentage coordinates, with hover/focus feedback. The image's aspect ratio is preserved.
- Unsupported actions explain that the desktop app is required. The site never reports that a tenant change or installation succeeded.
- No extra label, walkthrough, or reset toolbar is added above the app.
- On narrow screens, the desktop canvas pans horizontally within its container. It is not replaced with a redesigned mobile app.
- Only the initial screenshot loads immediately. A requested screenshot is loaded before its hotspots become active; failures provide recovery.
- JavaScript-disabled visitors see the existing static desktop screenshot.

## Validation

Build the desktop before capturing. Then run `npm --prefix web run typecheck` and `npm --prefix web run build`. Verify the sidebar, settings tabs, detail/modal navigation, keyboard focus, and image alignment at desktop and mobile widths. Confirm that every navigation target exists and every hotspot stays within its image bounds.
