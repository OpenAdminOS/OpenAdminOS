// Renders the relief-map stage artwork in web/public/art/ from topo.html.
//
// Not part of the site build. Run it by hand when the stages change:
//   npx -y -p playwright-core@latest node web/scripts/stage-art/render.mjs
// with CHROME_PATH pointing at a Chromium binary, then convert each PNG in
// ./out to a 1920x1200 WebP (quality 78) in web/public/art/.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const variants = JSON.parse(
  readFileSync(new URL("./variants.json", import.meta.url), "utf8"),
);
const outDir = new URL("./out/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
await page.goto(new URL("./topo.html", import.meta.url).href);
for (const variant of variants) {
  await page.setViewportSize({ width: variant.w, height: variant.h });
  await page.evaluate((options) => window.render(options), variant);
  await page
    .locator("#c")
    .screenshot({ path: new URL(`${variant.name}.png`, outDir).pathname });
  console.log(variant.name);
}
await browser.close();
