// Minimal Liquid-subset template engine for agent templates.
//
// Supports:
//   {{ path.to.value }}
//   {{ path.to.value | filter }}
//   {{ path.to.value | filter(arg) }}
//
// Filters: size, total (alias for size), sample(n), default("..."), join(", "),
// boundedJson(maxChars), upper, lower, length, type.
//
// Type preservation: when the entire string IS a single {{ ... }} expression
// the raw value is returned (number stays number, array stays array). When
// the expression is embedded in surrounding text the result is coerced to
// string.

import { registerRenderedFragment } from "./data-classification.js";
import type { TemplateInterpolation } from "./request-classification.js";
import { escapeTenantDataBody, fenceTenantData } from "./tenant-data.js";

const EXPRESSION_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;
const STANDALONE_REGEX = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

export const PROMPT_INSTRUCTION_ROOTS = Symbol("promptInstructionRoots");
export type TemplateContext = Record<string, unknown> & {
  [PROMPT_INSTRUCTION_ROOTS]?: Record<string, unknown>;
};

export interface TemplateFilter {
  (value: unknown, ...args: unknown[]): unknown;
}

type SourceTrace = {
  value: unknown;
  key: string;
  format: "value" | "join" | "json" | "literal" | "unmapped";
  separator?: string;
  casing: Array<"upper" | "lower">;
};

function boundedJson(value: unknown, maxChars: unknown, trace?: SourceTrace): string {
  if (!Array.isArray(value) || typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 512) {
    throw new Error("boundedJson requires an array and an integer character budget of at least 512.");
  }
  // Preserve whole records. Skipping an oversized record must not hide the
  // coverage gap, and must not prevent smaller later records from fitting.
  const records: unknown[] = [];
  const envelope = () => ({
    totalRecords: value.length,
    includedRecords: records.length,
    omittedRecords: value.length - records.length,
    coverage: records.length === value.length ? "complete" : "partial: omitted records are not assessed; do not extrapolate sample findings",
    records,
  });
  for (const record of value) {
    records.push(record);
    if (JSON.stringify(envelope()).length > maxChars) records.pop();
  }
  const result = envelope();
  if (trace) {
    trace.value = result;
    trace.format = "json";
  }
  return JSON.stringify(result);
}

const FILTERS: Record<string, TemplateFilter> = {
  boundedJson: (value, maxChars) => boundedJson(value, maxChars),
  size(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value as object).length;
    if (typeof value === "string") return value.length;
    return 0;
  },
  total(value) {
    return FILTERS.size!(value);
  },
  length(value) {
    return FILTERS.size!(value);
  },
  sample(value, n) {
    const count = typeof n === "number" ? Math.max(0, Math.floor(n)) : 3;
    if (Array.isArray(value)) return value.slice(0, count);
    return value;
  },
  default(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return value;
  },
  join(value, separator) {
    const sep = typeof separator === "string" ? separator : ", ";
    if (Array.isArray(value)) return value.join(sep);
    return value;
  },
  upper(value) {
    return typeof value === "string" ? value.toUpperCase() : value;
  },
  lower(value) {
    return typeof value === "string" ? value.toLowerCase() : value;
  },
  type(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  },
};

/**
 * Resolve a dotted path against a context object. Returns `undefined` for
 * missing keys rather than throwing — templating in a UI should be forgiving.
 */
function lookup(path: string, ctx: TemplateContext, trace?: SourceTrace): unknown {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = ctx;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (trace && !Array.isArray(current)) trace.key = segment;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

interface ParsedExpression {
  path: string;
  pipeline: Array<{ filter: string; args: unknown[] }>;
}

function parseExpression(raw: string): ParsedExpression {
  const parts = raw.split("|").map((p) => p.trim());
  const path = parts[0] ?? "";
  const pipeline: ParsedExpression["pipeline"] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const segment = parts[i];
    if (!segment) continue;
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/.exec(segment);
    if (!match) {
      throw new Error(`Invalid filter syntax: "${segment}"`);
    }
    const filter = match[1] ?? "";
    const argsRaw = match[2];
    const args = argsRaw ? parseFilterArgs(argsRaw) : [];
    pipeline.push({ filter, args });
  }
  return { path, pipeline };
}

function parseFilterArgs(raw: string): unknown[] {
  // Very small parser: comma-separated literals (string, number, true/false/null).
  const args: unknown[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i] ?? "")) i += 1;
    if (i >= raw.length) break;
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = "";
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          value += raw[i + 1];
          i += 2;
          continue;
        }
        value += raw[i];
        i += 1;
      }
      i += 1; // closing quote
      args.push(value);
    } else {
      let token = "";
      while (i < raw.length && raw[i] !== ",") {
        token += raw[i];
        i += 1;
      }
      token = token.trim();
      if (token === "true") args.push(true);
      else if (token === "false") args.push(false);
      else if (token === "null") args.push(null);
      else if (token !== "") {
        const num = Number(token);
        args.push(Number.isNaN(num) ? token : num);
      }
    }
    while (i < raw.length && raw[i] !== ",") i += 1;
    i += 1; // skip comma
  }
  return args;
}

function evaluateExpression(parsed: ParsedExpression, ctx: TemplateContext, trace?: SourceTrace): unknown {
  let value: unknown = lookup(parsed.path, ctx, trace);
  if (trace) trace.value = value;
  for (const { filter: name, args } of parsed.pipeline) {
    const filter = FILTERS[name];
    if (!filter) {
      throw new Error(`Unknown template filter: "${name}"`);
    }
    const rendered = name === "boundedJson" && trace
      ? boundedJson(value, args[0], trace) : filter(value, ...args);
    if (name === "upper" || name === "lower") {
      if (typeof rendered === "string" && value !== rendered) {
        if (trace) trace.casing.push(name);
        else registerRenderedFragment(value, rendered, { key: parsed.path.split(".").at(-1)! });
      }
    } else if (trace && rendered !== value) {
      switch (name) {
        case "sample":
          // The prefix retains its original elements and field key.
          trace.value = rendered;
          break;
        case "join":
          trace.format = "join";
          trace.separator = typeof args[0] === "string" ? args[0] : ", ";
          break;
        case "default":
          trace.format = "literal";
          break;
        case "boundedJson":
          // The filter supplied the envelope with the actual included records.
          break;
        default:
          // Aggregating a collection loses the per-element mapping. A
          // scalar measurement still comes from the original scalar.
          if (trace.format !== "literal" && (trace.format !== "value" || !isScalar(trace.value))) {
            trace.format = "unmapped";
          }
      }
    }
    value = rendered;
  }
  return value;
}

type Scalar = NonNullable<TemplateInterpolation["value"]>;
type TracePiece = { text: string; key?: string; value?: Scalar };

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const MAX_TRACE_PIECE = 32_768;
const MAX_TRACE_TEXT = 128 * 1024;

function* tracePieces(
  value: unknown, key: string, format: "join" | "json", separator: string, depth = 0, envelope = false,
): Generator<TracePiece, boolean> {
  if (depth > 64) return false;
  if (Array.isArray(value)) {
    if (format === "json") yield { text: "[" };
    for (let i = 0; i < value.length; i++) {
      if (i) yield { text: separator };
      const property = Object.getOwnPropertyDescriptor(value, i);
      if (property && !("value" in property)) return false;
      if (!(yield* tracePieces(property?.value, key, format, ",", depth + 1))) return false;
    }
    if (format === "json") yield { text: "]" };
    return true;
  }
  if (value && typeof value === "object") {
    if (format === "join") return false;
    yield { text: "{" };
    let first = true;
    for (const field in value) {
      const property = Object.getOwnPropertyDescriptor(value, field);
      if (!property) continue;
      if (!("value" in property) || field.length > MAX_TRACE_PIECE) return false;
      if (property.value === undefined || typeof property.value === "function" || typeof property.value === "symbol") {
        if (field === "toJSON" && typeof property.value === "function") return false;
        yield { text: "" };
        continue;
      }
      if (!first) yield { text: "," };
      first = false;
      yield { text: JSON.stringify(field) + ":" };
      // Only the records in boundedJson came from tenant data.
      const sourceKey = envelope ? (field === "records" ? key : "") : field.toLowerCase();
      if (!(yield* tracePieces(property.value, sourceKey, format, ",", depth + 1))) return false;
    }
    yield { text: "}" };
    return true;
  }
  if (!isScalar(value)) {
    if (value !== undefined && value !== null && format === "join") return false;
    yield { text: format === "json" ? "null" : "" };
    return true;
  }
  if (typeof value === "string" && value.length > MAX_TRACE_PIECE) return false;
  if (typeof value === "number" && !Number.isFinite(value) && format === "json") {
    yield { text: "null" };
  } else if (format === "json" && typeof value === "string") {
    yield { text: '"' };
    yield { text: JSON.stringify(value).slice(1, -1), key, value };
    yield { text: '"' };
  } else {
    yield { text: String(value), key, value };
  }
  return true;
}

function* traceInterpolation(
  trace: SourceTrace, rendered: string, start: number, end: number, fenced: boolean,
): Generator<TemplateInterpolation | undefined, boolean> {
  if (end - start > MAX_TRACE_TEXT) return false;
  const format = trace.format === "join" ? "join" : "json";
  const pieces = tracePieces(trace.value, trace.key.toLowerCase(), format, trace.separator ?? ",", 0, trace.format === "json");
  // start and end are prompt offsets. Read the local fence body at its
  // stable offset without making another copy of the interpolated text.
  const bodyStart = fenced ? rendered.indexOf("\n") + 1 : 0;
  let position = start;
  for (;;) {
    const next = pieces.next();
    if (next.done) return next.value && position === end;
    const { key, value } = next.value;
    let { text } = next.value;
    if (text.length > MAX_TRACE_PIECE) return false;
    for (const casing of trace.casing) text = casing === "upper" ? text.toUpperCase() : text.toLowerCase();
    if (fenced) text = escapeTenantDataBody(text);
    const previous = position;
    position += text.length;
    if (position > end || !rendered.startsWith(text, bodyStart + previous - start)) return false;
    yield key && value !== undefined && position > previous
      ? { key, value, start: previous, end: position, requireEvidence: true } : undefined;
  }
}

/**
 * Render a templated string against the given context.
 *
 * If the input is the *single* `{{ expression }}` with no surrounding text,
 * the raw (typed) value is returned so callers can preserve numbers / arrays.
 * Otherwise interpolations are coerced to strings.
 */
export function renderTemplate(input: string, ctx: TemplateContext): unknown {
  if (typeof input !== "string") return input;

  const standalone = STANDALONE_REGEX.exec(input);
  if (standalone && standalone[1]) {
    return evaluateExpression(parseExpression(standalone[1]), ctx);
  }

  return input.replace(EXPRESSION_REGEX, (_match, expr: string) => {
    const value = evaluateExpression(parseExpression(expr), ctx);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

/** Only model prompts fence interpolations; transforms and displayed results stay typed. */
export function renderPromptTemplate(
  input: string, ctx: TemplateContext, capture?: (interpolation: TemplateInterpolation) => void,
): string {
  let shift = 0;
  return input.replace(EXPRESSION_REGEX, (match, expr: string, offset: number) => {
    const expression = parseExpression(expr);
    const { path } = expression;
    const key = path.split(".").at(-1)!;
    const root = path.split(".")[0]!;
    const trusted = ctx[PROMPT_INSTRUCTION_ROOTS]?.[root] === ctx[root] &&
      /^(?:settings\.|descriptor\.|ctx\.|task\.instructions$)/.test(path);
    const trace: SourceTrace | undefined = capture && !trusted
      ? { value: undefined, key, format: "value", casing: [] } : undefined;
    const value = evaluateExpression(expression, ctx, trace);
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    const scalar = typeof value === "number" || typeof value === "boolean";
    const fenced = value !== undefined && value !== null && !trusted && !scalar;
    const rendered = fenced ? fenceTenantData(text, `template:${path}`) : text;
    if (capture) {
      const at = offset + shift;
      const start = at + (fenced ? rendered.indexOf("\n") + 1 : 0);
      const end = at + (fenced ? rendered.lastIndexOf("\n") : rendered.length);
      const sourceKey = (trace?.key ?? key).toLowerCase();
      if (trace?.format === "unmapped") {
        capture({ start, end, key: sourceKey, incomplete: true });
      } else if (trace && (trace.format === "join" || trace.format === "json" ||
          trace.format === "value" && Array.isArray(trace.value))) {
        capture({ start, end, key: sourceKey, trace: () => traceInterpolation(trace, rendered, start, end, fenced) });
      } else {
        capture({ start, end, key: sourceKey,
          ...(trace?.format === "value" && isScalar(trace.value)
            ? { value: trace.value, requireEvidence: trace.value !== value } : {}) });
      }
      shift += rendered.length - match.length;
    } else if (scalar && !trusted) {
      const before = input.slice(Math.max(0, offset - 48), offset).split("}}").at(-1);
      const after = input.slice(offset + match.length, offset + match.length + 48).split("{{")[0];
      if (before?.trim() || after?.trim()) registerRenderedFragment(value, value, {
        key, ...(before ? { before } : {}), ...(after ? { after } : {}),
      });
    }
    return rendered;
  });
}

/**
 * Recursively render every string in an object or array. Non-string scalars
 * pass through unchanged.
 */
export function renderDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") {
    return renderTemplate(value, ctx) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderDeep(entry, ctx)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderDeep(child, ctx);
    }
    return out as T;
  }
  return value;
}
