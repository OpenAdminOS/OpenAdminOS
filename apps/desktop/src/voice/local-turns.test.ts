import { describe, expect, it } from "vitest";
import { LocalTurns, localPcmWav } from "./local-turns";

const frame = (value: number) => new Float32Array(512).fill(value);

describe("local voice boundaries", () => {
  it.each([350, 800, 1400])("preserves a qualifier after a %i ms pause while output is pending", pause => {
    const turns = new LocalTurns(800);
    turns.accept(frame(0.1), 0.9, false);
    const gap = Array.from({ length: Math.ceil(pause / 32) }, () => turns.accept(frame(0), 0, false));
    const qualifier = turns.accept(frame(0.2), 0.9, false);
    expect(qualifier.resume).toBe(pause >= 800);
    expect(gap.some(event => event.submit)).toBe(pause >= 800);
    const tail = Array.from({ length: 25 }, () => turns.accept(frame(0), 0, false)).at(-1)!;
    expect(tail.submit?.[0]?.[0]).toBeCloseTo(0.1);
    expect(tail.submit?.some(part => part[0]! > 0.19)).toBe(true);
  });

  it("starts a new request when output already appeared", () => {
    const turns = new LocalTurns(800);
    turns.accept(frame(0.1), 0.9, false);
    for (let index = 0; index < 25; index++) turns.accept(frame(0), 0, false);
    turns.clearSubmitted();
    expect(turns.accept(frame(0.2), 0.9, false).resume).toBe(false);
  });

  it("ignores low playback echo and signals barge-in on clear speech", () => {
    const turns = new LocalTurns(800);
    expect(turns.accept(frame(0.2), 0.7, true).bargeIn).toBe(false);
    expect(turns.accept(frame(0.2), 0.9, true).bargeIn).toBe(true);
  });

  it("encodes mono 16 kHz PCM for Whisper", () => {
    const data = new DataView(Uint8Array.from(localPcmWav([frame(0.5)])).buffer);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getInt16(44, true)).toBe(16383);
  });
});
