import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { useAppState } from "../state";
import type {
  GraphCacheResourceKind,
  GraphCacheStatus,
} from "../shared/openAdminOS";

export default function Cache() {
  const { state } = useAppState();
  const tenantId = state.activeTenantId;
  const [status, setStatus] = useState<GraphCacheStatus>();
  const [selected, setSelected] = useState<Set<GraphCacheResourceKind>>(
    new Set(),
  );
  const [search, setSearch] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    setStatus(undefined);
    setSelected(new Set());
    setError("");
    setBusy(false);
    if (!tenantId) return;
    let initial = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await window.openAdminOS!.getGraphCacheStatus(tenantId);
        if (epoch.current !== generation) return;
        setStatus(next);
        if (initial) {
          setSelected(new Set(next.resources.map((r) => r.resource)));
          initial = false;
        }
      } catch (e) {
        if (epoch.current === generation) setError(String(e));
      }
      if (epoch.current === generation)
        timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      epoch.current++;
      clearTimeout(timer);
    };
  }, [tenantId]);
  const job = status?.preload;
  const running = busy || job?.status === "running";
  const issues =
    status?.resources.filter(
      (r) => !r.refreshedAt || r.lastError || r.pageLimitReached,
    ) ?? [];
  async function action(fn: () => Promise<unknown>) {
    const generation = epoch.current;
    setBusy(true);
    setError("");
    try {
      await fn();
      if (epoch.current === generation) {
        const next = await window.openAdminOS!.getGraphCacheStatus(tenantId);
        if (epoch.current === generation) setStatus(next);
      }
    } catch (e) {
      if (epoch.current === generation) setError(String(e));
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }
  const preload = (retry: boolean) =>
    action(() =>
      window.openAdminOS!.startGraphCachePreload({
        tenantId,
        resources: [...selected].filter(
          (r) => !retry || issues.some((i) => i.resource === r),
        ),
      }),
    );
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Cache"
        subtitle="Preload tenant data for Chat, Nova and your agent team."
        actions={
          <Link
            to="/settings/chat"
            className="text-sm text-[var(--color-accent)]"
          >
            Cache settings
          </Link>
        }
      />
      <PageBody>
        {!tenantId ? (
          <Card>
            <div className="p-6">
              Connect a tenant to preload its data.{" "}
              <Link to="/settings/tenants">Open tenant settings</Link>
            </div>
          </Card>
        ) : (
          <div className="space-y-5">
            <Card>
              <div className="space-y-4 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-medium">Your tenant, ready to work.</h2>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {state.tenants.find((t) => t.id === tenantId)?.displayName}{" "}
                    · stored on this device
                  </span>
                </div>
                <p className="text-sm text-[var(--color-text-soft)]">
                  All supported resources are selected by default. Preload
                  follows every page, including available log history. Source
                  retention and tenant permissions still apply. This covers the
                  app’s resource catalogue, not every Graph endpoint or
                  relationship.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={running || !selected.size}
                    onClick={() => void preload(false)}
                  >
                    Preload{" "}
                    {selected.size === status?.resources.length ? "all " : ""}
                    {selected.size} resources
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={
                      running || !issues.some((r) => selected.has(r.resource))
                    }
                    onClick={() => void preload(true)}
                  >
                    Retry incomplete
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={job?.status !== "running" || busy}
                    onClick={() =>
                      void action(() =>
                        window.openAdminOS!.cancelGraphCachePreload(tenantId),
                      )
                    }
                  >
                    Cancel refresh
                  </Button>
                </div>
              </div>
            </Card>
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-400/30 p-4 text-sm"
              >
                {error}
              </div>
            )}
            {job && (
              <Card>
                <div role="status" className="space-y-2 p-5">
                  <strong>
                    {job.status === "running"
                      ? "Preloading"
                      : job.status === "complete"
                        ? "Selected resources complete"
                        : job.status === "cancelled"
                          ? "Refresh cancelled"
                          : "Refresh finished with incomplete coverage"}
                  </strong>
                  <p className="text-sm">
                    {job.completed} / {job.total} attempted.{" "}
                    {job.active.join(" · ")}
                  </p>
                  <progress
                    className="w-full accent-[var(--color-accent)]"
                    aria-label="Cache preload progress"
                    max={job.total || 1}
                    value={job.completed}
                  />
                  {job.error && <p>{job.error}</p>}
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Failed or cancelled collections keep their previous
                    snapshot. A recent fetch does not mean every device checked
                    in recently.
                  </p>
                </div>
              </Card>
            )}
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label>
                <input
                  type="checkbox"
                  disabled={running || !status}
                  checked={
                    !!status?.resources.length &&
                    selected.size === status.resources.length
                  }
                  onChange={(e) =>
                    setSelected(
                      new Set(
                        e.target.checked
                          ? status?.resources.map((r) => r.resource)
                          : [],
                      ),
                    )
                  }
                />{" "}
                Select all
              </label>
              <input
                aria-label="Find a resource"
                placeholder="Find a resource"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-2"
              />
              <label>
                <input
                  type="checkbox"
                  checked={onlyIssues}
                  onChange={(e) => setOnlyIssues(e.target.checked)}
                />{" "}
                Needs attention
              </label>
              <span className="text-xs text-[var(--color-text-muted)]">
                Filters do not change selections.
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {status?.resources
                .filter(
                  (r) =>
                    r.label.toLowerCase().includes(search.toLowerCase()) &&
                    (!onlyIssues || issues.includes(r)),
                )
                .map((r) => (
                  <Card key={r.resource}>
                    <div className="space-y-2 p-4">
                      <label className="flex gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={selected.has(r.resource)}
                          disabled={running}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(r.resource);
                              else next.delete(r.resource);
                              return next;
                            })
                          }
                        />
                        {r.label}
                      </label>
                      <p className="text-xs">
                        {r.lastError
                          ? "Refresh failed"
                          : !r.refreshedAt
                            ? "Not preloaded"
                            : r.pageLimitReached
                              ? "Partial coverage"
                              : "Complete collection"}{" "}
                        · {r.rows.toLocaleString()} rows · {r.pages ?? 0} pages
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {r.refreshedAt
                          ? `Snapshot: ${new Date(r.refreshedAt).toLocaleString()}`
                          : "No snapshot available"}
                      </p>
                      {r.lastError && (
                        <p className="text-xs text-[var(--color-text-soft)]">
                          {r.lastError}
                        </p>
                      )}
                      <p className="break-words text-[10px] text-[var(--color-text-muted)]">
                        Read permissions: {r.scopeSet.join(", ")}
                      </p>
                    </div>
                  </Card>
                ))}
            </div>
            <Card>
              <div className="space-y-3 p-5">
                <h2 className="font-medium">Automatic refresh</h2>
                <p className="text-sm text-[var(--color-text-muted)]">
                  Scheduled refresh preloads all supported resources while this
                  device is awake, the app is running and the tenant is signed
                  in.
                </p>
                <label className="text-sm">
                  Frequency{" "}
                  <select
                    aria-label="Cache refresh frequency"
                    disabled={busy || !status}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-2"
                    value={
                      status?.schedule?.enabled
                        ? status.schedule.intervalMinutes
                        : 0
                    }
                    onChange={(e) =>
                      void action(() =>
                        window.openAdminOS!.setGraphCacheRefreshSchedule({
                          tenantId,
                          enabled: Number(e.target.value) > 0,
                          intervalMinutes: Number(e.target.value) || 360,
                        }),
                      )
                    }
                  >
                    <option value={0}>Manual only</option>
                    <option value={60}>Every hour</option>
                    <option value={360}>Every 6 hours</option>
                    <option value={1440}>Daily</option>
                  </select>
                </label>
                {status?.schedule?.lastError && (
                  <p role="alert">{status.schedule.lastError}</p>
                )}
              </div>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}
