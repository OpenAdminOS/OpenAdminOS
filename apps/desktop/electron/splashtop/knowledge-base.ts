import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { BuiltinReference, BuiltinCallResult } from "../mcp/host.js";
import { McpHostError } from "../mcp/host.js";

/**
 * Splashtop's public Help Center (Zendesk Guide) as a built-in public
 * reference. It needs no sign-in and runs on this device: the query words
 * go straight from here to support-splashtopbusiness.splashtop.com, with
 * no MCP server in between. It goes through the MCP host like a catalog
 * server, so installing, turning off, the egress checks on its params and
 * the third-party fencing of its results are the same.
 *
 * Endpoints (verified 2026-11-09, public, rate limit header 700):
 * `/api/v2/help_center/articles/search.json?query=` and
 * `/api/v2/help_center/{locale}/articles/{id}.json`.
 */

export const SPLASHTOP_KB_HOST = "support-splashtopbusiness.splashtop.com";
export const SPLASHTOP_KB_URL = `https://${SPLASHTOP_KB_HOST}/api/v2/help_center`;

const LOCALE = /^[a-z]{2}(?:-[a-z]{2,4})?$/;
const PER_PAGE = 10;
const MAX_PAGE = 20;
const ARTICLE_TEXT_LIMIT = 8_000;
const SNIPPET_LIMIT = 400;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/** Article HTML as plain text: tags removed, block ends as line breaks, entities decoded. */
export function articleText(html: string): string {
  return html
    .replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)) ?? match)
    .replace(/&#(\d{1,7});/g, (match, digits: string) => safeCodePoint(Number.parseInt(digits, 10)) ?? match)
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED[name.toLowerCase()] ?? match)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCodePoint(value: number): string | undefined {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit ? { text, truncated: false } : { text: `${text.slice(0, limit - 3).trimEnd()}...`, truncated: true };
}

function oneLine(text: string, limit: number): string {
  return clip(articleText(text).replace(/\s+/g, " "), limit).text;
}

function httpsOnHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === SPLASHTOP_KB_HOST ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function localeParam(value: unknown): string {
  if (value === undefined || value === null || value === "") return "en-us";
  if (typeof value !== "string" || !LOCALE.test(value.toLowerCase())) {
    throw new McpHostError("tool-error", "locale takes a Help Center locale such as en-us, de or fr. Nothing was sent.", false);
  }
  return value.toLowerCase();
}

function retryAfterText(headers: Headers): string {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? "" : "s"}` : "a minute";
}

function httpError(status: number, headers: Headers, what: string): McpHostError {
  if (status === 404) return new McpHostError("tool-error", `The Splashtop Knowledge Base has no ${what} (HTTP 404). It may have been removed or is not published in that language.`);
  if (status === 429) return new McpHostError("server-error", `The Splashtop Knowledge Base is limiting requests (HTTP 429). Wait ${retryAfterText(headers)}, then ask again.`);
  if (status === 400 || status === 422) return new McpHostError("tool-error", `The Splashtop Knowledge Base did not accept the search (HTTP ${status}). Ask with a few plain product words.`);
  return new McpHostError("server-error", `The Splashtop Knowledge Base at ${SPLASHTOP_KB_HOST} answered HTTP ${status}. Retry later.`);
}

async function getJson(fetch: FetchLike, url: URL, signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal });
  } catch (error) {
    if (error instanceof McpHostError) throw error;
    signal.throwIfAborted();
    throw new McpHostError("unreachable", `The Splashtop Knowledge Base could not be reached at ${SPLASHTOP_KB_HOST}. Check the network connection or proxy, then retry.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw httpError(response.status, response.headers, what);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    signal.throwIfAborted();
    throw new McpHostError("server-error", `The Splashtop Knowledge Base sent an answer OpenAdminOS could not read.`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new McpHostError("server-error", `The Splashtop Knowledge Base sent an answer OpenAdminOS could not read.`);
  }
  return body as Record<string, unknown>;
}

async function searchArticles(args: Record<string, unknown>, fetch: FetchLike, signal: AbortSignal): Promise<BuiltinCallResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0 || query.length > 200) {
    throw new McpHostError("tool-error", "search_articles needs a query of 1 to 200 characters. Nothing was sent.", false);
  }
  const locale = args.locale === undefined ? undefined : localeParam(args.locale);
  const pageValue = args.page ?? 1;
  if (typeof pageValue !== "number" || !Number.isInteger(pageValue) || pageValue < 1 || pageValue > MAX_PAGE) {
    throw new McpHostError("tool-error", `page takes a whole number from 1 to ${MAX_PAGE}. Nothing was sent.`, false);
  }
  const url = new URL(`${SPLASHTOP_KB_URL}/articles/search.json`);
  url.searchParams.set("query", query);
  if (locale) url.searchParams.set("locale", locale);
  url.searchParams.set("page", String(pageValue));
  url.searchParams.set("per_page", String(PER_PAGE));
  const body = await getJson(fetch, url, signal, "results for this search");
  const raw = Array.isArray(body.results) ? body.results : [];
  const results = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    const title = typeof record.title === "string" ? oneLine(record.title, 200) : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !title) return [];
    const link = httpsOnHost(record.html_url);
    const snippet = typeof record.snippet === "string" ? oneLine(record.snippet, SNIPPET_LIMIT) : typeof record.body === "string" ? oneLine(record.body, SNIPPET_LIMIT) : "";
    return [{
      id,
      title,
      ...(link ? { url: link } : {}),
      ...(snippet ? { snippet } : {}),
      ...(typeof record.locale === "string" ? { locale: record.locale } : {}),
      ...(typeof record.updated_at === "string" ? { updated_at: record.updated_at } : {}),
    }];
  });
  const count = Number(body.count);
  const pageCount = Number(body.page_count);
  const data = {
    results,
    count: Number.isFinite(count) ? count : results.length,
    page: pageValue,
    ...(Number.isFinite(pageCount) ? { page_count: pageCount } : {}),
    has_more: Number.isFinite(pageCount) ? pageValue < pageCount : false,
  };
  return { text: JSON.stringify(data), structured: data };
}

async function getArticle(args: Record<string, unknown>, fetch: FetchLike, signal: AbortSignal): Promise<BuiltinCallResult> {
  const id = typeof args.id === "string" && /^\d{1,16}$/.test(args.id) ? Number(args.id) : args.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new McpHostError("tool-error", "get_article needs an article id from search_articles. Nothing was sent.", false);
  }
  const locale = localeParam(args.locale);
  const url = new URL(`${SPLASHTOP_KB_URL}/${locale}/articles/${id}.json`);
  const body = await getJson(fetch, url, signal, `article ${id} in ${locale}`);
  const article = body.article && typeof body.article === "object" ? (body.article as Record<string, unknown>) : undefined;
  const title = typeof article?.title === "string" ? oneLine(article.title, 200) : "";
  if (!article || !title) throw new McpHostError("server-error", "The Splashtop Knowledge Base sent an article without a title. OpenAdminOS did not use it.");
  const text = clip(articleText(typeof article.body === "string" ? article.body : ""), ARTICLE_TEXT_LIMIT);
  const link = httpsOnHost(article.html_url);
  const data = {
    id,
    title,
    ...(link ? { url: link } : {}),
    locale: typeof article.locale === "string" ? article.locale : locale,
    ...(typeof article.updated_at === "string" ? { updated_at: article.updated_at } : {}),
    body: text.text,
    ...(text.truncated ? { body_truncated: true } : {}),
  };
  return { text: JSON.stringify(data), structured: data };
}

export const SPLASHTOP_KNOWLEDGE_BASE: BuiltinReference = {
  serverName: "Splashtop Knowledge Base",
  serverVersion: "built-in",
  tools: [
    {
      name: "search_articles",
      description: "Search Splashtop's public Help Center articles for Splashtop Business, Enterprise, SOS and Remote Support. Returns titles, links and a short excerpt.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", maxLength: 200, description: "A few product words, for example reboot computer or SOS connection." },
          locale: { type: "string", description: "Optional Help Center locale such as en-us or de." },
          page: { type: "number", description: `Page of ${PER_PAGE} results, from 1 to ${MAX_PAGE}.` },
        },
      },
    },
    {
      name: "get_article",
      description: "Read one Splashtop Help Center article as plain text, by the id search_articles returned.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "number", description: "Article id from search_articles." },
          locale: { type: "string", description: "Help Center locale. Defaults to en-us." },
        },
      },
    },
  ],
  call(name, args, fetch, signal) {
    if (name === "search_articles") return searchArticles(args, fetch, signal);
    if (name === "get_article") return getArticle(args, fetch, signal);
    return Promise.reject(new McpHostError("unknown-tool", `The Splashtop Knowledge Base has no tool named ${name}. Nothing was sent.`, false));
  },
};
