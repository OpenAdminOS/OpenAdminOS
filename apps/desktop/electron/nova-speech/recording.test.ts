import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRecording, shortWhisperContext } from "./recording.js";

function recording(samples: number, active: Array<[number, number]>): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (const [start, end] of active) {
    for (let index = start; index < end; index++) wav.writeInt16LE(4096, 44 + index * 2);
  }
  return wav;
}

test("trims only quiet edges, retains padding and internal pauses, and rewrites WAV sizes", () => {
  const input = recording(8 * 16000, [[32000, 48000], [64000, 80000]]);
  const { wav, seconds } = prepareRecording(input);
  const buffer = Buffer.from(wav);
  assert.equal(seconds, 3.5);
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8);
  assert.equal(buffer.readUInt32LE(40), buffer.length - 44);
  assert.deepEqual(buffer.subarray(44), input.subarray(44 + (32000 - 4000) * 2, 44 + (80000 + 4000) * 2));
});

test("preserves quiet or unrecognized WAV input", () => {
  const quiet = recording(6400, []);
  assert.deepEqual(prepareRecording(quiet), { wav: quiet, seconds: 0.4 });
  const invalid = new Uint8Array([1, 2, 3]);
  assert.deepEqual(prepareRecording(invalid), { wav: invalid });
});

test("sizes short windows with padding and keeps the default for longer clips", () => {
  assert.equal(shortWhisperContext(3), 256);
  assert.equal(shortWhisperContext(11), 704);
  assert.equal(shortWhisperContext(25), 0);
  assert.equal(shortWhisperContext(undefined), 0);
});

test("preserves a quiet onset inside the quarter-second padding", () => {
  const input = recording(64000, [[32000, 48000]]);
  input.writeInt16LE(100, 44 + (32000 - 3600) * 2);
  const { wav } = prepareRecording(input);
  assert.equal(Buffer.from(wav).readInt16LE(44 + 400 * 2), 100);
});
