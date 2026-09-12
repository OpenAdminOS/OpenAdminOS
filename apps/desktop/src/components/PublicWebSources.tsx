import type { IntuneChatToolTraceEntry } from "../shared/openAdminOS";

/** Citations come from the search provider's annotations, not model-authored links. */
export function PublicWebSources({ trace }: { trace?: IntuneChatToolTraceEntry[] }) {
  const sources = [...new Map((trace ?? []).flatMap(t => t.webSources ?? []).filter(source => {
    try {
      const url = new URL(source.url);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  }).map(source => [source.url, source])).values()];
  if (!sources.length) return null;
  return (
    <section aria-label="Public web sources" className="mt-3 rounded-lg border border-[var(--color-border-soft)] px-3 py-2.5">
      <p className="text-[11px] text-[var(--color-text-muted)]">Public web sources · external information</p>
      <ul className="mt-1.5 grid gap-1.5">
        {sources.map(source => (
          <li key={source.url} className="min-w-0 text-xs">
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-words text-[var(--color-accent)] underline underline-offset-2 hover:opacity-80">
              {source.title || new URL(source.url).hostname}
            </a>
            <span className="ml-2 break-all text-[10px] text-[var(--color-text-muted)]">{new URL(source.url).hostname}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
