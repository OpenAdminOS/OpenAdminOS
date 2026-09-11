import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve the actual executable; .bin/electron is a shell shim on Windows.
const electronBinary = createRequire(import.meta.url)("electron");
const viteBin = resolve(
  dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
  "bin/vite.js",
);
const port = process.env.OPENADMINOS_SCREENSHOT_PORT ?? "5179";
const rendererUrl = `http://127.0.0.1:${port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-screenshot-capture-"));
const outDir = process.env.OPENADMINOS_OFFICE_SMOKE_OUT ?? join(userDataDir, "evidence");
let renderer;
let electron;
const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

try {
  renderer = spawn(
    process.execPath,
    [viteBin, ...(process.env.OPENADMINOS_OFFICE_BUILT_RENDERER === "1" ? ["preview"] : []), "--host", "127.0.0.1", "--port", port, "--strictPort"],
    {
      cwd: join(root, "apps/desktop"),
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeProcess(renderer, "renderer");
  await waitForHttp(rendererUrl, 20_000);

  const electronArgs = ["apps/desktop"];
  // Linux CI containers cannot install Electron's helper as root-owned setuid.
  // This flag is confined to the synthetic capture process, never the packaged app.
  if (process.platform === "linux") electronArgs.push("--no-sandbox");
  electron = spawn(electronBinary, electronArgs, {
    cwd: root,
    env: {
      ...electronEnv,
      VITE_DEV_SERVER_URL: rendererUrl,
      OPENADMINOS_SCREENSHOT_CAPTURE: "1",
      OPENADMINOS_OFFICE_SMOKE: "1",
      OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA: userDataDir,
      OPENADMINOS_SCREENSHOT_OUT_DIR: outDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeProcess(electron, "electron");

  const code = await waitForExit(electron, 180_000);
  if (code !== 0) {
    throw new Error(`Electron screenshot capture exited with code ${code}.`);
  }
  console.log("[office-smoke] passed");
} finally {
  await terminateChild(electron);
  await terminateChild(renderer);
  await removeTempDir(userDataDir);
}

function pipeProcess(child, label) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectExit(new Error("Timed out waiting for Electron screenshot capture."));
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
