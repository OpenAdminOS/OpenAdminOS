import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolateSmokeProviders, terminateSmokeChild, waitForSmokeServer } from "./smoke-provider-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronBinary = createRequire(import.meta.url)("electron");
const viteBin = resolve(
  dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
  "bin/vite.js",
);
const port = process.env.OPENADMINOS_SMOKE_PORT ?? "5174";
const rendererUrl = `http://127.0.0.1:${port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-intune-chat-smoke-"));
let renderer;
let electron;
let providerIsolation;

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
  await waitForSmokeServer(renderer, rendererUrl, 20_000);

  providerIsolation = await isolateSmokeProviders(rendererUrl);
  const electronArgs = ["apps/desktop"];
  // Linux CI containers cannot install Electron's helper as root-owned setuid.
  // This flag is confined to the synthetic smoke process, never the packaged app.
  if (process.platform === "linux") electronArgs.push("--no-sandbox");
  electron = spawn(electronBinary, electronArgs, {
    cwd: root,
    env: {
      ...providerIsolation.env,
      VITE_DEV_SERVER_URL: rendererUrl,
      OPENADMINOS_INTUNE_CHAT_SMOKE: "1",
      OPENADMINOS_INTUNE_CHAT_SMOKE_USER_DATA: userDataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeProcess(electron, "electron");

  const code = await waitForExit(electron, 45_000);
  if (code !== 0) {
    throw new Error(`Electron Intune Chat smoke exited with code ${code}.`);
  }
} finally {
  try {
    await Promise.all([terminateSmokeChild(electron), terminateSmokeChild(renderer)]);
    await removeTempDir(userDataDir);
  } finally {
    await providerIsolation?.close();
  }
}
console.log("[smoke:intune-chat] passed");

function pipeProcess(child, label) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
}


function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectExit(new Error("Timed out waiting for Electron Intune Chat smoke."));
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
