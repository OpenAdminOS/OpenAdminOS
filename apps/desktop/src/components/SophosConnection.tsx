import { useEffect, useRef, useState, type FormEvent } from "react";

import { useNavigate } from "react-router";

import { SOPHOS_PREVIEW_NOTE, type SophosChangeKind, type SophosConnectionSummary, type SophosTarget } from "../shared/openAdminOS";
import { useAppState } from "../state";
import { splashtopErrorText } from "./SplashtopConnection";
import { Modal, ModalHeader } from "./Modal";
import { Badge, Button } from "./ui";

const connectionIssues = {
  credentials: "The Sophos Central credential may have expired or been removed. Verify or create credentials in Sophos Central, then disconnect and reconnect here.",
  forbidden: "Sophos Central refused access. Check the credential’s service principal role in Sophos Central, then test the connection again.",
  "rate-limit": "Sophos Central is rate limiting requests. Wait a minute, then test the connection again.",
};

export function SophosConnection({ organizationId, connection, focus }: {
  organizationId: string;
  connection?: SophosConnectionSummary | undefined;
  focus: boolean;
}) {
  const { refresh } = useAppState();
  const api = window.openAdminOS;
  const navigate = useNavigate();
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [kind, setKind] = useState<SophosChangeKind>("isolate");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<SophosTarget[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);

  async function run(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await refresh();
      setMessage(success);
    } catch (cause) {
      setError(splashtopErrorText(cause) || "Could not update the Sophos Central connection. Reopen Connections and try again.");
    } finally {
      setBusy(false);
    }
  }

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const clientId = String(fields.get("clientId") ?? "");
    const clientSecret = String(fields.get("clientSecret") ?? "");
    form.reset();
    void run(async () => {
      if (!api?.connectSophos) throw new Error("Open the desktop app to connect Sophos Central.");
      await api.connectSophos({ organizationId, clientId, clientSecret });
    }, "Sophos Central connected.");
  }

  return (
    <section className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3 border-t border-[var(--color-border-soft)] py-3">
      {/* TODO(ugur): Sophos logo licensing */}
      <span aria-hidden="true" className="svc-mark" data-size="lg">SC</span>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={heading} tabIndex={-1} className="text-base font-medium">Sophos Central</h3>
          <Badge>Preview</Badge>
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">{SOPHOS_PREVIEW_NOTE}</p>
        <p className="text-sm text-[var(--color-text-muted)]">Requests go to your Sophos region. If you use a hosted model, Sophos Chat results go to that provider.</p>
        {connection ? (
          <>
            {connection.unreadable ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">The Sophos Central connection record could not be read. Disconnect it, then reconnect with your tenant credentials.</p>
            ) : (
              <>
                <p className="break-words text-sm text-[var(--color-text-muted)]">Connected · {connection.region} · {connection.host}</p>
                <p className="text-sm text-[var(--color-text-muted)]">
                  Connected {new Date(connection.connectedAt).toLocaleString()} · Last checked {new Date(connection.lastCheckedAt).toLocaleString()}
                </p>
                {connection.issue && <p role="alert" className="text-sm text-[var(--color-danger)]">{connectionIssues[connection.issue]}</p>}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {!connection.unreadable && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => {
                if (!api?.testSophos) throw new Error("Open the desktop app to test Sophos Central.");
                await api.testSophos(organizationId);
              }, "Sophos Central connection verified.")}>Test connection</Button>}
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
                setError("");
                setDisconnectOpen(true);
              }}>Disconnect</Button>
              {!connection.unreadable && <Button size="sm" variant="secondary" disabled={busy} aria-expanded={planning} onClick={() => setPlanning(!planning)}>Plan a change</Button>}
            </div>
            <Modal open={disconnectOpen} onClose={() => { if (!busy) setDisconnectOpen(false); }} size="md">
              <ModalHeader title="Disconnect Sophos Central" onClose={() => { if (!busy) setDisconnectOpen(false); }} />
              <div className="space-y-4 p-6">
                <p className="text-sm text-[var(--color-text-soft)]">The client secret is deleted from this device. It stays valid in Sophos Central until you remove it there.</p>
                {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => setDisconnectOpen(false)}>Cancel</Button>
                  <Button variant="danger" disabled={busy} onClick={() => void run(async () => {
                    if (!api?.disconnectSophos) throw new Error("Open the desktop app to disconnect Sophos Central.");
                    await api.disconnectSophos(organizationId);
                    setPlanning(false);
                    setTargets([]);
                    setSelected([]);
                    setComment("");
                    setDisconnectOpen(false);
                  }, "Sophos Central disconnected.")}>Disconnect Sophos Central</Button>
                </div>
              </div>
            </Modal>
            {!connection.unreadable && planning && (
              <div className="space-y-2 rounded border border-[var(--color-border-soft)] p-3">
                <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    if (!api?.listSophosTargets) throw new Error("Open the desktop app to list Sophos Central endpoints.");
                    setSelected([]);
                    const found = await api.listSophosTargets(organizationId, search);
                    setTargets(found);
                    if (!found.length) throw new Error("No endpoints matched. Change the search and try again.");
                  }, "Choose endpoints from the first 50 matches.");
                }}>
                  <label className="grid gap-1 text-sm">Endpoint search
                    <input className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} />
                  </label>
                  <Button type="submit" size="sm" variant="secondary" disabled={busy}>Find endpoints</Button>
                </form>
                {targets.length > 0 && (
                  <>
                    <fieldset className="max-h-48 overflow-y-auto">
                      <legend className="text-sm">Endpoints</legend>
                      {targets.map((target) => (
                        <label key={target.id} className="flex items-center gap-2 break-all py-1 text-sm">
                          <input type="checkbox" disabled={busy} checked={selected.includes(target.id)} onChange={(event) => {
                            const checked = event.target.checked;
                            setSelected((current) => checked ? [...current, target.id] : current.filter((id) => id !== target.id));
                          }} />
                          {target.hostname} · {target.isolationStatus} · {target.id}
                        </label>
                      ))}
                    </fieldset>
                    <label className="grid gap-1 text-sm">Change
                      <select value={kind} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1" onChange={(event) => setKind(event.target.value as SophosChangeKind)}>
                        <option value="isolate">Isolate endpoints</option>
                        <option value="release">Release from isolation</option>
                        <option value="scan">Start a scan</option>
                      </select>
                    </label>
                    {kind !== "scan" && <label className="grid gap-1 text-sm">Isolation reason
                      <textarea value={comment} maxLength={400} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1" onChange={(event) => setComment(event.target.value)} />
                    </label>}
                    <Button size="sm" disabled={busy || !selected.length || (kind !== "scan" && !comment.trim())} onClick={() => void run(async () => {
                      if (!api?.prepareSophosChange) throw new Error("Open the desktop app to prepare a Sophos Central change.");
                      const plan = await api.prepareSophosChange({ organizationId, kind, targetIds: selected, ...(kind === "scan" ? {} : { comment }) });
                      navigate(`/runs/${encodeURIComponent(plan.id)}`);
                    }, "Plan ready for review.")}>Review plan</Button>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--color-text-muted)]">Ask a Super Admin to create a tenant credential under Global Settings → API Credentials. The client secret is shown once.</p>
            <p className="text-sm text-[var(--color-text-muted)]">Use Service Principal Read-Only for reads or Service Principal Management for isolate and scan.</p>
            <form onSubmit={connect} className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm">Client ID
                <input name="clientId" required maxLength={512} autoComplete="off" disabled={busy} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" />
              </label>
              <label className="grid gap-1 text-sm">Client secret
                <input name="clientSecret" type="password" required maxLength={4096} autoComplete="off" disabled={busy} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" />
              </label>
              <Button type="submit" size="sm" disabled={busy}>{busy ? "Connecting…" : "Connect"}</Button>
            </form>
          </>
        )}
        {error && !disconnectOpen && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        {message && <p role="status" className="text-sm text-[var(--color-text-muted)]">{message}</p>}
      </div>
    </section>
  );
}
