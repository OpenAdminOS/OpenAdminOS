import { useEffect, useRef, useState } from "react";
import { Modal, ModalHeader } from "../components/Modal";
import { Badge, Button, DataTable, Toolbar } from "../components/ui";
import type { GraphCachePage, GraphCacheStatus } from "../shared/openAdminOS";

type Resource = GraphCacheStatus["resources"][number];
type Row = GraphCachePage["rows"][number];
const PAGE_SIZE = 100;

export function CacheBrowser({ tenantId, resource, onClose }: {
  tenantId: string;
  resource: Resource;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<GraphCachePage>();
  const [selected, setSelected] = useState<Row>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const { refreshedAt, rows, resource: kind } = resource;

  useEffect(() => {
    let current = true;
    setPage(undefined);
    setSelected(undefined);
    setFailed(false);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.openAdminOS!.browseGraphCache({
            tenantId, resource: kind, offset, limit: PAGE_SIZE, search,
          });
          if (current) setPage(result);
        } catch {
          if (current) setFailed(true);
        }
      })();
    }, search ? 180 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [tenantId, kind, offset, search, retry, refreshedAt, rows]);

  const lastRefresh = refreshedAt && new Date(refreshedAt).getTime() > 0
    ? new Date(refreshedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : refreshedAt ? "Before the last write (stale)" : "Never";
  const partial = resource.pageLimitReached ||
    (resource.tenantTotal != null && resource.tenantTotal > resource.rows);

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader title={resource.label} subtitle="Cached on this device. Read-only." onClose={onClose} />
      <div className="min-h-0 space-y-4 overflow-auto p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span>Last refresh · {lastRefresh}</span>
          {partial ? <Badge tone="warning">Partial cache</Badge> : null}
        </div>
        <Toolbar search={
          <input
            type="search"
            aria-label="Search cached rows"
            placeholder="Search cached rows"
            maxLength={256}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            className="h-9 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 ring-1 ring-[var(--color-border)]"
          />
        } />
        {failed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p>Could not read this cache. Check the active organization and retry.</p>
            <Button size="sm" variant="secondary" onClick={() => setRetry(retry + 1)}>Retry</Button>
          </div>
        ) : (
          <DataTable<Row>
            caption="Cached rows"
            rowKey={(row) => row.id}
            rows={page?.rows ?? []}
            loading={!page}
            emptyTitle={search.trim() ? "No matching rows" : "No rows cached"}
            emptyDescription={search.trim() ? "Change or clear your search." : "Refresh this resource in Data to load rows."}
            columns={[
              { id: "name", header: "Name", render: (row) => row.name ?? "Not recorded" },
              ...(page?.rows.some((row) => row.user) ? [
                { id: "user", header: "User", render: (row: Row) => row.user ?? "Not recorded" },
              ] : []),
              { id: "id", header: "ID", render: (row) => <span className="break-all font-mono text-xs">{row.id}</span> },
              { id: "detail", header: "Details", render: (row) => (
                <Button size="sm" variant="secondary" onClick={() => setSelected(row)} aria-pressed={selected?.id === row.id}>
                  View JSON
                </Button>
              ) },
            ]}
          />
        )}
        {page && page.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>Rows {page.offset + 1} to {page.offset + page.rows.length} of {page.total.toLocaleString()}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page.offset === 0} onClick={() => setOffset(page.offset - PAGE_SIZE)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page.offset + page.rows.length >= page.total} onClick={() => setOffset(page.offset + PAGE_SIZE)}>Next</Button>
            </div>
          </div>
        ) : null}
        {selected ? (
          <section aria-label="Cached row JSON" ref={detailRef}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="break-all text-sm font-medium">{selected.name ?? selected.id}</h3>
              <Button size="sm" variant="ghost" onClick={() => setSelected(undefined)}>Close details</Button>
            </div>
            <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--color-bg)] p-3 text-xs" tabIndex={0}>{JSON.stringify(selected.data, null, 2)}</pre>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
