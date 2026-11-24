// Silero VAD v6.2.1, upstream commit 7e30209a3e901f9842f81b225f3e93d8199902b1.
export const VAD_MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";

export function validVadFrames(value: unknown): value is Float32Array[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 8 && Array.from(value).every(
    frame => frame instanceof Float32Array && frame.length === 512 &&
      frame.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1),
  );
}
