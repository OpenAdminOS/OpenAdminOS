import { validVadFrames } from "./vad-protocol.js";
import { fileURLToPath } from "node:url";
import type { UtilityProcess, utilityProcess } from "electron";

export class NovaVad {
  private child?: UtilityProcess;
  private pending?: Promise<number[]>;

  constructor(private readonly path: string, private readonly signal: AbortSignal, private readonly fork?: typeof utilityProcess.fork) {}

  async score(frames: unknown): Promise<number[]> {
    if (!validVadFrames(frames)) throw new Error("Invalid local microphone frames. Restart the session.");
    if (this.pending) throw new Error("Local microphone input is busy. Restart the session.");
    const job = this.run(frames).catch(async () => {
      this.signal.throwIfAborted();
      return this.run(frames);
    });
    this.pending = job;
    try { return await job; }
    finally { this.pending = undefined; }
  }

  private async run(frames: Float32Array[]): Promise<number[]> {
    const fork = this.fork ?? (await import("electron")).utilityProcess.fork;
    this.signal.throwIfAborted();
    const fresh = !this.child;
    const child = this.child ??= fork(
      fileURLToPath(new URL("./vad-worker.js", import.meta.url)), [this.path],
      { serviceName: "Nova Voice Detection", stdio: "ignore" },
    );
    if (fresh) {
      const stop = () => child.kill();
      this.signal.addEventListener("abort", stop, { once: true });
      child.once("exit", () => {
        this.signal.removeEventListener("abort", stop);
        if (this.child === child) this.child = undefined;
      });
    }
    return new Promise((resolve, reject) => {
      const budget = AbortSignal.any([this.signal, AbortSignal.timeout(5000)]);
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("exit", fail);
        child.off("error", fail);
        budget.removeEventListener("abort", fail);
      };
      const fail = () => {
        cleanup();
        child.kill();
        this.child = undefined;
        reject(new Error("Local voice detection stopped. Start Nova again or select Hold to talk in Settings."));
      };
      const onMessage = (message: { ready?: boolean; scores?: number[] } | null) => {
        if (message?.ready === true && fresh) child.postMessage(frames);
        else if (Array.isArray(message?.scores) && message.scores.length === frames.length && Array.from(message.scores).every(score => Number.isFinite(score) && score >= 0 && score <= 1)) {
          cleanup();
          resolve(message.scores);
        } else fail();
      };
      child.on("message", onMessage);
      child.once("exit", fail);
      child.once("error", fail);
      budget.addEventListener("abort", fail, { once: true });
      if (!fresh) child.postMessage(frames);
    });
  }
}
