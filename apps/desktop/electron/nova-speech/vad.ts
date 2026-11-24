import { fileURLToPath } from "node:url";
import type { UtilityProcess } from "electron";

export class NovaVad {
  private child?: UtilityProcess;
  private pending?: Promise<number>;

  constructor(private readonly path: string, private readonly signal: AbortSignal) {}

  async score(frame: unknown): Promise<number> {
    if (!(frame instanceof Float32Array) || frame.length !== 512 || frame.some(value => !Number.isFinite(value) || Math.abs(value) > 1))
      throw new Error("Invalid local microphone frame. Restart the session.");
    if (this.pending) throw new Error("Local microphone input is busy. Restart the session.");
    const job = this.run(frame);
    this.pending = job;
    try { return await job; }
    finally { this.pending = undefined; }
  }

  private async run(frame: Float32Array): Promise<number> {
    const { utilityProcess } = await import("electron");
    this.signal.throwIfAborted();
    const fresh = !this.child;
    const child = this.child ??= utilityProcess.fork(
      fileURLToPath(new URL("./vad-worker.js", import.meta.url)), [this.path],
      { serviceName: "Nova Voice Detection", stdio: "ignore" },
    );
    if (fresh) this.signal.addEventListener("abort", () => child.kill(), { once: true });
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
      const onMessage = (message: { ready?: boolean; score?: number }) => {
        if (message.ready) child.postMessage(frame);
        else if (typeof message.score === "number" && Number.isFinite(message.score)) {
          cleanup();
          resolve(message.score);
        } else fail();
      };
      child.on("message", onMessage);
      child.once("exit", fail);
      child.once("error", fail);
      budget.addEventListener("abort", fail, { once: true });
      if (!fresh) child.postMessage(frame);
    });
  }
}
