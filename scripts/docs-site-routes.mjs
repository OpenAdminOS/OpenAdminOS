/**
 * Route model for the self-hosted docs site at docs.openadminos.com.
 *
 * GitBook published each page at `<section slug>/<page slug>`, where the
 * section slug comes from the SUMMARY.md group title and the page slug from
 * the file name (README.md takes its folder name). The first page is served
 * at the root. File-path URLs such as /getting-started/installation were
 * redirected by GitBook, so they are kept here as redirect aliases.
 */

import { posix } from "node:path";

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parses SUMMARY.md into groups of (possibly nested) page links. */
export function parseSummary(text) {
  const sections = [];
  let current = null;
  const stack = [];

  for (const line of String(text).split(/\r?\n/)) {
    const group = /^##\s+(.+?)\s*$/.exec(line);
    if (group) {
      current = { title: group[1], items: [] };
      sections.push(current);
      stack.length = 0;
      continue;
    }

    const item = /^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*$/.exec(line);
    if (!item) continue;
    if (!current) {
      current = { title: "", items: [] };
      sections.push(current);
    }

    const depth = Math.floor(item[1].replace(/\t/g, "  ").length / 2);
    const node = {
      title: item[2],
      source: posix.normalize(item[3]),
      children: [],
    };
    stack.length = Math.min(stack.length, depth);
    const parent = stack[stack.length - 1];
    (parent ? parent.children : current.items).push(node);
    stack.push(node);
  }

  return sections.filter((section) => section.items.length > 0);
}

function pageSlug(source) {
  const base = posix.basename(source, ".md");
  if (base.toLowerCase() !== "readme") return slugify(base);
  const dir = posix.dirname(source);
  return dir === "." ? "readme" : slugify(posix.basename(dir));
}

function fileAlias(source) {
  const withoutExt = source.replace(/\.md$/i, "");
  if (posix.basename(withoutExt).toLowerCase() !== "readme") return withoutExt;
  const dir = posix.dirname(withoutExt);
  return dir === "." ? "" : dir;
}

/**
 * Builds the navigation tree, the flat page order, and the redirects that
 * keep old GitBook and file-path URLs working. Routes have no leading slash;
 * the root page has the empty route.
 */
export function buildDocsSite(sections) {
  const pages = [];

  function walk(items, parentPath, sectionTitle) {
    return items.map((item) => {
      const path = `${parentPath}/${pageSlug(item.source)}`;
      const page = {
        title: item.title,
        source: item.source,
        route: pages.length === 0 ? "" : path,
        path,
        section: sectionTitle,
      };
      pages.push(page);
      const children = walk(item.children, path, sectionTitle);
      return {
        title: page.title,
        source: page.source,
        route: page.route,
        path: page.path,
        children,
      };
    });
  }

  const navSections = sections.map((section) => {
    const slug = slugify(section.title);
    return {
      title: section.title,
      slug,
      pages: walk(section.items, slug, section.title),
    };
  });

  const seenRoutes = new Set();
  for (const page of pages) {
    if (seenRoutes.has(page.route)) {
      throw new Error(`Two docs pages resolve to the same URL: /${page.route}`);
    }
    seenRoutes.add(page.route);
  }

  const redirects = new Map();
  function addRedirect(source, destination) {
    if (!source || source === destination) return;
    if (seenRoutes.has(source) || redirects.has(source)) return;
    redirects.set(source, destination);
  }

  for (const page of pages) addRedirect(page.path, page.route);
  for (const page of pages) addRedirect(fileAlias(page.source), page.route);
  for (const section of navSections) {
    const first = section.pages[0];
    if (first) addRedirect(section.slug, first.route);
  }
  // Old folder URLs (for example /getting-started) land on the first page
  // that lived in that folder.
  for (const page of pages) {
    let dir = posix.dirname(page.source);
    while (dir !== ".") {
      addRedirect(dir, page.route);
      dir = posix.dirname(dir);
    }
  }

  return {
    sections: navSections,
    pages,
    redirects: [...redirects].map(([source, destination]) => ({
      source,
      destination,
    })),
  };
}
