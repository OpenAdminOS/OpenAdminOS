import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.OPENADMINOS_SMOKE_PORT ?? "5174";
const rendererUrl = `http://127.0.0.1:${port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-intune-chat-smoke-"));
let renderer;
let electron;

try {
  renderer = spawn(
    resolve(root, "apps/desktop/node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", port, "--strictPort"],
    {
      cwd: join(root, "apps/desktop"),
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeProcess(renderer, "renderer");
  await waitForHttp(rendererUrl, 20_000);

  electron = spawn(resolve(root, "node_modules/.bin/electron"), ["apps/desktop"], {
    cwd: root,
    env: {
      ...process.env,
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
  console.log("[smoke:intune-chat] passed");
} finally {
  if (electron && electron.exitCode === null) electron.kill("SIGTERM");
  if (renderer && renderer.exitCode === null) renderer.kill("SIGTERM");
  await rm(userDataDir, { recursive: true, force: true });
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
