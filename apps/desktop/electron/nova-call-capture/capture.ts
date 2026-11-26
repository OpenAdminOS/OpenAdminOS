import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

const helperName = "openadminos-nova-call-capture";

export function callCaptureExecutable(resourcesPath: string, packaged: boolean, appPath: string): string | undefined {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const [major, minor] = release().split(".").map(Number);
  if (major < 23 || (major === 23 && minor < 2)) return;
  const executable = packaged
    ? join(resourcesPath, "..", "Helpers", helperName)
    : join(appPath, "build", helperName);
  if (existsSync(executable)) return executable;
}

export type CaptureState = "starting" | "waiting-audio" | "capturing" | "reconnecting" | "permission" | "failed" | "stopped";

const retryDelays = [250, 750, 1500];
const stableCaptureMs = 10_000;
const initialTimeoutMs = 90_000; // The first start can wait for the macOS permission prompt.
const recoveryTimeoutMs = 5_000;
const silenceStatusMs = 15_000;
const frameHeaderBytes = 3;
const maxPcmBytes = 4092;
const readyFrame = 1;
const pcmFrame = 2;
const permissionDenied = 77;

type CaptureOptions = {
  executable: string;
  onState: (state: CaptureState) => void;
  onPcm: (pcm: Buffer) => void;
  launch?: () => ChildProcessWithoutNullStreams;
  delays?: readonly number[];
  stableMs?: number;
  timeouts?: { initial: number; recovery: number; silence: number };
};

/** A single capture session. Each rebuild starts a fresh stream and invalidates its predecessor. */
export class CallCapture {
  private child?: ChildProcessWithoutNullStreams;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private started = false;
  private failures = 0;

  constructor(private readonly options: CaptureOptions) {}

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.options.onState("starting");
    if (!this.stopped) this.launch(true);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    const child = this.child;
    this.child = undefined;
    if (child) this.close(child);
    this.options.onState("stopped");
  }

  private launch(initial: boolean) {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.options.launch?.() ?? spawn(this.options.executable, [String(process.pid)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      this.recover();
      return;
    }
    this.child = child;
    let ready = false;
    let hearingAudio = false;
    let lastNonzero = 0;
    let failed = false;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let liveness: ReturnType<typeof setTimeout>;
    let stable: ReturnType<typeof setTimeout> | undefined;
    const timeouts = this.options.timeouts ?? { initial: initialTimeoutMs, recovery: recoveryTimeoutMs, silence: silenceStatusMs };
    const current = () => this.child === child && !this.stopped && !failed;
    const clear = () => {
      clearTimeout(liveness);
      clearTimeout(stable);
      pending = Buffer.alloc(0);
    };
    const interrupt = () => {
      if (!current()) return;
      failed = true;
      clear();
      this.options.onState("reconnecting");
      this.close(child);
    };
    const finished = (code: number | null) => {
      clear();
      if (this.child !== child) return;
      this.child = undefined;
      if (code === permissionDenied) {
        this.options.onState("permission");
        return;
      }
      this.recover(failed);
    };

    child.once("close", finished);
    child.stdin.on("error", interrupt);
    child.stdout.on("error", interrupt);
    // Spawn failures have no exit event. Node still emits close.
    child.on("error", interrupt);
    child.stderr.resume();
    liveness = setTimeout(interrupt, initial ? timeouts.initial : timeouts.recovery);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!current()) return;
      let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (current() && data.length >= frameHeaderBytes) {
        const kind = data[0];
        const size = data.readUInt16LE(1);
        const validReady = kind === readyFrame && !ready && size === 0;
        const validPcm = kind === pcmFrame && ready && size > 0 && size <= maxPcmBytes && size % 2 === 0;
        if (!validReady && !validPcm) {
          interrupt();
          return;
        }
        if (data.length < size + frameHeaderBytes) break;

        clearTimeout(liveness);
        liveness = setTimeout(interrupt, timeouts.recovery);
        if (validReady) {
          ready = true;
          stable = setTimeout(() => { this.failures = 0; }, this.options.stableMs ?? stableCaptureMs);
          this.options.onState("waiting-audio");
        } else {
          const pcm = data.subarray(frameHeaderBytes, frameHeaderBytes + size);
          const now = performance.now();
          if (pcm.some(byte => byte !== 0)) {
            lastNonzero = now;
            if (!hearingAudio) {
              hearingAudio = true;
              this.options.onState("capturing");
            }
          } else if (hearingAudio && now - lastNonzero >= timeouts.silence) {
            hearingAudio = false;
            this.options.onState("waiting-audio");
          }
          if (current() && hearingAudio) this.options.onPcm(Buffer.from(pcm));
        }
        data = data.subarray(frameHeaderBytes + size);
      }
      if (current()) pending = Buffer.from(data);
    });
  }

  private recover(alreadyReconnecting = false) {
    if (this.stopped) return;
    const delay = (this.options.delays ?? retryDelays)[this.failures++];
    if (delay === undefined) {
      this.options.onState("failed");
      return;
    }
    if (!alreadyReconnecting) this.options.onState("reconnecting");
    if (!this.stopped) this.retry = setTimeout(() => this.launch(false), delay);
  }

  private close(child: ChildProcessWithoutNullStreams) {
    const kill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
    child.stdin.end();
  }
}
