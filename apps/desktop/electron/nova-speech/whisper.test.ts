import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WhisperRuntime, whisperUsesMetal } from "./whisper.js";

test("Whisper retries failed startup, polls health, and idles out by closing the secret pipe", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "nova-sidecar-"));
  const executable = join(root, "fake.cjs");
  const eof = join(root, "eof");
  const attempted = join(root, "attempted");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.once("line", prefix => {
  if (!/^\\/[a-f0-9]{48}$/.test(prefix) || process.argv.includes(prefix)) process.exit(2);
  const marker = ${JSON.stringify(attempted)};
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "");
    process.exit(132);
  }
  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== prefix + "/health") { res.writeHead(404).end(); return; }
    polls++;
    res.writeHead(polls === 1 ? 503 : 200).end(JSON.stringify({ status: "ok" }));
  });
  server.listen(0, "127.0.0.1", () => console.log("whisper server listening at http://127.0.0.1:" + server.address().port));
  lines.once("close", () => {
    fs.writeFileSync(${JSON.stringify(eof)}, String(polls));
    process.exit(0);
  });
});
`, { mode: 0o700 });
  const runtime = new WhisperRuntime(executable, "model", 40);
  t.after(async () => { runtime.stop(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(runtime.check(AbortSignal.timeout(5000)), whisperUsesMetal
    ? /stopped or could not start/
    : /processor is not supported.*My own servers/);
  await runtime.check(AbortSignal.timeout(5000));
  const budget = AbortSignal.timeout(5000);
  while (!existsSync(eof)) await delay(20, undefined, { signal: budget });
  assert.equal(await readFile(eof, "utf8"), "2");
});
