import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const sourceFile = join(desktopDir, "electron/menu-bar-helper/main.swift");
const packageJson = JSON.parse(
  readFileSync(join(desktopDir, "package.json"), "utf8"),
);

const appName = "OpenAdminOS Menu Bar Helper";
const bundleId = "com.openadminos.desktop.menubar-helper";
const outputRoot = join(desktopDir, "build/menu-bar-helper");
const appBundle = join(outputRoot, `${appName}.app`);
const contentsDir = join(appBundle, "Contents");
const macosDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");
const executablePath = join(macosDir, appName);
const infoPlistPath = join(contentsDir, "Info.plist");
const pkgInfoPath = join(contentsDir, "PkgInfo");
const sourceIconPath = join(desktopDir, "build/icon.png");
const iconsetPath = join(outputRoot, "OpenAdminOS.iconset");
const helperIconPath = join(resourcesDir, "OpenAdminOS.icns");

if (process.platform !== "darwin") {
  console.log("Skipping menu bar helper build: not macOS.");
  process.exit(0);
}

rmSync(appBundle, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

const build = spawnSync(
  "swiftc",
  [
    "-O",
    "-Xlinker",
    "-dead_strip",
    sourceFile,
    "-o",
    executablePath,
  ],
  { stdio: "inherit" },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

chmodSync(executablePath, 0o755);

function run(command, args, stdio = "inherit") {
  const result = spawnSync(command, args, { stdio });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildHelperIcon() {
  if (!existsSync(sourceIconPath)) {
    console.error(`Menu bar helper icon source is missing: ${sourceIconPath}`);
    process.exit(1);
  }

  rmSync(iconsetPath, { recursive: true, force: true });
  mkdirSync(iconsetPath, { recursive: true });

  const iconSizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  for (const [size, filename] of iconSizes) {
    run("sips", [
      "-z",
      String(size),
      String(size),
      sourceIconPath,
      "--out",
      join(iconsetPath, filename),
    ], "ignore");
  }

  run("iconutil", ["-c", "icns", iconsetPath, "-o", helperIconPath]);
  rmSync(iconsetPath, { recursive: true, force: true });
}

buildHelperIcon();

const version = String(packageJson.version ?? "0.0.0");
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleIconFile</key>
  <string>OpenAdminOS</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
`;

writeFileSync(infoPlistPath, infoPlist, "utf8");
writeFileSync(pkgInfoPath, "APPL????", "utf8");

if (!existsSync(executablePath) || !existsSync(infoPlistPath) || !existsSync(helperIconPath)) {
  console.error(`Menu bar helper build did not create ${appBundle}.`);
  process.exit(1);
}

console.log(`Built menu bar helper at ${appBundle}`);
