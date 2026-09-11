/** Export the isolated Electron rehearsal capture as a shareable silent video. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const dir = process.argv[2];
if (!dir) {
  console.error(
    "Usage: node scripts/render-office-rehearsal.mjs <smoke-output-directory>",
  );
  process.exit(1);
}
const input = join(resolve(dir), "rehearsal-frames");
if (!existsSync(join(resolve(dir), "rehearsal-frames", "0000.jpg"))) {
  console.error(
    "No rehearsal frames found. Run the Office Electron smoke first.",
  );
  process.exit(1);
}
const output = join(resolve(dir), "agent-team-rehearsal.webm");
const frames = readdirSync(input)
  .filter((name) => /^\d{4}\.jpg$/.test(name))
  .sort();
const result = spawnSync(
  process.env.FFMPEG_PATH ?? "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    "5",
    "-vcodec",
    "mjpeg",
    "-i",
    "pipe:0",
    "-c:v",
    "libvpx",
    "-b:v",
    "1200k",
    "-crf",
    "12",
    "-pix_fmt",
    "yuv420p",
    output,
  ],
  {
    stdio: ["pipe", "inherit", "inherit"],
    input: Buffer.concat(frames.map((name) => readFileSync(join(input, name)))),
  },
);
if (result.error) {
  console.error(
    "Video export needs FFmpeg. Install it or set FFMPEG_PATH to its executable.",
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Wrote ${output}`);
