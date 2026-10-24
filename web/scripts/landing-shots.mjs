// Converts the landing captures in docs/screenshots/landing (written by
// `npm run screenshots:landing` at the repo root) to the WebP files the
// homepage serves from public/app. Not part of the site build.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = new URL("../../docs/screenshots/landing/", import.meta.url);
const target = new URL("../public/app/", import.meta.url);

const files = (await readdir(source)).filter((file) => file.endsWith(".png"));
if (files.length === 0) {
  throw new Error("No landing captures found. Run `npm run screenshots:landing` first.");
}
for (const file of files) {
  const out = fileURLToPath(new URL(file.replace(/\.png$/, ".webp"), target));
  const info = await sharp(fileURLToPath(new URL(file, source)))
    .webp({ quality: 82 })
    .toFile(out);
  console.log(`[landing-shots] ${file} -> public/app (${info.width}x${info.height}, ${Math.round(info.size / 1024)} KB)`);
}
