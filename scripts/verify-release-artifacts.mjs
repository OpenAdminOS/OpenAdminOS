import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { NIGHTLY_VERSION } from "./release-version.mjs";

function artifactLayout(platform, channel, version) {
  const prefix = `OpenAdminOS-${version}`;
  const channelName = channel === "nightly" ? "nightly" : "latest";
  const layouts = {
    "windows-x64": {
      manifest: `${channelName}.yml`,
      updateFiles: [`${prefix}-win-x64.exe`],
      packages: [],
    },
    "macos-arm64": {
      manifest: `${channelName}-mac.yml`,
      updateFiles: [`${prefix}-arm64.dmg`, `${prefix}-arm64-mac.zip`],
      packages: channel === "stable" ? [`${prefix}-arm64.pkg`] : [],
    },
    "linux-x64": {
      manifest: `${channelName}-linux.yml`,
      updateFiles: [`${prefix}-linux-x86_64.AppImage`],
      packages: [`${prefix}-linux-amd64.deb`, `${prefix}-linux-x86_64.rpm`],
    },
  };
  if (!Object.hasOwn(layouts, platform)) throw new Error(`Unknown release platform ${platform}.`);
  const { manifest, updateFiles, packages } = layouts[platform];
  return {
    manifest,
    updateFiles,
    binaries: [...updateFiles, ...packages],
    checksums: `${platform.split("-")[0]}-checksums.sha256`,
    checksumFiles: platform === "linux-x64" ? [...updateFiles, ...packages, manifest] : [...packages, manifest],
  };
}

function fileSize(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) throw new Error(`${path} is missing.`);
  if (!info.isFile() || info.size === 0) throw new Error(`${path} must be a nonempty file.`);
  return info.size;
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

async function recordChecksums(platform, channel, version, directory) {
  const { manifest, binaries, checksums, checksumFiles } = artifactLayout(platform, channel, version);
  for (const name of [...binaries, manifest]) fileSize(join(directory, name));

  const lines = [];
  for (const name of checksumFiles) {
    const digest = await hashFile(join(directory, name), "sha256", "hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(directory, checksums), `${lines.join("\n")}\n`);
}

async function readUpdateManifest(path, version) {
  fileSize(path);
  const metadata = parseYaml(await readFile(path, "utf8"), { filename: path });
  if (metadata?.version !== version || !Array.isArray(metadata.files)) {
    throw new Error(`${path} must describe version ${version} and list its files.`);
  }
  return metadata;
}

async function verifyUpdateEntry(path, size, entry, manifestPath) {
  if (size !== entry.size) {
    throw new Error(`${path} has ${size} bytes, expected ${entry.size} from ${manifestPath}.`);
  }
  if (await hashFile(path, "sha512", "base64") !== entry.sha512) {
    throw new Error(`${path} SHA-512 mismatch against ${manifestPath}.`);
  }
}

async function verifyAptPackage(version, directory) {
  const { manifest, binaries } = artifactLayout("linux-x64", "stable", version);
  const name = binaries.find((file) => file.endsWith(".deb"));
  const manifestPath = join(directory, manifest);
  const metadata = await readUpdateManifest(manifestPath, version);
  const entries = metadata.files.filter((entry) => entry?.url === name);
  if (entries.length !== 1) {
    throw new Error(`${manifestPath} must list exactly one entry for ${name}.`);
  }
  const path = join(directory, name);
  await verifyUpdateEntry(path, fileSize(path), entries[0], manifestPath);
  console.log(`Verified ${name} against ${manifest}.`);
}

async function verifyPlatform(platform, channel, version, directory) {
  const { manifest, updateFiles, binaries, checksums, checksumFiles } = artifactLayout(platform, channel, version);
  const sizes = new Map(binaries.map((name) => [name, fileSize(join(directory, name))]));
  fileSize(join(directory, manifest));
  fileSize(join(directory, checksums));

  const checksumsPath = join(directory, checksums);
  const lines = (await readFile(checksumsPath, "utf8")).trimEnd().split(/\r?\n/);
  for (const [index, name] of checksumFiles.entries()) {
    const match = lines[index]?.match(/^([a-f0-9]{64})  (.+)$/);
    if (match?.[2] !== name) throw new Error(`${checksumsPath} is missing a valid SHA-256 entry for ${name}.`);
    const path = join(directory, name);
    if (await hashFile(path, "sha256", "hex") !== match[1]) throw new Error(`${path} SHA-256 mismatch.`);
  }
  if (lines.length !== checksumFiles.length) throw new Error(`${checksumsPath} contains unexpected entries.`);

  const manifestPath = join(directory, manifest);
  const metadata = await readUpdateManifest(manifestPath, version);
  const hashes = new Map();
  for (const entry of metadata.files) {
    const name = entry?.url;
    if (!binaries.includes(name) || hashes.has(name)) {
      throw new Error(`${manifestPath} lists an unexpected or duplicate file ${JSON.stringify(name)}.`);
    }
    await verifyUpdateEntry(join(directory, name), sizes.get(name), entry, manifestPath);
    hashes.set(name, entry.sha512);
  }
  for (const name of updateFiles) {
    if (!hashes.has(name)) throw new Error(`${manifestPath} is missing the update entry for ${name}.`);
  }
  if (!updateFiles.includes(metadata.path)) {
    throw new Error(`${manifestPath} top-level path must name an expected update file.`);
  }
  if (metadata.sha512 !== hashes.get(metadata.path)) {
    throw new Error(`${manifestPath} top-level SHA-512 mismatch for ${metadata.path}.`);
  }

  if (platform === "linux-x64") {
    const deb = join(directory, binaries.find((name) => name.endsWith(".deb")));
    execFileSync("dpkg-deb", ["--fsys-tarfile", deb], { stdio: ["ignore", "ignore", "inherit"] });
  }

  return [...binaries, manifest].map((name) => ({ name, path: join(directory, name) }));
}

async function prepareRelease(channel, version, downloads, destination) {
  const assets = [];
  for (const platform of ["windows-x64", "macos-arm64", "linux-x64"]) {
    assets.push(...await verifyPlatform(platform, channel, version, join(downloads, platform)));
  }

  // Stage only the verified files, after all three platforms have passed.
  await mkdir(destination);
  for (const { name, path } of assets) await copyFile(path, join(destination, name));
  console.log(`Verified and staged ${assets.length} ${channel} release assets for ${version}.`);
}

try {
  const [command, channel, version, ...args] = process.argv.slice(2);
  const versionPattern = channel === "stable" ? /^\d+\.\d+\.\d+$/ : NIGHTLY_VERSION;
  if (!["stable", "nightly"].includes(channel) || !versionPattern.test(version)) {
    throw new Error(`Invalid release channel or version: ${channel} ${version}.`);
  }
  if (command === "record" && args.length === 2) {
    await recordChecksums(args[0], channel, version, args[1]);
  } else if (command === "prepare" && args.length === 2) {
    await prepareRelease(channel, version, args[0], args[1]);
  } else if (command === "verify-apt" && channel === "stable" && args.length === 1) {
    await verifyAptPackage(version, args[0]);
  } else {
    throw new Error("Usage: record <channel> <version> <platform> <build-dir>, prepare <channel> <version> <downloads-dir> <release-dir>, or verify-apt stable <version> <download-dir>.");
  }
} catch (error) {
  console.error(`::error::${error.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
}
