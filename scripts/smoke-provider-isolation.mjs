import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("./smoke-provider-preload.cjs", import.meta.url));

// Every variable that selects an Electron smoke or capture launch mode or its
// output paths (apps/desktop/electron/main.ts).
const SMOKE_LAUNCH_VARIABLES = new Set([
  "OPENADMINOS_INTUNE_CHAT_SMOKE",
  "OPENADMINOS_INTUNE_CHAT_SMOKE_USER_DATA",
  "OPENADMINOS_REPORT_ISSUE_SMOKE",
  "OPENADMINOS_REPORT_ISSUE_SMOKE_USER_DATA",
  "OPENADMINOS_OFFICE_SMOKE",
  "OPENADMINOS_SCREENSHOT_CAPTURE",
  "OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA",
  "OPENADMINOS_SCREENSHOT_OUT_DIR",
  "OPENADMINOS_SCREENSHOT_HUB_DETAILS",
  "OPENADMINOS_FIRST_RUN_CAPTURE",
  "OPENADMINOS_LANDING_CAPTURE",
  "OPENADMINOS_WEBSITE_CAPTURE",
  "OPENADMINOS_BRAND_CAPTURE",
  "OPENADMINOS_CAPTURE_EXTERNAL_URL",
  "OPENADMINOS_SUPPORT_BUNDLE_EXPORT_PATH",
]);

// Probe the renderer directly. The parent process may have inherited proxy
// settings that Electron does not, so the global fetch could answer through a
// proxy; this request uses its own socket, follows no redirect and is bounded.
function probeDirect(url) {
  return new Promise((resolve) => {
    const request = httpGet(url, { agent: false, timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

export async function terminateSmokeChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// Resolve only when this run's own server is ready: the child reported its
// address and answers while still running. Another process that already holds
// the port makes a strict-port child exit, which rejects instead of letting the
// smoke use and allow the foreign listener.
export function waitForSmokeServer(child, url, timeoutMs) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let checking = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code, signal) => finish(new Error(
      `Smoke server for ${url} exited (${signal ?? code}) before it was ready.`));
    const check = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        if (await probeDirect(url) && child.exitCode === null && child.signalCode === null) return finish();
      } finally {
        checking = false;
      }
      if (!settled) setTimeout(check, 200);
    };
    const onData = (chunk) => {
      output += chunk;
      // Vite colors its banner when the environment asks for color (as CI does),
      // which puts escape codes between the colon and the port.
      if (output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").includes(`:${port}`)) check();
    };
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for the smoke server at ${url}.`)), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) return onExit(child.exitCode, child.signalCode);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
}

export async function isolateSmokeProviders(...origins) {
  const directory = await mkdtemp(join(tmpdir(), "openadminos-smoke-guard-"));
  const logPath = join(directory, "violations.jsonl");
  // Keep the endpoint reserved throughout the smoke run. Provider fallback
  // probes get a closed connection from this smoke-owned fixture.
  const unavailable = createServer((socket) => socket.destroy());
  const closeServer = () => new Promise((resolve, reject) => {
    unavailable.close((error) => error ? reject(error) : resolve());
  });
  try {
    await new Promise((resolve, reject) => {
      unavailable.once("error", reject);
      unavailable.listen(0, "127.0.0.1", () => {
        unavailable.off("error", reject);
        resolve();
      });
    });
    const endpoint = `http://127.0.0.1:${unavailable.address().port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      // Inherited smoke and capture launch flags would change which code path
      // Electron runs, so a smoke could pass without running its own flow.
      // Each runner sets the flags for its own mode after this.
      if (/^(electron_run_as_node|node_options|node_use_env_proxy|http_proxy|https_proxy|all_proxy|no_proxy|openagents_stats_api)$/i.test(key) ||
          SMOKE_LAUNCH_VARIABLES.has(key.toUpperCase())) {
        delete env[key];
      }
    }
    return {
      env: {
        ...env,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
        OPENADMINOS_SMOKE_PROVIDER_GUARD: JSON.stringify({ origins: [endpoint, ...origins], logPath }),
        OPENAGENTS_OLLAMA_URL: endpoint,
        OLLAMA_HOST: endpoint,
        OPENADMINOS_LM_STUDIO_URL: `${endpoint}/v1`,
        OPENADMINOS_LEMONADE_URL: `${endpoint}/v1`,
        OPENADMINOS_EMBEDDING_ENDPOINT: endpoint,
      },
      async close() {
        try {
          await closeServer();
          // The preload creates the file only after installing the guard.
          const violations = await readFile(logPath, "utf8").catch((error) => {
            if (error.code !== "ENOENT") throw error;
            throw new Error("Electron smoke exited without installing the provider guard.", { cause: error });
          });
          assert.equal(violations, "", `Electron smoke provider guard violations:\n${violations}`);
          console.log("[smoke:providers] Zero blocked attempts in the Electron main process.");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      if (unavailable.listening) await closeServer();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
