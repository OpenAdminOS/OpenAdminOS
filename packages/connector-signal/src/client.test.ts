import assert from "node:assert/strict";
import test from "node:test";

import { createSignalClient, type ProcessRunner } from "./client.js";

test("Signal REST client sends to local bridge /v2/send", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createSignalClient({
    account: "+15550001111",
    httpUrl: "http://127.0.0.1:8080",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ timestamp: "1700000000000" });
    }) as typeof fetch,
  });

  const result = await client.sendMessage({ to: "+15550002222", text: "hello" });

  assert.deepEqual(result, { timestamp: 1700000000000 });
  assert.equal(calls[0]?.url, "http://127.0.0.1:8080/v2/send");
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({
      message: "hello",
      number: "+15550001111",
      recipients: ["+15550002222"],
    }),
  );
});

test("Signal CLI client invokes signal-cli without shell interpolation", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runProcess: ProcessRunner = async (file, args) => {
    calls.push({ file, args });
    return { stdout: "Timestamp: 1700000000000", stderr: "", exitCode: 0 };
  };
  const client = createSignalClient({
    account: "+15550001111",
    cliPath: "/opt/signal-cli",
    configPath: "/tmp/signal",
    runProcess,
  });

  const result = await client.sendMessage({ to: "+15550002222", text: "hello; rm -rf /" });

  assert.deepEqual(result, { timestamp: 1700000000000 });
  assert.deepEqual(calls[0], {
    file: "/opt/signal-cli",
    args: [
      "--config",
      "/tmp/signal",
      "-a",
      "+15550001111",
      "send",
      "-m",
      "hello; rm -rf /",
      "+15550002222",
    ],
  });
});
