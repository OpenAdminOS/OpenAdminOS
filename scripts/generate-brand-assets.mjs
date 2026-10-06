import sharp from 'sharp';
import { copyFile } from 'node:fs/promises';
const build = 'apps/desktop/build';
const raster = (source, target, width, height = width) => sharp(source).resize(width, height).png().toFile(target);
for (const [name, size] of [['icon',1024],['StoreLogo',50],['Square44x44Logo',44],['Square71x71Logo',71],['Square150x150Logo',150],['Square310x310Logo',310]]) {
  await raster(`${build}/icon-source.svg`, `${build}/${name}.png`, size);
}
for (const [name,w,h] of [['Wide310x150Logo',310,150],['SplashScreen',620,300]]) await raster(`${build}/${name}.source.svg`,`${build}/${name}.png`,w,h);
await raster('web/public/apple-icon.svg','web/public/apple-icon.png',180);
await raster('web/src/app/icon.svg','web/public/favicon-48.png',48);
await raster('web/src/app/opengraph-image.source.svg','web/src/app/opengraph-image.png',1200,630);
await copyFile('web/src/app/opengraph-image.png','web/src/app/twitter-image.png');
await raster(`${build}/dmg-background.svg`,`${build}/background-1x.png`,660,440);
await raster(`${build}/dmg-background.svg`,`${build}/background-2x.png`,1320,880);
