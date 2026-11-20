import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_CLASSES_BY_SENSITIVITY, maxDataClass, type DataClass, type DataClassCounts, type LlmOptions, type ProviderId, type RunLlmApi } from "@openadminos/agent-sdk";
import { emptyDataClassCounts, graphClassificationSource, requestTextSpans, walkDataClasses, type ClassificationOptions, type TextSpan } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES_VERSION, type SecurityMaskRole } from "./graph-field-classes.js";
import { ClassificationSlice, requestWorker, reserveClassificationRequest, syncIdentityShards, yieldClassificationTurn, type ClassificationReservation, type ClassificationWorker } from "./classification-worker-client.js";
import { graphClassificationInput, MAX_GRAPH_INPUT_BYTES } from "./graph-ingress-classification.js";
import { TenantValueIndex } from "./tenant-value-index.js";

export interface ClassificationSpan extends TextSpan {
  section: "system" | "prompt";
  kind: DataClass;
  source: string;
  maskRole?: SecurityMaskRole;
}

interface UnexaminedRange extends TextSpan {
  section: ClassificationSpan["section"];
  reason: "text-limit" | "match-limit" | "history-evidence-unavailable" | "history-provenance-unavailable" | "script-provenance-unavailable" | "clipped-provenance-unavailable" | "competing-provenance" | "rendered-provenance-unavailable" | "failure";
}

interface HistoryReplay extends TextSpan {
  ledger: ClassificationLedger | undefined;
  hostSerialization?: true;
}

type ReplayRange = TextSpan & { incomplete: boolean; hostSerialization?: true };
type HistoryFences = ReadonlyMap<string, { length: number; replays: readonly ReplayRange[] }>;

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
  requestSequence: number;
  providerId: ProviderId;
  method: "complete" | "stream";
  fieldMapVersion: number;
  timestamp: string;
  scopeId?: string;
  scopePresent: boolean;
  failed: boolean;
  classification: RequestClassification;
  /** Historical records may summarize excess offsets. Live observers receive all offsets. */
  spansOmitted?: number;
  rangesOmitted?: number;
}

type Scalar = string | number | boolean;
export interface TemplateInterpolation extends TextSpan {
  key: string;
  value?: Scalar;
  incomplete?: boolean;
  requireEvidence?: boolean;
  classification?: Pick<ClassificationSpan, "kind" | "source" | "maskRole">;
  trace?: () => Generator<TemplateInterpolation | undefined, boolean>;
}
type FencedRendering = {
  fence: string;
  start: number;
  trace: (body: string, offset: number, identityIndex?: ClassificationOptions["identityIndex"]) =>
    Generator<TemplateInterpolation | undefined, boolean>;
};

export const MAX_TEMPLATE_INTERPOLATIONS = 1024;
const templateInterpolations = new AsyncLocalStorage<Partial<Record<ClassificationSpan["section"], readonly TemplateInterpolation[]>>>();

export function withTemplateInterpolations<T>(
  sections: Partial<Record<ClassificationSpan["section"], readonly TemplateInterpolation[]>>, work: () => T,
): T {
  return templateInterpolations.run(sections, work);
}
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
  unknownOrigin?: boolean;
  jsonPrefix?: boolean;
  requireEvidence?: boolean;
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
  leastSensitiveFieldKind?: DataClass;
}
interface ValueEntry {
  kind: DataClass;
  mode?: MatchMode;
  folded?: boolean;
  fields: Map<string, Evidence>;
  best?: Evidence;
  patterns: MatchPattern[];
  fenceIds?: Set<string>;
  cost: number;
}
type MatchMode = "text" | "word" | "field" | "context" | "folded" | "replay" | "clipped";
interface MatchPattern {
  text: string;
  offset: number;
  anchor: string;
  mode: MatchMode;
  entry: ValueEntry;
  before?: string;
  after?: string;
  key?: string;
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
  promptReplay?: TextSpan;
  dropped: number;
  registrations: number;
  incomplete: boolean;
  identityIndex: ClassificationOptions["identityIndex"];
  renderedSpans?: ClassificationSpan[];
  renderedGaps?: UnexaminedRange[];
  scriptText?: Partial<Record<ClassificationSpan["section"], TextSpan>>;
  scriptReadClass?: DataClass;
};

type EvidenceSnapshot = {
  state: ScanState;
  revisions: readonly number[];
  shards: readonly TenantValueIndex[];
  interpolations: ReturnType<typeof templateInterpolations.getStore>;
  fencedRenderings: readonly FencedRendering[];
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
  state: Pick<ScanState, "historyFences" | "promptReplay" | "dropped" | "registrations" | "incomplete" | "renderedSpans" | "renderedGaps" | "scriptText" | "scriptReadClass">;
}

export interface WorkerResult {
  classification: Omit<RequestClassification, "spans">;
  offsets: Int32Array;
  sources: string[];
}

const VALUE_BUDGET = 2_000_000;
const PENDING_RENDER_UNITS = 256_000;
const PENDING_RENDER_COUNT = 512;
export const REQUEST_CLASSIFICATION_MAX_SECTION = 16_000_000;
const TEXT_CHUNK = 128_000;
const MATCH_BUDGET = 200_000;
const ANCHOR_WIDTH = 8;
const MAIN_SCAN_LIMIT = 512;
const SYNC_BATCH_UNITS = 16_384;
export const CLASSIFICATION_TTL_MS = 15 * 60_000;

function fenceEscapes(text: string): string {
  return text.replace(/[<>\uff1c\uff1e\ufe64\ufe65\u2329\u232a\u27e8\u27e9\u2039\u203a]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const JSON_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;

function wordBoundaries(text: string): (edge: number, side: -1 | 1) => boolean {
  let slashRunStart = -1;
  let slashRunEnd = -1;
  return (edge, side) => {
    // Check the provider's spelling in place. Escapes are indivisible: the
    // last hex digit is not a word character, and matches cannot start in it.
    for (let slash = edge - 1; slash >= Math.max(0, edge - 6); slash--) {
      if (text.charCodeAt(slash) !== 92) continue;
      if (slash < slashRunStart || slash > slashRunEnd) {
        slashRunStart = slashRunEnd = slash;
        while (text.charCodeAt(slashRunStart - 1) === 92) slashRunStart--;
        while (text.charCodeAt(slashRunEnd + 1) === 92) slashRunEnd++;
      }
      if ((slash - slashRunStart) % 2 !== 0) continue;
      JSON_ESCAPE.lastIndex = slash;
      if (JSON_ESCAPE.test(text) && JSON_ESCAPE.lastIndex >= edge) {
        if (JSON_ESCAPE.lastIndex > edge) return false;
        if (side === -1) return true;
        break;
      }
    }
    let start = side === -1 ? edge - 1 : edge;
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff) start--;
    const point = text.codePointAt(start);
    return point === undefined || !WORD_CHAR.test(String.fromCodePoint(point));
  };
}

const MAX_REPLAY_DECODE_LAYERS = 3;
const MAX_REPLAY_DECODE_UNITS = 128_000;
const REPLAY_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}|[\s\S]|$)/g;
const REPLAY_ESCAPE_VALUES: Readonly<Record<string, string>> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

/** Keep every decoded UTF-16 boundary tied to its spelling in the request. */
function decodeReplayLayer(text: string, toOriginal: (offset: number) => number) {
  if (!text.includes("\\")) return undefined;
  const offsets = new Uint32Array(text.length + 1);
  const parts: string[] = [];
  let read = 0;
  let written = 0;
  let changed = false;
  let uncertain = false;
  const copy = (end: number) => {
    parts.push(text.slice(read, end));
    while (read < end) offsets[written++] = toOriginal(read++);
  };
  for (const { 0: escape, index } of text.matchAll(REPLAY_ESCAPE)) {
    const value = escape.length === 6 ? String.fromCharCode(Number.parseInt(escape.slice(2), 16))
      : REPLAY_ESCAPE_VALUES[escape.slice(1)];
    if (value === undefined) {
      uncertain = true;
      continue;
    }
    copy(index);
    parts.push(value);
    offsets[written++] = toOriginal(read);
    read += escape.length;
    changed = true;
  }
  if (!changed) return { text, toOriginal, changed, uncertain };
  copy(text.length);
  offsets[written] = toOriginal(text.length);
  return { text: parts.join(""), toOriginal: (offset: number) => offsets[offset]!, changed, uncertain };
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

function lessSensitiveKind(first: DataClass | undefined, second: DataClass): DataClass {
  return first && maxDataClass(first, second) === second ? first : second;
}

function classification(
  spans: ClassificationSpan[], ranges: UnexaminedRange[], retainedValues: number, droppedValues: number,
  registrations: number, incomplete = false, scriptReadClass?: DataClass,
): RequestClassification {
  const counts = emptyDataClassCounts();
  for (const span of spans) counts[span.kind]++;
  const coverageIncomplete = incomplete || ranges.length > 0 || droppedValues > 0 || registrations > 0;
  const observedClass = DATA_CLASSES_BY_SENSITIVITY.find(kind => counts[kind] > 0);
  const unknownCoverage = incomplete || droppedValues > 0 || registrations > 0 ||
    ranges.some(range => range.reason !== "script-provenance-unavailable");
  const effectiveClass = unknownCoverage ? "credential" : scriptReadClass && observedClass
    ? maxDataClass(scriptReadClass, observedClass) : scriptReadClass ?? observedClass;
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
    for (const { text, before, after, entry: _entry, ...pattern } of patterns) {
      packed.patterns.push({ ...pattern, text: await encode(text),
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

async function unpackWorkerResult({ classification, offsets, sources }: WorkerResult, signal?: AbortSignal): Promise<RequestClassification> {
  const spans: ClassificationSpan[] = [];
  const slice = new ClassificationSlice(signal);
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
const tenantLedgers = new Map<string, Set<ClassificationLedger>>();

export class ClassificationLedger {
  private readonly values = new Map<Scalar, ValueEntry>();
  private readonly byClass = new Map(DATA_CLASSES_BY_SENSITIVITY.map(kind => [kind, new Set<Scalar>()]));
  private hasShortReplayValues = false;
  private readonly anchors: Array<AnchorIndex | undefined> = [];
  private readonly foldedAnchors: Array<AnchorIndex | undefined> = [];
  private readonly fences = new Map<string, Fence>();
  private readonly historyFences = new Map<string, { length: number; replays: readonly HistoryReplay[] }>();
  private fencedRenderings: FencedRendering[] = [];
  private readonly historyReplays = new Map<string, readonly HistoryReplay[]>();
  private prior: readonly ClassificationLedger[] = [];
  private transient?: ClassificationLedger;
  private remaining = VALUE_BUDGET;
  private revision = 0;
  private dropped = 0;
  private incompleteRegistrations = 0;
  private pendingRegistrations = 0;
  private registrationGeneration = 0;
  private unresolvedScriptReads = 0;
  private scriptReadClass?: DataClass;
  private pendingRenderUnits = 0;
  private readonly pendingRenderings: Array<[Scalar, Scalar, RenderProvenance]> = [];
  private resolvingRenderings = false;
  private disposed = false;
  private discardedIncompleteEvidence = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly observationLifetime = new AbortController();
  private readonly observations = new Set<Promise<void>>();

  observeRequest(reservation: ClassificationReservation, work: (signal: AbortSignal) => Promise<void>): void {
    const signal = this.observationLifetime.signal;
    const release = reservation.release;
    if (signal.aborted) {
      release();
      return;
    }
    signal.addEventListener("abort", release, { once: true });
    this.trackObservation(yieldClassificationTurn(signal).then(() => work(signal)).finally(() => {
      signal.removeEventListener("abort", release);
      release();
    }));
  }

  observeMetadata(work: () => void): void {
    this.trackObservation(Promise.resolve().then(work));
  }

  /** Mark pending evidence before returning its input to the caller. */
  scheduleRegistration(bytes: number, work: (signal: AbortSignal, reservation: ClassificationReservation) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const reservation = reserveClassificationRequest(bytes);
    if (!reservation) {
      this.incompleteRegistrations++;
      return Promise.resolve();
    }
    this.pendingRegistrations++;
    this.registrationGeneration++;
    const signal = this.observationLifetime.signal;
    const release = reservation.release;
    signal.addEventListener("abort", release, { once: true });
    const observation = yieldClassificationTurn(signal).then(() => work(signal, reservation))
      .catch(() => { if (!this.disposed) this.incompleteRegistrations++; })
      .finally(async () => {
        this.pendingRegistrations--;
        try { await this.resolveRenderings(); }
        finally {
          signal.removeEventListener("abort", release);
          release();
        }
      });
    this.trackObservation(observation);
    return observation;
  }

  private trackObservation(pending: Promise<void>): void {
    this.observations.add(pending);
    const remove = () => {
      this.observations.delete(pending);
      this.releaseTenantReferences();
    };
    void pending.then(remove, remove);
  }

  private releaseTenantReferences(): void {
    if (!this.disposed || this.observations.size) return;
    for (const id of this.tenantIds) {
      const ledgers = tenantLedgers.get(id);
      ledgers?.delete(this);
      if (!ledgers?.size) tenantLedgers.delete(id);
    }
  }

  async waitForObservations(): Promise<void> {
    await Promise.allSettled(this.observations);
  }
  private workerState?: { client: ClassificationWorker; id: number; dirty: Set<Scalar>; mirrored: Set<Scalar> };
  private promptReplay?: TextSpan;
  scopeId: string | undefined;

  constructor(
    private readonly identityIndex?: ClassificationOptions["identityIndex"], scopeId?: string,
    readonly tenantIds: readonly string[] = [],
  ) {
    this.scopeId = scopeId;
    for (const id of tenantIds) {
      let ledgers = tenantLedgers.get(id);
      if (!ledgers) tenantLedgers.set(id, ledgers = new Set());
      ledgers.add(this);
    }
  }

  get expired(): boolean { return this.disposed; }

  expireAfter(ttl = CLASSIFICATION_TTL_MS): void {
    if (this.disposed) return;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.dispose(), ttl);
    this.expiry.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    clearTimeout(this.expiry);
    this.disposed = true;
    this.observationLifetime.abort();
    this.pendingRenderings.length = 0;
    this.pendingRenderUnits = 0;
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
    this.fencedRenderings = [];
    delete this.promptReplay;
    this.prior = [];
    this.discardTransient();
    this.releaseTenantReferences();
  }

  /** A shallow reference to earlier turns. Each turn owns its own budget and expiry. */
  include(previous: ClassificationLedger): void {
    if (previous !== this && !this.prior.includes(previous)) this.prior = [...this.prior, previous];
  }

  releaseHistory(): void {
    this.prior = [];
    this.historyFences.clear();
    this.historyReplays.clear();
    this.fencedRenderings = [];
    this.revision++;
  }

  markCoverageIncomplete(): void {
    if (!this.disposed) this.incompleteRegistrations++;
  }

  registerFencedRendering(fence: string, start: number, trace: FencedRendering["trace"]): void {
    if (this.disposed) return;
    if (this.fencedRenderings.length >= 4) {
      this.incompleteRegistrations++;
      return;
    }
    this.fencedRenderings = [...this.fencedRenderings, { fence, start, trace }];
  }

  registerHistoryReplay(text: string, replays: readonly HistoryReplay[]): void {
    if (!this.disposed) this.historyReplays.set(text, replays);
  }

  markPromptReplay(start: number, end: number): void {
    if (!this.disposed) {
      this.promptReplay = { start, end };
      this.revision++;
    }
  }

  private get replayEvidenceIncomplete(): boolean {
    return this.disposed || this.dropped > 0 || this.incompleteRegistrations > 0 || this.pendingRegistrations > 0 ||
      this.pendingRenderings.length > 0 || this.discardedIncompleteEvidence || this.transient?.replayEvidenceIncomplete === true;
  }

  discardTransient(): void {
    this.discardedIncompleteEvidence ||= this.transient?.replayEvidenceIncomplete === true;
    this.transient?.dispose();
    delete this.transient;
  }

  registerTransient(source: string, data: unknown): void {
    if (this.disposed) return;
    this.transient ??= new ClassificationLedger(this.identityIndex);
    const transient = this.transient;
    void this.scheduleRegistration(MAX_GRAPH_INPUT_BYTES, (signal, reservation) => transient.observeIngress(source, data, {}, signal, reservation));
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

  registerIngress(source: string, data: unknown, options: ClassificationOptions, context?: "script"): void {
    if (context === "script") this.unresolvedScriptReads++;
    void this.scheduleRegistration(MAX_GRAPH_INPUT_BYTES, (signal, reservation) => this.observeIngress(
      source.startsWith("graph:") && options.graphPath ? graphClassificationSource(options.graphPath) : source, data, options, signal, reservation, context,
    ));
  }

  registerGraph(graphPath: string, data: unknown, signal?: AbortSignal, context?: "script"): Promise<void> {
    if (context === "script") this.unresolvedScriptReads++;
    return this.scheduleRegistration(MAX_GRAPH_INPUT_BYTES, (lifetime, reservation) => this.observeIngress(
      graphClassificationSource(graphPath), data, { graphPath }, signal ? AbortSignal.any([signal, lifetime]) : lifetime, reservation, context,
    ));
  }

  private async observeIngress(source: string, data: unknown, options: ClassificationOptions, signal: AbortSignal, reservation: ClassificationReservation, context?: "script"): Promise<void> {
    if (this.disposed) return;
    const { identityIndex = this.identityIndex, ...settings } = options;
    let indexCurrent = () => true;
    const { bytes, header, rows, collection, batches } = await graphClassificationInput(data, signal);
    reservation.shrink(bytes);
    const classified = await requestWorker().run<"graph">(bytes, async client => {
      const slice = new ClassificationSlice(signal);
      const { shards, isCurrent } = await syncIdentityShards(client, identityIndex, slice);
      indexCurrent = isCurrent;
      signal.throwIfAborted();
      // Preserve the root wrapper and order for the worker's single field-map walk.
      // Small input messages also avoid a page-sized main-thread clone.
      for (const [start, end] of batches) {
        signal.throwIfAborted();
        if (this.disposed) throw new Error("Graph classification evidence was released.");
        client.post({ type: "graph-rows", rows: rows!.slice(start, end) });
        if (slice.elapsed) await slice.yield();
      }
      return { message: { type: "graph", data: header, settings, shards, collection } };
    }, signal, reservation);
    if (this.disposed) return;
    await yieldClassificationTurn(signal);
    this.dropped += classified.dropped;
    if (classified.incomplete || !indexCurrent()) this.incompleteRegistrations++;
    const slice = new ClassificationSlice(signal);
    const decoder = new TextDecoder();
    for (const batch of classified.batches) {
      const fields = JSON.parse(decoder.decode(batch)) as ClassifiedValues["fields"];
      for (const { value, kind, key, maskRole } of fields) {
        if (this.disposed) return;
        signal?.throwIfAborted();
        this.add(value, { kind, source, key: key.toLowerCase(), ...(maskRole ? { maskRole } : {}) });
        if (context === "script") this.scriptReadClass = maxDataClass(this.scriptReadClass ?? kind, kind);
        if (slice.elapsed) await slice.yield();
      }
      if (slice.elapsed) await slice.yield();
    }
    if (context === "script" && !classified.dropped && !classified.incomplete && indexCurrent()) this.unresolvedScriptReads--;
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
    if (this.disposed || (typeof original !== "string" && typeof original !== "number" && typeof original !== "boolean")) return;
    try {
      const deferred = provenance.jsonPrefix || provenance.requireEvidence || provenance.unknownOrigin;
      if (deferred || this.pendingRegistrations || this.pendingRenderings.length) {
        const units = (typeof original === "string" ? original.length : 16) +
          (typeof fragment === "string" ? fragment.length : 16) + 64 + (provenance.key?.length ?? 0) +
          (provenance.before?.length ?? 0) + (provenance.after?.length ?? 0) + (provenance.fence?.length ?? 0);
        if (this.pendingRenderUnits + units > PENDING_RENDER_UNITS || this.pendingRenderings.length >= PENDING_RENDER_COUNT) {
          this.incompleteRegistrations++;
        } else {
          this.pendingRenderUnits += units;
          this.pendingRenderings.push([original, fragment, provenance]);
        }
        if (deferred) {
          if (!this.pendingRegistrations && !this.resolvingRenderings && this.pendingRenderings.length) {
            this.trackObservation(this.resolveRenderings());
          }
          if (provenance.jsonPrefix) return;
          // Preserve already known source evidence while the deferred pass
          // checks whether missing provenance needs an incomplete range.
          this.recordRendering(original, fragment, { ...provenance, requireEvidence: false });
          return;
        }
      }
      this.recordRendering(original, fragment, provenance);
    }
    catch { this.incompleteRegistrations++; }
  }

  private async resolveRenderings(): Promise<void> {
    if (this.resolvingRenderings || this.pendingRegistrations || !this.pendingRenderings.length) return;
    this.resolvingRenderings = true;
    try {
      const signal = this.observationLifetime.signal;
      await yieldClassificationTurn(signal);
      const slice = new ClassificationSlice(signal);
      let generation = this.registrationGeneration;
      for (let index = 0;;) {
        if (this.pendingRegistrations || this.disposed) return;
        if (generation !== this.registrationGeneration) {
          generation = this.registrationGeneration;
          index = 0;
        }
        if (index === this.pendingRenderings.length) break;
        const [original, fragment, provenance] = this.pendingRenderings[index++]!;
        try {
          if (provenance.jsonPrefix && typeof original === "string" && typeof fragment === "string") {
            await this.recordClippedJsonValue(original, fragment, slice);
          } else this.recordRendering(original, fragment, provenance);
        }
        catch { this.incompleteRegistrations++; }
        if (slice.elapsed) await slice.yield();
      }
      this.pendingRenderings.length = 0;
      this.pendingRenderUnits = 0;
    } catch {
      if (!this.disposed) this.incompleteRegistrations++;
    } finally {
      this.resolvingRenderings = false;
    }
  }

  private recordRendering(original: Scalar, fragment: Scalar, provenance: RenderProvenance): void {
    if (typeof fragment === "string" && !fragment.trim()) return;
    if (provenance.fence && typeof original === "string" && typeof fragment === "string") {
      const replays = this.historyReplays.get(original);
      if (replays) this.revision++;
      if (replays) this.historyFences.set(provenance.fence, {
        length: fragment.length,
        replays: replays.map(({ start, end, ledger, hostSerialization }) => ({
          start: fenceEscapes(original.slice(0, start)).length,
          end: fenceEscapes(original.slice(0, end)).length,
          ledger, hostSerialization,
        })),
      });
    }
    if (provenance.unknownOrigin && typeof fragment === "string") {
      this.recordClippedGap(fragment, provenance);
      return;
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
      if (provenance.requireEvidence && typeof fragment === "string") this.recordClippedGap(fragment, provenance);
      return;
    }
    if (provenance.fence && typeof fragment === "string") {
      const entry = owner.add(original, best, true);
      const recorded = entry?.fenceIds?.has(provenance.fence);
      if (entry && (recorded || owner.reserve(64, entry.kind))) {
        if (!recorded) entry.cost += 64;
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
  private async recordClippedJsonValue(original: string, fragment: string, slice: ClassificationSlice): Promise<void> {
    let cut = 0;
    while (cut < fragment.length && original[cut] === fragment[cut]) cut++;
    if (cut === 0 || cut === original.length) return;
    // The normal field matcher needs a visible delimiter. A cut after the
    // scalar's closing quote can still hide that delimiter in formatted JSON.
    const whitespace = /[ \t\r\n]/;
    let lastVisibleTokenEnd = cut;
    while (lastVisibleTokenEnd > 0 && whitespace.test(original[lastVisibleTokenEnd - 1]!)) lastVisibleTokenEnd--;
    // The original is serialized JSON. A property supplies the next value's
    // key, and arrays pass their containing key to their elements.
    const stack: Array<{ array: boolean; key: string | undefined }> = [];
    const colon = /\s*:/y;
    for (const token of original.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gs)) {
      const start = token.index;
      if (start >= cut) break;
      if (slice.elapsed) await slice.yield();
      const literal = token[0];
      const end = start + literal.length;
      const frame = stack.at(-1);
      if (literal === "[" || literal === "{") {
        stack.push({ array: literal === "[", key: literal === "[" ? frame?.key : undefined });
      } else if (literal === "]" || literal === "}") stack.pop();
      else if (literal !== ":" && literal !== "," && literal !== "null") {
        const quoted = literal.startsWith('"');
        colon.lastIndex = end;
        const property = quoted && frame && !frame.array && colon.test(original);
        if (end < lastVisibleTokenEnd || property && end <= cut) {
          if (property) frame.key = JSON.parse(literal) as string;
          continue;
        }
        const begin = start + Number(quoted);
        const finish = Math.min(cut, end - Number(quoted));
        const part = fragment.slice(begin, finish);
        if (!part) break;
        const before = original.slice(Math.max(0, start - 48), begin);
        const after = fragment.slice(finish, finish + 48);
        if (frame?.key !== undefined && !property) {
          this.recordRendering(JSON.parse(literal) as Scalar, part, { key: frame.key, before, after, requireEvidence: true });
        } else this.recordClippedGap(part, { before, after });
        break;
      }
    }
  }

  private recordClippedGap(fragment: string, provenance: RenderProvenance): void {
    const entry = this.add(fragment);
    if (entry) this.indexContext(entry, fragment, provenance, "clipped");
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

  private add(value: Scalar, evidence?: Evidence, contextOnly = evidence === undefined): ValueEntry | undefined {
    this.revision++;
    let entry = this.values.get(value);
    if (entry) {
      if (!evidence) {
        this.workerState?.dirty.add(value);
        return entry;
      }
      const previous = entry.fields.get(evidence.key);
      if (preferEvidence(previous, evidence)) {
        if (!previous) {
          const cost = evidence.key.length + 20;
          if (!this.reserve(cost, entry.kind)) return undefined;
          entry.cost += cost;
        }
        entry.fields.set(evidence.key, evidence);
      }
      if (previous && (previous.kind !== evidence.kind || previous.leastSensitiveFieldKind)) {
        const bound = entry.fields.get(evidence.key)!;
        const lower = lessSensitiveKind(previous.leastSensitiveFieldKind ?? previous.kind, evidence.kind);
        entry.fields.set(evidence.key, { ...bound, leastSensitiveFieldKind: lower });
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
    const cost = scalarText.length + (evidence?.key.length ?? 0) + 48;
    const kind = evidence?.kind ?? "credential";
    if (!this.reserve(cost, kind)) return;
    entry = { kind, best: evidence, fields: new Map(evidence ? [[evidence.key, evidence]] : []), patterns: [], cost };
    this.values.set(value, entry);
    this.byClass.get(kind)!.add(value);

    if (evidence && !contextOnly) this.indexValue(entry, value, evidence);
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
    if (mode === "field" && entry.kind === "credential" && typeof value === "string" &&
        value.length <= 22 && [...value].length < 12 && !entry.patterns.some(pattern => pattern.mode === "replay")) {
      const escaped = JSON.stringify(value).slice(1, -1);
      for (const text of new Set([value, escaped, fenceEscapes(value), fenceEscapes(escaped)])) {
        this.index(entry, text, "replay");
      }
    }
    if (!entry.folded && typeof value === "string" && evidence.kind === "identity" &&
        /^(?:userdisplayname|userprincipalname|username|userid|givenname|surname|displayname|mail)$/.test(evidence.key) &&
        !/^(?:the|and|windows|default|administrator|admin|unknown|none|true|false)$/i.test(value) &&
        [...value].length >= 3 && /\p{L}/u.test(value)) {
      this.index(entry, foldIdentity(value), "folded");
      entry.folded = true;
    }
  }

  private indexContext(entry: ValueEntry, text: string, provenance: RenderProvenance, mode: "context" | "clipped" = "context"): void {
    const key = mode === "clipped" && !provenance.before && !provenance.after ? provenance.key?.toLowerCase() : undefined;
    if (key) text = JSON.stringify(text);
    const escape = (value: string) => JSON.stringify(value).slice(1, -1);
    for (const encode of [(value: string) => value, fenceEscapes, escape, (value: string) => fenceEscapes(escape(value))]) {
      const value = encode(text);
      const before = encode(provenance.before ?? "");
      const after = encode(provenance.after ?? "");
      if (entry.patterns.some(pattern => pattern.mode === mode && pattern.text === value && pattern.key === key &&
          (pattern.before ?? "") === before && (pattern.after ?? "") === after)) continue;
      const cost = before.length + after.length + (key?.length ?? 0) + 24;
      if (!this.reserve(cost, entry.kind)) return;
      entry.cost += cost;
      this.index(entry, value, mode, { before, after, key });
    }
  }

  private index(entry: ValueEntry, text: string, mode: MatchMode, provenance?: RenderProvenance): void {
    if (!text || entry.patterns.some(pattern => pattern.text === text && pattern.mode === mode &&
      pattern.before === provenance?.before && pattern.after === provenance?.after && pattern.key === provenance?.key)) return;
    if (mode === "replay") this.hasShortReplayValues = true;
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
      ...(provenance?.key ? { key: provenance.key } : {}),
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
        if (mode === "replay") this.hasShortReplayValues = true;
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
    boundary: ReturnType<typeof wordBoundaries>,
    fieldAt?: (start: number, end: number) => string | undefined,
    replayAt?: (span: TextSpan, evidence: Evidence) => void,
    clippedAt?: (start: number, end: number) => void,
    fieldEvidence?: (span: TextSpan, best: Evidence, bound?: Evidence) => void,
    replayOnly = false,
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
          for (const { text: value, offset, mode, entry, before, after, key } of bucket) {
            if (mode === "replay" ? !replayAt : replayOnly) continue;
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
            if ((mode === "word" || mode === "folded" || mode === "replay") && (!boundary(start, -1) || !boundary(end, 1))) continue;
            if ((mode === "context" || mode === "clipped") && (before && (start < before.length || !text.startsWith(before, start - before.length)) ||
                after && !text.startsWith(after, end))) continue;
            if (mode === "clipped") {
              if (key && fieldAt?.(start, end) !== key) continue;
              const quoteWidth = key ? value.startsWith('\\"') ? 2 : 1 : 0;
              clippedAt?.(start + quoteWidth, end - quoteWidth);
              continue;
            }
            if (mode === "replay") {
              if (entry.best) replayAt?.({ start, end }, entry.best);
              continue;
            }
            const field = mode === "field" ? fieldAt?.(start, end) : undefined;
            const evidence = mode === "field" ? (field === undefined ? undefined : entry.fields.get(field)) : entry.best;
            if (evidence || field !== undefined && entry.best) {
              // String quotes are syntax, separate from the value to be masked.
              const quoteWidth = mode === "field" ? value.startsWith('\\"') ? 2 : value.startsWith('"') ? 1 : 0 : 0;
              const span = { start: start + quoteWidth, end: end - quoteWidth };
              if (field !== undefined && entry.best) fieldEvidence?.(span, entry.best, evidence);
              else if (evidence) emit(span, evidence, mode === "context");
            }
          }
        }
      }
    }
    return true;
  }

  private scanState(): ScanState {
    const retained = [this, ...(this.transient ? [this.transient] : []), ...this.prior].filter(ledger => !ledger.disposed);
    const historyFences = new Map<string, { length: number; replays: ReplayRange[] }>();
    for (const [nonce, { length, replays }] of this.historyFences) {
      historyFences.set(nonce, { length, replays: replays.map(({ start, end, ledger, hostSerialization }) => ({
        start, end, hostSerialization, incomplete: !ledger || ledger.replayEvidenceIncomplete,
      })) });
    }
    return { retained, historyFences, promptReplay: this.promptReplay,
      dropped: this.dropped + (this.transient?.dropped ?? 0),
      registrations: this.pendingRegistrations + this.pendingRenderings.length +
        this.incompleteRegistrations + (this.transient?.incompleteRegistrations ?? 0),
      incomplete: this.disposed || this.identityIndex?.isComplete?.() === false,
      identityIndex: this.disposed ? undefined : this.identityIndex,
    };
  }

  classifyRequest(request: RequestText): RequestClassification {
    const evidence = this.captureEvidence();
    return this.scanRequest(request, this.renderedState(evidence, request));
  }

  captureEvidence(): EvidenceSnapshot {
    const state = this.scanState();
    state.scriptText = scriptText.getStore();
    if (state.scriptText) state.scriptReadClass = this.unresolvedScriptReads ? "credential" : this.scriptReadClass;
    return { state, revisions: state.retained.map(ledger => ledger.revision),
      shards: [...state.identityIndex?.workerShards?.() ?? []], interpolations: templateInterpolations.getStore(),
      fencedRenderings: this.fencedRenderings };
  }

  private *renderedStateSteps({ state, interpolations, fencedRenderings }: EvidenceSnapshot, request: RequestText): Generator<void, ScanState> {
    if (!interpolations && !fencedRenderings.length) return state;
    const renderedSpans: ClassificationSpan[] = [];
    const renderedGaps: UnexaminedRange[] = [];
    let incomplete = state.incomplete;
    for (const section of ["system", "prompt"] as const) {
      const entries = [...interpolations?.[section] ?? []];
      if (section === "prompt") for (const { fence, start, trace } of fencedRenderings) {
        // Bound the byte comparison and the allocations in the trace.
        const matched = fence.length <= 128_000 && request.prompt.startsWith(fence, start);
        const bodyStart = start + fence.indexOf("\n") + 1;
        const bodyEnd = start + fence.lastIndexOf("\n");
        if (matched) entries.push({ start: bodyStart, end: bodyEnd, key: "",
          trace: () => trace(request.prompt.slice(bodyStart, bodyEnd), bodyStart, state.identityIndex) });
        else if (request.prompt.startsWith(fence.slice(0, fence.indexOf("\n") + 1), start)) {
          entries.push({ start: bodyStart, end: bodyEnd, key: "", incomplete: true });
        }
      }
      if (!entries.length) continue;
      let remaining = MAX_TEMPLATE_INTERPOLATIONS;
      let traceWork = 8 * MAX_TEMPLATE_INTERPOLATIONS;
      const gap = ({ start, end }: TextSpan) => {
        incomplete = true;
        if (start < end) renderedGaps.push({ section, start, end, reason: "rendered-provenance-unavailable" });
      };
      const collect = ({ start, end, key, value, classification, requireEvidence, incomplete: missing }: TemplateInterpolation) => {
        if (missing) gap({ start, end });
        if (start >= end) return;
        if (classification) {
          renderedSpans.push({ section, start, end, ...classification });
          return;
        }
        if (value === undefined) return;
        let best: Evidence | undefined;
        for (const ledger of state.retained) {
          const entry = ledger.values.get(value);
          const candidate = entry?.fields.get(key) ?? entry?.fields.get("");
          if (candidate && preferEvidence(best, candidate)) best = candidate;
        }
        if (best) renderedSpans.push({ section, start, end, kind: best.kind, source: best.source,
          ...(best.maskRole ? { maskRole: best.maskRole } : {}) });
        else if (requireEvidence && (typeof value !== "string" || value.length > 32_768 || value.trim())) gap({ start, end });
      };
      sectionEntries: for (const entry of entries) {
        if (--remaining < 0) {
          gap(entry);
          break;
        }
        if (entry.incomplete && entry.trace) gap(entry);
        if (!entry.trace) {
          collect(entry);
          yield;
          continue;
        }
        const trace = entry.trace();
        for (;;) {
          if (--traceWork < 0) {
            gap(entry);
            break sectionEntries;
          }
          const next = trace.next();
          if (next.done) {
            if (!next.value) gap(entry);
            break;
          }
          if (next.value) {
            if (--remaining < 0) {
              gap(entry);
              break sectionEntries;
            }
            collect(next.value);
          }
          yield;
        }
      }
    }
    return { ...state, renderedSpans, renderedGaps, incomplete };
  }

  private renderedState(evidence: EvidenceSnapshot, request: RequestText): ScanState {
    const steps = this.renderedStateSteps(evidence, request);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  }

  private async renderedStateInSlices(evidence: EvidenceSnapshot, request: RequestText, slice: ClassificationSlice): Promise<ScanState> {
    const steps = this.renderedStateSteps(evidence, request);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      if (slice.elapsed) await slice.yield();
    }
  }

  private evidenceCurrent({ state, revisions, shards }: EvidenceSnapshot, latest: ScanState): boolean {
    const currentShards = [...latest.identityIndex?.workerShards?.() ?? []];
    return state.retained.length === latest.retained.length && state.retained.every((ledger, index) =>
      ledger === latest.retained[index] && ledger.revision === revisions[index]) &&
      currentShards.length === shards.length && shards.every((shard, index) => shard === currentShards[index]);
  }

  private withCurrentCoverage(result: RequestClassification, evidence: EvidenceSnapshot): RequestClassification {
    const latest = this.scanState();
    const { state } = evidence;
    const droppedValues = Math.max(result.droppedValues, latest.dropped);
    const registrations = Math.max(result.unexamined.registrations, latest.registrations);
    if (this.evidenceCurrent(evidence, latest) && !state.incomplete && !latest.incomplete &&
        droppedValues === result.droppedValues && registrations === result.unexamined.registrations) return result;
    return { ...result, droppedValues, coverageIncomplete: true, effectiveClass: "credential",
      unexamined: { ...result.unexamined, registrations, values: droppedValues } };
  }

  async classifyProviderRequest(request: RequestText & Pick<LlmOptions, "signal">, evidence = this.captureEvidence(), reservation?: ClassificationReservation): Promise<RequestClassification> {
    const length = (request.system?.length ?? 0) + request.prompt.length;
    const ledgerUnits = (ledger: ClassificationLedger) => ledger.disposed ? 0 : VALUE_BUDGET - ledger.remaining;
    const retainedUnits = ledgerUnits(this) + (this.transient ? ledgerUnits(this.transient) : 0) +
      this.prior.reduce((sum, ledger) => sum + ledgerUnits(ledger), 0);
    // No arbitrary-sized lookup or folding work enters the main-thread path.
    if (length <= MAIN_SCAN_LIMIT && retainedUnits <= 4_096 && !this.identityIndex?.workerShards) {
      const slice = new ClassificationSlice(request.signal);
      const result = this.scanRequest(request, await this.renderedStateInSlices(evidence, request, slice));
      if (slice.elapsed) await slice.yield();
      return this.withCurrentCoverage(result, evidence);
    }
    return this.classifyLargeRequest(request, request.signal, evidence, reservation);
  }

  private async syncLedger(client: ClassificationWorker, slice: ClassificationSlice): Promise<number | undefined> {
    if (this.disposed) return undefined;
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

  async classifyLargeRequest(request: RequestText, signal?: AbortSignal, evidence = this.captureEvidence(), reservation?: ClassificationReservation): Promise<RequestClassification> {
    const wasDisposed = this.disposed;
    let indexCurrent = () => true;
    const bytes = 128 + 2 * ((request.system?.length ?? 0) + request.prompt.length);
    const result = await requestWorker().run<"scan">(bytes, async client => {
      const slice = new ClassificationSlice(signal);
      const sections = { system: await encodeSection(request.system, slice), prompt: await encodeSection(request.prompt, slice) };
      const transfers = Object.values(sections).flatMap(section => section ? [section.buffer] : []);
      const { retained, identityIndex, ...state } = await this.renderedStateInSlices(evidence, request, slice);
      const ledgers: number[] = [];
      for (const ledger of retained) {
        const id = await ledger.syncLedger(client, slice);
        if (id !== undefined && !ledger.disposed) ledgers.push(id);
      }
      const { shards, isCurrent } = await syncIdentityShards(client, identityIndex, slice);
      indexCurrent = isCurrent;
      // Resample expiry after asynchronous synchronization. Disposed mirrors
      // have already been dropped; history will mark their replay ranges.
      const latest = this.scanState();
      return {
        message: { type: "scan", sections, ledgers, shards, state: {
          ...state, historyFences: latest.historyFences,
          dropped: Math.max(state.dropped, latest.dropped),
          registrations: Math.max(state.registrations, latest.registrations),
          incomplete: state.incomplete || latest.incomplete || !indexCurrent() || !this.evidenceCurrent(evidence, latest),
        } },
        transfers,
      };
    }, signal, reservation);
    await yieldClassificationTurn(signal);
    const classification = await unpackWorkerResult(result, signal);
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
      const provenRanges = new Set<string>();
      const matchedFields = new Map<string, TextSpan & { best: Evidence; bound?: Evidence; leastSensitive?: DataClass }>();
      const work = { remaining: MATCH_BUDGET };
      let fields: ReturnType<typeof jsonFields> | undefined;
      const fieldAt = (start: number, end: number) => {
        const field = (fields ??= jsonFields(text)).get(start);
        return field?.end === end ? field.key : undefined;
      };
      const collect = ({ start, end }: TextSpan, evidence: Evidence, authoritative = false, fieldBacked = false) => {
        const { kind, source, maskRole } = evidence;
        const key = `${start}:${end}`;
        if (authoritative && !fieldBacked) provenRanges.add(key);
        const previous = found.get(key);
        // A bare GUID can identify a device or a policy. Use typed
        // provenance for that syntax when available.
        if (source === "detector:identifier" && (provenRanges.has(key) || matchedFields.get(key)?.bound)) return;
        const higher = previous && previous.kind !== kind && maxDataClass(previous.kind, kind) === kind;
        const sameWithBetterEvidence = previous?.kind === kind && (
          authoritative && !previous.authoritative ||
          (authoritative || !previous.authoritative) && Boolean(maskRole) &&
            (!previous.maskRole || previous.maskRole === "setting" && maskRole === "nameOrIdentifier")
        );
        if (!previous || higher || sameWithBetterEvidence) {
          found.set(key, { section, start, end, kind, source, ...(maskRole ? { maskRole } : {}), ...(authoritative ? { authoritative } : {}) });
        }
      };
      const collectCandidate = (span: TextSpan, best: Evidence, bound?: Evidence) => {
        const key = `${span.start}:${span.end}`;
        const match = matchedFields.get(key) ?? { ...span, best };
        if (preferEvidence(match.best, best)) match.best = best;
        if (bound) {
          if (preferEvidence(match.bound, bound)) match.bound = bound;
          match.leastSensitive = lessSensitiveKind(match.leastSensitive, bound.leastSensitiveFieldKind ?? bound.kind);
        }
        matchedFields.set(key, match);
      };
      for (const gap of state.renderedGaps ?? []) {
        if (gap.section === section && gap.start < text.length) {
          ranges.push({ ...gap, end: Math.min(gap.end, text.length) });
        }
      }
      for (const span of state.renderedSpans ?? []) {
        if (span.section === section && span.end <= text.length) collect(span, { ...span, key: "" }, true);
      }
      if (section === "prompt" && state.promptReplay) {
        const { start, end } = state.promptReplay;
        if (start < text.length && start < end) {
          ranges.push({ section, start, end: Math.min(end, text.length), reason: "history-evidence-unavailable" });
        }
      }
      const preservedReplays: Array<TextSpan & { hostSerialization?: true }> = [];
      if (historyFences.size || retained.some(ledger => ledger.fences.size)) {
        for (const marker of text.matchAll(/<tenant_data [^<>\n]* nonce="([0-9a-f]{16})">/g)) {
          const start = marker.index + marker[0].length + 1;
          if (text[start - 1] !== "\n") continue;
          const history = historyFences.get(marker[1]!);
          const close = '\n</tenant_data nonce="' + marker[1] + '">';
          if (history && original.startsWith(close, start + history.length)) {
            for (const replay of history.replays) {
              const end = Math.min(text.length, start + replay.end);
              const replayStart = start + replay.start;
              if (replayStart >= end) continue;
              if (replay.incomplete) {
                ranges.push({ section, start: replayStart, end, reason: "history-evidence-unavailable" });
              } else {
                preservedReplays.push({ start: replayStart, end, hostSerialization: replay.hostSerialization });
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
      const ambiguous = new Map<string, TextSpan>();
      const clipped = new Map<string, TextSpan>();
      const scriptRange = state.scriptText?.[section];
      if (state.scriptReadClass && scriptRange && scriptRange.start < scriptRange.end) {
        ranges.push({ section, ...scriptRange, reason: "script-provenance-unavailable" });
      }
      const replayAt = preservedReplays.length ? (span: TextSpan, evidence: Evidence) => {
        if (preservedReplays.some(replay => replay.start <= span.start && span.end <= replay.end)) {
          ambiguous.set(`${span.start}:${span.end}`, span);
          collectCandidate(span, evidence);
        }
      } : undefined;
      const folded = foldedIndex ? foldIdentity(text) : undefined;
      const boundary = wordBoundaries(text);
      for (let from = 0; from < text.length; from += TEXT_CHUNK) {
        const to = Math.min(text.length, from + TEXT_CHUNK);
        if (!this.scan(rawIndex, text, from, to, work, collect, boundary, fieldAt, replayAt,
            (start, end) => clipped.set(`${start}:${end}`, { start, end }), collectCandidate) ||
            foldedIndex && folded !== undefined && !this.scan(foldedIndex, folded, from, to, work, collect, boundary)) {
          // The section-wide detector pass has not examined any of this text.
          ranges.push({ section, start: 0, end: text.length, reason: "match-limit" });
          break;
        }
      }
      // A retained turn may quote JSON, a fenced value, or serialized JSON
      // inside another string. Decoding can recover a match, but it cannot
      // establish that the replay used the original field or rendering.
      let decodeBudget = MAX_REPLAY_DECODE_UNITS;
      for (const replay of preservedReplays) {
        if (!retained.some(ledger => ledger.hasShortReplayValues)) break;
        let reported = false;
        const unavailable = () => {
          if (!reported) ranges.push({ section, start: replay.start, end: replay.end, reason: "history-provenance-unavailable" });
          reported = true;
        };
        if (replay.end - replay.start > decodeBudget || work.remaining < 0) {
          unavailable();
          continue;
        }
        let decoded = text.slice(replay.start, replay.end);
        let toOriginal = (offset: number) => replay.start + offset;
        const maxLayers = MAX_REPLAY_DECODE_LAYERS + Number(replay.hostSerialization === true);
        for (let depth = 0; depth <= maxLayers; depth++) {
          if (!decoded.includes("\\")) break;
          decodeBudget -= decoded.length;
          if (decodeBudget < 0) {
            unavailable();
            break;
          }
          const layer = decodeReplayLayer(decoded, toOriginal);
          if (!layer) break;
          if (depth === 0 && layer.uncertain || depth === maxLayers && layer.changed) {
            unavailable();
            if (depth === maxLayers) break;
          }
          if (!layer.changed) break;
          ({ text: decoded, toOriginal } = layer);
          if (!this.scan(rawIndex, decoded, 0, decoded.length, work, collect, wordBoundaries(decoded), undefined,
            ({ start, end }, evidence) => replayAt?.({ start: toOriginal(start), end: toOriginal(end) }, evidence),
            undefined, undefined, true)) {
            unavailable();
            break;
          }
        }
      }
      const competing = new Map<string, TextSpan>();
      for (const [key, { start, end, best, bound, leastSensitive }] of matchedFields) {
        const proven = provenRanges.has(key);
        if (!bound && !proven) continue;
        const span = { start, end };
        const match = found.get(key);
        const highest = match ? maxDataClass(match.kind, best.kind) : best.kind;
        if (bound && !proven && highest !== leastSensitive &&
            !(state.scriptReadClass && scriptRange && scriptRange.start <= start && end <= scriptRange.end)) {
          competing.set(key, span);
        }
        if (bound) collect(span, bound, true, true);
        if (!bound || best.kind !== bound.kind) collect(span, best);
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
      for (const [key, span] of ambiguous) {
        if (found.get(key)?.kind !== "credential") ranges.push({ section, ...span, reason: "history-provenance-unavailable" });
      }
      for (const [matches, reason] of [[competing, "competing-provenance"],
        [clipped, "clipped-provenance-unavailable"]] as const) {
        let reported = 0;
        let overflow: UnexaminedRange | undefined;
        for (const span of matches.values()) {
          if (++reported <= 256) ranges.push({ section, ...span, reason });
          else if (!overflow) overflow = { section, ...span, reason };
          else {
            overflow.start = Math.min(overflow.start, span.start);
            overflow.end = Math.max(overflow.end, span.end);
          }
        }
        if (overflow) ranges.push(overflow);
      }
      const ordered = [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      for (const { authoritative: _, ...span } of ordered) spans.push(span);
    }
    return classification(spans, ranges, retained.reduce((sum, ledger) => sum + ledger.values.size, 0),
      state.dropped, state.registrations, state.incomplete, state.scriptReadClass);
  }
}

export async function clearTenantClassificationLedgers(tenantId: string): Promise<void> {
  const ledgers = [...tenantLedgers.get(tenantId) ?? []];
  for (const ledger of ledgers) ledger.dispose();
  await Promise.all(ledgers.map(ledger => ledger.waitForObservations()));
}

const scopes = new AsyncLocalStorage<ClassificationLedger>();
const scriptText = new AsyncLocalStorage<ScanState["scriptText"]>();

/** Keep script offsets outside the provider options and exclude host-added text. */
export function withScriptText<T>(prompt: string, systemLength: number | undefined, work: () => T): T {
  return scriptText.run({
    prompt: { start: prompt.indexOf("\n") + 1, end: prompt.lastIndexOf("\n") },
    ...(systemLength === undefined ? {} : { system: { start: 0, end: systemLength } }),
  }, work);
}
let unscopedRegistrations = 0;
let unscopedRequests = 0;
let requestSequence = 0;

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
    void ledger.waitForObservations().then(() => {
      signal?.removeEventListener("abort", dispose);
      dispose();
    });
  }
}

export function currentClassificationLedger(): ClassificationLedger | undefined {
  return scopes.getStore();
}

export function registerTenantData(source: string, data: unknown, options?: ClassificationOptions, context?: "script"): void {
  const ledger = scopes.getStore();
  if (ledger) ledger.registerIngress(source, data, options ?? {}, context);
  else unscopedRegistrations++;
}

export function registerGraphTenantData(graphPath: string, data: unknown, signal?: AbortSignal, context?: "script"): void {
  const ledger = scopes.getStore();
  if (ledger) void ledger.registerGraph(graphPath, data, signal, context);
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
  type EventMetadata = Omit<RequestClassificationEvent, "classification" | "failed">;
  const publish = (
    ledger: ClassificationLedger, metadata: EventMetadata, result: RequestClassification, failed: boolean,
  ) => {
    if (ledger.expired) return;
    try { observe({ ...metadata, failed, classification: result }, ledger.tenantIds); }
    catch { /* Development observers cannot change provider behavior. */ }
  };
  const failure = (systemLength: number, promptLength: number) => {
    const ranges: UnexaminedRange[] = [];
    if (systemLength) ranges.push({ section: "system", start: 0, end: systemLength, reason: "failure" });
    if (promptLength) ranges.push({ section: "prompt", start: 0, end: promptLength, reason: "failure" });
    return classification([], ranges, 0, 0, 0, true);
  };
  const recordUnavailable = (
    ledger: ClassificationLedger, metadata: EventMetadata, systemLength: number, promptLength: number,
  ) => templateInterpolations.exit(() =>
    ledger.observeMetadata(() => publish(ledger, metadata, failure(systemLength, promptLength), true)));

  const classify = (
    scoped: ClassificationLedger | undefined, method: RequestClassificationEvent["method"], options: LlmOptions, sequence: number,
  ) => {
    if (!llm.available) return;
    if (!scoped) unscopedRequests++;
    const ledger = scoped ?? new ClassificationLedger();
    if (ledger.expired) return;
    const { scopeId } = ledger;
    const metadata = { requestSequence: sequence, providerId, method, fieldMapVersion: GRAPH_FIELD_CLASSES_VERSION,
      timestamp: new Date().toISOString(), ...(scopeId ? { scopeId } : {}), scopePresent: scoped !== undefined };
    const { prompt, system } = options;
    const systemLength = system?.length ?? 0;
    const promptLength = prompt.length;
    const reservation = reserveClassificationRequest(128 + 2 * (systemLength + promptLength));
    if (!reservation) {
      recordUnavailable(ledger, metadata, systemLength, promptLength);
      return;
    }
    try {
      const evidence = ledger.captureEvidence();
      ledger.observeRequest(reservation, async scanSignal => {
        try {
          scanSignal.throwIfAborted();
          const result = await ledger.classifyProviderRequest({ prompt, system, signal: scanSignal }, evidence, reservation);
          publish(ledger, metadata, result, false);
        } catch {
          publish(ledger, metadata, failure(systemLength, promptLength), true);
        }
      });
    } catch {
      reservation.release();
      recordUnavailable(ledger, metadata, systemLength, promptLength);
    }
  };
  return {
    available: llm.available,
    defaultModel: llm.defaultModel,
    streamsIncrementally: llm.streamsIncrementally,
    async complete(options) {
      const ledger = scopes.getStore();
      const sequence = ++requestSequence;
      try { return llm.complete(options); }
      finally { classify(ledger, "complete", options, sequence); }
    },
    stream(options) {
      const ledger = scopes.getStore();
      return (async function* () {
        classify(ledger, "stream", options, ++requestSequence);
        yield* llm.stream(options);
      })();
    },
  };
}
