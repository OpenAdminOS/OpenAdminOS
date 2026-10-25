"use client";

import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DOCS_SEARCH_INDEX_PATH,
  type DocsBase,
  docsHref,
} from "~/lib/docs/paths";
import type { DocsSearchIndex } from "~/lib/docs/site";

interface Result {
  key: string;
  href: string;
  section: string;
  title: string;
  heading: string;
  text: string;
  score: number;
}

type IndexState =
  | { status: "idle" | "loading" }
  | { status: "ready"; index: DocsSearchIndex }
  | { status: "error" };

const MAX_RESULTS = 12;

function terms(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

function countOf(haystack: string, needle: string) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && count < 3) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function search(
  index: DocsSearchIndex,
  base: DocsBase,
  query: string,
): Result[] {
  const words = terms(query);
  if (words.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  // Words in query order, a few words apart at most ("retire devices"
  // matches "retires stale devices").
  const near =
    words.length > 1
      ? new RegExp(
          words
            .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("\\w*\\W+(?:\\w+\\W+){0,2}?"),
        )
      : null;
  const best = new Map<string, Result>();

  for (const chunk of index.chunks) {
    const page = index.pages[chunk.p];
    if (!page) continue;
    const title = page.t.toLowerCase();
    const heading = chunk.h.toLowerCase();
    const text = chunk.x.toLowerCase();
    const description = chunk.h ? "" : page.d.toLowerCase();

    let score = 0;
    let matchedAll = true;
    for (const word of words) {
      const inTitle = title.includes(word);
      const inHeading = heading.includes(word);
      const inBody = countOf(text, word);
      const inDescription = description.includes(word);
      if (!inTitle && !inHeading && !inDescription && inBody === 0) {
        matchedAll = false;
        break;
      }
      // A title match says most about the page's own intro, less about
      // each of its subsections.
      score +=
        (inTitle ? (chunk.h ? 3 : 8) : 0) +
        (title.startsWith(word) && !chunk.h ? 4 : 0) +
        (inHeading ? 5 : 0) +
        (inDescription ? 3 : 0) +
        inBody;
    }
    if (!matchedAll) continue;
    if (
      words.length > 1 &&
      [title, heading, description, text].some((field) =>
        field.includes(phrase),
      )
    ) {
      score += 6;
    }
    if (near && [description, text].some((field) => near.test(field))) {
      score += 5;
    }
    if (!chunk.h) score += 1;

    const key = `${page.r}#${chunk.a}`;
    const existing = best.get(key);
    if (existing && existing.score >= score) continue;
    best.set(key, {
      key,
      href: docsHref(base, page.r, chunk.a ? `#${chunk.a}` : ""),
      section: page.s,
      title: page.t,
      heading: chunk.h,
      text: chunk.x || page.d,
      score,
    });
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
}

function highlight(text: string, words: string[]): ReactNode[] {
  if (words.length === 0) return [text];
  const escaped = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return parts.map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : part,
  );
}

function snippet(text: string, words: string[]) {
  const lower = text.toLowerCase();
  const first = words
    .map((word) => lower.indexOf(word))
    .filter((at) => at >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined || first < 60) return text.slice(0, 160);
  const start = text.lastIndexOf(" ", first - 50);
  return `...${text.slice(start + 1, start + 160)}`;
}

/** Client-side search over a static index built with the site. */
export function DocsSearch({ base }: { base: DocsBase }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [state, setState] = useState<IndexState>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [shortcut, setShortcut] = useState("");

  const loadIndex = useCallback(() => {
    if (state.status === "loading" || state.status === "ready") return;
    setState({ status: "loading" });
    fetch(DOCS_SEARCH_INDEX_PATH)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<DocsSearchIndex>;
      })
      .then((index) => setState({ status: "ready", index }))
      .catch(() => setState({ status: "error" }));
  }, [state.status]);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    loadIndex();
    dialog.showModal();
    inputRef.current?.select();
  }, [loadIndex]);

  const close = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    setShortcut(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K");
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "");
      if (
        (event.key === "k" || event.key === "K") &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        open();
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        open();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const words = useMemo(() => terms(query), [query]);
  const results = useMemo(
    () => (state.status === "ready" ? search(state.index, base, query) : []),
    [state, base, query],
  );

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(result: Result | undefined) {
    if (!result) return;
    close();
    router.push(result.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    }
  }

  let body: ReactNode;
  if (state.status === "error") {
    body = (
      <p className="px-4 py-8 text-center text-sm text-brand-muted">
        The search index did not load. Check your connection and reopen search,
        or browse the page list.
      </p>
    );
  } else if (state.status !== "ready") {
    body = (
      <p className="px-4 py-8 text-center text-sm text-brand-muted">
        Loading the search index.
      </p>
    );
  } else if (!query.trim()) {
    body = (
      <p className="px-4 py-8 text-center text-sm text-brand-muted">
        Search page titles, headings, and text across the documentation.
      </p>
    );
  } else if (results.length === 0) {
    body = (
      <p className="px-4 py-8 text-center text-sm text-brand-muted">
        No pages match &ldquo;{query.trim()}&rdquo;. Try fewer or different
        words.
      </p>
    );
  } else {
    body = (
      <ul
        ref={listRef}
        id="docs-search-results"
        role="listbox"
        aria-label="Search results"
        className="space-y-px p-2"
      >
        {results.map((result, index) => (
          <li
            key={result.key}
            role="option"
            aria-selected={index === active}
            data-index={index}
          >
            <a
              href={result.href}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                go(result);
              }}
              onMouseMove={() => setActive(index)}
              className={`block rounded-[10px] px-3 py-2.5 ${index === active ? "bg-brand-hover" : ""}`}
            >
              <span className="block text-xs text-brand-faint">
                {result.section}
                {result.heading ? ` / ${result.title}` : ""}
              </span>
              <span className="mt-0.5 block text-sm font-medium text-brand-ink">
                {highlight(result.heading || result.title, words)}
              </span>
              {result.text ? (
                <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-brand-muted">
                  {highlight(snippet(result.text, words), words)}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        onMouseEnter={loadIndex}
        onFocus={loadIndex}
        className="inline-flex h-10 items-center gap-2.5 rounded-[10px] text-sm text-brand-muted transition-colors hover:text-brand-ink max-md:w-10 max-md:justify-center max-md:hover:bg-brand-hover md:w-full md:max-w-sm md:border md:border-brand-line md:bg-brand-card md:px-3 md:hover:border-brand-line-strong"
      >
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="h-[18px] w-[18px] shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <circle cx="9" cy="9" r="5.25" />
          <path d="M13 13l3.5 3.5" />
        </svg>
        <span className="max-md:sr-only">Search docs</span>
        {shortcut ? (
          <kbd className="ml-auto hidden rounded-md border border-brand-line px-1.5 py-0.5 font-sans text-[11px] text-brand-faint md:inline">
            {shortcut}
          </kbd>
        ) : null}
      </button>

      <dialog
        ref={dialogRef}
        aria-label="Search documentation"
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
        className="docs-search m-0 mx-auto mt-[min(12vh,7rem)] max-h-[min(36rem,80dvh)] w-[min(40rem,calc(100vw-1.5rem))] overflow-hidden rounded-[16px] bg-brand-raised p-0 text-brand-ink shadow-(--shadow-pop) backdrop:bg-transparent open:flex open:flex-col"
      >
        <div className="flex items-center gap-3 border-b border-brand-line-soft px-4">
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-[18px] w-[18px] shrink-0 text-brand-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <circle cx="9" cy="9" r="5.25" />
            <path d="M13 13l3.5 3.5" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search docs"
            aria-label="Search docs"
            aria-controls="docs-search-results"
            autoComplete="off"
            spellCheck={false}
            className="h-14 flex-1 bg-transparent text-base text-brand-ink outline-none placeholder:text-brand-faint [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-brand-line px-1.5 py-0.5 text-[11px] text-brand-faint transition-colors hover:text-brand-ink"
          >
            Esc
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {body}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-brand-line-soft px-4 py-2.5 text-xs text-brand-faint">
          <span>
            Search runs in your browser. Queries are not sent anywhere.
          </span>
          <span className="hidden sm:inline">↑ ↓ to move, Enter to open</span>
        </div>
      </dialog>
    </>
  );
}
