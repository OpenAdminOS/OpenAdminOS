import { describe, expect, it } from "vitest";
import { LocalTurns, localPcmWav } from "./local-turns";

function fixture() {
  const turns = new LocalTurns(800);
  let time = 0;
  const send = (count: number, score: number, value = score, speaking = false) =>
    Array.from({ length: count }, () => turns.accept(new Float32Array(512).fill(value), score, speaking, time += 32));
  return { turns, send };
}

describe("local voice boundaries", () => {
  it.each([350, 800, 1400, 3000])("preserves a qualifier after a %i ms pause while output is pending", pause => {
    const { send } = fixture();
    send(8, 0.9, 0.1);
    const gap = send(Math.ceil(pause / 32), 0);
    expect(send(8, 0.9, 0.2).some(event => event.resume)).toBe(pause >= 800);
    expect(gap.some(event => event.submit)).toBe(pause >= 800);
    const tail = send(25, 0).at(-1)!;
    expect(tail.submit?.[0]?.[0]).toBeCloseTo(0.1);
    expect(tail.submit?.some(part => part[0]! > 0.19)).toBe(true);
  });

  it("starts a new request when output already appeared", () => {
    const { turns, send } = fixture();
    send(8, 0.9, 0.1);
    send(25, 0);
    turns.clearSubmitted();
    expect(send(8, 0.9, 0.2).some(event => event.resume)).toBe(false);
    expect(send(25, 0).at(-1)?.submit?.[0]?.[0]).toBeCloseTo(0.2);
  });

  it("caps each segment and starts fresh during sustained speech", () => {
    const { send } = fixture();
    const events = send(3700, 0.9);
    expect(events.flatMap(event => event.submit ? [event.submit.length] : [])).toEqual([1800, 1800]);
    expect(events.some(event => event.resume)).toBe(false);
    expect(send(25, 0).filter(event => event.submit)).toHaveLength(1);
  });

  it("requires three strong frames for barge-in and eight voiced frames to submit", () => {
    const { send } = fixture();
    expect(send(4, 0.7, 0.2, true).some(event => event.bargeIn)).toBe(false);
    expect(send(3, 0.9, 0.2, true).map(event => event.bargeIn)).toEqual([false, false, true]);
    expect(send(25, 0).some(event => event.submit)).toBe(false);
  });

  it("uses frame capture time for silence even when frames were dropped", () => {
    const turns = new LocalTurns(800);
    for (let i = 0; i < 8; i++) turns.accept(new Float32Array(512), 0.9, false, i * 32);
    expect(turns.accept(new Float32Array(512), 0, false, 1100).submit).toHaveLength(9);
  });

  it("encodes mono 16 kHz PCM for Whisper", () => {
    const data = new DataView(Uint8Array.from(localPcmWav([new Float32Array(512).fill(0.5)])).buffer);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getInt16(44, true)).toBe(16383);
  });
});
