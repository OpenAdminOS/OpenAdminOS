// Minimal Liquid-subset template engine for Tier 1 manifests.
//
// Supports:
//   {{ path.to.value }}
//   {{ path.to.value | filter }}
//   {{ path.to.value | filter(arg) }}
//
// Filters: size, total (alias for size), sample(n), default("..."), join(", "),
// upper, lower, length, type. New filters can be added to FILTERS below.
//
// Type preservation: when the entire string IS a single {{ ... }} expression
// the raw value is returned (number stays number, array stays array). When
// the expression is embedded in surrounding text the result is coerced to
// string.

const EXPRESSION_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;
const STANDALONE_REGEX = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

export type TemplateContext = Record<string, unknown>;

export interface TemplateFilter {
  (value: unknown, ...args: unknown[]): unknown;
}

const FILTERS: Record<string, TemplateFilter> = {
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
function lookup(path: string, ctx: TemplateContext): unknown {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = ctx;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
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

function evaluateExpression(raw: string, ctx: TemplateContext): unknown {
  const parsed = parseExpression(raw);
  let value: unknown = lookup(parsed.path, ctx);
  for (const step of parsed.pipeline) {
    const filter = FILTERS[step.filter];
    if (!filter) {
      throw new Error(`Unknown template filter: "${step.filter}"`);
    }
    value = filter(value, ...step.args);
  }
  return value;
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
    return evaluateExpression(standalone[1], ctx);
  }

  return input.replace(EXPRESSION_REGEX, (_match, expr: string) => {
    const value = evaluateExpression(expr, ctx);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
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
