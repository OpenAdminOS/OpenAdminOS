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
