import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { UtilityProcess, utilityProcess } from "electron";
import type { NovaLocalVoicePreferences, NovaSpeechStatus } from "@openadminos/agent-sdk";
import { DataFolderSealedError, dataFolderSealed } from "../data-folder-seal.js";
import { installSpeechModels, kokoroModels, SpeechModelIntegrity, whisperModels, type ModelFile } from "./models.js";
import { WhisperRuntime, whisperUsesMetal } from "./whisper.js";
import { directFetch } from "../retrieval/direct-fetch.js";

export const novaVoiceFetch: typeof fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "http://127.0.0.1:8080" && url.origin !== "http://127.0.0.1:8880") {
    return fetch(input, options);
  }
  if (options.body instanceof FormData) {
    const multipart = new Response(options.body);
    return directFetch(url, {
      ...options,
      body: new Uint8Array(await multipart.arrayBuffer()),
      headers: { "Content-Type": multipart.headers.get("content-type")! },
    });
  }
  return directFetch(url, options);
};

const kokoroError = "Built-in Kokoro could not speak. Retry local voice or use your device's voice.";

export class LocalSpeech {
  private download?: AbortController;
  private progress?: number;
  private failure?: string;
  private whisper?: WhisperRuntime;
  private worker?: UtilityProcess;
  private requestId = 0;
  private readonly integrity = new SpeechModelIntegrity();
  private readonly repair = new Map<string, string>();
  private workerIdle?: ReturnType<typeof setTimeout>;
  private speechQueue = Promise.resolve();
  private readonly gpuAccelerated = whisperUsesMetal;
  private selection: { source: "builtin" | "servers"; model: "auto" | "small" | "turbo" } = { source: "builtin", model: "auto" };

  private preferences: NovaLocalVoicePreferences = { interaction: "hands-free", silenceMs: 800, idleSeconds: 120, showTimings: false };

  constructor(private readonly directory: string, private readonly binary: string, private readonly dependencies: {
    fork?: typeof utilityProcess.fork;
    fetch?: typeof fetch;
    files?: (model: "small" | "turbo") => readonly ModelFile[];
  } = {}) {
    try {
      const saved = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
      if (validVoicePreferences(saved.preferences)) this.preferences = saved.preferences;
      if (saved.source === "builtin" || saved.source === "servers") this.selection.source = saved.source;
      if (saved.model === "auto" || saved.model === "small" || saved.model === "turbo") this.selection.model = saved.model;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[nova-speech] Could not read local speech settings.");
    }
  }

  private get model() { return this.selection.model === "auto" ? (this.gpuAccelerated ? "turbo" : "small") : this.selection.model; }
  private get files() { return this.filesFor(this.model); }
  private get target() { return this.targetFor(this.model); }
  private targetFor(model: "small" | "turbo") { return join(this.directory, "models-v1-" + model); }
  private filesFor(model: "small" | "turbo") { return this.dependencies.files?.(model) ?? [whisperModels[model], ...kokoroModels]; }

  private installedBytes(model: "small" | "turbo"): number {
    return this.filesFor(model).reduce((total, file) =>
      total + (statSync(join(this.targetFor(model), file.path), { throwIfNoEntry: false })?.size ?? 0), 0);
  }
  get advanced() { return this.selection.source === "servers"; }

  status(): NovaSpeechStatus {
    return {
      ...this.selection, preferences: this.preferences, selectedModel: this.model, gpuAccelerated: this.gpuAccelerated,
      available: existsSync(this.binary),
      repairNeeded: this.repair.has(this.target),
      unusedBytes: this.installedBytes(this.model === "small" ? "turbo" : "small"),
      ready: !this.repair.has(this.target) && this.files.every(file => statSync(join(this.target, file.path), { throwIfNoEntry: false })?.size === file.bytes),
      totalBytes: this.files.reduce((total, item) => total + item.bytes, 0),
      receivedBytes: this.progress,
      error: this.failure ?? this.repair.get(this.target),
    };
  }

  configure(source: unknown, model: unknown) {
    if ((source !== "builtin" && source !== "servers") || (model !== "auto" && model !== "small" && model !== "turbo"))
      throw new Error("Choose a supported local voice source and model.");
    const next = { source, model } as const;
    this.saveSettings(next, this.preferences);
    this.stop();
    this.selection = next;
    this.failure = undefined;
  }

  configurePreferences(value: unknown) {
    if (!validVoicePreferences(value)) throw new Error("Choose a supported local voice mode and timeout.");
    const { interaction, silenceMs, idleSeconds, showTimings } = value;
    const next = { interaction, silenceMs, idleSeconds, showTimings };
    this.saveSettings(this.selection, next);
    this.preferences = next;
  }

  private saveSettings(selection: typeof this.selection, preferences: NovaLocalVoicePreferences) {
    if (dataFolderSealed()) throw new DataFolderSealedError();
    mkdirSync(this.directory, { recursive: true });
    const settings = join(this.directory, "settings.json");
    writeFileSync(settings + ".tmp", JSON.stringify({ ...selection, preferences }));
    renameSync(settings + ".tmp", settings);
  }

  async install() {
    if (this.download) return;
    if (this.advanced || !this.status().available) throw new Error("Built-in local voice is unavailable in this build.");
    const controller = this.download = new AbortController();
    this.progress = 0;
    this.failure = undefined;
    const target = this.target;
    const files = this.files;
    try {
      if (dataFolderSealed()) throw new DataFolderSealedError();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
      const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (entry.isDirectory() && /^models-v1-(small|turbo)\.staging-[A-Za-z0-9]+$/.test(entry.name)) {
          signal.throwIfAborted();
          if (dataFolderSealed()) throw new DataFolderSealedError();
          await rm(join(this.directory, entry.name), { recursive: true, force: true });
        }
      }
      if (!this.repair.has(target) && await this.integrity.check(target, files, signal)) return;
      signal.throwIfAborted();
      if (dataFolderSealed()) throw new DataFolderSealedError();
      this.whisper?.stop();
      this.whisper = undefined;
      this.stopWorker();
      // A previously installed set can be missing files after manual removal.
      await rm(target, { recursive: true, force: true });
      await installSpeechModels({
        target, files,
        signal, fetchImpl: this.dependencies.fetch,
        onProgress: received => { this.progress = received; },
      });
      this.repair.delete(target);
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = (error as NodeJS.ErrnoException).code;
        this.failure = code === "ENOSPC"
          ? "The app data folder is out of space. Free up space and retry the download."
          : error instanceof DataFolderSealedError
            ? error.message
            : error instanceof Error && error.message.includes("Retry setup.")
              ? error.message
              : "Local voice models could not be downloaded or saved. Check your network and free disk space, then retry.";
      }
    } finally {
      this.download = undefined;
      this.progress = undefined;
    }
  }

  cancel() { this.download?.abort(); }

  stop() {
    this.cancel();
    this.whisper?.stop();
    this.whisper = undefined;
    this.stopWorker();
  }

  private stopWorker() {
    clearTimeout(this.workerIdle);
    const child = this.worker;
    this.worker = undefined;
    child?.kill();
  }

  private async requireModels(signal: AbortSignal) {
    if (!existsSync(this.binary)) throw new Error("Built-in Whisper is unavailable in this build. Install a desktop release or use your own servers.");
    const target = this.target;
    if (this.download) throw new Error("Wait for the local voice download to finish, or type your question.");
    if (this.files.some(file => !existsSync(join(target, file.path)))) {
      throw new Error("Set up local voice to use the microphone, or type your question.");
    }
    if (!await this.integrity.check(target, this.files, signal)) {
      const message = "Local voice models failed verification. Choose Download again to repair them.";
      this.repair.set(target, message);
      throw new Error(message);
    }
    if (this.download || target !== this.target || this.advanced) throw new Error("Local voice settings changed. Try again.");
  }

  private async whisperRuntime(signal: AbortSignal) {
    await this.requireModels(signal);
    return this.whisper ??= new WhisperRuntime(this.binary, join(this.target, whisperModels[this.model].path));
  }

  async check(full = true) {
    const signal = AbortSignal.timeout(60_000);
    const target = this.target;
    const runtime = await this.whisperRuntime(signal);
    try {
      await runtime.check(signal);
      if (full) await this.speak("Nova is ready.", signal);
      else if (this.repair.get(target)?.startsWith("Built-in Whisper")) this.repair.delete(target);
    } catch (error) {
      if (target === this.target) this.repair.set(target, (error as Error).message);
      throw error;
    }
  }

  async openCallTranscriber(signal: AbortSignal): Promise<WhisperRuntime> {
    await this.requireModels(signal).catch(() => {
      signal.throwIfAborted();
      throw new Error("Set up built-in local speech in Settings > Nova, then start call assist again.");
    });
    const runtime = new WhisperRuntime(this.binary, join(this.target, whisperModels[this.model].path), 5 * 60_000, true);
    const stop = () => runtime.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await runtime.check(signal);
      return runtime;
    } catch {
      runtime.stop();
      signal.throwIfAborted();
      throw new Error("Set up built-in local speech in Settings > Nova, then start call assist again.");
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal) {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const runtime = await this.whisperRuntime(budget);
    return runtime.transcribe(audio, budget);
  }

  speak(text: string, signal: AbortSignal, onAudio?: (wav: Uint8Array, remainingText?: string) => void): Promise<Uint8Array> {
    const result = this.speechQueue.then(() => this.speakOnce(text, signal, onAudio));
    this.speechQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async speakOnce(text: string, signal: AbortSignal, onAudio?: (wav: Uint8Array, remainingText?: string) => void): Promise<Uint8Array> {
    await this.requireModels(signal);
    signal.throwIfAborted();
    clearTimeout(this.workerIdle);
    const target = this.target;
    const fresh = !this.worker;
    const fork = this.dependencies.fork ?? (await import("electron")).utilityProcess.fork;
    signal.throwIfAborted();
    if (target !== this.target || this.download || this.advanced) throw new Error("Local voice settings changed. Try again.");
    const id = ++this.requestId;
    const child = this.worker ??= fork(fileURLToPath(new URL("./kokoro-worker.js", import.meta.url)), [
      target,
    ], { serviceName: "Nova Kokoro", stdio: "ignore" });

    const budget = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const waveParts: Buffer[] = [];
    return new Promise((resolve, reject) => {
      function cleanup() {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onExit);
        budget.removeEventListener("abort", onAbort);
      }
      const onExit = () => {
        if (this.worker === child) this.repair.set(target, kokoroError);
        cleanup();
        if (this.worker === child) this.worker = undefined;
        child.kill();
        reject(new Error(kokoroError));
      };
      const onAbort = () => {
        cleanup();
        if (this.worker === child) this.worker = undefined;
        child.kill();
        reject(signal.aborted ? signal.reason : new Error(kokoroError));
      };
      const onMessage = (message: { id?: number; remainingText?: string; ready?: boolean; loadMs?: number; firstAudioMs?: number; wavReadyMs?: number; done?: boolean; failed?: boolean; audio?: Uint8Array }) => {
        if (message.ready && fresh) {
          console.info("[nova-speech] kokoro model load ms", message.loadMs);
          child.postMessage({ id, text });
        } else if (message.id !== id) {
          return;
        } else if (message.audio) {
          if (message.firstAudioMs !== undefined) console.info("[nova-speech] TTS first audio ms", message.firstAudioMs);
          if (onAudio) onAudio(message.audio, message.remainingText);
          else waveParts.push(Buffer.from(message.audio));
        } else {
          cleanup();
          this.workerIdle = setTimeout(() => {
            if (this.worker === child) child.kill();
          }, 5 * 60_000);
          this.workerIdle.unref();
          if (message.failed || !message.done) reject(new Error(kokoroError));
          else {
            if (this.repair.get(target) === kokoroError) this.repair.delete(target);
            console.info("[nova-speech] TTS WAV ready ms", message.wavReadyMs);
            if (waveParts.length === 0) resolve(new Uint8Array());
            else {
              const wav = Buffer.concat([waveParts[0]!, ...waveParts.slice(1).map(part => part.subarray(44))]);
              wav.writeUInt32LE(wav.length - 8, 4);
              wav.writeUInt32LE(wav.length - 44, 40);
              resolve(wav);
            }
          }
        }
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onExit);
      budget.addEventListener("abort", onAbort, { once: true });
      if (fresh) child.once("exit", () => { if (this.worker === child) this.worker = undefined; });
      else child.postMessage({ id, text });
    });
  }
}

function validVoicePreferences(value: unknown): value is NovaLocalVoicePreferences {
  if (!value || typeof value !== "object") return false;
  const { interaction, silenceMs, idleSeconds, showTimings } = value as NovaLocalVoicePreferences;
  return (interaction === "hands-free" || interaction === "hold-to-talk") &&
    Number.isInteger(silenceMs) && silenceMs >= 300 && silenceMs <= 2000 &&
    Number.isInteger(idleSeconds) && idleSeconds >= 15 && idleSeconds <= 600 &&
    typeof showTimings === "boolean";
}
