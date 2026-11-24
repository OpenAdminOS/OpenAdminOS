const frameMs = 32;
const continuationMs = 1200;

export class LocalTurns {
  private frameIndex = 0;
  private lastSpeech = 0;
  private submittedAt?: number;
  private frames: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private collecting = false;

  constructor(private readonly silenceMs: number) {}

  accept(frame: Float32Array, score: number, speaking: boolean) {
    const now = ++this.frameIndex * frameMs;
    const speech = score >= (speaking ? 0.85 : 0.5);
    let resume = false;
    let bargeIn = false;
    if (speech) {
      if (!this.collecting) {
        resume = this.submittedAt !== undefined && now - this.submittedAt <= continuationMs;
        bargeIn = speaking;
        if (!resume) this.frames = this.preRoll;
        this.preRoll = [];
        this.collecting = true;
        this.submittedAt = undefined;
      }
      this.lastSpeech = now;
    }

    if (this.collecting) {
      this.frames.push(frame);
      if (now - this.lastSpeech >= this.silenceMs || this.frames.length >= 1800) {
        this.collecting = false;
        this.submittedAt = now;
        return { speech, resume, bargeIn, submit: this.frames.slice() };
      }
    } else if (this.submittedAt !== undefined && now - this.submittedAt <= continuationMs) {
      this.frames.push(frame);
    } else {
      this.clearSubmitted();
      this.preRoll.push(frame);
      if (this.preRoll.length > 6) this.preRoll.shift();
    }
    return { speech, resume, bargeIn };
  }

  clearSubmitted() {
    if (this.collecting) return;
    this.frames = [];
    this.submittedAt = undefined;
  }
}

export function localPcmWav(frames: readonly Float32Array[]): number[] {
  const size = frames.reduce((length, frame) => length + frame.length * 2, 0);
  const wav = new Uint8Array(44 + size);
  const view = new DataView(wav.buffer);
  const tags = new TextEncoder();
  wav.set(tags.encode("RIFF"), 0);
  wav.set(tags.encode("WAVEfmt "), 8);
  wav.set(tags.encode("data"), 36);
  view.setUint32(4, 36 + size, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, size, true);
  let offset = 44;
  for (const frame of frames) for (const sample of frame) {
    view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 32767, true);
    offset += 2;
  }
  return Array.from(wav);
}
