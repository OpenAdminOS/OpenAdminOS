import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_CLASSES_BY_SENSITIVITY, maxDataClass, type DataClass, type DataClassCounts, type LlmOptions, type ProviderId, type RunLlmApi } from "@openadminos/agent-sdk";
import { emptyDataClassCounts, graphClassificationSource, requestTextSpans, walkDataClasses, type ClassificationOptions, type TextSpan } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES_VERSION, type SecurityMaskRole } from "./graph-field-classes.js";
import { ClassificationSlice, requestWorker, syncIdentityShards, type ClassificationWorker } from "./classification-worker-client.js";
import { TenantValueIndex } from "./tenant-value-index.js";

export interface ClassificationSpan extends TextSpan {
  section: "system" | "prompt";
  kind: DataClass;
  source: string;
  maskRole?: SecurityMaskRole;
}

interface UnexaminedRange extends TextSpan {
  section: ClassificationSpan["section"];
  reason: "text-limit" | "match-limit" | "history-evidence-unavailable" | "failure";
}

interface HistoryReplay extends TextSpan {
  ledger: ClassificationLedger | undefined;
}

type HistoryFences = ReadonlyMap<string, { length: number; replays: readonly TextSpan[] }>;

export interface RequestClassification {
  counts: DataClassCounts;
  /** UTF-16 offsets, with an exclusive end, in the named request section. */
  spans: readonly ClassificationSpan[];
  coverageIncomplete: boolean;
  effectiveClass?: DataClass;
  retainedValues: number;
  droppedValues: number;
  unexamined: {
    registrations: number;
    values: number;
    textCodeUnits: number;
    ranges: readonly UnexaminedRange[];
  };
}

export interface RequestClassificationEvent {
  providerId: ProviderId;
  method: "complete" | "stream";
  fieldMapVersion: number;
  timestamp: string;
  scopeId?: string;
  scopePresent: boolean;
  failed: boolean;
  classification: RequestClassification;
  /** Historical records may summarize excess offsets. Live observers receive all spans. */
  spansOmitted?: number;
}

type Scalar = string | number | boolean;
interface FieldObservation {
  value: Scalar;
  kind: DataClass;
  key: string;
  maskRole?: SecurityMaskRole;
}
export interface ClassifiedValues {
  fields: readonly FieldObservation[];
  incomplete: boolean;
}

export function collectClassifiedValues(data: unknown, options: ClassificationOptions): ClassifiedValues {
  const fields: FieldObservation[] = [];
  const result = walkDataClasses(data, options, (value, kind, _pointer, key, maskRole) => {
    if (typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") {
      fields.push({ value, kind, key, ...(maskRole ? { maskRole } : {}) });
    }
  });
  return { fields, incomplete: result.budgetExhausted };
}

interface RenderProvenance {
  jsonPrefix?: boolean;
  key?: string;
  fence?: string;
  before?: string;
  after?: string;
}

interface Evidence {
  kind: DataClass;
  source: string;
  key: string;
  maskRole?: SecurityMaskRole;
}
interface ValueEntry {
  kind: DataClass;
  mode?: MatchMode;
  folded?: boolean;
  fields: Map<string, Evidence>;
  best: Evidence;
  patterns: MatchPattern[];
  fenceIds?: Set<string>;
  cost: number;
}
type MatchMode = "text" | "word" | "field" | "context" | "folded";
interface MatchPattern {
  text: string;
  offset: number;
  anchor: string;
  mode: MatchMode;
  entry: ValueEntry;
  before?: string;
  after?: string;
}

type AnchorIndex = Map<number, Map<string, Set<MatchPattern>>>;
type ScanLane = { width: number; buckets: Array<Map<string, Set<MatchPattern>>> };
type ScanIndex = {
  ascii: Array<ScanLane[] | undefined>;
  unicode: Map<number, ScanLane[]>;
  resolved: Map<string, Array<Set<MatchPattern>> | null>;
};
type RequestText = Pick<LlmOptions, "system" | "prompt">;
type EncodedText = { buffer: ArrayBuffer; length: number };
type Fence = { body: string; evidence: Evidence };
type ScanState = {
  retained: readonly ClassificationLedger[];
  historyFences: HistoryFences;
  dropped: number;
  registrations: number;
  incomplete: boolean;
  identityIndex: ClassificationOptions["identityIndex"];
};

export type WorkerValue = [Scalar, ValueEntry | undefined, Array<[string, Fence]>];
type TransferableString = string | ArrayBuffer;
type TransferablePattern = Omit<MatchPattern, "entry" | "text" | "before" | "after"> & {
  text: TransferableString;
  before?: TransferableString;
  after?: TransferableString;
};
export interface WorkerLargeValue {
  value: TransferableString | number | boolean;
  entry?: Omit<ValueEntry, "patterns">;
  patterns: TransferablePattern[];
  fences: Array<[string, { body: TransferableString; evidence: Evidence }]>;
}
export interface WorkerScan {
  type: "scan";
  sections: Record<ClassificationSpan["section"], EncodedText | undefined>;
  ledgers: number[];
  shards: number[];
  state: Pick<ScanState, "historyFences" | "dropped" | "registrations" | "incomplete">;
}

export interface WorkerResult {
  classification: Omit<RequestClassification, "spans">;
  offsets: Int32Array;
  sources: string[];
}

const VALUE_BUDGET = 2_000_000;
export const REQUEST_CLASSIFICATION_MAX_SECTION = 16_000_000;
const TEXT_CHUNK = 128_000;
const MATCH_BUDGET = 200_000;
const ANCHOR_WIDTH = 8;
const MAIN_SCAN_LIMIT = 512;
const SYNC_BATCH_UNITS = 16_384;
const MAX_GRAPH_MATCH_VALUE = 32_768;
export const CLASSIFICATION_TTL_MS = 15 * 60_000;

function fenceEscapes(text: string): string {
  return text.replace(/[<>\uff1c\uff1e\ufe64\ufe65\u2329\u232a\u27e8\u27e9\u2039\u203a]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

function wordBoundary(text: string, offset: number): boolean {
  let start = offset;
  if (/[\udc00-\udfff]/.test(text[start] ?? "")) start--;
  const point = text.codePointAt(start);
  return point === undefined || !WORD_CHAR.test(String.fromCodePoint(point));
}

function foldIdentity(text: string): string {
  const folded = text.toLowerCase();
  if (folded.length === text.length) return folded;
  // Prevent matches crossing a length-changing code point while preserving
  // offsets for the rest of the request.
  return text.replace(/[^\x00-\x7f]/gu, point => {
    const lower = point.toLowerCase();
    return lower.length === point.length ? lower : "\0".repeat(point.length);
  }).toLowerCase();
}

function matchMode(value: Scalar, kind: DataClass): MatchMode {
  if (typeof value !== "string") return "field";
  let length = 0;
  for (const _point of value) { if (++length >= 12) break; }
  const hasLetter = /\p{L}/u.test(value);
  const hasDigit = /\p{N}/u.test(value);
  if (/^[+-]?[\p{N}.,]+$/u.test(value)) return "field";
  if (length < 12) return hasLetter && hasDigit ? "word" : "field";
  if (/^[\p{L}\p{N}\p{M}_]+$/u.test(value)) return hasDigit && hasLetter || kind === "credential" ? "word" : "field";
  if (/^[\p{L}\p{M}_]+(?:\s+[\p{L}\p{M}_]+)+$/u.test(value)) return "word";
  return "text";
}

/** Index JSON value tokens once, keeping their nearest property through arrays. */
function jsonFields(text: string): ReadonlyMap<number, { key: string; end: number }> {
  const fields = new Map<number, { key: string; end: number }>();
  for (const escaped of [false, true]) {
    const tokens = escaped
      ? /(?<!\\)\\"(?:\\\\(?:\\["\\]|[^"\\])|[^"\\])*\\"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
      : /(?<!\\)"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    const whitespace = escaped ? /^(?:\s|\\[nrt])*$/ : /^\s*$/;
    const delimiter = escaped ? /(?:\s|\\[nrt])*[,}\]]/y : /\s*[,}\]]/y;
    const stack: Array<{ array: boolean; key?: string; expectsValue: boolean }> = [];
    let previousEnd = 0;
    for (const match of text.matchAll(tokens)) {
      const value = match[0];
      const start = match.index;
      const end = start + value.length;
      if (stack.length && !whitespace.test(text.slice(previousEnd, start))) stack.length = 0;
      previousEnd = end;
      const frame = stack.at(-1);
      if (value === "{" || value === "[") {
        if (frame && !frame.expectsValue) stack.length = 0;
        else if (frame) frame.expectsValue = false;
        const key = value === "[" ? frame?.key : undefined;
        stack.push({ array: value === "[", ...(key === undefined ? {} : { key }), expectsValue: value === "[" });
      } else if (!frame) {
        continue;
      } else if (value === (frame.array ? "]" : "}")) {
        stack.pop();
      } else if (value === ",") {
        frame.expectsValue = frame.array;
        if (!frame.array) delete frame.key;
      } else if (value === ":" && !frame.array && frame.key !== undefined) {
        frame.expectsValue = true;
      } else if (frame.expectsValue && value !== ":" && value !== "]" && value !== "}") {
        delimiter.lastIndex = end;
        if (frame.key !== undefined && delimiter.test(text)) fields.set(start, { key: frame.key, end });
        frame.expectsValue = false;
      } else if (!frame.array && frame.key === undefined && value.startsWith(escaped ? '\\"' : '"')) {
        const quoteWidth = escaped ? 2 : 1;
        frame.key = value.slice(quoteWidth, -quoteWidth).toLowerCase();
      } else {
        stack.length = 0;
      }
    }
  }
  return fields;
}

function preferEvidence(previous: Evidence | undefined, next: Evidence): boolean {
  return !previous || (previous.kind !== next.kind
    ? maxDataClass(previous.kind, next.kind) === next.kind
    : next.maskRole === "nameOrIdentifier" && previous.maskRole !== next.maskRole);
}

function classification(
  spans: ClassificationSpan[], ranges: UnexaminedRange[], retainedValues: number, droppedValues: number,
  registrations: number, incomplete = false,
): RequestClassification {
  const counts = emptyDataClassCounts();
  for (const span of spans) counts[span.kind]++;
  const coverageIncomplete = incomplete || ranges.length > 0 || droppedValues > 0 || registrations > 0;
  const effectiveClass = coverageIncomplete ? "credential" : DATA_CLASSES_BY_SENSITIVITY.find(kind => counts[kind] > 0);
  return { counts, spans, coverageIncomplete, ...(effectiveClass ? { effectiveClass } : {}),
    retainedValues, droppedValues, unexamined: {
      registrations, values: droppedValues, ranges, textCodeUnits: ranges.reduce((total, range) => total + range.end - range.start, 0),
    } };
}

async function encodeSection(text: string | undefined, slice: ClassificationSlice, max = REQUEST_CLASSIFICATION_MAX_SECTION): Promise<EncodedText | undefined> {
  if (!text?.length) return undefined;
  const limit = Math.min(text.length, max);
  const buffer = new ArrayBuffer(limit * 2);
  const bytes = Buffer.from(buffer);
  // Preserve individual UTF-16 code units, including lone surrogates.
  for (let start = 0; start < limit; start += SYNC_BATCH_UNITS) {
    const end = Math.min(start + SYNC_BATCH_UNITS, limit);
    bytes.write(text.slice(start, end), start * 2, (end - start) * 2, "utf16le");
    if (slice.elapsed) await slice.yield();
  }
  return { buffer, length: text.length };
}

/** Ship long strings out of line so a single large value cannot stall a batch. */
async function encodeLargeValue([value, entry, fences]: WorkerValue, slice: ClassificationSlice):
  Promise<{ value: WorkerLargeValue; buffers: ArrayBuffer[] }> {
  const encoded = new Map<string, ArrayBuffer>();
  const encode = async (text: string): Promise<TransferableString> => {
    if (text.length < SYNC_BATCH_UNITS) return text;
    let buffer = encoded.get(text);
    if (!buffer) {
      buffer = (await encodeSection(text, slice, text.length))!.buffer;
      encoded.set(text, buffer);
    }
    return buffer;
  };
  const packed: WorkerLargeValue = {
    value: typeof value === "string" ? await encode(value) : value, patterns: [], fences: [],
  };
  if (entry) {
    const { patterns, ...metadata } = entry;
    packed.entry = metadata;
    for (const { text, offset, anchor, mode, before, after } of patterns) {
      packed.patterns.push({ text: await encode(text), offset, anchor, mode,
        ...(before === undefined ? {} : { before: await encode(before) }),
        ...(after === undefined ? {} : { after: await encode(after) }),
      });
    }
    for (const [nonce, { body, evidence }] of fences) {
      packed.fences.push([nonce, { body: await encode(body), evidence }]);
      if (slice.elapsed) await slice.yield();
    }
  }
  return { value: packed, buffers: [...encoded.values()] };
}

export function decodeWorkerLargeValue(packed: WorkerLargeValue): WorkerValue {
  const decoded = new Map<ArrayBuffer, string>();
  const decode = (text: TransferableString): string => {
    if (typeof text === "string") return text;
    let value = decoded.get(text);
    if (value === undefined) {
      value = Buffer.from(text).toString("utf16le");
      decoded.set(text, value);
    }
    return value;
  };
  const value = packed.value instanceof ArrayBuffer ? decode(packed.value) : packed.value;
  const entry = packed.entry && { ...packed.entry, patterns: [] as MatchPattern[] };
  if (entry) for (const { text, before, after, ...pattern } of packed.patterns) {
    entry.patterns.push({ ...pattern, text: decode(text), entry,
      ...(before === undefined ? {} : { before: decode(before) }),
      ...(after === undefined ? {} : { after: decode(after) }),
    });
  }
  return [value, entry, packed.fences.map(([nonce, { body, evidence }]) => [nonce, { body: decode(body), evidence }])];
}

function packWorkerResult(spans: readonly ClassificationSpan[], classification: WorkerResult["classification"]): WorkerResult {
  const offsets = new Int32Array(spans.length * 6);
  const sources = new Map<string, number>();
  let offset = 0;
  for (const span of spans) {
    if (!sources.has(span.source)) sources.set(span.source, sources.size);
    offsets[offset++] = span.start;
    offsets[offset++] = span.end;
    offsets[offset++] = span.section === "system" ? 0 : 1;
    offsets[offset++] = DATA_CLASSES_BY_SENSITIVITY.indexOf(span.kind);
    offsets[offset++] = sources.get(span.source)!;
    offsets[offset++] = span.maskRole === "nameOrIdentifier" ? 1 : span.maskRole === "setting" ? 2 : 0;
  }
  return { classification, offsets, sources: [...sources.keys()] };
}

async function unpackWorkerResult({ classification, offsets, sources }: WorkerResult): Promise<RequestClassification> {
  const spans: ClassificationSpan[] = [];
  const slice = new ClassificationSlice();
  for (let at = 0; at < offsets.length; at += 6) {
    const role = offsets[at + 5];
    spans.push({ start: offsets[at]!, end: offsets[at + 1]!,
      section: offsets[at + 2] ? "prompt" : "system",
      kind: DATA_CLASSES_BY_SENSITIVITY[offsets[at + 3]!]!,
      source: sources[offsets[at + 4]!]!,
      ...(role ? { maskRole: role === 1 ? "nameOrIdentifier" : "setting" } : {}),
    });
    if (at % (6 * 128) === 0 && slice.elapsed) await slice.yield();
  }
  return { ...classification, spans };
}

/** Memory-only plaintext evidence. Each ledger owns one turn or run. */
export class ClassificationLedger {
  private readonly values = new Map<Scalar, ValueEntry>();
  private readonly byClass = new Map(DATA_CLASSES_BY_SENSITIVITY.map(kind => [kind, new Set<Scalar>()]));
  private readonly anchors: Array<AnchorIndex | undefined> = [];
  private readonly foldedAnchors: Array<AnchorIndex | undefined> = [];
  private readonly fences = new Map<string, Fence>();
  private readonly historyFences = new Map<string, { length: number; replays: readonly HistoryReplay[] }>();
  private readonly historyReplays = new Map<string, readonly HistoryReplay[]>();
  private prior: readonly ClassificationLedger[] = [];
  private transient?: ClassificationLedger;
  private remaining = VALUE_BUDGET;
  private dropped = 0;
  private incompleteRegistrations = 0;
  private disposed = false;
  private discardedIncompleteEvidence = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private workerState?: { client: ClassificationWorker; id: number; dirty: Set<Scalar>; mirrored: Set<Scalar> };
  scopeId: string | undefined;

  constructor(
    private readonly identityIndex?: ClassificationOptions["identityIndex"], scopeId?: string,
    readonly tenantIds: readonly string[] = [],
  ) {
    this.scopeId = scopeId;
  }

  get expired(): boolean { return this.disposed; }

  expireAfter(ttl = CLASSIFICATION_TTL_MS): void {
    if (this.disposed) return;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.dispose(), ttl);
    this.expiry.unref();
  }

  dispose(): void {
    clearTimeout(this.expiry);
    this.disposed = true;
    this.values.clear();
    for (const keys of this.byClass.values()) keys.clear();
    this.anchors.length = 0;
    this.foldedAnchors.length = 0;
    this.fences.clear();
    if (this.workerState) {
      this.workerState.client.drop(this, this.workerState.id);
      delete this.workerState;
    }
    this.historyFences.clear();
    this.historyReplays.clear();
    this.prior = [];
    this.discardTransient();
  }

  /** A shallow reference to earlier turns. Each turn owns its own budget and expiry. */
  include(previous: ClassificationLedger): void {
    if (previous !== this && !this.prior.includes(previous)) this.prior = [...this.prior, previous];
  }

  releaseHistory(): void {
    this.prior = [];
    this.historyFences.clear();
    this.historyReplays.clear();
  }

  registerHistoryReplay(text: string, replays: readonly HistoryReplay[]): void {
    if (!this.disposed) this.historyReplays.set(text, replays);
  }

  private get replayEvidenceIncomplete(): boolean {
    return this.disposed || this.dropped > 0 || this.incompleteRegistrations > 0 ||
      this.discardedIncompleteEvidence || this.transient?.replayEvidenceIncomplete === true;
  }

  discardTransient(): void {
    this.discardedIncompleteEvidence ||= this.transient?.replayEvidenceIncomplete === true;
    this.transient?.dispose();
    delete this.transient;
  }

  registerTransient(source: string, data: unknown): void {
    if (this.disposed) return;
    this.transient ??= new ClassificationLedger(this.identityIndex);
    this.transient.register(source, data);
  }

  register(source: string, data: unknown, options: ClassificationOptions = {}): void {
    if (this.disposed) return;
    try {
      const identityIndex = options.identityIndex ?? this.identityIndex;
      this.registerClassified(source.startsWith("graph:") && options.graphPath ? graphClassificationSource(options.graphPath) : source, collectClassifiedValues(data, { ...options, ...(identityIndex ? { identityIndex } : {}) }));
    } catch {
      this.incompleteRegistrations++;
    }
  }

  async registerGraph(graphPath: string, data: unknown, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return;
    try {
      const source = graphClassificationSource(graphPath);
      let indexCurrent = () => true;
      const classified = await requestWorker().run<"graph">(async client => {
        const { shards, isCurrent } = await syncIdentityShards(client, this.identityIndex, new ClassificationSlice());
        indexCurrent = isCurrent;
        return { message: { type: "graph", data, graphPath, shards } };
      }, signal);
      if (classified.incomplete || !indexCurrent()) this.incompleteRegistrations++;
      const slice = new ClassificationSlice();
      for (const { value, kind, key, maskRole } of classified.fields) {
        if (this.disposed) return;
        // Large individual values can require several escaped match patterns.
        // The final request detectors still see their text with incomplete provenance.
        if (typeof value === "string" && value.length > MAX_GRAPH_MATCH_VALUE) this.dropped++;
        else this.add(value, { kind, source, key: key.toLowerCase(), ...(maskRole ? { maskRole } : {}) });
        if (slice.elapsed) await slice.yield();
      }
    } catch {
      this.incompleteRegistrations++;
    }
  }

  registerClassified(source: string, observations: ClassifiedValues): void {
    if (this.disposed) return;
    if (observations.incomplete) this.incompleteRegistrations++;
    try {
      for (const { value, kind, key, maskRole } of observations.fields) {
        this.add(value, { kind, source, key: key.toLowerCase(), ...(maskRole ? { maskRole } : {}) });
      }
    } catch { this.incompleteRegistrations++; }
  }

  /** No pattern-table scans are needed to look up the class of a transformed scalar. */
  rendered(original: unknown, fragment: Scalar, provenance: RenderProvenance): void {
    try { this.recordRendering(original, fragment, provenance); }
    catch { this.incompleteRegistrations++; }
  }

  private recordRendering(original: unknown, fragment: Scalar, provenance: RenderProvenance): void {
    if (this.disposed || (typeof original !== "string" && typeof original !== "number" && typeof original !== "boolean")) return;
    if (typeof fragment === "string" && !fragment.trim()) return;
    if (provenance.fence && typeof original === "string" && typeof fragment === "string") {
      const replays = this.historyReplays.get(original);
      if (replays) this.historyFences.set(provenance.fence, {
        length: fragment.length,
        replays: replays.map(({ start, end, ledger }) => ({
          start: fenceEscapes(original.slice(0, start)).length,
          end: fenceEscapes(original.slice(0, end)).length,
          ledger,
        })),
      });
    }
    let best: Evidence | undefined;
    let owner: ClassificationLedger = this;
    const key = provenance.key?.toLowerCase();
    for (const ledger of [this, this.transient, ...this.prior]) {
      const entry = ledger?.values.get(original);
      const evidence = key ? entry?.fields.get(key) ?? entry?.fields.get("") : entry?.best;
      if (evidence && preferEvidence(best, evidence)) {
        best = evidence;
        owner = ledger !== this ? (this.transient ??= new ClassificationLedger(this.identityIndex)) : this;
      }
    }
    if (!best) {
      if (provenance.jsonPrefix && typeof original === "string" && typeof fragment === "string") {
        this.recordClippedJsonValue(original, fragment);
      }
      return;
    }
    if (provenance.fence && typeof fragment === "string") {
      const entry = owner.add(original, best, true);
      if (entry && owner.reserve(64, entry.kind)) {
        entry.cost += 64;
        (entry.fenceIds ??= new Set()).add(provenance.fence);
        owner.fences.set(provenance.fence, { body: fragment, evidence: best });
        owner.workerState?.dirty.add(original);
      }
    } else if (provenance.before || provenance.after) {
      const entry = owner.add(fragment, best, true);
      if (!entry) return;
      owner.indexContext(entry, String(fragment), provenance);
      owner.workerState?.dirty.add(fragment);
    } else {
      owner.add(fragment, best);
    }
  }

  /** Intact fields still match their original patterns. Carry the value cut by a serialized preview. */
  private recordClippedJsonValue(original: string, fragment: string): void {
    let cut = 0;
    while (cut < fragment.length && original[cut] === fragment[cut]) cut++;
    if (cut === original.length) return;
    let prior: RegExpMatchArray | undefined;
    for (const token of original.matchAll(/"(?:[^"\\]|\\.)*"/gs)) {
      const start = token.index!;
      if (start >= cut) break;
      const end = start + token[0].length;
      if (end <= cut) { prior = token; continue; }
      if (!prior || !/^\s*:\s*$/.test(original.slice(prior.index! + prior[0].length, start))) break;
      try {
        const key = JSON.parse(prior[0]) as string;
        const value = JSON.parse(token[0]) as string;
        const before = original.slice(Math.max(prior.index!, start - 48), start + 1);
        const after = fragment.slice(cut, cut + 48);
        this.recordRendering(value, original.slice(start + 1, cut), { key, before, ...(after ? { after } : {}) });
      } catch { /* A malformed preview still uses plain request detectors. */ }
      break;
    }
  }

  private reserve(cost: number, kind: DataClass): boolean {
    if (cost <= VALUE_BUDGET) {
      for (let index = DATA_CLASSES_BY_SENSITIVITY.length - 1; this.remaining < cost; index--) {
        const lower = DATA_CLASSES_BY_SENSITIVITY[index];
        if (!lower || lower === kind) break;
        const bucket = this.byClass.get(lower)!;
        for (const value of bucket) {
          this.remove(value, this.values.get(value)!);
          if (this.remaining >= cost) break;
        }
      }
      if (this.remaining >= cost) {
        this.remaining -= cost;
        return true;
      }
    }
    this.dropped++;
    return false;
  }

  private remove(value: Scalar, entry: ValueEntry): void {
    if (this.workerState?.mirrored.has(value)) this.workerState.dirty.add(value);
    else this.workerState?.dirty.delete(value);
    this.values.delete(value);
    this.byClass.get(entry.kind)!.delete(value);
    for (const nonce of entry.fenceIds ?? []) this.fences.delete(nonce);
    for (const pattern of entry.patterns) {
      const prefixes = (pattern.mode === "folded" ? this.foldedAnchors : this.anchors)[pattern.anchor.length]!;
      const first = pattern.anchor.charCodeAt(0);
      const buckets = prefixes.get(first)!;
      const bucket = buckets.get(pattern.anchor)!;
      bucket.delete(pattern);
      if (!bucket.size) buckets.delete(pattern.anchor);
      if (!buckets.size) prefixes.delete(first);
    }
    this.remaining += entry.cost;
    this.dropped++;
  }

  private add(value: Scalar, evidence: Evidence, contextOnly = false): ValueEntry | undefined {
    let entry = this.values.get(value);
    if (entry) {
      const previous = entry.fields.get(evidence.key);
      if (preferEvidence(previous, evidence)) {
        if (!previous) {
          const cost = evidence.key.length + 20;
          if (!this.reserve(cost, entry.kind)) return undefined;
          entry.cost += cost;
        }
        entry.fields.set(evidence.key, evidence);
      }
      if (preferEvidence(entry.best, evidence)) {
        this.byClass.get(entry.kind)!.delete(value);
        this.byClass.get(evidence.kind)!.add(value);
        entry.best = evidence;
        entry.kind = evidence.kind;
      }
      if (!contextOnly) this.indexValue(entry, value, evidence);
      this.workerState?.dirty.add(value);
      return entry;
    }
    const scalarText = String(value);
    const cost = scalarText.length + evidence.key.length + 48;
    if (!this.reserve(cost, evidence.kind)) return;
    entry = { kind: evidence.kind, best: evidence, fields: new Map([[evidence.key, evidence]]), patterns: [], cost };
    this.values.set(value, entry);
    this.byClass.get(evidence.kind)!.add(value);

    if (!contextOnly) this.indexValue(entry, value, evidence);
    this.workerState?.dirty.add(value);
    return entry;
  }

  private indexValue(entry: ValueEntry, value: Scalar, evidence: Evidence): void {
    const mode = matchMode(value, entry.kind);
    if (entry.mode !== mode) {
      const serialized = JSON.stringify(value);
      const unquoted = typeof value === "string" ? serialized.slice(1, -1) : serialized;
      if (mode !== "field") {
        const escaped = JSON.stringify(unquoted).slice(1, -1);
        for (const text of new Set([String(value), unquoted, escaped, fenceEscapes(unquoted), fenceEscapes(escaped)])) {
          this.index(entry, text, mode);
        }
      }
      const escaped = JSON.stringify(serialized).slice(1, -1);
      for (const text of new Set([serialized, fenceEscapes(serialized), escaped, fenceEscapes(escaped)])) {
        this.index(entry, text, "field");
      }
      entry.mode = mode;
    }
    if (!entry.folded && typeof value === "string" && evidence.kind === "identity" &&
        /^(?:userdisplayname|userprincipalname|username|userid|givenname|surname|displayname|mail)$/.test(evidence.key) &&
        !/^(?:the|and|windows|default|administrator|admin|unknown|none|true|false)$/i.test(value) &&
        [...value].length >= 3 && /\p{L}/u.test(value)) {
      this.index(entry, foldIdentity(value), "folded");
      entry.folded = true;
    }
  }

  private indexContext(entry: ValueEntry, text: string, provenance: RenderProvenance): void {
    const escape = (value: string) => JSON.stringify(value).slice(1, -1);
    for (const encode of [(value: string) => value, fenceEscapes, escape, (value: string) => fenceEscapes(escape(value))]) {
      const value = encode(text);
      const before = encode(provenance.before ?? "");
      const after = encode(provenance.after ?? "");
      if (entry.patterns.some(pattern => pattern.mode === "context" && pattern.text === value &&
          (pattern.before ?? "") === before && (pattern.after ?? "") === after)) continue;
      const cost = before.length + after.length + 24;
      if (!this.reserve(cost, entry.kind)) return;
      entry.cost += cost;
      this.index(entry, value, "context", { before, after });
    }
  }

  private index(entry: ValueEntry, text: string, mode: MatchMode, provenance?: RenderProvenance): void {
    if (!text || entry.patterns.some(pattern => pattern.text === text && pattern.mode === mode &&
      pattern.before === provenance?.before && pattern.after === provenance?.after)) return;
    const width = Math.min(text.length, ANCHOR_WIDTH);
    const indexes = mode === "folded" ? this.foldedAnchors : this.anchors;
    const prefixes = indexes[width] ??= new Map();
    let offset = 0;
    let anchor = text.slice(0, width);
    let load = prefixes.get(anchor.charCodeAt(0))?.get(anchor)?.size ?? 0;
    // Select a sparse anchor, even for values with the same long prefix.
    const step = Math.max(width, Math.floor(text.length / 16));
    for (let position = step; load && position + width <= text.length; position += step) {
      const candidate = text.slice(position, position + width);
      const size = prefixes.get(candidate.charCodeAt(0))?.get(candidate)?.size ?? 0;
      if (size < load) { anchor = candidate; offset = position; load = size; }
    }
    const first = anchor.charCodeAt(0);
    let buckets = prefixes.get(first);
    if (!buckets) prefixes.set(first, buckets = new Map());
    let bucket = buckets.get(anchor);
    if (!bucket) buckets.set(anchor, bucket = new Set());
    const pattern: MatchPattern = { text, offset, anchor, mode, entry,
      ...(provenance?.before ? { before: provenance.before } : {}),
      ...(provenance?.after ? { after: provenance.after } : {}),
    };
    bucket.add(pattern);
    entry.patterns.push(pattern);
  }

  /** Install the sender's exact entry and anchors without rebuilding earlier entries. */
  applyWorkerValues(values: WorkerValue[]): void {
    for (const [value, entry, fences] of values) {
      const previous = this.values.get(value);
      if (previous) this.remove(value, previous);
      if (!entry) continue;
      this.values.set(value, entry);
      this.byClass.get(entry.kind)!.add(value);
      for (const pattern of entry.patterns) {
        const { anchor, mode } = pattern;
        const indexes = mode === "folded" ? this.foldedAnchors : this.anchors;
        const prefixes = indexes[anchor.length] ??= new Map();
        const first = anchor.charCodeAt(0);
        let buckets = prefixes.get(first);
        if (!buckets) prefixes.set(first, buckets = new Map());
        let bucket = buckets.get(anchor);
        if (!bucket) buckets.set(anchor, bucket = new Set());
        bucket.add(pattern);
      }
      for (const [nonce, fence] of fences) this.fences.set(nonce, fence);
    }
  }

  private static scanIndex(retained: readonly ClassificationLedger[], folded: boolean): ScanIndex {
    const ascii: ScanIndex["ascii"] = new Array(128);
    const unicode: ScanIndex["unicode"] = new Map();
    // Merge only the first-code-unit dispatch tables. The prebuilt bucket
    // maps stay in their original ledgers and anchors are sliced once.
    for (const ledger of retained) {
      const anchors = folded ? ledger.foldedAnchors : ledger.anchors;
      for (let width = 1; width < anchors.length; width++) {
        for (const [first, buckets] of anchors[width] ?? []) {
          let lanes = first < ascii.length ? ascii[first] : unicode.get(first);
          if (!lanes) {
            lanes = [];
            if (first < ascii.length) ascii[first] = lanes;
            else unicode.set(first, lanes);
          }
          const existing = lanes.find(lane => lane.width === width);
          if (existing) existing.buckets.push(buckets);
          else lanes.push({ width, buckets: [buckets] });
        }
      }
    }
    return { ascii, unicode, resolved: new Map() };
  }

  private scan(
    index: ScanIndex, text: string, from: number, to: number, work: { remaining: number },
    emit: (span: TextSpan, evidence: Evidence, authoritative?: boolean) => void,
    fieldAt?: (start: number, end: number) => string | undefined,
  ): boolean {
    for (let at = from; at < to; at++) {
      const first = text.charCodeAt(at);
      const lanes = first < index.ascii.length ? index.ascii[first] : index.unicode.get(first);
      if (!lanes) continue;
      for (const { width, buckets } of lanes) {
        if (at + width > text.length) continue;
        const anchor = text.slice(at, at + width);
        let matched = index.resolved.get(anchor);
        if (matched === undefined) {
          matched = null;
          for (const anchors of buckets) {
            const patterns = anchors.get(anchor);
            if (patterns) (matched ??= []).push(patterns);
          }
          // Cache misses too, since repeated prompt wording otherwise
          // probes every retained ledger's bucket for the same anchor.
          if (index.resolved.size < 8_192) index.resolved.set(anchor, matched);
        }
        if (!matched) continue;
        for (const bucket of matched) {
          for (const { text: value, offset, mode, entry, before, after } of bucket) {
            if (--work.remaining < 0) return false;
            const start = at - offset;
            const end = start + value.length;
            if (start < 0 || end > text.length) continue;
            if (value.length > 64) {
              if (!text.startsWith(value.slice(-8), end - 8) || !text.startsWith(value.slice(0, 8), start)) continue;
              work.remaining -= Math.ceil(value.length / 64);
              if (work.remaining < 0) return false;
            }
            if (!text.startsWith(value, start)) continue;
            if ((mode === "word" || mode === "folded") && (!wordBoundary(text, start - 1) || !wordBoundary(text, end))) continue;
            if (mode === "context" && (before && (start < before.length || !text.startsWith(before, start - before.length)) ||
                after && !text.startsWith(after, end))) continue;
            const field = mode === "field" ? fieldAt?.(start, end) : undefined;
            const evidence = mode === "field" ? (field === undefined ? undefined : entry.fields.get(field)) : entry.best;
            if (evidence) {
              // String quotes are syntax, separate from the value to be masked.
              const quoteWidth = mode === "field" ? value.startsWith('\\"') ? 2 : value.startsWith('"') ? 1 : 0 : 0;
              emit({ start: start + quoteWidth, end: end - quoteWidth }, evidence, mode === "field" || mode === "context");
            }
          }
        }
      }
    }
    return true;
  }

  private scanState(): ScanState {
    const retained = [this, ...(this.transient ? [this.transient] : []), ...this.prior].filter(ledger => !ledger.disposed);
    const historyFences = new Map<string, { length: number; replays: TextSpan[] }>();
    for (const [nonce, { length, replays }] of this.historyFences) {
      const missing = replays.filter(({ ledger }) => !ledger || ledger.replayEvidenceIncomplete).map(({ start, end }) => ({ start, end }));
      if (missing.length) historyFences.set(nonce, { length, replays: missing });
    }
    return { retained, historyFences,
      dropped: this.dropped + (this.transient?.dropped ?? 0),
      registrations: this.incompleteRegistrations + (this.transient?.incompleteRegistrations ?? 0),
      incomplete: this.disposed || this.identityIndex?.isComplete?.() === false,
      identityIndex: this.disposed ? undefined : this.identityIndex,
    };
  }

  classifyRequest(request: RequestText): RequestClassification {
    return this.scanRequest(request, this.scanState());
  }

  async classifyProviderRequest(request: RequestText & Pick<LlmOptions, "signal">): Promise<RequestClassification> {
    const length = (request.system?.length ?? 0) + request.prompt.length;
    const ledgerUnits = (ledger: ClassificationLedger) => ledger.disposed ? 0 : VALUE_BUDGET - ledger.remaining;
    const retainedUnits = ledgerUnits(this) + (this.transient ? ledgerUnits(this.transient) : 0) +
      this.prior.reduce((sum, ledger) => sum + ledgerUnits(ledger), 0);
    // No arbitrary-sized lookup or folding work enters the main-thread path.
    if (length <= MAIN_SCAN_LIMIT && retainedUnits <= 4_096 && !this.identityIndex?.workerShards) {
      const slice = new ClassificationSlice();
      const result = this.classifyRequest(request);
      if (slice.elapsed) await slice.yield();
      return result;
    }
    return this.classifyLargeRequest(request, request.signal);
  }

  private async syncLedger(client: ClassificationWorker, slice: ClassificationSlice): Promise<number> {
    const initial = this.workerState?.client !== client;
    const state = initial ? { client, id: client.id(this), dirty: new Set<Scalar>(), mirrored: new Set<Scalar>() } : this.workerState!;
    this.workerState = state;
    const syncValues = async (keys: Iterable<Scalar>) => {
      let batch: WorkerValue[] = [];
      let units = 0;
      for (const value of keys) {
        if (this.disposed) break;
        const entry = this.values.get(value);
        if (entry) state.mirrored.add(value);
        else state.mirrored.delete(value);
        const fences = Array.from(entry?.fenceIds ?? [], nonce => [nonce, this.fences.get(nonce)!] satisfies [string, Fence]);
        const item: WorkerValue = [value, entry, fences];
        const cost = (entry?.cost ?? (typeof value === "string" ? value.length : 0)) + 48;
        if (cost >= SYNC_BATCH_UNITS) {
          const encoded = await encodeLargeValue(item, slice);
          if (this.disposed) break;
          client.post({ type: "large-value", id: state.id, value: encoded.value }, encoded.buffers);
        } else {
          batch.push(item);
          units += cost;
        }
        if (units >= SYNC_BATCH_UNITS || slice.elapsed) {
          client.post({ type: "values", id: state.id, values: batch });
          batch = [];
          units = 0;
          if (slice.elapsed) await slice.yield();
        }
      }
      if (batch.length && !this.disposed) client.post({ type: "values", id: state.id, values: batch });
    };
    if (initial) await syncValues(this.values.keys());
    // Mutations can occur while a synchronization slice yields. Send only
    // changes and removals before using the mirror again.
    while (state.dirty.size && !this.disposed) {
      const dirty = state.dirty;
      state.dirty = new Set();
      await syncValues(dirty);
    }
    return state.id;
  }

  async classifyLargeRequest(request: RequestText, signal?: AbortSignal): Promise<RequestClassification> {
    const wasDisposed = this.disposed;
    let indexCurrent = () => true;
    const result = await requestWorker().run<"scan">(async client => {
      const slice = new ClassificationSlice();
      const sections = { system: await encodeSection(request.system, slice), prompt: await encodeSection(request.prompt, slice) };
      const transfers = Object.values(sections).flatMap(section => section ? [section.buffer] : []);
      const { retained, identityIndex, ...state } = this.scanState();
      const ledgers: number[] = [];
      for (const ledger of retained) {
        const id = await ledger.syncLedger(client, slice);
        if (!ledger.disposed) ledgers.push(id);
      }
      const { shards, isCurrent } = await syncIdentityShards(client, identityIndex, slice);
      indexCurrent = isCurrent;
      // Resample expiry after asynchronous synchronization. Disposed mirrors
      // have already been dropped; history will mark their replay ranges.
      const latest = this.scanState();
      return {
        message: { type: "scan", sections, ledgers, shards, state: {
          ...state, historyFences: latest.historyFences,
          incomplete: state.incomplete || latest.incomplete || !indexCurrent(),
        } },
        transfers,
      };
    }, signal);
    const classification = await unpackWorkerResult(result);
    if (!wasDisposed && this.disposed) throw new Error("Request classification evidence was released.");
    return indexCurrent() ? classification : { ...classification, coverageIncomplete: true, effectiveClass: "credential" };
  }

  static scanInWorker(message: WorkerScan, ledgers: Map<number, ClassificationLedger>, shards: Map<number, TenantValueIndex>): WorkerResult {
    const { system, prompt } = message.sections;
    const retained = message.ledgers.flatMap(id => ledgers.get(id) ?? []);
    const indexes = message.shards.flatMap(id => shards.get(id) ?? []);
    const identityIndex = indexes.length ? {
      matches: (text: string) => !TenantValueIndex.spansFor(text, indexes).next().done,
      spans: (text: string) => TenantValueIndex.spansFor(text, indexes),
    } : undefined;
    const { spans, ...classification } = new ClassificationLedger().scanRequest({
      system: system && Buffer.from(system.buffer).toString("utf16le"),
      prompt: prompt ? Buffer.from(prompt.buffer).toString("utf16le") : "",
    }, { ...message.state, retained, identityIndex }, { system: system?.length ?? 0, prompt: prompt?.length ?? 0 });
    return packWorkerResult(spans, classification);
  }

  private scanRequest(request: RequestText, state: ScanState, fullLengths?: Record<ClassificationSpan["section"], number>): RequestClassification {
    const spans: ClassificationSpan[] = [];
    const ranges: UnexaminedRange[] = [];
    const { retained, historyFences, identityIndex } = state;
    const rawIndex = ClassificationLedger.scanIndex(retained, false);
    const foldedIndex = retained.some(ledger => ledger.foldedAnchors.length)
      ? ClassificationLedger.scanIndex(retained, true) : undefined;
    for (const section of ["system", "prompt"] as const) {
      const original = request[section];
      if (!original) continue;
      const text = original.slice(0, REQUEST_CLASSIFICATION_MAX_SECTION);
      const fullLength = fullLengths?.[section] ?? original.length;
      if (text.length < fullLength) ranges.push({ section, start: text.length, end: fullLength, reason: "text-limit" });
      const found = new Map<string, ClassificationSpan & { authoritative?: boolean }>();
      const work = { remaining: MATCH_BUDGET };
      let fields: ReturnType<typeof jsonFields> | undefined;
      const fieldAt = (start: number, end: number) => {
        const field = (fields ??= jsonFields(text)).get(start);
        return field?.end === end ? field.key : undefined;
      };
      const collect = ({ start, end }: TextSpan, evidence: Evidence, authoritative = false) => {
        const { kind, source, maskRole } = evidence;
        const confirmedIdentity = source === "detector:tenant-index";
        const key = `${start}:${end}`;
        const previous = found.get(key);
        // Typed provenance distinguishes, for example, a security policy id from an arbitrary GUID.
        if (!previous || confirmedIdentity && maxDataClass(previous.kind, kind) !== previous.kind ||
            !previous.authoritative && authoritative && kind !== "credential" && previous.kind !== "credential" ||
            (authoritative || !previous.authoritative || kind === "credential") &&
            (previous.kind !== kind ? maxDataClass(previous.kind, kind) === kind :
              Boolean(maskRole) && (!previous.maskRole || maskRole === "nameOrIdentifier"))) {
          found.set(key, { section, start, end, kind, source, ...(maskRole ? { maskRole } : {}), ...(authoritative ? { authoritative } : {}) });
        }
      };
      if (historyFences.size || retained.some(ledger => ledger.fences.size)) {
        for (const marker of text.matchAll(/<tenant_data [^<>\n]* nonce="([0-9a-f]{16})">/g)) {
          const start = marker.index + marker[0].length + 1;
          if (text[start - 1] !== "\n") continue;
          const history = historyFences.get(marker[1]!);
          const close = '\n</tenant_data nonce="' + marker[1] + '">';
          if (history && original.startsWith(close, start + history.length)) {
            for (const replay of history.replays) {
              const end = Math.min(text.length, start + replay.end);
              if (start + replay.start < end) {
                ranges.push({ section, start: start + replay.start, end, reason: "history-evidence-unavailable" });
              }
            }
          }
          for (const ledger of retained) {
            const entry = ledger.fences.get(marker[1]!);
            if (!entry) continue;
            const { body } = entry;
            const end = start + body.length;
            if (text.startsWith(body, start) && text.startsWith(`\n</tenant_data nonce="${marker[1]}">`, end)) {
              collect({ start, end }, entry.evidence, true);
            }
          }
        }
      }
      const folded = foldedIndex ? foldIdentity(text) : undefined;
      for (let from = 0; from < text.length; from += TEXT_CHUNK) {
        const to = Math.min(text.length, from + TEXT_CHUNK);
        if (!this.scan(rawIndex, text, from, to, work, collect, fieldAt) ||
            foldedIndex && folded !== undefined && !this.scan(foldedIndex, folded, from, to, work, collect)) {
          // The section-wide detector pass has not examined any of this text.
          ranges.push({ section, start: 0, end: text.length, reason: "match-limit" });
          break;
        }
      }
      // Detector grammar can span an arbitrarily long gap or token. Run on
      // the bounded section so the ledger's chunks do not clip its input.
      if (work.remaining >= 0) for (const match of requestTextSpans(text, identityIndex)) {
        if (--work.remaining < 0) {
          ranges.push({ section, start: 0, end: text.length, reason: "match-limit" });
          break;
        }
        collect(match, { kind: match.kind, source: match.source, key: "" });
      }
      const ordered = [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      for (const { authoritative: _, ...span } of ordered) spans.push(span);
    }
    return classification(spans, ranges, retained.reduce((sum, ledger) => sum + ledger.values.size, 0),
      state.dropped, state.registrations, state.incomplete);
  }
}

const scopes = new AsyncLocalStorage<ClassificationLedger>();
let unscopedRegistrations = 0;
let unscopedRequests = 0;

export function classificationDiagnostics(): Readonly<{ unscopedRegistrations: number; unscopedRequests: number }> {
  return { unscopedRegistrations, unscopedRequests };
}

export function withClassificationScope<T>(ledger: ClassificationLedger, work: () => T): T {
  return scopes.run(ledger, work);
}

export async function withTransientClassificationScope<T>(
  ledger: ClassificationLedger, work: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  ledger.expireAfter();
  const dispose = () => ledger.dispose();
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    signal?.throwIfAborted();
    return await withClassificationScope(ledger, work);
  } finally {
    signal?.removeEventListener("abort", dispose);
    dispose();
  }
}

export function currentClassificationLedger(): ClassificationLedger | undefined {
  return scopes.getStore();
}

export function registerTenantData(source: string, data: unknown, options?: ClassificationOptions): void {
  const ledger = scopes.getStore();
  if (ledger) ledger.register(source, data, options);
  else unscopedRegistrations++;
}

export async function registerGraphTenantData(graphPath: string, data: unknown, signal?: AbortSignal): Promise<void> {
  const ledger = scopes.getStore();
  if (ledger) await ledger.registerGraph(graphPath, data, signal);
  else unscopedRegistrations++;
}

export function registerTransientTenantData(source: string, data: unknown): void {
  const ledger = scopes.getStore();
  if (ledger) ledger.registerTransient(source, data);
  else unscopedRegistrations++;
}

export function registerClassifiedValues(source: string, values: ClassifiedValues): void {
  const ledger = scopes.getStore();
  if (ledger) ledger.registerClassified(source, values);
  else unscopedRegistrations++;
}

/** Return the fragment unchanged. Only the local evidence follows the rendering. */
export function registerRenderedFragment<T extends Scalar>(original: unknown, fragment: T, provenance: RenderProvenance = {}): T {
  scopes.getStore()?.rendered(original, fragment, provenance);
  return fragment;
}

export function withRequestClassification(
  llm: RunLlmApi,
  providerId: ProviderId,
  observe: (event: RequestClassificationEvent, tenantIds: readonly string[]) => void,
): RunLlmApi {
  const classify = async (ledger: ClassificationLedger | undefined, method: RequestClassificationEvent["method"], request: LlmOptions) => {
    if (!llm.available) return;
    if (!ledger) unscopedRequests++;
    let result: RequestClassification;
    let failed = false;
    try {
      const active = ledger ?? new ClassificationLedger();
      result = await active.classifyProviderRequest(request);
    } catch {
      failed = true;
      const ranges: UnexaminedRange[] = [];
      for (const section of ["system", "prompt"] as const) {
        const length = request[section]?.length ?? 0;
        if (length) ranges.push({ section, start: 0, end: length, reason: "failure" });
      }
      result = classification([], ranges, 0, 0, 0, true);
    }
    try {
      observe({ providerId, method, fieldMapVersion: GRAPH_FIELD_CLASSES_VERSION, timestamp: new Date().toISOString(),
        ...(ledger?.scopeId ? { scopeId: ledger.scopeId } : {}), scopePresent: ledger !== undefined,
        failed, classification: result }, ledger?.tenantIds ?? []);
    } catch { /* Development observers cannot change provider behavior. */ }
  };
  return {
    available: llm.available,
    defaultModel: llm.defaultModel,
    streamsIncrementally: llm.streamsIncrementally,
    async complete(options) {
      await classify(scopes.getStore(), "complete", options);
      return llm.complete(options);
    },
    stream(options) {
      const ledger = scopes.getStore();
      return (async function* () {
        await classify(ledger, "stream", options);
        yield* llm.stream(options);
      })();
    },
  };
}
