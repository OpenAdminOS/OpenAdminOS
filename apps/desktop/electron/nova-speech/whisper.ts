import { whisperModels } from "./models.js";
import { prepareRecording, shortWhisperContext } from "./recording.js";
import { speechThreads } from "./threads.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Agent, request } from "node:http";
import { basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

class UnsupportedWhisperProcessor extends Error {
  constructor() {
    super("This processor is not supported for built-in transcription. Type a question or select My own servers in Settings > Nova.");
  }
}

const recovery = "Built-in Whisper stopped or could not start. Check local voice setup, then retry or type your question.";

export const whisperUsesMetal = process.platform === "darwin" && process.arch === "arm64";

export class WhisperRuntime {
  private child?: ChildProcess;
  private starting?: Promise<string>;
  private idle?: ReturnType<typeof setTimeout>;
  private active = 0;

  constructor(private readonly executable: string, private readonly model: string, private readonly idleMs = 5 * 60_000) {}

  stop() {
    clearTimeout(this.idle);
    this.starting = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    const fallback = setTimeout(() => child.kill("SIGKILL"), 500);
    fallback.unref();
    child.once("exit", () => clearTimeout(fallback));
  }

  async check(signal: AbortSignal) {
    await this.use(signal, () => undefined);
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<{ text: string; language?: string }> {
    const started = performance.now();
    const transcript = await this.use(signal, async (url) => {
      const { wav, seconds } = prepareRecording(audio);
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
      form.set("response_format", "json");
      if (!whisperUsesMetal && basename(this.model) === whisperModels.small.path) {
        const context = shortWhisperContext(seconds);
        if (context) form.set("audio_ctx", String(context));
      }
      const body = new Response(form);
      const result = await localJson(url + "/inference", signal, Buffer.from(await body.arrayBuffer()), body.headers.get("content-type")!);
      if (typeof result.text !== "string") throw new Error("Whisper did not return a transcript. Retry or type your question.");
      return { text: result.text, language: typeof result.language === "string" ? result.language : undefined };
    });
    console.info("[nova-speech] transcribe ms", Math.round(performance.now() - started));
    return transcript;
  }

  private async use<T>(signal: AbortSignal, work: (url: string) => T | Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.active++;
    clearTimeout(this.idle);
    try {
      const url = await (this.starting ??= this.start());
      signal.throwIfAborted();
      return await work(url);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof UnsupportedWhisperProcessor) throw error;
      throw new Error(recovery, { cause: error });
    } finally {
      this.active--;
      if (this.active === 0 && this.child) {
        this.idle = setTimeout(() => this.stop(), this.idleMs);
        this.idle.unref();
      }
    }
  }

  private async start(): Promise<string> {
    const started = performance.now();
    const prefix = "/" + randomBytes(24).toString("hex");
    const child = this.child = spawn(this.executable, [
      "--host", "127.0.0.1", "--port", "0", "--model", this.model,
      "--threads", String(speechThreads()), "--language", "auto", "--no-timestamps", "--best-of", "1", "--beam-size", "1",
    ], { cwd: dirname(this.executable), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let startupFailure: Error | undefined;
    const stopped = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (!whisperUsesMetal && (signal === "SIGILL" || code === 132 || (code != null && (code >>> 0) === 0xc000001d))) {
        startupFailure = new UnsupportedWhisperProcessor();
      }
      if (this.child === child) this.stop();
    };
    child.on("error", () => stopped());
    child.stdin?.on("error", () => { /* Startup and exit listeners report pipe failures. */ });
    child.on("exit", stopped);
    try {
      const signal = AbortSignal.timeout(45_000);
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        const cleanup = () => {
          child.stdout?.off("data", onData);
          child.off("error", onExit);
          child.off("exit", onExit);
          signal.removeEventListener("abort", onExit);
        };
        const onExit = () => {
          cleanup();
          reject(startupFailure ?? new Error(recovery));
        };
        const onData = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096);
          const match = /listening at http:\/\/127\.0\.0\.1:(\d+)\s/.exec(output);
          if (match) {
            cleanup();
            child.stdout?.resume();
            resolve(Number(match[1]));
          }
        };
        child.stdout?.on("data", onData);
        child.once("error", onExit);
        child.once("exit", onExit);
        signal.addEventListener("abort", onExit, { once: true });
        child.stdin?.write(prefix + "\n");
      });
      const url = `http://127.0.0.1:${port}${prefix}`;
      while (this.child === child && !signal.aborted) {
        const health = await localJson(url + "/health", signal).catch(() => undefined);
        if (health?.status === "ok") {
          console.info("[nova-speech] whisper model load ms", Math.round(performance.now() - started));
          return url;
        }
        await delay(150, undefined, { signal });
      }
      throw startupFailure ?? new Error(recovery);
    } catch (error) {
      stopped();
      throw error;
    }
  }
}

function localJson(url: string, signal: AbortSignal, body?: Buffer, contentType?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const agent = new Agent();
    const req = request(url, {
      agent,
      signal,
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": contentType, "Content-Length": body.length } : undefined,
    }, async (response) => {
      try {
        if (response.statusCode !== 200) throw new Error(recovery);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 1024 * 1024) throw new Error(recovery);
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    req.once("error", reject);
    req.end(body);
  });
}
