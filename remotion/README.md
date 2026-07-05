# OpenAdminOS Remotion

This folder contains the local Remotion project used to render marketing video assets. It is intentionally separate from the root npm workspace and is not installed on Vercel.

Renders happen locally. Generated outputs are written to `../web/public/videos/` and committed from there when the video changes.

```sh
npm run studio
npm run render
```

`npm run render` creates `hero-demo.mp4` and `hero-demo-poster.jpg`.
