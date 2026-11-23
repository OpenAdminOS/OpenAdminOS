import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";
import { isRefusedRedirect, modelServerRedirect, redirectRefusedDetail } from "./llm-openai-compatible.js";

export interface OllamaProviderOptions {
  endpoint?: string;
  defaultModel?: string;
  timeoutMs?: number;
  /** How long reading the model's context limit may take (tests). */
  lookupTimeoutMs?: number;
  /**
   * Read the model's entry from /api/tags (which loads no model) before each
   * request, so a model replaced under the same name between two requests on
   * this adapter gets its own think value. On unless set to false.
   */
  refreshModelFamily?: boolean;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    content?: string;
    /**
     * Ollama 0.10+ emits reasoning-model chain-of-thought in this
     * separate field. It is never used as the answer; it only tells us
     * the model reasoned without writing one.
     */
    thinking?: string;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  /** Tokens consumed parsing the prompt + system message. */
  prompt_eval_count?: number;
  /** Tokens generated in the response. */
  eval_count?: number;
}

const DEFAULT_OLLAMA_TIMEOUT_MS = 180_000;
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
/** Room left for the answer when the caller sets no token limit. */
const OLLAMA_ANSWER_RESERVE_TOKENS = 4096;
const OLLAMA_SHOW_TIMEOUT_MS = 5000;

/**
 * The context size this app raised for a model, keyed by endpoint and model.
 * Later requests keep sending it so Ollama does not reload the model with
 * its smaller default between turns. It is dropped when a request that sends
 * it fails with a context overflow or an out-of-memory error.
 */
// TODO(ugur): Should small requests keep sending the raised size (no model
// reload between turns, but the larger context keeps its memory until the
// app restarts), or go back to Ollama's default (saves memory, but the next
// large request reloads the model and retries)? SPEC.md is silent, so the
// raised size is kept for every later request.
const ollamaContextOverrides = new Map<string, number>();

/**
 * How often a context size failed, keyed by endpoint, model and size. A retry
 * keeps its size only if that size has not failed since the retry started, so
 * a retry that finishes late cannot bring back a size a newer request saw fail.
 */
const ollamaContextFailures = new Map<string, number>();
const contextFailureKey = (cacheKey: string, size: number) => `${cacheKey}\0${size}`;

export interface OllamaEndpointTrust {
  endpoint: string;
  isLocal: boolean;
  reason: string;
}

export function createOllamaLlm(options: OllamaProviderOptions = {}): RunLlmApi {
  const endpoint = resolveOllamaEndpoint(options.endpoint);
  const defaultModel = options.defaultModel;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(
      process.env.OPENAGENTS_OLLAMA_TIMEOUT_MS ?? String(DEFAULT_OLLAMA_TIMEOUT_MS),
      10,
    );

  return {
    available: true,
    defaultModel,
    streamsIncrementally: true,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(opts)) {
        last = chunk;
      }
      if (!last) {
        throw new Error("Ollama returned no content.");
      }
      return {
        text: last.accumulated,
        model: last.model,
        ...(last.tokenUsage ? { tokenUsage: last.tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error("No Ollama model available. Pull a model with `ollama pull <model>`.");
      }
      // The installed model the name resolves to: what is known about the
      // model is kept under it, while the request sends the name as given.
      // A newer version read that applied while the list was read decides.
      const settleInstalledModel = async (): Promise<string> => {
        let installed = await resolveOllamaModel(endpoint, model, opts.signal);
        for (let pass = 0; pass < 2; pass += 1) {
          if (opts.signal?.aborted) throw new Error("Ollama request stopped by user.");
          if (options.refreshModelFamily !== false) {
            await refreshOllamaModelFamily(endpoint, installed, undefined, opts.signal);
            if (opts.signal?.aborted) throw new Error("Ollama request stopped by user.");
          }
          const now = ollamaInstalledModelNow(endpoint, model);
          if (now === installed) break;
          installed = now;
        }
        return installed;
      };
      let installedModel = await settleInstalledModel();

      // Each request to /api/chat gets its own controller and timeout, so a
      // retry is not charged for the time the first request and the model
      // lookup took. A stop from the caller aborts whichever one is running.
      let controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // How a timeout message names the request that timed out.
      let attemptLabel = "";
      const startAttempt = (label: string) => {
        clearTimeout(timer);
        const current = new AbortController();
        controller = current;
        attemptLabel = label;
        if (opts.signal?.aborted) current.abort();
        else timer = setTimeout(() => current.abort(), timeoutMs);
      };
      const abortFromCaller = () => controller.abort();
      opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const url = `${endpoint.replace(/\/$/, "")}/api/chat`;

      const messages: { role: string; content: string }[] = [];
      if (opts.system) {
        messages.push({ role: "system", content: opts.system });
      }
      messages.push({ role: "user", content: opts.prompt });

      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        // Ask Ollama to skip reasoning-model "thinking" mode and have
        // the model produce its answer directly, so the model does not
        // spend its token budget inside a hidden chain-of-thought.
        // gpt-oss ignores `false` and always reasons, so it gets the
        // lowest effort level instead. What Ollama showed about this model
        // (it rejected the level, or reasoned anyway) overrides its name.
        think: ollamaThinkFor(endpoint, installedModel),
      };
      // What Ollama's answers show applies only to the version this request was sent to.
      let sentDigest = ollamaModelDigests.get(familyKey(endpoint, installedModel));
      // Registered, so a model list read that finds it removed while this
      // request runs changes its generation.
      if (!ollamaModelGenerations.has(familyKey(endpoint, installedModel))) ollamaModelGenerations.set(familyKey(endpoint, installedModel), 0);
      let sentGeneration = ollamaModelGenerations.get(familyKey(endpoint, installedModel)) ?? 0;
      // The family the think value was chosen with.
      let sentFamily = ollamaModelFamilies.get(familyKey(endpoint, installedModel));
      const learn = (value: false | "low") => {
        const key = familyKey(endpoint, installedModel);
        // Only about the model this request went to: not one removed or
        // replaced under the name since.
        if (ollamaModelFamilies.has(key) || ollamaModelDigests.get(key) !== sentDigest) return;
        if ((ollamaModelGenerations.get(key) ?? 0) !== sentGeneration) return;
        ollamaThinkLearned.set(key, { value, digest: sentDigest });
      };
      const optionsPayload: Record<string, number> = {};
      if (typeof opts.temperature === "number") {
        optionsPayload.temperature = opts.temperature;
      }
      if (typeof opts.maxTokens === "number") {
        optionsPayload.num_predict = opts.maxTokens;
      }
      if (Object.keys(optionsPayload).length > 0) {
        body.options = optionsPayload;
      }

      const cacheKey = `${endpoint}\0${model}`;
      const send = async (numCtx: number | undefined): Promise<Response> => {
        const payload = numCtx === undefined ? body : { ...body, options: { ...optionsPayload, num_ctx: numCtx } };
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
            redirect: modelServerRedirect(url),
          });
        } catch (error) {
          throw abortError() ?? new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
        }
        if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail("Ollama", url));
        return response;
      };
      /** The body of a failed response; a stop or timeout while reading it keeps its own message. */
      const errorDetail = async (response: Response): Promise<string> => {
        if (response.ok) return "";
        try {
          return await response.text();
        } catch (error) {
          throw abortError() ?? new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
        }
      };
      const stoppedByUser = () => new Error("Ollama request stopped by user.");
      const abortError = (): Error | undefined => {
        if (!controller.signal.aborted) return undefined;
        return opts.signal?.aborted
          ? stoppedByUser()
          : new Error(`Ollama timed out after ${timeoutMs}ms at ${url}${attemptLabel}.`);
      };

      let response: Response;
      let raisedCtx: number | undefined;
      // Set while the retry runs, so a memory failure can name both sizes.
      let retry: { requested: number; numCtx: number } | undefined;
      let modelMax: number | undefined;
      const cachedCtx = ollamaContextOverrides.get(cacheKey);
      /**
       * Forgets a size the attempt that just failed sent. A failure is
       * evidence only about the size that attempt asked for, at the moment it
       * failed, so it never touches another size, and it forgets this size
       * even when a concurrent request has kept it since.
       */
      const forgetSize = (size: number | undefined) => {
        if (size === undefined) return;
        const failureKey = contextFailureKey(cacheKey, size);
        ollamaContextFailures.set(failureKey, (ollamaContextFailures.get(failureKey) ?? 0) + 1);
        if (ollamaContextOverrides.get(cacheKey) === size) ollamaContextOverrides.delete(cacheKey);
      };
      // The failure count of the retry's size when the retry started.
      let retryFailuresAtStart = 0;
      /**
       * A failure, from an HTTP answer or the stream, that shows the context
       * the running attempt sent did not fit or could not be loaded. Forgets
       * that size and returns the message; undefined for other failures.
       */
      const contextFailure = (text: string, answering: boolean): Error | undefined => {
        const counted = parseContextOverflow(text);
        const memory = isOllamaMemoryError(text);
        if (!counted && !memory && !isOllamaPromptTooLong(text)) return undefined;
        // Ollama still giving all of the size this attempt sent means the
        // prompt outgrew it (Ollama can reject a prompt that exactly fills
        // the context), not that memory ran out; that size stays.
        const sent = retry ? retry.numCtx : cachedCtx;
        const sentSizeGiven = counted !== undefined && sent !== undefined && counted.available >= sent;
        if (!sentSizeGiven) forgetSize(sent);
        if (memory) {
          if (retry) {
            return new Error(
              answering
                ? `Ollama failed partway through an answer from ${model} on the retry with a ${formatTokens(retry.numCtx)} token context size, usually because free memory ran out. Ollama said: ${truncate(text, 200)}`
                : contextMemoryMessage(model, retry.requested, retry.numCtx, text),
            );
          }
          if (cachedCtx !== undefined) return new Error(cachedContextMemoryMessage(model, cachedCtx, text, answering));
          return undefined;
        }
        if (counted) {
          const atModelLimit = modelMax !== undefined && counted.available >= modelMax;
          if (!atModelLimit && sent !== undefined && counted.available >= sent) {
            // Ollama gave all the context asked for; the request outgrew it.
            return new Error(`Ollama context size too small: This request needs ${formatTokens(counted.requested)} tokens of context and did not fit in the ${formatTokens(counted.available)} Ollama loaded for ${model}.`);
          }
          return new Error(contextTooSmallMessage(model, counted.requested, counted.available, atModelLimit));
        }
        return new Error(notFitMessage(model, retry ? { size: retry.numCtx, kept: false } : cachedCtx !== undefined ? { size: cachedCtx, kept: true } : undefined, text));
      };
      /**
       * Sends once, and once more without a level when Ollama rejects the
       * level this model was sent (a model named like gpt-oss that is not one).
       */
      const sendWithThinkFallback = async (numCtx: number | undefined): Promise<[Response, string]> => {
        let sent = await send(numCtx);
        let text = await errorDetail(sent);
        // At most two resends: a model replaced or upgraded since the request
        // was built gets its own value first, and if it rejects that too, none.
        for (let resend = 0; resend < 2 && sent.status === 400 && body.think !== false && rejectsThinkLevel(text); resend += 1) {
          const previous = { model: installedModel, generation: sentGeneration, family: sentFamily };
          installedModel = await settleInstalledModel();
          const key = familyKey(endpoint, installedModel);
          const generation = ollamaModelGenerations.get(key) ?? 0;
          const family = ollamaModelFamilies.get(key);
          if (installedModel === previous.model && generation === previous.generation && family === previous.family) {
            // The model that rejected the level is still the one installed:
            // it gets none, and that is remembered for it.
            learn(false);
            body.think = false;
          } else {
            // Another model, or one Ollama now reports a family for.
            body.think = family !== undefined ? ollamaThinkSetting(model, family) : ollamaThinkFor(endpoint, installedModel);
          }
          sentDigest = ollamaModelDigests.get(key);
          sentGeneration = generation;
          sentFamily = family;
          startAttempt(attemptLabel);
          sent = await send(numCtx);
          text = await errorDetail(sent);
        }
        return [sent, text];
      };
      try {
        let numCtx = cachedCtx;

        startAttempt(cachedCtx === undefined ? "" : ` with the ${formatTokens(cachedCtx)} token context kept from an earlier request`);
        let detail: string;
        [response, detail] = await sendWithThinkFallback(numCtx);
        const overflow = response.status === 400 ? parseContextOverflow(detail) : undefined;
        if (overflow) {
          // Less room than the kept size asked for means Ollama can no longer
          // give it. Otherwise the prompt grew and the kept size stays.
          if (cachedCtx !== undefined && overflow.available < cachedCtx) forgetSize(cachedCtx);
          // The first request's budget ends here; the lookup has its own.
          clearTimeout(timer);
          // Ollama sizes the context from its own default and free memory,
          // not from the model's limit. Ask for enough room for this prompt
          // plus the answer, up to what the model supports, and retry once.
          modelMax = await readOllamaContextLength(endpoint, model, opts.signal ?? new AbortController().signal, lookupTimeoutMs);
          if (opts.signal?.aborted) throw stoppedByUser();
          // The model may have been replaced under its name during the lookup:
          // the retry gets the think value of the model installed now.
          installedModel = await settleInstalledModel();
          body.think = ollamaThinkFor(endpoint, installedModel);
          sentDigest = ollamaModelDigests.get(familyKey(endpoint, installedModel));
          sentGeneration = ollamaModelGenerations.get(familyKey(endpoint, installedModel)) ?? 0;
          sentFamily = ollamaModelFamilies.get(familyKey(endpoint, installedModel));
          const wanted = roundUp(overflow.requested + (opts.maxTokens ?? OLLAMA_ANSWER_RESERVE_TOKENS), 1024);
          if (modelMax !== undefined && overflow.requested > modelMax) {
            throw new Error(contextTooSmallMessage(model, overflow.requested, modelMax, true));
          }
          numCtx = modelMax === undefined ? wanted : Math.min(wanted, modelMax);
          retry = { requested: overflow.requested, numCtx };
          retryFailuresAtStart = ollamaContextFailures.get(contextFailureKey(cacheKey, numCtx)) ?? 0;
          startAttempt(` on the retry with a ${formatTokens(numCtx)} token context`);
          [response, detail] = await sendWithThinkFallback(numCtx);
          if (response.ok) raisedCtx = numCtx;
        }
        if (!response.ok) {
          const failed = contextFailure(detail, false);
          if (failed) throw failed;
          if (response.status === 404 && detail.toLowerCase().includes("model")) {
            throw new Error(
              `Ollama model "${model}" is not pulled. Run \`ollama pull ${model}\`.`,
            );
          }
          throw new Error(`Ollama responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
        }
      } catch (error) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw error;
      }

      if (!response.body) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw new Error("Ollama response had no body to stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
      // Whether the model streamed any reasoning, whitespace included.
      let reasoned = false;
      // A model can also reason inline in its content, in think tags.
      const inlineThink = createInlineThinkFilter();
      let actualModel = model;

      try {
        while (true) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (error) {
            // A stop or the deadline mid-stream keeps its own message.
            throw abortError() ?? error;
          }
          const { value, done } = read;
          // At the end of the body the last record may lack its newline;
          // it is read like any other.
          buffer += done ? `${decoder.decode()}\n` : decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            // A stop while the caller handled the last chunk ends the stream
            // before records that were already buffered.
            const stopped = abortError();
            if (stopped) throw stopped;
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(trimmed) as OllamaChatChunk;
            } catch {
              continue;
            }
            if (chunk.error) {
              // Ollama can accept a request and then fail to load the model
              // with its context, or run out of room or memory mid-answer.
              throw contextFailure(errorText(chunk.error), accumulated.length > 0) ?? new Error(`Ollama error: ${chunk.error}`);
            }
            if (
              chunk.done &&
              raisedCtx !== undefined &&
              (ollamaContextFailures.get(contextFailureKey(cacheKey, raisedCtx)) ?? 0) === retryFailuresAtStart
            ) {
              // Kept only once the stream finished cleanly, and before the
              // caller sees the last chunk and may stop reading. Concurrent
              // requests can raise it at once; keep the largest that worked.
              ollamaContextOverrides.set(cacheKey, Math.max(ollamaContextOverrides.get(cacheKey) ?? 0, raisedCtx));
            }
            if (typeof chunk.model === "string" && chunk.model.length > 0) {
              actualModel = chunk.model;
            }
            const tokenUsage = extractTokenUsage(chunk);
            const content = inlineThink.push(chunk.message?.content ?? "");
            const delta = chunk.done ? content + inlineThink.flush() : content;
            if (inlineThink.reasoned) reasoned = true;
            // Track reasoning-model chain-of-thought separately so a
            // reply with reasoning and no answer fails with that cause.
            const reasoningDelta = chunk.message?.thinking ?? "";
            if (reasoningDelta.length > 0) {
              reasoned = true;
              // A model of unknown family that reasons although it was asked
              // not to (gpt-oss under another name) gets the lowest level on
              // later requests.
              if (body.think === false) learn("low");
            }
            accumulated += delta;
            // Reasoning is not an answer, so it is never returned as one,
            // and the caller sees no completed chunk before this is known.
            if (chunk.done && accumulated.trim().length === 0 && reasoned) {
              throw new OllamaReasoningWithoutAnswerError(reasoningWithoutAnswerMessage(actualModel, chunk.done_reason));
            }
            if (delta.length > 0) {
              yield {
                delta,
                accumulated,
                done: Boolean(chunk.done),
                model: actualModel,
                ...(tokenUsage ? { tokenUsage } : {}),
              };
            }
            if (chunk.done) {
              if (delta.length === 0) {
                yield {
                  delta: "",
                  accumulated,
                  done: true,
                  model: actualModel,
                  ...(tokenUsage ? { tokenUsage } : {}),
                };
              }
              return;
            }
          }
          if (done) break;
        }
        // The body ended without a final record after reasoning alone.
        accumulated += inlineThink.flush();
        if (accumulated.trim().length === 0 && reasoned) {
          throw new OllamaReasoningWithoutAnswerError(reasoningWithoutAnswerMessage(actualModel, undefined));
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        reader.releaseLock();
      }
    },
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Takes reasoning a model writes inline in its content, in `<think>` blocks,
 * out of the answer as it streams: a tag split across chunks is held back
 * until it is known, and a block never closed is reasoning to the end.
 */
export function createInlineThinkFilter(): { push(text: string): string; flush(): string; readonly reasoned: boolean } {
  let inThink = false;
  let pending = "";
  let reasoned = false;
  // The longest end of `text` that could start `tag`.
  const partialTag = (text: string, tag: string): number => {
    for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
      if (tag.startsWith(text.slice(-length).toLowerCase())) return length;
    }
    return 0;
  };
  return {
    push(text) {
      let rest = pending + text;
      pending = "";
      let visible = "";
      while (rest.length > 0) {
        const tag = inThink ? THINK_CLOSE : THINK_OPEN;
        const at = rest.toLowerCase().indexOf(tag);
        if (at >= 0) {
          if (!inThink) {
            visible += rest.slice(0, at);
            reasoned = true;
          }
          rest = rest.slice(at + tag.length);
          inThink = !inThink;
          continue;
        }
        const held = partialTag(rest, tag);
        pending = rest.slice(rest.length - held);
        if (!inThink) visible += rest.slice(0, rest.length - held);
        rest = "";
      }
      return visible;
    },
    flush() {
      const rest = inThink ? "" : pending;
      pending = "";
      return rest;
    },
    get reasoned() {
      return reasoned;
    },
  };
}

/**
 * For a model whose family is unknown, the think value Ollama's last answer
 * showed it needs, keyed by endpoint and model: `false` after it rejected a
 * level, "low" after it reasoned when asked not to. An answer counts only for
 * the version (digest) its request was sent to. Each answer replaces the one
 * before; a model that both rejects a level and reasons under `false` would
 * alternate, and each of its requests still gets an answer, with one retry.
 */
const ollamaThinkLearned = new Map<string, { value: false | "low"; digest: string | undefined }>();

/** Model families from the provider check's /api/show, keyed by endpoint and model. */
const ollamaModelFamilies = new Map<string, string>();
/** Model list reads in the order they started, and the newest one applied per model. */
let ollamaFamilyReadSeq = 0;
/** The newest model list read applied per endpoint. */
const ollamaListReadApplied = new Map<string, number>();
const ollamaFamilyReadApplied = new Map<string, number>();
/** Bumped when a model under a name is removed or replaced, keyed by endpoint and model. */
const ollamaModelGenerations = new Map<string, number>();
const nextGeneration = (key: string) => ollamaModelGenerations.set(key, (ollamaModelGenerations.get(key) ?? 0) + 1);
/** The model version (digest) each recorded family belongs to. */
const ollamaModelDigests = new Map<string, string>();
const familyKey = (endpoint: string, model: string) => `${endpoint.trim().replace(/\/$/, "")}\0${ollamaModelName(model)}`;

/**
 * A model name as Ollama resolves it, so "team-model",
 * "team-model:latest" and "registry.ollama.ai/library/team-model:latest"
 * are one model: lower case, without the default registry and namespace,
 * with the default tag.
 */
export function ollamaModelName(name: string): string {
  // Ollama's name parts: [scheme://][host/][namespace/]model[:tag][@digest][:local].
  // A ":local" after a tag only says the installed model is meant, as Ollama
  // 0.40 reads it. A lone ":local" stays: older Ollama reads it as a tag.
  const parts = name.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split("/").filter(Boolean);
  if (parts.length > 0 && /:[^:]+:\s*local\s*$/.test(parts.at(-1)!)) parts[parts.length - 1] = parts.at(-1)!.replace(/:\s*local\s*$/, "");
  if (parts.length === 3 && parts[0] === "registry.ollama.ai") parts.shift();
  if (parts.length === 2 && parts[0] === "library") parts.shift();
  let normalized = parts.join("/");
  const last = parts.at(-1) ?? "";
  if (!last.includes(":") && !last.includes("@")) normalized += ":latest";
  return normalized;
}

/**
 * Records a model's family as the provider check read it (`details.family`
 * in /api/tags or /api/show, or `general.architecture` in `model_info`), so a
 * copy of a model under another name gets the right think value before its
 * first request, without another /api/show call. An answer without a family
 * forgets the one recorded before, so the name decides again.
 */
export function recordOllamaModelFamily(endpoint: string, model: string, show: unknown, read?: number): void {
  const key = familyKey(endpoint, model);
  // A read that started before the last one applied for this model is older
  // than what is known and is ignored. Without a read number the observation
  // is the newest.
  const seq = read ?? beginOllamaModelRead();
  if (seq <= (ollamaFamilyReadApplied.get(key) ?? 0)) return;
  ollamaFamilyReadApplied.set(key, seq);
  recordFamily(key, show);
}

const entryName = (entry: unknown) => {
  const record = typeof entry === "object" && entry !== null ? entry as { name?: unknown; model?: unknown } : {};
  return ollamaModelName(String(record.name ?? record.model ?? ""));
};

/**
 * Applies one successful read of Ollama's model list (from the provider check
 * or an adapter): records every listed model, and forgets what is known about
 * a model of this endpoint the list no longer has, so a model installed later
 * under its name starts fresh. A read older than the last list applied for
 * the endpoint changes nothing; returns whether it was applied.
 */
export function recordOllamaModelList(endpoint: string, models: readonly unknown[], read: number): boolean {
  // A whole list older than one already applied for this endpoint is
  // ignored, also for names it has that the newer one did not.
  const endpointKey = familyKey(endpoint, "").split("\0")[0]!;
  if (read <= (ollamaListReadApplied.get(endpointKey) ?? 0)) return false;
  ollamaListReadApplied.set(endpointKey, read);
  const listed = new Set<string>();
  for (const entry of models) {
    const name = entryName(entry);
    if (name === ollamaModelName("")) continue;
    listed.add(familyKey(endpoint, name));
    recordOllamaModelFamily(endpoint, name, entry, read);
  }
  const prefix = familyKey(endpoint, "").split("\0")[0] + "\0";
  const known = new Set([...ollamaThinkLearned.keys(), ...ollamaModelFamilies.keys(), ...ollamaModelDigests.keys(), ...ollamaModelGenerations.keys()]);
  for (const key of known) {
    if (key.startsWith(prefix) && !listed.has(key)) forgetOllamaModelKey(key, read);
  }
  return true;
}

/** Forgets what is known about a model a read found missing, unless a newer read applied. */
function forgetOllamaModel(endpoint: string, model: string, read: number): void {
  forgetOllamaModelKey(familyKey(endpoint, model), read);
}

function forgetOllamaModelKey(key: string, read: number): void {
  if (read <= (ollamaFamilyReadApplied.get(key) ?? 0)) return;
  ollamaFamilyReadApplied.set(key, read);
  ollamaThinkLearned.delete(key);
  ollamaModelFamilies.delete(key);
  ollamaModelDigests.delete(key);
  nextGeneration(key);
}

/**
 * Starts a read of Ollama's model list: call it before sending /api/tags and
 * pass the number to recordOllamaModelFamily, so a read that started earlier
 * never replaces one that started later, whichever ends first.
 */
export function beginOllamaModelRead(): number {
  ollamaFamilyReadSeq += 1;
  return ollamaFamilyReadSeq;
}

function recordFamily(key: string, show: unknown): void {
  const data = typeof show === "object" && show !== null
    ? show as { digest?: unknown; details?: { family?: unknown }; model_info?: Record<string, unknown> }
    : {};
  // Another version under this name: what Ollama's answers showed about the
  // one before no longer applies.
  const digest = typeof data.digest === "string" ? data.digest : undefined;
  if (ollamaModelDigests.get(key) !== digest) {
    ollamaThinkLearned.delete(key);
    nextGeneration(key);
  }
  // An entry without a version leaves none recorded.
  if (digest !== undefined) ollamaModelDigests.set(key, digest);
  else ollamaModelDigests.delete(key);
  const family = data.details?.family ?? data.model_info?.["general.architecture"];
  if (typeof family === "string" && family.length > 0) ollamaModelFamilies.set(key, family);
  else ollamaModelFamilies.delete(key);
}

/**
 * The endpoint's Ollama version from /api/version, which loads no model. Read
 * each time it is needed, so a server upgraded while the app runs is seen.
 */
async function ollamaServerVersion(endpoint: string, signal?: AbortSignal): Promise<string | undefined> {
  const base = endpoint.trim().replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const url = `${base}/api/version`;
    const response = await fetch(url, { signal: controller.signal, redirect: modelServerRedirect(url) });
    if (!response.ok || isRefusedRedirect(response, url)) return undefined;
    const version = ((await response.json()) as { version?: unknown }).version;
    if (typeof version !== "string" || version.length === 0) return undefined;
    return version;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Whether a version is older than another, comparing major, minor and patch. */
function versionBelow(version: string, than: string): boolean {
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version), parse(than)];
  for (let i = 0; i < 3; i += 1) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

/**
 * The installed model a requested name resolves to, as the endpoint's Ollama
 * reads it. Ollama 0.18 and later drop a final ":local" from every name (it
 * only says the installed model is meant), so a lone "x:local" runs "x:latest"
 * there; earlier versions read "local" as a tag. The version is asked only for
 * such a name, before each send; when it cannot be read, current Ollama's
 * reading applies.
 */
export async function resolveOllamaModel(endpoint: string, model: string, signal?: AbortSignal): Promise<string> {
  const name = ollamaModelName(model);
  if (!name.endsWith(":local")) return name;
  const read = ++ollamaVersionReadSeq;
  const version = await ollamaServerVersion(endpoint, signal);
  const key = ollamaEndpointKey(endpoint);
  const applied = ollamaServerVersions.get(key);
  // A read that started before the newest applied one is outdated: the newer one decides.
  if (version !== undefined && read > (applied?.read ?? 0)) {
    ollamaServerVersions.set(key, { read, version });
    return installedModelFor(name, version);
  }
  return installedModelFor(name, applied && applied.read > read ? applied.version : version);
}

/** Version reads in the order they started, and the newest one applied per endpoint. */
let ollamaVersionReadSeq = 0;
const ollamaServerVersions = new Map<string, { read: number; version: string }>();

function ollamaEndpointKey(endpoint: string): string {
  return endpoint.trim().replace(/\/$/, "");
}

function installedModelFor(name: string, version: string | undefined): string {
  if (!name.endsWith(":local")) return name;
  return version !== undefined && versionBelow(version, "0.18.0") ? name : `${name.slice(0, -":local".length)}:latest`;
}

/**
 * The installed model a name resolves to by the newest Ollama version read
 * for the endpoint, without a read: a newer read can apply while a request
 * reads the model list.
 */
function ollamaInstalledModelNow(endpoint: string, model: string): string {
  return installedModelFor(ollamaModelName(model), ollamaServerVersions.get(ollamaEndpointKey(endpoint))?.version);
}

/**
 * Reads the model's current entry from /api/tags, which loads no model, and
 * records its family and digest before a send, so a model replaced under the
 * same name since the provider check gets its own think value. A failed or
 * slow read changes nothing.
 */
export async function refreshOllamaModelFamily(endpoint: string, model: string, timeoutMs = 1500, signal?: AbortSignal): Promise<void> {
  const url = `${endpoint.trim().replace(/\/$/, "")}/api/tags`;
  const seq = beginOllamaModelRead();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) return;
    const response = await fetch(url, { signal: controller.signal, redirect: modelServerRedirect(url) });
    if (!response.ok || isRefusedRedirect(response, url)) return;
    const data = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    if (!Array.isArray(data.models)) return;
    const wanted = ollamaModelName(model);
    if (!recordOllamaModelList(endpoint, data.models, seq)) return;
    // The model is not installed: nothing known about it carries over to a
    // model installed later under the name, also a reply still in flight.
    if (!data.models.some((candidate) => entryName(candidate) === wanted)) forgetOllamaModel(endpoint, model, seq);
  } catch {
    // The send goes ahead with what is known; Ollama's answer still corrects it.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * The think value for a request: the model's family when Ollama reported it,
 * otherwise what Ollama's answers showed, then the name.
 */
function ollamaThinkFor(endpoint: string, model: string): false | "low" {
  const key = familyKey(endpoint, model);
  const family = ollamaModelFamilies.get(key);
  if (family !== undefined) return ollamaThinkSetting(model, family);
  // An answer counts only for the version it was learned against, so one
  // learned before any version was known does not pass to the first version seen.
  const learned = ollamaThinkLearned.get(key);
  if (learned && learned.digest === ollamaModelDigests.get(key)) return learned.value;
  return ollamaThinkSetting(model);
}

/** Ollama's answer to a think level the model does not support, in old and current wording. */
function rejectsThinkLevel(detail: string): boolean {
  // The quotes arrive escaped inside Ollama's JSON error body.
  return /think value \\?"[^"\\]*\\?" is not supported for this model|\\?"[^"\\]*\\?" does not support thinking/i.test(detail);
}

/**
 * Ollama's `think` value for a model. gpt-oss cannot turn reasoning off and
 * ignores `false`, so it gets the lowest effort level; other models get
 * `false`, which Ollama accepts for every model. The family decides when it
 * is known; otherwise the name does.
 */
export function ollamaThinkSetting(model: string, family?: string): false | "low" {
  // Ollama names the family "gptoss" or "gpt-oss".
  if (family !== undefined) return family.toLowerCase().replace(/-/g, "") === "gptoss" ? "low" : false;
  return /(^|\/)gpt-oss([:-]|$)/i.test(model) ? "low" : false;
}

/** An Ollama reply that had reasoning and no answer. */
export class OllamaReasoningWithoutAnswerError extends Error {
  override name = "OllamaReasoningWithoutAnswerError";
}

/** Whether an error is a reply with reasoning and no answer, also across wrappers that keep the name. */
export function isReasoningWithoutAnswerError(error: unknown): boolean {
  return error instanceof Error && error.name === "OllamaReasoningWithoutAnswerError";
}

/** Whether a reply with reasoning and no answer is the error or one of its causes. */
export function reasoningWithoutAnswerInChain(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    if (isReasoningWithoutAnswerError(current)) return true;
  }
  return false;
}

/** The failure for a reply that has reasoning and no answer. */
export function reasoningWithoutAnswerMessage(model: string, doneReason: string | undefined): string {
  return doneReason === "length"
    ? `Ollama stopped "${model}" at the token limit while it was still reasoning, so there is no answer. ` +
        "Raise the token limit, shorten the request, or pick a model that answers without reasoning."
    : `Ollama returned only reasoning from "${model}" and no answer. Retry, or pick a model that answers without reasoning.`;
}

export function resolveOllamaEndpoint(endpoint?: string): string {
  return (endpoint ?? ollamaEndpointOverride() ?? DEFAULT_OLLAMA_ENDPOINT).trim();
}

/** The non-default endpoint configured for this device, if any. */
export function ollamaEndpointOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENAGENTS_OLLAMA_URL ?? ollamaHostEndpoint(env.OLLAMA_HOST);
}

/**
 * Read Ollama's own OLLAMA_HOST setting the way the Ollama client does, so a
 * server moved to another port is still found. A wildcard bind address
 * (0.0.0.0 or ::) is reached through loopback. Returns undefined when unset
 * or when it names the default endpoint.
 */
export function ollamaHostEndpoint(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let scheme = "http";
  let hostport = raw;
  let defaultPort = "11434";
  const separator = raw.indexOf("://");
  if (separator >= 0) {
    scheme = raw.slice(0, separator).toLowerCase();
    hostport = raw.slice(separator + 3);
    if (scheme === "http") defaultPort = "80";
    else if (scheme === "https") defaultPort = "443";
    else return undefined;
  }
  hostport = hostport.split("/")[0]!;
  let host = hostport;
  let port = defaultPort;
  const bracketed = /^\[([^\]]*)\](?::(\d*))?$/.exec(hostport);
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2] || defaultPort;
  } else if (hostport.split(":").length === 2) {
    [host, port] = hostport.split(":") as [string, string];
    port ||= defaultPort;
  }
  if (!host || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  const endpoint = `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return endpoint === DEFAULT_OLLAMA_ENDPOINT ? undefined : endpoint;
}

export function classifyOllamaEndpoint(endpoint: string): OllamaEndpointTrust {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "Ollama endpoint is empty.",
    };
  }

  if (/^(unix|http\+unix):/i.test(trimmed)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses a local Unix socket.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "Ollama endpoint is not a valid URL.",
    };
  }

  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `Ollama endpoint uses unsupported protocol ${parsed.protocol}`,
    };
  }

  if (host === "localhost" || host === "localhost.") {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses localhost.",
    };
  }

  if (isIpv4Loopback(host) || isIpv6Loopback(host)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses a loopback address.",
    };
  }

  return {
    endpoint: trimmed,
    isLocal: false,
    reason: `Ollama endpoint host ${host || "(empty)"} is not loopback.`,
  };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

function isIpv6Loopback(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const dottedMapped = host.match(/^::ffff:(127(?:\.\d{1,3}){3})$/);
  if (dottedMapped) return isIpv4Loopback(dottedMapped[1] ?? "");
  const hexMapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexMapped) return false;
  const high = Number.parseInt(hexMapped[1] ?? "", 16);
  const low = Number.parseInt(hexMapped[2] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return false;
  const ipv4 = [
    (high >> 8) & 255,
    high & 255,
    (low >> 8) & 255,
    low & 255,
  ].join(".");
  return isIpv4Loopback(ipv4);
}

export const noopLlm: RunLlmApi = {
  available: false,
  async complete(): Promise<LlmCompletion> {
    throw new Error("No LLM provider is configured for this run.");
  },
  async *stream(): AsyncIterable<LlmStreamChunk> {
    throw new Error("No LLM provider is configured for this run.");
  },
};

function extractTokenUsage(chunk: OllamaChatChunk): LlmTokenUsage | undefined {
  const prompt = typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined;
  const completion = typeof chunk.eval_count === "number" ? chunk.eval_count : undefined;
  if (prompt === undefined && completion === undefined) return undefined;
  const usage: LlmTokenUsage = {};
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (prompt !== undefined && completion !== undefined) {
    usage.totalTokens = prompt + completion;
  }
  return usage;
}

/** Reads Ollama's "request (N tokens) exceeds the available context size (M tokens)" error. */
export function parseContextOverflow(detail: string): { requested: number; available: number } | undefined {
  const match = /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i.exec(detail);
  if (!match) return undefined;
  return { requested: Number(match[1]), available: Number(match[2]) };
}

/**
 * The model's maximum context length from /api/show. Undefined only when
 * Ollama answered successfully without that metadata; a stop of the caller's signal
 * returns undefined so the caller reports it, and a failed or timed out
 * lookup throws.
 */
async function readOllamaContextLength(
  endpoint: string,
  model: string,
  signal: AbortSignal,
  timeoutMs = OLLAMA_SHOW_TIMEOUT_MS,
): Promise<number | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const url = `${endpoint.replace(/\/$/, "")}/api/show`;
  const failure = (error: unknown): Error | undefined => {
    if (signal.aborted) return undefined;
    if (timeout.aborted) return new Error(`Ollama did not report the model's context limit within ${timeoutMs}ms at ${url}.`);
    return new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: modelServerRedirect(url),
    });
  } catch (error) {
    const failed = failure(error);
    if (failed) throw failed;
    return undefined;
  }
  if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail("Ollama", url));
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const failed = failure(error);
    if (failed) throw failed;
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Ollama could not report the model's context limit: HTTP ${response.status} at ${url}: ${truncate(raw, 200)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Ollama could not report the model's context limit: the answer from ${url} was not JSON: ${truncate(raw, 200)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Ollama could not report the model's context limit: the answer from ${url} was not a JSON object.`);
  }
  const answer = data as { error?: unknown; model_info?: unknown };
  if (answer.error !== undefined) {
    throw new Error(`Ollama could not report the model's context limit: ${url} answered with an error: ${truncate(errorText(answer.error), 200)}`);
  }
  // A valid answer without the metadata leaves the limit unknown.
  if (typeof answer.model_info !== "object" || answer.model_info === null) return undefined;
  for (const [key, value] of Object.entries(answer.model_info as Record<string, unknown>)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

/** Readable text for an error field of any shape. */
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "an unreadable error";
  } catch {
    return "an unreadable error";
  }
}

/**
 * Ollama's out-of-memory wording: the substrings its own classifier uses
 * (llm/status.go outOfMemorySubstrings) plus the scheduler's messages when a
 * model and its context do not fit.
 */
const OLLAMA_MEMORY_ERRORS = [
  "out of memory",
  "out of device memory",
  "cudamalloc failed",
  "hipmalloc failed",
  "failed to allocate",
  "allocation failed",
  "not enough memory",
  "insufficient memory",
  "vk_error_out_of_device_memory",
  "erroroutofmemory",
  "failed to reserve graph",
  "requires more system memory",
  "unable to load full model",
];

/** Ollama's overflow message without token counts (llm/llama_server.go promptTooLongMessage). */
function isOllamaPromptTooLong(detail: string): boolean {
  return detail.toLowerCase().includes("the prompt is longer than the context length currently available");
}

function isOllamaMemoryError(detail: string): boolean {
  const lower = detail.toLowerCase();
  return OLLAMA_MEMORY_ERRORS.some((text) => lower.includes(text));
}

function contextMemoryMessage(model: string, requested: number, numCtx: number, detail: string): string {
  return `Ollama context size too small: This request needs ${requested.toLocaleString("en-US")} tokens of context, but Ollama could not load ${model} with ${numCtx.toLocaleString("en-US")}, usually because free memory ran out. Ollama said: ${truncate(detail, 200)}`;
}

function cachedContextMemoryMessage(model: string, numCtx: number, detail: string, answering = false): string {
  const failed = answering ? "failed partway through an answer from" : "could not load";
  return `Ollama ${failed} ${model} with the ${formatTokens(numCtx)} token context size kept from an earlier request, usually because free memory ran out. Ollama said: ${truncate(detail, 200)}`;
}

function notFitMessage(model: string, sent: { size: number; kept: boolean } | undefined, detail: string): string {
  const where = sent === undefined
    ? `the context Ollama loaded for ${model}`
    : sent.kept
      ? `the ${formatTokens(sent.size)} token context kept from an earlier request`
      : `the ${formatTokens(sent.size)} token context of the retry`;
  return `Ollama context size too small: This request did not fit in ${where}. Ollama said: ${truncate(detail, 200)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function contextTooSmallMessage(model: string, requested: number, limit: number, modelLimit: boolean): string {
  const needs = `This request needs ${requested.toLocaleString("en-US")} tokens of context`;
  return modelLimit
    ? `Ollama context size too small: ${needs}, but ${model} supports at most ${limit.toLocaleString("en-US")}.`
    : `Ollama context size too small: ${needs}, but Ollama could only give ${model} ${limit.toLocaleString("en-US")}, usually because free memory ran out.`;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
