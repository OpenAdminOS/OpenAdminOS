import { strict as assert } from "node:assert";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CallCapture, type CaptureState } from "./capture.js";

const ready = Buffer.from([1, 0, 0]);
const pcm = Buffer.from([2, 4, 0, 0, 128, 255, 127]);

class Fixture extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor() {
    super();
    this.stdin.once("finish", () => this.finish(0));
  }

  finish(code: number) {
    this.emit("close", code);
  }

  kill() {
    this.killed = true;
    this.finish(1);
  }
}

function captureFixture(t: { after: (run: () => void) => void }, delays = [0, 0, 0],
  timeouts?: { initial: number; recovery: number; silence: number }) {
  const children: Fixture[] = [];
  const samples: Buffer[] = [];
  const states: CaptureState[] = [];
  const events = new EventEmitter();
  const capture = new CallCapture({
    executable: "unused",
    delays,
    timeouts,
    launch: () => {
      const child = new Fixture();
      children.push(child);
      events.emit("launch");
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    onState(state) {
      states.push(state);
      events.emit(state);
    },
    onPcm: (sample) => samples.push(sample),
  });
  t.after(() => capture.stop());
  capture.start();
  return { capture, children, samples, states, events };
}

test("joins split PCM frames and discards the previous stream on a route change", { timeout: 2000 }, async (t) => {
  const { children, states, samples, events } = captureFixture(t);
  const first = children[0]!;
  first.stdout.write(ready.subarray(0, 2));
  assert.deepEqual(states, ["starting"]);
  first.stdout.write(Buffer.concat([ready.subarray(2), pcm, pcm.subarray(0, 4)]));
  assert.deepEqual(samples, [pcm.subarray(3)]);

  const rebuilt = new Promise<void>((resolve) => events.once("launch", resolve));
  first.finish(75);
  assert.equal(states.at(-1), "reconnecting");
  first.stdout.write(pcm.subarray(4));
  await rebuilt;
  children[1]!.stdout.write(Buffer.concat([ready, pcm]));
  assert.deepEqual(states, ["starting", "waiting-audio", "capturing", "reconnecting", "waiting-audio", "capturing"]);
  assert.deepEqual(samples, [pcm.subarray(3), pcm.subarray(3)]);
});

test("stopping while reconnecting cancels the pending child launch", async (t) => {
  const { capture, children, states } = captureFixture(t, [10]);
  children[0]!.finish(75);
  capture.stop();
  await delay(30);
  assert.equal(children.length, 1);
  assert.deepEqual(states, ["starting", "reconnecting", "stopped"]);
});

test("stopping active capture closes its control pipe and ignores subsequent PCM", async (t) => {
  const { capture, children, states, samples } = captureFixture(t);
  const child = children[0]!;
  child.stdout.write(ready);
  capture.stop();
  child.stdout.write(pcm);
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(states, ["starting", "waiting-audio", "stopped"]);
  assert.deepEqual(samples, []);
});

test("a permission error releases capture without retrying", async (t) => {
  const { children, states } = captureFixture(t);
  children[0]!.stdout.write(ready);
  children[0]!.finish(77);
  await delay(15);
  assert.equal(children.length, 1);
  assert.deepEqual(states, ["starting", "waiting-audio", "permission"]);
});

test("repeated interruptions exhaust the retry budget, even after brief successful starts", { timeout: 2000 }, async (t) => {
  const { children, states, events } = captureFixture(t);
  for (let index = 0; index < 4; index++) {
    const next = new Promise<void>((resolve) => events.once(index < 3 ? "launch" : "failed", resolve));
    children[index]!.stdout.write(ready);
    children[index]!.finish(75);
    await next;
  }
  assert.equal(children.length, 4);
  assert.equal(states.at(-1), "failed");
});

test("rejects an oversized frame before forwarding or buffering the payload", { timeout: 2000 }, async (t) => {
  const { children, states, events, samples } = captureFixture(t, []);
  const failed = new Promise<void>((resolve) => events.once("failed", resolve));
  children[0]!.stdout.write(Buffer.concat([ready, Buffer.from([2, 255, 255]), pcm]));
  await failed;
  assert.equal(children[0]!.stdin.writableEnded, true);
  assert.deepEqual(states, ["starting", "waiting-audio", "reconnecting", "failed"]);
  assert.deepEqual(samples, []);
});


test("an all-zero tap reports waiting for audio and resumes on audible playback", async t => {
  const { children, states, samples } = captureFixture(t, [], { initial: 1000, recovery: 1000, silence: 0 });
  const silence = Buffer.from([2, 4, 0, 0, 0, 0, 0]);
  const child = children[0]!;
  child.stdout.write(Buffer.concat([ready, silence]));
  assert.equal(states.at(-1), "waiting-audio");
  assert.deepEqual(samples, []);
  child.stdout.write(pcm);
  assert.equal(states.at(-1), "capturing");
  child.stdout.write(silence);
  assert.equal(states.at(-1), "waiting-audio");
  child.stdout.write(pcm);
  assert.equal(states.at(-1), "capturing");
  assert.deepEqual(samples, [pcm.subarray(3), pcm.subarray(3)]);
});

test("a stalled helper closes its control pipe and starts recovery", { timeout: 2000 }, async t => {
  const { children, states, events } = captureFixture(t, [0], { initial: 10, recovery: 1000, silence: 1000 });
  await new Promise<void>(resolve => events.once("launch", resolve));
  assert.equal(children[0]!.stdin.writableEnded, true);
  assert.deepEqual(states, ["starting", "reconnecting"]);
});
