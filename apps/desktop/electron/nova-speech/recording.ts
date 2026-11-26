const headerBytes = 44;
const sampleRate = 16000;
const frameSamples = sampleRate / 50;
const paddingSamples = sampleRate / 4;
const speechEnergy = (32768 * 0.005) ** 2;

/** Trim quiet edges from the mono PCM WAV that Nova records. Keep nearby consonants and pauses. */
export function prepareRecording(audio: Uint8Array): { wav: Uint8Array; seconds?: number } {
  const source = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (source.length < headerBytes ||
      source.toString("ascii", 0, 4) !== "RIFF" ||
      source.readUInt32LE(4) !== source.length - 8 ||
      source.toString("ascii", 8, 16) !== "WAVEfmt " ||
      source.readUInt32LE(16) !== 16 ||
      source.readUInt16LE(20) !== 1 ||
      source.readUInt16LE(22) !== 1 ||
      source.readUInt32LE(24) !== sampleRate ||
      source.readUInt16LE(32) !== 2 ||
      source.readUInt16LE(34) !== 16 ||
      source.toString("ascii", 36, 40) !== "data") return { wav: audio };
  const bytes = source.readUInt32LE(40);
  if (headerBytes + bytes !== source.length || bytes % 2 !== 0) return { wav: audio };

  const samples = bytes / 2;
  const quiet = (start: number, end: number) => {
    let sum = 0;
    for (let index = start; index < end; index++) {
      sum += source.readInt16LE(headerBytes + index * 2) ** 2;
    }
    return sum < speechEnergy * (end - start);
  };
  let start = 0;
  let end = samples;
  while (start + frameSamples <= end && quiet(start, start + frameSamples)) start += frameSamples;
  while (end - frameSamples >= start && quiet(end - frameSamples, end)) end -= frameSamples;
  // A very quiet clip may still contain speech. Preserve it for Whisper to decide.
  if (end - start < frameSamples) return { wav: audio, seconds: samples / sampleRate };
  start = Math.max(0, start - paddingSamples);
  end = Math.min(samples, end + paddingSamples);
  if (start === 0 && end === samples) return { wav: audio, seconds: samples / sampleRate };

  const wav = Buffer.concat([source.subarray(0, headerBytes), source.subarray(headerBytes + start * 2, headerBytes + end * 2)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - headerBytes, 40);
  return { wav, seconds: (end - start) / sampleRate };
}

/** The Small model uses 50 encoder frames per second. Leave about two seconds of headroom. */
export function shortWhisperContext(seconds: number | undefined): number {
  if (!seconds || seconds > 20) return 0;
  return Math.max(256, Math.ceil((seconds * 50 + 100) / 64) * 64);
}
