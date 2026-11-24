// The capture context already runs at 16 kHz.
class NovaMic extends AudioWorkletProcessor {
  frame = new Float32Array(512);
  offset = 0;

  process(inputs) {
    for (const sample of inputs[0]?.[0] ?? []) {
      this.frame[this.offset++] = Math.max(-1, Math.min(1, sample));
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(512);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("nova-mic", NovaMic);
