import { isCommonWord, isGenericTokens, normalizeTokens } from "./tenant-token-normalization.js";

export type TenantValueKind = "identifier" | "name" | "label";

/**
 * Whether a display name or label value can identify something. One that
 * is only numbers and stopwords cannot; a label of only common words
 * cannot. A single-word display name is indexed when it has 3 or more
 * characters and is not a common word, so "Anna" is and "Platform" is not.
 * A single-word label must contain a digit or hyphen, or have 6 or more
 * characters and not be a common word.
 */
function isDistinctiveValue(value: string, tokens: readonly string[], kind: "name" | "label"): boolean {
  if (isGenericTokens(tokens)) return false;
  if (kind === "label" && tokens.every((token) => /^\p{N}+$/u.test(token) || isCommonWord(token))) return false;
  if (tokens.length > 1) return true;
  const token = tokens[0]!;
  if (kind === "name") return token.length >= 3 && !isCommonWord(token);
  return /[\p{N}-]/u.test(value) || (token.length >= 6 && !isCommonWord(token));
}

/** Identifier values this long are also matched with separators removed. */
const COMPACT_IDENTIFIER_MIN = 8;

/**
 * Token sequence matcher. Values and queries are normalized the same way
 * (see normalizeTokens). A value matches when its token sequence appears
 * as a contiguous token sequence in the query, so "Mark" never matches
 * "marketplace" and "HR-LAPTOP-07" matches "hr laptop 07". Mostly numeric
 * values (phone numbers, IMEI, serials) also match with separators
 * removed: their digits are indexed as one token, and runs of numeric
 * tokens in the query are joined the same way. Sequences are bucketed by
 * their first token: a query is scanned once and, at each token, compared
 * using direct lookups of the known sequence lengths for that token. The
 * value count does not increase the number of lookups per token.
 * Identifiers of 8 or more characters (MAC addresses, serials) are also
 * kept with separators removed and matched against every run of
 * consecutive query tokens joined, so "A1B2C3 D4E5F6" matches
 * "A1:B2:C3:D4:E5:F6".
 */
export type TenantMatchEntry = readonly ["sequence" | "compact", string];

export interface TenantValueIndexSnapshot {
  longestSequence: Map<string, number>;
  buckets: Map<string, Set<string>>;
  compact: Set<string>;
  compactPrefixes: Set<string>;
  compactMaxLength: number;
  count: number;
}

export class TenantValueIndex {
  private readonly longestSequence = new Map<string, number>();
  private readonly buckets = new Map<string, Set<string>>();
  private readonly compact = new Set<string>();
  private readonly compactPrefixes = new Set<string>();
  private compactMaxLength = 0;
  private count = 0;

  constructor(private readonly parts: readonly TenantValueIndex[] = []) {}

  static fromWorkerSnapshot(snapshot: TenantValueIndexSnapshot): TenantValueIndex {
    return Object.assign(new TenantValueIndex(), snapshot);
  }

  workerSnapshot(): TenantValueIndexSnapshot {
    return {
      longestSequence: this.longestSequence, buckets: this.buckets, compact: this.compact,
      compactPrefixes: this.compactPrefixes, compactMaxLength: this.compactMaxLength, count: this.count,
    };
  }

  get size(): number {
    return this.parts.reduce((count, part) => count + part.size, this.count);
  }

  add(value: unknown, kind: TenantValueKind = "identifier"): void {
    if (typeof value !== "string") return;
    const tokens = normalizeTokens(value);
    if (tokens.length === 0 || tokens.join(" ").length < 3) return;
    if (kind !== "identifier" && !isDistinctiveValue(value, tokens, kind)) return;
    this.insert(tokens);
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 6 && digits.length * 2 > value.replace(/\s/g, "").length) this.insert([digits]);
    const compact = tokens.join("");
    if (kind === "identifier" && compact.length >= COMPACT_IDENTIFIER_MIN) {
      this.insertCompact(compact);
    }
  }

  addAll(values: Iterable<unknown>, kind: TenantValueKind = "identifier"): void {
    for (const value of values) this.add(value, kind);
  }

  /** Normalized values, for storage; adding them again yields the same index or a stricter one. */
  values(): string[] {
    return [...new Set([...this.buckets.values()].flatMap(bucket => [...bucket.keys()]).concat(this.parts.flatMap(part => part.values())))];
  }

  /** Worker snapshots ship normalized matcher entries in small batches. */
  *workerEntries(): Iterable<TenantMatchEntry> {
    for (const bucket of this.buckets.values()) {
      for (const value of bucket) yield ["sequence", value];
    }
    for (const value of this.compact) yield ["compact", value];
  }

  addWorkerEntry([kind, value]: TenantMatchEntry): void {
    if (kind === "sequence") this.insert(value.split(" "));
    else this.insertCompact(value);
  }

  private insertCompact(value: string): void {
    this.compact.add(value);
    for (let length = 1; length <= 4; length++) this.compactPrefixes.add(value.slice(0, length));
    this.compactMaxLength = Math.max(this.compactMaxLength, value.length);
  }

  /** Whether any indexed value appears as a token sequence in the text. */
  matches(text: string): boolean {
    const tokens = normalizeTokens(text);
    const numeric = joinNumericRuns(tokens);
    return this.matchesNormalized(tokens, numeric);
  }

  private matchesNormalized(tokens: readonly string[], numeric: readonly string[]): boolean {
    return this.matchesTokens(tokens) || this.matchesTokens(numeric) || this.matchesCompact(tokens) ||
      this.parts.some(part => part.matchesNormalized(tokens, numeric));
  }

  /** Source offsets for policy classification. Egress keeps its existing matcher. */
  static *spansFor(text: string, indexes: Iterable<TenantValueIndex>): IterableIterator<{ start: number; end: number }> {
    let tokens: IndexedToken[] | undefined;
    for (const index of indexes) {
      if (!index.count) continue;
      tokens ??= toIndexedTokens(text);
      yield* index.tokenSpans(tokens);
    }
  }

  private *tokenSpans(tokens: readonly IndexedToken[]): IterableIterator<{ start: number; end: number }> {
    for (let first = 0; first < tokens.length; first++) {
      const start = tokens[first]!;
      const bucket = this.buckets.get(start.token);
      if (bucket) {
        let sequence = "";
        const limit = Math.min(tokens.length, first + (this.longestSequence.get(start.token) ?? 0));
        for (let last = first; last < limit; last++) {
          sequence += (last === first ? "" : " ") + tokens[last]!.token;
          if (bucket.has(sequence)) yield { start: start.start, end: tokens[last]!.end };
        }
      }
      if (!this.compactPrefixes.has(start.token.slice(0, 4))) continue;
      let joined = "";
      for (let last = first; last < tokens.length; last++) {
        const end = tokens[last]!;
        joined += end.token;
        if (joined.length > this.compactMaxLength) break;
        if (this.compact.has(joined)) yield { start: start.start, end: end.end };
      }
    }
  }

  private matchesCompact(tokens: readonly string[]): boolean {
    if (this.compact.size === 0) return false;
    for (let start = 0; start < tokens.length; start += 1) {
      let joined = "";
      for (let end = start; end < tokens.length; end += 1) {
        joined += tokens[end]!;
        if (joined.length > this.compactMaxLength) break;
        if (this.compact.has(joined)) return true;
      }
    }
    return false;
  }

  private insert(tokens: string[]): void {
    const key = tokens.join(" ");
    let bucket = this.buckets.get(tokens[0]!);
    if (!bucket) this.buckets.set(tokens[0]!, (bucket = new Set()));
    if (!bucket.has(key)) {
      bucket.add(key);
      this.longestSequence.set(tokens[0]!, Math.max(this.longestSequence.get(tokens[0]!) ?? 0, tokens.length));
      this.count += 1;
    }
  }

  private matchesTokens(tokens: readonly string[]): boolean {
    for (let index = 0; index < tokens.length; index += 1) {
      const bucket = this.buckets.get(tokens[index]!);
      if (!bucket) continue;
      let sequence = "";
      const limit = Math.min(tokens.length, index + (this.longestSequence.get(tokens[index]!) ?? 0));
      for (let end = index; end < limit; end++) {
        sequence += (end === index ? "" : " ") + tokens[end]!;
        if (bucket.has(sequence)) return true;
      }
    }
    return false;
  }
}

interface IndexedToken {
  token: string;
  start: number;
  end: number;
}

function toIndexedTokens(text: string): IndexedToken[] {
  const tokens: IndexedToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}\p{Cf}]+/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    for (const token of /^[a-z0-9]+$/i.test(match[0]) ? [match[0].toLowerCase()] : normalizeTokens(match[0])) {
      tokens.push({ token, start, end });
    }
  }
  return tokens;
}

/** "call 555 123 4567" becomes "call 5551234567". */
function joinNumericRuns(tokens: readonly string[]): string[] {
  const joined: string[] = [];
  for (const token of tokens) {
    const previous = joined.at(-1);
    if (previous !== undefined && /^\d+$/.test(previous) && /^\d+$/.test(token)) joined[joined.length - 1] = previous + token;
    else joined.push(token);
  }
  return joined;
}
