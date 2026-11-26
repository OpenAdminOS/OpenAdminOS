import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { UtilityProcess } from "electron";
import { LocalSpeech } from "./local.js";
import { SpeechModelIntegrity } from "./models.js";

const good = "good model";
const file = { path: "model.bin", url: "https://example.invalid/model.bin", bytes: good.length, sha256: createHash("sha256").update(good).digest("hex") };

async function fixture(t: TestContext, dependencies: ConstructorParameters<typeof LocalSpeech>[2] = {}) {
  const root = await mkdtemp(join(tmpdir(), "nova-local-"));
  const binary = join(root, "whisper");
  const target = join(root, "models-v1-small");
  await mkdir(target);
  await writeFile(binary, "");
  await writeFile(join(target, file.path), good);
  const speech = new LocalSpeech(root, binary, { ...dependencies, files: () => [file] });
  speech.configure("builtin", "small");
  t.after(async () => { speech.stop(); await rm(root, { recursive: true, force: true }); });
  return { speech, root, target };
}

test("detects a same-size model corruption after verifying the earlier revision and repairs it", async t => {
  const { speech, target } = await fixture(t, { fetch: async () => new Response(good) });
  const integrity = new SpeechModelIntegrity();
  const signal = AbortSignal.timeout(5000);
  assert.equal(await integrity.check(target, [file], signal), true);
  await writeFile(join(target, file.path), "bad! model");
  const modified = new Date(Date.now() - 5000);
  await utimes(join(target, file.path), modified, modified);
  assert.equal(await integrity.check(target, [file], signal), false);
  await assert.rejects(speech.check(), /failed verification/);
  assert.equal(speech.status().ready, false);
  assert.equal(speech.status().repairNeeded, true);
  await speech.install();
  assert.equal(speech.status().ready, true);
  assert.equal(speech.status().repairNeeded, false);
});

test("sweeps orphaned staging, cancels an active download and validates configuration", async t => {
  let started!: () => void;
  const fetching = new Promise<void>(resolve => { started = resolve; });
  const { speech, root, target } = await fixture(t, { fetch: async (_url, options) => {
    const signal = options!.signal!;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    });
  } });
  assert.throws(() => speech.configure("external", "small"), /supported local voice/);
  assert.throws(() => speech.configure("builtin", "other"), /supported local voice/);
  speech.configure("builtin", "small");
  await mkdir(join(root, "models-v1-turbo.staging-dead"));
  await mkdir(join(root, "unrelated.staging-live"));
  await rm(target, { recursive: true });
  const installing = speech.install();
  await fetching;
  speech.cancel();
  await installing;
  assert.equal(speech.status().ready, false);
  assert.deepEqual((await readdir(root)).sort(), ["settings.json", "unrelated.staging-live", "whisper"]);
});

test("aborting queued speech kills its worker, and a crashed worker can be re-forked", async t => {
  let forks = 0;
  let kills = 0;
  let began!: () => void;
  const synthesizing = new Promise<void>(resolve => { began = resolve; });
  const { speech } = await fixture(t, { fork: () => {
    const child = new EventEmitter() as EventEmitter & { postMessage: (request: { id: number }) => void; kill: () => boolean };
    const instance = ++forks;
    child.kill = () => { kills++; queueMicrotask(() => child.emit("exit", 0)); return true; };
    child.postMessage = ({ id }) => {
      if (instance === 1) began();
      else if (instance === 2) queueMicrotask(() => child.emit("exit", 1));
      else queueMicrotask(() => {
        child.emit("message", { id: id - 1, audio: new Uint8Array([1]) });
        child.emit("message", { id, audio: new Uint8Array([2]), remainingText: "rest" });
        child.emit("message", { id, done: true });
      });
    };
    queueMicrotask(() => child.emit("message", { ready: true }));
    return child as unknown as UtilityProcess;
  } });
  const controller = new AbortController();
  const pending = speech.speak("first", controller.signal);
  const queued = speech.speak("queued", controller.signal);
  const failures = Promise.all([assert.rejects(pending, { name: "AbortError" }), assert.rejects(queued, { name: "AbortError" })]);
  await synthesizing;
  controller.abort();
  await failures;
  assert.equal(forks, 1);
  assert.equal(kills, 1);
  await assert.rejects(speech.speak("crash", AbortSignal.timeout(3000)), /Built-in Kokoro/);
  assert.equal(speech.status().repairNeeded, true);
  const chunks: number[] = [];
  await speech.speak("next", AbortSignal.timeout(3000), (wav, remaining) => {
    chunks.push(...wav);
    assert.equal(remaining, "rest");
  });
  assert.deepEqual(chunks, [2]);
  assert.equal(forks, 3);
  assert.equal(speech.status().ready, true);
});

test("persists local voice mode, thresholds and timing preferences across source changes", async t => {
  const { speech, root } = await fixture(t);
  assert.deepEqual(speech.status().preferences, {
    interaction: "hands-free", silenceMs: 800, idleSeconds: 120, showTimings: false,
  });
  const preferences = { interaction: "hold-to-talk", silenceMs: 900, idleSeconds: 180, showTimings: true };
  speech.configurePreferences(preferences);
  speech.configure("servers", "turbo");
  const reopened = new LocalSpeech(root, join(root, "whisper"));
  assert.deepEqual(reopened.status().preferences, preferences);
  assert.throws(() => reopened.configurePreferences({ ...preferences, idleSeconds: 0 }), /supported local voice mode and timeout/);
});
