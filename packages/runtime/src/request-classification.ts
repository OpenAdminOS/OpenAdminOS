import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToMain } from "node:timers/promises";
import { DATA_CLASSES_BY_SENSITIVITY, maxDataClass, type DataClass, type DataClassCounts, type LlmOptions, type ProviderId, type RunLlmApi } from "@openadminos/agent-sdk";
import { emptyDataClassCounts, requestTextSpans, walkDataClasses, type ClassificationOptions, type TextSpan } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES_VERSION, type SecurityMaskRole } from "./graph-field-classes.js";

export interface ClassificationSpan extends TextSpan {
  section: "system" | "prompt";
  kind: DataClass;
  source: string;
  maskRole?: SecurityMaskRole;
}

interface UnexaminedRange extends TextSpan {
  section: ClassificationSpan["section"];
  reason: "text-limit" | "match-limit" | "failure";
}

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

const VALUE_BUDGET = 2_000_000;
export const REQUEST_CLASSIFICATION_MAX_SECTION = 16_000_000;
const TEXT_CHUNK = 128_000;
const DETECTOR_OVERLAP = 32_768;
const MATCH_BUDGET = 200_000;
const ANCHOR_WIDTH = 8;
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
  return "text";
}

function fieldEvidence(text: string, start: number, end: number, fields: ReadonlyMap<string, Evidence>): Evidence | undefined {
  // The value pattern includes quotes for strings. Accept a JSON property or the
  // same property serialized inside a JSON string. Bounded context avoids rescans.
  const left = /(?:^|[{,](?:\s|\\[nrt])*)\\?"([^"\\]{1,160})\\?"\s*:(?:\s|\\[nrt])*(?:\[(?:\s|\\[nrt])*)*$/
    .exec(text.slice(Math.max(0, start - 256), start));
  if (!left || !/^(?:\s|\\[nrt])*[,}\]]/.test(text.slice(end, end + 64))) return undefined;
  return fields.get(left[1]!.toLowerCase());
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

/** Memory-only plaintext evidence. Each ledger owns one turn or run. */
export class ClassificationLedger {
  private readonly values = new Map<Scalar, ValueEntry>();
  private readonly byClass = new Map(DATA_CLASSES_BY_SENSITIVITY.map(kind => [kind, new Set<Scalar>()]));
  private readonly anchors: Array<AnchorIndex | undefined> = [];
  private readonly foldedAnchors: Array<AnchorIndex | undefined> = [];
  private readonly fences = new Map<string, { value: Scalar; evidence: Evidence }>();
  private prior: readonly ClassificationLedger[] = [];
  private transient?: ClassificationLedger;
  private remaining = VALUE_BUDGET;
  private dropped = 0;
  private incompleteRegistrations = 0;
  private disposed = false;
  private expiry?: ReturnType<typeof setTimeout>;
  scopeId: string | undefined;

  constructor(private readonly identityIndex?: ClassificationOptions["identityIndex"], scopeId?: string) {
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
    this.prior = [];
    this.discardTransient();
  }

  /** A shallow reference to earlier turns. Each turn owns its own budget and expiry. */
  include(previous: ClassificationLedger): void {
    if (previous !== this && !this.prior.includes(previous)) this.prior = [...this.prior, previous];
  }

  releaseHistory(): void { this.prior = []; }

  discardTransient(): void {
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
      this.registerClassified(source, collectClassifiedValues(data, { ...options, ...(identityIndex ? { identityIndex } : {}) }));
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
        owner.fences.set(provenance.fence, { value: original, evidence: best });
      }
    } else if (provenance.before || provenance.after) {
      const entry = owner.add(fragment, best, true);
      if (!entry) return;
      owner.indexContext(entry, String(fragment), provenance);
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
      return entry;
    }
    const scalarText = String(value);
    const cost = scalarText.length + evidence.key.length + 48;
    if (!this.reserve(cost, evidence.kind)) return;
    entry = { kind: evidence.kind, best: evidence, fields: new Map([[evidence.key, evidence]]), patterns: [], cost };
    this.values.set(value, entry);
    this.byClass.get(evidence.kind)!.add(value);

    if (!contextOnly) this.indexValue(entry, value, evidence);
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

  private scan(
    anchors: ClassificationLedger["anchors"], text: string, from: number, to: number, work: { remaining: number },
    emit: (span: TextSpan, evidence: Evidence, authoritative?: boolean) => void,
  ): boolean {
    for (let width = 1; width < anchors.length; width++) {
      const prefixes = anchors[width];
      if (!prefixes?.size) continue;
      for (let at = from; at < to && at + width <= text.length; at++) {
        // Most offsets cannot start an anchor. Avoid substring allocation
        // and hashing unless the index contains that first code unit.
        const buckets = prefixes.get(text.charCodeAt(at));
        if (!buckets) continue;
        const bucket = buckets.get(text.slice(at, at + width));
        if (!bucket) continue;
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
          const evidence = mode === "field" ? fieldEvidence(text, start, end, entry.fields) : entry.best;
          if (evidence) {
            // String quotes are syntax, separate from the value to be masked.
            const quoteWidth = mode === "field" ? value.startsWith('\\"') ? 2 : value.startsWith('"') ? 1 : 0 : 0;
            emit({ start: start + quoteWidth, end: end - quoteWidth }, evidence, mode === "field" || mode === "context");
          }
        }
      }
    }
    return true;
  }

  classifyRequest(request: Pick<LlmOptions, "system" | "prompt">): RequestClassification {
    const chunks = this.classifyRequestChunks(request);
    for (let result = chunks.next(); ; result = chunks.next()) if (result.done) return result.value;
  }

  async classifyLargeRequest(request: Pick<LlmOptions, "system" | "prompt">): Promise<RequestClassification> {
    const chunks = this.classifyRequestChunks(request);
    for (let result = chunks.next(); ; result = chunks.next()) {
      if (result.done) return result.value;
      await yieldToMain();
    }
  }

  private *classifyRequestChunks(request: Pick<LlmOptions, "system" | "prompt">): Generator<void, RequestClassification> {
    const spans: ClassificationSpan[] = [];
    const ranges: UnexaminedRange[] = [];
    const retained = [this, ...(this.transient ? [this.transient] : []), ...this.prior].filter(ledger => !ledger.disposed);
    for (const section of ["system", "prompt"] as const) {
      const original = request[section];
      if (!original) continue;
      const text = original.slice(0, REQUEST_CLASSIFICATION_MAX_SECTION);
      if (text.length < original.length) ranges.push({ section, start: text.length, end: original.length, reason: "text-limit" });
      const found = new Map<string, ClassificationSpan & { authoritative?: boolean }>();
      const work = { remaining: MATCH_BUDGET };
      const collect = ({ start, end }: TextSpan, evidence: Evidence, authoritative = false) => {
        const { kind, source, maskRole } = evidence;
        const key = `${start}:${end}`;
        const previous = found.get(key);
        // Typed provenance distinguishes, for example, a security policy id from an arbitrary GUID.
        if (!previous || !previous.authoritative && authoritative && kind !== "credential" && previous.kind !== "credential" ||
            (authoritative || !previous.authoritative || kind === "credential") &&
            (previous.kind !== kind ? maxDataClass(previous.kind, kind) === kind :
              Boolean(maskRole) && (!previous.maskRole || maskRole === "nameOrIdentifier"))) {
          found.set(key, { section, start, end, kind, source, ...(maskRole ? { maskRole } : {}), ...(authoritative ? { authoritative } : {}) });
        }
      };
      if (retained.some(ledger => ledger.fences.size)) {
        for (const marker of text.matchAll(/<tenant_data [^<>\n]* nonce="([0-9a-f]{16})">/g)) {
          const start = marker.index + marker[0].length + 1;
          if (text[start - 1] !== "\n") continue;
          for (const ledger of retained) {
            const entry = ledger.fences.get(marker[1]!);
            if (!entry) continue;
            const body = fenceEscapes(String(entry.value));
            const end = start + body.length;
            if (text.startsWith(body, start) && text.startsWith(`\n</tenant_data nonce="${marker[1]}">`, end)) {
              collect({ start, end }, entry.evidence, true);
            }
          }
        }
      }
      const folded = retained.some(ledger => ledger.foldedAnchors.length) ? foldIdentity(text) : undefined;
      for (let from = 0; from < text.length; from += TEXT_CHUNK) {
        if (from > 0) yield;
        const to = Math.min(text.length, from + TEXT_CHUNK);
        if (retained.some(ledger => !ledger.scan(ledger.anchors, text, from, to, work, collect) ||
            folded !== undefined && !ledger.scan(ledger.foldedAnchors, folded, from, to, work, collect))) {
          ranges.push({ section, start: from, end: text.length, reason: "match-limit" });
          break;
        }
        // Keep original offsets and look across chunk edges for bounded detectors.
        const begin = Math.max(0, from - DETECTOR_OVERLAP);
        const end = Math.min(text.length, to + DETECTOR_OVERLAP);
        for (const match of requestTextSpans(text.slice(begin, end), this.disposed ? undefined : this.identityIndex)) {
          const start = match.start + begin;
          if (start < from || start >= to) continue;
          if (--work.remaining < 0) break;
          collect({ start, end: match.end + begin }, { kind: match.kind, source: match.source, key: "" });
        }
        if (work.remaining < 0) {
          ranges.push({ section, start: from, end: text.length, reason: "match-limit" });
          break;
        }
      }
      const ordered = [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      for (const { authoritative: _, ...span } of ordered) spans.push(span);
    }
    return classification(spans, ranges, retained.reduce((sum, ledger) => sum + ledger.values.size, 0),
      this.dropped + (this.transient?.dropped ?? 0), this.incompleteRegistrations + (this.transient?.incompleteRegistrations ?? 0),
      this.disposed || this.identityIndex?.isComplete?.() === false);
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

export async function withTransientClassificationScope<T>(ledger: ClassificationLedger, work: () => Promise<T>): Promise<T> {
  ledger.expireAfter();
  try { return await withClassificationScope(ledger, work); }
  finally { ledger.dispose(); }
}

export function currentClassificationLedger(): ClassificationLedger | undefined {
  return scopes.getStore();
}

export function registerTenantData(source: string, data: unknown, options?: ClassificationOptions): void {
  const ledger = scopes.getStore();
  if (ledger) ledger.register(source, data, options);
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
  observe: (event: RequestClassificationEvent) => void,
): RunLlmApi {
  const classify = async (ledger: ClassificationLedger | undefined, method: RequestClassificationEvent["method"], request: LlmOptions) => {
    if (!llm.available) return;
    if (!ledger) unscopedRequests++;
    let result: RequestClassification;
    let failed = false;
    try {
      const active = ledger ?? new ClassificationLedger();
      result = Math.max(request.system?.length ?? 0, request.prompt.length) > TEXT_CHUNK
        ? await active.classifyLargeRequest(request) : active.classifyRequest(request);
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
        failed, classification: result });
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
