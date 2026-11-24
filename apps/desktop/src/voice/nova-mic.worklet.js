class NovaMic extends AudioWorkletProcessor {
  frame = new Float32Array(512);
  batch = [];
  offset = 0;

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let index = 0; index < samples.length; index++) {
      this.frame[this.offset++] = Math.max(-1, Math.min(1, samples[index]));
      if (this.offset === this.frame.length) {
        this.batch.push({ frame: this.frame, captured: (currentFrame + index + 1) / sampleRate * 1000 });
        if (this.batch.length === 4) {
          this.port.postMessage(this.batch, this.batch.map(({ frame }) => frame.buffer));
          this.batch = [];
        }
        this.frame = new Float32Array(512);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("nova-mic", NovaMic);
