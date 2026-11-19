import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("../tests/provider-test-setup.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../tests/fixtures/provider-test-guard.mjs", import.meta.url));

function runFixture(scenario, origin) {
  const env = { ...process.env, PROVIDER_GUARD_CASE: scenario, PROVIDER_GUARD_ORIGIN: origin };
  // The fixture needs its own test runner instead of inheriting this worker.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", preload, "--test", fixture], {
      env,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

it("blocks unregistered loopback requests through fetch, node:http and node:https", async () => {
  let requests = 0;
  // This server belongs to the parent process and is unregistered in each child.
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected request");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [scenario, diagnostic] of [
      ["fetch", /Blocked fetch outside test HTTP servers/],
      ["http", /Blocked node:http\.request outside test HTTP servers/],
      ["https", /Blocked node:https\.get outside test HTTP servers/],
    ]) {
      const { code, stdout, stderr } = await runFixture(scenario, origin);
      assert.equal(code, 1, stdout + stderr);
      assert.match(stdout, /failureType: 'hookFailed'/);
      assert.match(stdout, diagnostic);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("fails the test process after a caught violation beyond the last per-test hook", async () => {
  const { code, stdout, stderr } = await runFixture("late", "");
  assert.match(stdout, /^ok 1 - passes before teardown$/m);
  assert.equal(code, 1);
  assert.match(stdout + stderr, /Provider test guard violations:\s*(?:# )?Blocked spawnSync outside provider fixtures/);
});

it("allows fetch and node:http requests to a server the test starts", async () => {
  const { code, stdout, stderr } = await runFixture("owned", "");
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /^# pass 1$/m);
});
