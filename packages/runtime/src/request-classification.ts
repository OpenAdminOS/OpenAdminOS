import { AsyncLocalStorage } from "node:async_hooks";
import { maxDataClass, type DataClass, type DataClassCounts, type LlmOptions, type ProviderId, type RunLlmApi } from "@openadminos/agent-sdk";
import { emptyDataClassCounts, requestTextSpans, walkDataClasses, type ClassificationOptions, type TextSpan } from "./data-classification.js";

export interface ClassificationSpan extends TextSpan {
  section: "system" | "prompt";
  kind: DataClass;
  source: string;
}

export interface RequestClassification {
  counts: DataClassCounts;
  /** UTF-16 offsets, with an exclusive end, in the named request section. */
  spans: readonly ClassificationSpan[];
  budgetExhausted: boolean;
}

export interface RequestClassificationEvent {
  providerId: ProviderId;
  method: "complete" | "stream";
  classification: RequestClassification;
}

type MatchMode = "text" | "jsonString" | "escapedJsonString" | "jsonScalar" | "word";
interface Pattern {
  text: string;
  mode: MatchMode;
  kind: DataClass;
  source: string;
}

interface Node {
  edges: Map<string, Node>;
  fail?: Node;
  suffix?: Node;
  patterns?: Pattern[];
}

const PATTERN_BUDGET = 2_000_000;
const REQUEST_BUDGET = 4_000_000;
const MATCH_BUDGET = 200_000;

function trie(patterns: Iterable<Pattern>): Node {
  const root: Node = { edges: new Map() };
  for (const pattern of patterns) {
    let state = root;
    for (let i = 0; i < pattern.text.length; i++) {
      const char = pattern.text[i]!;
      let next = state.edges.get(char);
      if (!next) state.edges.set(char, next = { edges: new Map() });
      state = next;
    }
    (state.patterns ??= []).push(pattern);
  }
  const queue = [...root.edges.values()];
  for (const node of queue) node.fail = root;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    for (const [char, child] of node.edges) {
      let fail = node.fail;
      while (fail && !fail.edges.has(char)) fail = fail.fail;
      child.fail = fail?.edges.get(char) ?? root;
      child.suffix = child.fail.patterns ? child.fail : child.fail.suffix;
      queue.push(child);
    }
  }
  return root;
}

function wholeMatch(mode: MatchMode, text: string, start: number, end: number): boolean {
  if (mode === "text") return true;
  if (mode === "word") return !/[\p{L}\p{N}_]/u.test(text[start - 1] ?? "") &&
    !/[\p{L}\p{N}_]/u.test(text[end] ?? "");
  if (mode === "jsonScalar") return /[\s[,\:]/.test(text[start - 1] ?? " ") &&
    /[\s,}\]]/.test(text[end] ?? " ");
  const escaped = mode === "escapedJsonString";
  let before = start - 1;
  while (before >= 0) {
    if (/\s/.test(text[before]!)) before--;
    else if (escaped && /[nrt]/.test(text[before]!) && text[before - 1] === "\\") before -= 2;
    else break;
  }
  let after = end;
  while (after < text.length) {
    if (/\s/.test(text[after]!)) after++;
    else if (escaped && text[after] === "\\" && /[nrt]/.test(text[after + 1] ?? "")) after += 2;
    else break;
  }
  if (!escaped && text[before] === ">" && text.startsWith("</tenant_data ", after)) {
    const opening = text.lastIndexOf("<", before);
    if (opening >= 0 && text.startsWith("<tenant_data ", opening)) {
      const nonce = / nonce="([0-9a-f]{16})">$/.exec(text.slice(opening, before + 1))?.[1];
      if (nonce) return text.startsWith(`</tenant_data nonce="${nonce}">`, after);
    }
  }
  return (before < 0 || /[:[,]/.test(text[before]!)) && (after === text.length || /[,}\]]/.test(text[after]!));
}

function fenceEscapes(text: string): string {
  return text.replace(/[<>\uff1c\uff1e\ufe64\ufe65\u2329\u232a\u27e8\u27e9\u2039\u203a]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Host-only, memory-only values for one run or Chat conversation. */
export class ClassificationLedger {
  private readonly patterns = new Map<string, Pattern>();
  private readonly identities = new Map<string, Pattern>();
  private matcher?: Node;
  private identityMatcher?: Node;
  private remaining = PATTERN_BUDGET;
  private fallback?: { kind: DataClass; source: string };
  private highest: DataClass = "identity";

  constructor(private readonly identityIndex?: ClassificationOptions["identityIndex"]) {}

  register(source: string, data: unknown, options: ClassificationOptions = {}): void {
    const index = options.identityIndex ?? this.identityIndex;
    const known = this.identityMatcher ??= trie(this.identities.values());
    const directoryUser = /^\/(?:beta\/|v1\.0\/)?users(?:[/(?]|$)/i.test(options.graphPath ?? "");
    const result = walkDataClasses(data, { ...options, identityIndex: {
      matches: text => index?.matches(text) === true || !this.match(known, text.toLowerCase()).next().done,
    } },
      (value, kind, pointer) => {
        this.highest = maxDataClass(this.highest, kind);
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
        if (typeof value === "string" && !value.trim()) return;
        const serialized = JSON.stringify(value);
        const shortString = typeof value === "string" && value.length < 12 && [...value].length < 6;
        if (typeof value !== "string") {
          this.add({ text: serialized, mode: "jsonScalar", kind, source });
        } else if (shortString) {
          this.add({ text: serialized, mode: "jsonString", kind, source });
          this.add({ text: fenceEscapes(serialized), mode: "jsonString", kind, source });
          const escaped = JSON.stringify(serialized).slice(1, -1);
          this.add({ text: escaped, mode: "escapedJsonString", kind, source });
          this.add({ text: fenceEscapes(escaped), mode: "escapedJsonString", kind, source });
        } else {
          for (const text of [value, serialized.slice(1, -1), JSON.stringify(serialized.slice(1, -1)).slice(1, -1)]) {
            this.add({ text, mode: "text", kind, source });
            this.add({ text: fenceEscapes(text), mode: "text", kind, source });
          }
        }
        // A typed directory user remains identifiable in later readings and requests.
        if (kind === "identity" && typeof value === "string" && !shortString &&
            (/\/(?:userdisplayname|userprincipalname|username|userid|givenname|surname)$/i.test(pointer) ||
              directoryUser && /\/(?:id|displayname|mail)$/i.test(pointer))) {
          this.add({ text: value.toLowerCase(), mode: "word", kind, source }, true);
        }
      });
    if (result.remainder) this.exhaust(result.remainder.kind, source);
  }

  private add(pattern: Pattern, identity = false): void {
    const target = identity ? this.identities : this.patterns;
    const key = pattern.mode + ":" + pattern.text;
    const previous = target.get(key);
    if (previous) {
      if (previous.kind !== pattern.kind && maxDataClass(previous.kind, pattern.kind) === pattern.kind) {
        previous.kind = pattern.kind;
        previous.source = pattern.source;
      }
      return;
    }
    if (this.remaining < pattern.text.length + 16) {
      this.exhaust(this.highest, pattern.source);
      return;
    }
    this.remaining -= pattern.text.length + 16;
    target.set(key, pattern);
    if (identity) this.identityMatcher = undefined;
    else this.matcher = undefined;
  }

  private exhaust(kind: DataClass, source: string): void {
    this.fallback = { kind: maxDataClass(this.fallback?.kind ?? "identity", kind), source };
  }

  /** Carry observations across turns in the same conversation without storing values on disk. */
  include(previous: ClassificationLedger): void {
    if (previous === this) return;
    this.highest = maxDataClass(this.highest, previous.highest);
    for (const item of previous.patterns.values()) this.add({ ...item });
    for (const item of previous.identities.values()) this.add({ ...item }, true);
    if (previous.fallback) this.exhaust(previous.fallback.kind, previous.fallback.source);
  }

  private *match(root: Node, text: string, work?: { remaining: number }): IterableIterator<TextSpan & Pattern> {
    let state = root;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      while (state.fail && !state.edges.has(char)) state = state.fail;
      state = state.edges.get(char) ?? root;
      for (let output: Node | undefined = state; output; output = output.suffix) {
        for (const pattern of output.patterns ?? []) {
          if (work && work.remaining-- <= 0) return;
          const start = i + 1 - pattern.text.length;
          if (wholeMatch(pattern.mode, text, start, i + 1)) yield { ...pattern, start, end: i + 1 };
        }
      }
    }
  }

  classifyRequest(request: Pick<LlmOptions, "system" | "prompt">): RequestClassification {
    const counts = emptyDataClassCounts();
    const spans: ClassificationSpan[] = [];
    const root = this.matcher ??= trie(this.patterns.values());
    const identities = this.identityMatcher ??= trie(this.identities.values());
    let budgetExhausted = this.fallback !== undefined;
    for (const section of ["system", "prompt"] as const) {
      const text = request[section];
      if (!text) continue;
      const scanned = text.slice(0, REQUEST_BUDGET);
      const found = new Map<string, ClassificationSpan>();
      const matchWork = { remaining: MATCH_BUDGET };
      const collect = (items: Iterable<TextSpan & { kind: DataClass; source: string }>) => {
        for (const { start, end, kind, source } of items) {
          if (found.size >= MATCH_BUDGET) return false;
          const key = `${start}:${end}`;
          const previous = found.get(key);
          if (!previous || previous.kind !== kind && maxDataClass(previous.kind, kind) === kind) {
            found.set(key, { section, start, end, kind, source });
          }
        }
        return true;
      };
      // Case folding can change UTF-16 length. Keep original offsets in that case.
      const lower = scanned.toLowerCase();
      const complete = collect(this.match(root, scanned, matchWork)) && matchWork.remaining >= 0 &&
        (lower.length !== scanned.length || collect(this.match(identities, lower, matchWork))) && matchWork.remaining >= 0 &&
        collect(requestTextSpans(scanned, this.identityIndex));
      spans.push(...found.values());
      // A skipped part of the request may contain a credential the ledger has never seen.
      const fallback = !complete || scanned.length !== text.length
        ? { kind: "credential" as const, source: "detector:work-budget" }
        : this.fallback;
      if (fallback) {
        budgetExhausted = true;
        spans.push({ section, start: 0, end: text.length, ...fallback });
      }
    }
    for (const span of spans) counts[span.kind]++;
    return { counts, spans, budgetExhausted };
  }
}

const scopes = new AsyncLocalStorage<ClassificationLedger>();

export function withClassificationScope<T>(ledger: ClassificationLedger, work: () => T): T {
  return scopes.run(ledger, work);
}

export function currentClassificationLedger(): ClassificationLedger | undefined {
  return scopes.getStore();
}

export function registerTenantData(source: string, data: unknown, options?: ClassificationOptions): void {
  scopes.getStore()?.register(source, data, options);
}

export function withRequestClassification(
  llm: RunLlmApi,
  providerId: ProviderId,
  observe: (event: RequestClassificationEvent) => void,
): RunLlmApi {
  const classify = (method: RequestClassificationEvent["method"], request: LlmOptions) => {
    const ledger = scopes.getStore() ?? new ClassificationLedger();
    observe({ providerId, method, classification: ledger.classifyRequest(request) });
  };
  return {
    available: llm.available,
    defaultModel: llm.defaultModel,
    streamsIncrementally: llm.streamsIncrementally,
    complete(options) {
      if (llm.available) classify("complete", options);
      return llm.complete(options);
    },
    async *stream(options) {
      if (llm.available) classify("stream", options);
      yield* llm.stream(options);
    },
  };
}
