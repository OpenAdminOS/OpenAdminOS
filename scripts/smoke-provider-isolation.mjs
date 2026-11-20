import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("./smoke-provider-preload.cjs", import.meta.url));

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
        const response = await fetch(url);
        if (response.ok && child.exitCode === null && child.signalCode === null) return finish();
      } catch {
        // The server is still starting.
      } finally {
        checking = false;
      }
      if (!settled) setTimeout(check, 200);
    };
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(`:${port}`)) check();
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
      if (/^(electron_run_as_node|node_options|node_use_env_proxy|http_proxy|https_proxy|all_proxy|no_proxy|openagents_stats_api)$/i.test(key)) {
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
