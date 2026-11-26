const maxFrames = 1800;
const minimumSpeechFrames = 8;

export class LocalTurns {
  private lastSpeech = 0;
  private lastFrame = 0;
  private frames: Float32Array[] = [];
  private onset: Float32Array[] = [];
  private speechFrames = 0;
  private quietFrames = 0;
  private collecting = false;
  private pending = false;
  private prefixLength = 0;

  constructor(private readonly silenceMs: number) {}

  accept(frame: Float32Array, score: number, speaking: boolean, captured: number) {
    if (captured - this.lastFrame > 40) this.onset = [];
    this.lastFrame = captured;
    const voiced = score >= (speaking ? 0.85 : 0.5);
    let resume = false;
    let bargeIn = false;
    if (!this.collecting) {
      if (!voiced) this.onset = [];
      else this.onset.push(frame);
      if (this.onset.length < 3) return { speech: false, resume, bargeIn };
      bargeIn = speaking;
      this.prefixLength = this.pending ? this.frames.length : 0;
      this.frames.push(...this.onset);
      this.speechFrames = this.onset.length;
      this.quietFrames = 0;
      this.onset = [];
      this.collecting = true;
      this.lastSpeech = captured;
      return { speech: true, resume, bargeIn };
    }
    this.frames.push(frame);
    if (voiced) {
      this.lastSpeech = captured;
      this.speechFrames++;
      this.quietFrames = 0;
      if (this.pending && this.speechFrames >= minimumSpeechFrames) {
        this.pending = false;
        resume = true;
      }
    } else this.quietFrames++;
    const capped = this.frames.length >= maxFrames;
    if (!capped && captured - this.lastSpeech < this.silenceMs)
      return { speech: voiced, resume, bargeIn };

    this.collecting = false;
    if (this.pending && this.speechFrames < minimumSpeechFrames) {
      this.frames = this.frames.slice(0, this.prefixLength);
      return { speech: voiced, resume, bargeIn };
    }
    const submit = this.speechFrames >= minimumSpeechFrames ? this.frames : undefined;
    // Keep only a short silence tail for continuation, even after a long backend delay.
    const trailingFrames = Math.max(0, this.quietFrames - 4);
    this.frames = submit && !capped ? submit.slice(0, Math.max(0, submit.length - trailingFrames)) : [];
    this.pending = Boolean(submit && !capped && this.frames.length <= maxFrames - minimumSpeechFrames);
    if (!this.pending) this.frames = [];
    return { speech: voiced, resume, bargeIn, submit, capped: Boolean(submit && !this.pending), end: this.lastSpeech };
  }

  reset() {
    this.collecting = false;
    this.onset = [];
    this.clearSubmitted();
  }

  clearSubmitted() {
    if (this.collecting) {
      if (this.pending) this.frames = this.frames.slice(this.prefixLength);
      this.pending = false;
      return;
    }
    this.frames = [];
    this.pending = false;
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
