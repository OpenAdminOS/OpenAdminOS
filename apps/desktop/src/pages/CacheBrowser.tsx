import { useEffect, useRef, useState } from "react";
import { Modal, ModalHeader } from "../components/Modal";
import { Badge, Button, DataTable, Toolbar } from "../components/ui";
import { isGraphCacheLogResource, type GraphCachePage, type GraphCacheStatus } from "../shared/openAdminOS";
import { cacheBrowserErrorCopy } from "../copy/errors";

type Resource = GraphCacheStatus["resources"][number];
type Row = GraphCachePage["rows"][number];
const PAGE_SIZE = 100;

export function CacheBrowser({ tenantId, tenantName, resource, onClose, onConnections, onClear, formatDateTime }: {
  tenantId: string;
  tenantName: string;
  onConnections: () => void;
  onClear: () => void;
  formatDateTime: (value: string) => string;
  resource: Resource;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<GraphCachePage>();
  const [selected, setSelected] = useState<Row>();
  const [failure, setFailure] = useState<ReturnType<typeof cacheBrowserErrorCopy>>();
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<Awaited<ReturnType<NonNullable<typeof window.openAdminOS>["readGraphCacheRow"]>>>();
  const [detailFailure, setDetailFailure] = useState<ReturnType<typeof cacheBrowserErrorCopy>>();
  const [detailRetry, setDetailRetry] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const rowButton = useRef<HTMLButtonElement | null>(null);
  const closeDetails = () => {
    setSelected(undefined);
    rowButton.current?.focus();
  };

  const goToPage = (nextOffset: number) => {
    setSelected(undefined);
    setPage(undefined);
    setOffset(nextOffset);
    contentRef.current?.scrollTo?.({ top: 0 });
  };

  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  const { refreshedAt, rows, resource: kind } = resource;

  useEffect(() => {
    let current = true;
    setFailure(undefined);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.openAdminOS!.browseGraphCache({
            tenantId, resource: kind, offset, limit: PAGE_SIZE, search,
          });
          if (current) setPage(result);
        } catch (error) {
          if (current) setFailure(cacheBrowserErrorCopy(error));
        }
      })();
    }, search ? 180 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [tenantId, kind, offset, search, retry, refreshedAt, rows]);

  useEffect(() => {
    if (!selected) return;
    let current = true;
    setDetail(undefined);
    setDetailFailure(undefined);
    void window.openAdminOS!.readGraphCacheRow({ tenantId, resource: kind, id: selected.id })
      .then((result) => { if (current) setDetail(result); })
      .catch((error: unknown) => { if (current) setDetailFailure(cacheBrowserErrorCopy(error)); });
    return () => { current = false; };
  }, [tenantId, kind, selected, detailRetry]);

  const lastRefresh = refreshedAt ? formatDateTime(refreshedAt) : "Never";
  const partial = !isGraphCacheLogResource(kind) &&
    (resource.pageLimitReached || (resource.tenantTotal != null && resource.tenantTotal > rows));

  const renderFailure = (failure: ReturnType<typeof cacheBrowserErrorCopy>, onRetry: () => void) => (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] p-3">
      <p>{failure.what}</p>
      <Button size="sm" variant="secondary" onClick={failure.action.label === "Return to Data" ? onClose : failure.action.kind === "navigate" ? onConnections : onRetry}>
        {failure.action.label}
      </Button>
    </div>
  );

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader title={resource.label} subtitle={`${tenantName} · Cached on this device. Read-only.`} onClose={onClose} />
      <div ref={contentRef} className="min-h-0 space-y-4 overflow-auto p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span>Last refresh · {lastRefresh}</span>
          {partial ? <Badge tone="warning">{resource.tenantTotal == null ? "Partial cache" : `${rows.toLocaleString()} of ${resource.tenantTotal.toLocaleString()} cached`}</Badge> : null}
        </div>
        {resource.notGrantedService ? (
          <p className="text-sm">
            Service not connected. These rows stay on this device until you clear the cache.{" "}
            {rows > 0 ? <button type="button" className="mr-3 text-[var(--color-accent)] underline" onClick={onClear}>Clear cache</button> : null}
            <button type="button" className="text-[var(--color-accent)] underline" onClick={onConnections}>Connect service</button>
          </p>
        ) : null}
        <Toolbar search={
          <input
            type="search"
            aria-label="Search cached rows"
            placeholder="Search cached rows"
            maxLength={256}
            value={search}
            onChange={(event) => {
              setPage(undefined);
              setSearch(event.target.value);
              setOffset(0);
              setSelected(undefined);
            }}
            className="h-9 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 ring-1 ring-[var(--color-border)]"
          />
        } />
        {selected ? (
          <section aria-label="Cached row JSON">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 tabIndex={-1} ref={detailRef} className="break-all text-sm font-medium">{selected.name ?? selected.id}</h3>
              <Button size="sm" variant="ghost" onClick={closeDetails}>Close details</Button>
            </div>
            {detailFailure ? renderFailure(detailFailure, () => setDetailRetry(detailRetry + 1)) :
              detail?.status === "ready" ? (
                <>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--color-bg)] p-3 text-xs" tabIndex={0}>{detail.json}</pre>
                  {detail.truncated ? <p className="text-sm">JSON preview truncated at 65,536 characters.</p> : null}
                </>
              ) : (
                <p role="status">{detail?.status === "unreadable" ? "This row could not be read." :
                  detail?.status === "missing" ? "This row is no longer cached. Close details and choose another row." :
                  "Reading cached row…"}</p>
              )}
          </section>
        ) : null}
        {failure ? renderFailure(failure, () => setRetry(retry + 1)) : (
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
                <Button size="sm" variant="secondary" aria-label={`View JSON for ${row.name ?? row.id}`}
                  onClick={(event) => {
                    rowButton.current = event.currentTarget;
                    if (selected?.id !== row.id) {
                      setDetail(undefined);
                      setDetailFailure(undefined);
                    }
                    setSelected(row);
                  }}>
                  View JSON
                </Button>
              ) },
            ]}
          />
        )}
      </div>
      {!failure && page && page.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] px-5 py-3 text-sm">
          <span>Rows {page.offset + 1} to {page.offset + page.rows.length} of {page.total.toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <span>Page {Math.floor(page.offset / PAGE_SIZE) + 1} of {Math.ceil(page.total / PAGE_SIZE)}</span>
            <Button size="sm" variant="secondary" disabled={page.offset === 0} onClick={() => goToPage(page.offset - PAGE_SIZE)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={page.offset + page.rows.length >= page.total} onClick={() => goToPage(page.offset + PAGE_SIZE)}>Next</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
