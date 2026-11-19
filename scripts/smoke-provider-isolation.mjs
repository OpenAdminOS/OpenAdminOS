import assert from "node:assert/strict";
import { createServer } from "node:net";

const modelPorts = [
  ["Ollama", 11434],
  ["LM Studio", 1234],
  ["Lemonade", 13305],
];

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServers(servers) {
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
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

export async function isolateSmokeProviders() {
  const servers = [];
  const unexpected = [];
  const checked = [];
  try {
    for (const [provider, port] of modelPorts) {
      for (const host of ["127.0.0.1", "::1"]) {
        const label = `${provider} on ${host} port ${port}`;
        const server = createServer((socket) => {
          unexpected.push(label);
          socket.destroy();
        });
        try {
          await listen(server, port, host);
          servers.push(server);
          checked.push(label);
        } catch (error) {
          if (error.code === "EADDRINUSE") {
            console.log(`[smoke:providers] Skipping ${label} because the port is in use.`);
          } else if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) {
            console.log(`[smoke:providers] Skipping ${label} because IPv6 loopback is unavailable.`);
          } else {
            throw error;
          }
        }
      }
    }

    // Keep the endpoint reserved throughout the smoke run. Any fallback
    // probe gets a closed connection from this smoke-owned fixture.
    const unavailable = createServer((socket) => socket.destroy());
    await listen(unavailable, 0, "127.0.0.1");
    servers.push(unavailable);
    const endpoint = `http://127.0.0.1:${unavailable.address().port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(electron_run_as_node|node_use_env_proxy|http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) {
        delete env[key];
      }
    }
    return {
      env: {
        ...env,
        OPENAGENTS_OLLAMA_URL: endpoint,
        OLLAMA_HOST: endpoint,
        OPENADMINOS_LM_STUDIO_URL: `${endpoint}/v1`,
        OPENADMINOS_LEMONADE_URL: `${endpoint}/v1`,
        OPENADMINOS_EMBEDDING_ENDPOINT: endpoint,
      },
      async close() {
        await closeServers(servers);
        assert.deepEqual(unexpected, [], "Electron connected to a default model port");
        if (checked.length) {
          console.log(`[smoke:providers] Zero connections to ${checked.join(", ")}.`);
        }
      },
    };
  } catch (error) {
    await closeServers(servers);
    throw error;
  }
}
