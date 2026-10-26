import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = resolve(
  dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
  "bin/vite.js",
);
const port = process.env.OPENADMINOS_FIRST_RUN_SCREENSHOT_PORT ?? "5177";
const rendererUrl = `http://127.0.0.1:${port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-first-run-capture-"));
const outDir = resolve(
  process.env.OPENADMINOS_FIRST_RUN_SCREENSHOT_OUT_DIR ??
    "/tmp/oaos-firstrun/shots",
);
const names = [
  "first-run",
  "sample-chat",
  "sample-switcher",
  "own-registration",
  "schedules-paused",
];
const expectedFiles = names.flatMap((name) =>
  ["light", "dark"].map((theme) => join(outDir, "app", `${name}-${theme}.png`)),
);
let renderer;
let electron;
const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

try {
  renderer = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", port, "--strictPort"],
    {
      cwd: join(root, "apps/desktop"),
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeProcess(renderer, "renderer");
  await waitForHttp(rendererUrl, 20_000);

  const electronArgs = ["apps/desktop"];
  if (process.platform === "linux") electronArgs.push("--no-sandbox");
  electron = spawn(resolve(root, "node_modules/.bin/electron"), electronArgs, {
    cwd: root,
    env: {
      ...electronEnv,
      VITE_DEV_SERVER_URL: rendererUrl,
      OPENADMINOS_SCREENSHOT_CAPTURE: "1",
      OPENADMINOS_FIRST_RUN_CAPTURE: "1",
      OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA: userDataDir,
      OPENADMINOS_SCREENSHOT_OUT_DIR: outDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeProcess(electron, "electron");

  const code = await waitForExit(electron, 90_000);
  if (code !== 0) {
    throw new Error(`Electron first-run capture exited with code ${code}.`);
  }
  for (const file of expectedFiles) {
    await access(file);
    const dimensions = await readPngDimensions(file);
    if (dimensions.width !== 1280 || dimensions.height !== 800) {
      throw new Error(
        `${file} is ${dimensions.width}x${dimensions.height}; expected 1280x800.`,
      );
    }
  }
  console.log(`[first-run-capture] passed ${expectedFiles.length} screenshots in ${outDir}`);
} finally {
  await terminateChild(electron);
  await terminateChild(renderer);
  await removeTempDir(userDataDir);
}

function pipeProcess(child, label) {
  child.stdout?.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The renderer is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectExit(new Error("Timed out waiting for Electron first-run capture."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code ?? 1);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
  });
}

function terminateChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveTerminate) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveTerminate();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveTerminate();
    });
    child.kill("SIGTERM");
  });
}

async function removeTempDir(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 4) throw error;
      await delay(150 * (attempt + 1));
    }
  }
}

async function readPngDimensions(path) {
  const bytes = await readFile(path);
  if (bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${path} is not a PNG file.`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
