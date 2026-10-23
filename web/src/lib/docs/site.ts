// Docs site model. Content is the mirror of docs/gitbook written by
// scripts/generate-gitbook-docs.mjs into web/content/docs, so the Vercel
// build (Root Directory = web/) has everything it needs.

import fs from "node:fs";
import path from "node:path";

import { load as parseYaml } from "js-yaml";
import {
  Marked,
  Renderer,
  type RendererObject,
  type Token,
  type Tokens,
} from "marked";

import manifest from "../../../content/docs/manifest.json";
import { DOCS_ORIGIN, type DocsBase, docsHref } from "./paths";

export * from "./paths";

export const DOCS_REPO_URL = "https://github.com/OpenAdminOS/OpenAdminOS";

export interface DocsNavPage {
  title: string;
  source: string;
  route: string;
  path: string;
  children: DocsNavPage[];
}

export interface DocsNavSection {
  title: string;
  slug: string;
  pages: DocsNavPage[];
}

export interface DocsHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface DocsLinkTarget {
  title: string;
  route: string;
}

export interface DocsPage {
  route: string;
  path: string;
  source: string;
  title: string;
  description: string;
  summary: string;
  section: DocsNavSection;
  parents: DocsLinkTarget[];
  generated: boolean;
  markdown: string;
  html: string;
  headings: DocsHeading[];
  prev?: DocsLinkTarget;
  next?: DocsLinkTarget;
}

export interface DocsRedirect {
  source: string;
  destination: string;
}

export const DOCS_NAV = manifest.sections as DocsNavSection[];
export const DOCS_REDIRECTS = manifest.redirects as DocsRedirect[];

interface FlatPage {
  nav: DocsNavPage;
  section: DocsNavSection;
  parents: DocsNavPage[];
}

const FLAT_PAGES: FlatPage[] = [];
for (const section of DOCS_NAV) {
  const walk = (pages: DocsNavPage[], parents: DocsNavPage[]) => {
    for (const nav of pages) {
      FLAT_PAGES.push({ nav, section, parents });
      walk(nav.children, [...parents, nav]);
    }
  };
  walk(section.pages, []);
}

const PAGES_BY_ROUTE = new Map(
  FLAT_PAGES.map((page) => [page.nav.route, page]),
);
const PAGES_BY_SOURCE = new Map(
  FLAT_PAGES.map((page) => [page.nav.source, page]),
);

export const DOCS_ROUTES = FLAT_PAGES.map((page) => page.nav.route);

/** Raw Markdown URL, matching GitBook's `<page>.md` export. */
export function docsMarkdownUrl(page: Pick<DocsPage, "path">) {
  return `${DOCS_ORIGIN}/${page.path}.md`;
}

export function routeFromSlug(slug: string[] | undefined) {
  return (slug ?? []).map((part) => decodeURIComponent(part)).join("/");
}

export function slugFromRoute(route: string) {
  return route ? route.split("/") : [];
}

export function findDocsPagePath(pathSegments: string[]) {
  const joined = pathSegments.join("/");
  return FLAT_PAGES.find((page) => page.nav.path === joined)?.nav;
}

function contentRoot() {
  const candidates = [
    path.join(process.cwd(), "content", "docs"),
    path.join(process.cwd(), "web", "content", "docs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Docs content not found. Tried: ${candidates.join(", ")}. Run npm run docs:generate from the repository root.`,
    );
  }
  return found;
}

function splitFrontMatter(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {} as Record<string, unknown>, body: raw };
  const data = (parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>;
  return { data, body: raw.slice(match[0].length) };
}

/** Anchor ids compatible with the ones GitBook generated. */
export function headingId(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((token) => {
      if ("tokens" in token && token.tokens) return inlineText(token.tokens);
      if (token.type === "br") return " ";
      if (token.type === "html") return "";
      return "text" in token ? String(token.text) : "";
    })
    .join("");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|tr|h\d|pre|div)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type HeadingToken = Tokens.Heading & { docsId?: string };

/**
 * Renderer overrides. marked only applies enumerable properties, so this is a
 * plain object rather than a Renderer subclass. `this` is marked's renderer.
 */
function docsRenderer(source: string, base: DocsBase): RendererObject {
  return {
    heading(this: Renderer, token: HeadingToken) {
      const inner = this.parser.parseInline(token.tokens);
      const id = token.docsId ?? headingId(inlineText(token.tokens));
      if (token.depth > 3)
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      return `<h${token.depth} id="${id}">${inner}<a class="docs-anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`;
    },

    link(this: Renderer, token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      const href = token.href;

      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        const external = /^https?:|^\/\//i.test(href);
        return external
          ? `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noreferrer" class="docs-external">${inner}</a>`
          : `<a href="${escapeHtml(href)}"${title}>${inner}</a>`;
      }
      if (href.startsWith("#"))
        return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`;

      const [target = "", hash = ""] = href.split("#", 2);
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(source), decodeURI(target)),
      );
      const page = PAGES_BY_SOURCE.get(resolved);
      if (!page) {
        throw new Error(
          `Broken docs link in ${source}: ${href} (resolved to ${resolved})`,
        );
      }
      const url = docsHref(base, page.nav.route, hash ? `#${hash}` : "");
      return `<a href="${escapeHtml(url)}"${title} data-docs-link>${inner}</a>`;
    },

    code(token: Tokens.Code) {
      const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      const label = lang ? `<span>${escapeHtml(lang)}</span>` : "<span></span>";
      return `<div class="docs-code">${label}<button type="button" class="docs-copy" data-copy>Copy</button><pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(token.text)}</code></pre></div>\n`;
    },

    table(this: Renderer, token: Tokens.Table) {
      return `<div class="docs-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
    },
  };
}

interface ParsedSource {
  data: Record<string, unknown>;
  body: string;
  tokens: Token[];
  headings: DocsHeading[];
}

const sourceCache = new Map<string, ParsedSource>();

function parseSource(source: string): ParsedSource {
  const cached = sourceCache.get(source);
  if (cached) return cached;

  const raw = fs.readFileSync(path.join(contentRoot(), source), "utf8");
  const { data, body } = splitFrontMatter(raw);
  const tokens = new Marked({ gfm: true }).lexer(body) as Token[];

  const firstContent = tokens.findIndex((token) => token.type !== "space");
  const first = tokens[firstContent];
  if (first?.type === "heading" && first.depth === 1)
    tokens.splice(firstContent, 1);

  const headings: DocsHeading[] = [];
  const used = new Map<string, number>();
  for (const token of tokens) {
    if (token.type !== "heading") continue;
    const text = inlineText(token.tokens).trim();
    const baseId = headingId(text);
    const count = used.get(baseId) ?? 0;
    used.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count}`;
    (token as HeadingToken).docsId = id;
    if (token.depth === 2 || token.depth === 3) {
      headings.push({ id, text, depth: token.depth });
    }
  }

  const parsed = { data, body, tokens, headings };
  sourceCache.set(source, parsed);
  return parsed;
}

function renderTokens(tokens: Token[], source: string, base: DocsBase) {
  const marked = new Marked({
    gfm: true,
    renderer: docsRenderer(source, base),
  });
  // marked keeps link definitions on the token list itself.
  const list = Object.assign([...tokens], {
    links: (tokens as Token[] & { links?: object }).links ?? {},
  });
  return marked.parser(list);
}

function firstParagraph(tokens: Token[]) {
  const paragraph = tokens.find((token) => token.type === "paragraph");
  if (!paragraph || paragraph.type !== "paragraph") return "";
  return inlineText(paragraph.tokens).replace(/\s+/g, " ").trim();
}

function clip(text: string, max = 158) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 80)).replace(/[\s,.;:]+$/, "")}...`;
}

const pageCache = new Map<string, DocsPage>();

export function getDocsPage(
  route: string,
  base: DocsBase,
): DocsPage | undefined {
  const key = `${base}|${route}`;
  const cached = pageCache.get(key);
  if (cached) return cached;

  const flat = PAGES_BY_ROUTE.get(route);
  if (!flat) return undefined;

  const parsed = parseSource(flat.nav.source);
  const index = FLAT_PAGES.indexOf(flat);
  const prev = FLAT_PAGES[index - 1];
  const next = FLAT_PAGES[index + 1];
  const description =
    typeof parsed.data.description === "string" ? parsed.data.description : "";
  // GitBook titles a page with its SUMMARY.md label and drops the H1.
  const title = flat.nav.title;

  const page: DocsPage = {
    route,
    path: flat.nav.path,
    source: flat.nav.source,
    title,
    description,
    summary: clip(
      description ||
        firstParagraph(parsed.tokens) ||
        `${title} in the OpenAdminOS documentation.`,
    ),
    section: flat.section,
    parents: flat.parents.map((parent) => ({
      title: parent.title,
      route: parent.route,
    })),
    generated: flat.nav.source.startsWith("generated/"),
    markdown: parsed.body.trimStart(),
    html: renderTokens(parsed.tokens, flat.nav.source, base),
    headings: parsed.headings,
    prev: prev ? { title: prev.nav.title, route: prev.nav.route } : undefined,
    next: next ? { title: next.nav.title, route: next.nav.route } : undefined,
  };
  pageCache.set(key, page);
  return page;
}

export function getAllDocsPages(base: DocsBase = "") {
  return DOCS_ROUTES.map((route) => getDocsPage(route, base)).filter(
    (page): page is DocsPage => Boolean(page),
  );
}

/** Compact search index: one entry per page section, built at build time. */
export interface DocsSearchIndex {
  pages: { r: string; t: string; s: string; d: string }[];
  chunks: { p: number; h: string; a: string; x: string }[];
}

export function buildSearchIndex(): DocsSearchIndex {
  const pages: DocsSearchIndex["pages"] = [];
  const chunks: DocsSearchIndex["chunks"] = [];

  for (const route of DOCS_ROUTES) {
    const page = getDocsPage(route, "");
    if (!page) continue;
    const parsed = parseSource(page.source);
    const pageIndex =
      pages.push({
        r: page.route,
        t: page.title,
        s: page.section.title,
        d: page.description,
      }) - 1;

    let heading = "";
    let anchor = "";
    let buffer: Token[] = [];
    const flush = () => {
      const text = htmlToText(renderTokens(buffer, page.source, ""));
      if (text || heading)
        chunks.push({ p: pageIndex, h: heading, a: anchor, x: text });
      buffer = [];
    };

    for (const token of parsed.tokens) {
      if (token.type === "heading" && token.depth <= 3) {
        flush();
        heading = inlineText(token.tokens).trim();
        anchor = (token as HeadingToken).docsId ?? headingId(heading);
        continue;
      }
      buffer.push(token);
    }
    flush();
  }

  return { pages, chunks };
}
