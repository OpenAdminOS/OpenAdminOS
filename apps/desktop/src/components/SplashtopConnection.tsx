import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "./Button";
import { IconChevronDown } from "./icons";
import { Modal, ModalHeader } from "./Modal";
import { ServiceMark } from "./ServiceMark";
import { useToast } from "./Toast";
import { Badge, Menu } from "./ui";
import { SPLASHTOP_COPY } from "../copy/splashtop";
import {
  SPLASHTOP_CHANGE_KINDS,
  SPLASHTOP_CHANGE_TARGET_LIMIT,
  SPLASHTOP_REGIONS,
  splashtopComputerNameProblem,
  splashtopRegion,
  type OrganizationRecord,
  type SplashtopChangeKind,
  type SplashtopChangeTarget,
  type SplashtopConnectionSummary,
  type SplashtopRegion,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

/**
 * A host error as the admin should read it: without Electron's IPC prefix,
 * and only when it carries no stack or local path. Splashtop messages
 * name the host and the fix, so they are longer than most.
 */
export function splashtopErrorText(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught ?? "");
  const message = raw.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:\w*Error: )?/, "").trim();
  if (!message || message.length > 700 || /\r|\n|\tat\s|\bat\s+\S+\s+\([^)]*:\d+:\d+\)|(?:[A-Za-z]:\\|\/home\/|\/Users\/|node:)/.test(message)) return "";
  return message;
}

function formatWhen(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/** The Splashtop line under Other services on Connections. */
export function SplashtopServiceRow({
  organization,
  connection,
  openConnect,
  onConnectHandled,
}: {
  organization: OrganizationRecord;
  connection: SplashtopConnectionSummary | undefined;
  /** Open the connect step on arrival, for example from the Marketplace listing. */
  openConnect?: boolean;
  onConnectHandled?: () => void;
}) {
  const { refresh } = useAppState();
  const toast = useToast();
  const [dialog, setDialog] = useState<"connect" | "rotate" | "disconnect" | "plan" | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!openConnect) return;
    if (!connection) setDialog("connect");
    onConnectHandled?.();
  }, [connection, onConnectHandled, openConnect]);

  const test = () => {
    const api = window.openAdminOS;
    setTesting(true);
    void Promise.resolve()
      .then(async () => {
        if (!api?.testSplashtop) throw new Error(SPLASHTOP_COPY.notInBuild);
        const summary = await api.testSplashtop(organization.id);
        await refresh();
        toast.success(SPLASHTOP_COPY.testOk(summary.host));
      })
      .catch((caught) => toast.error(SPLASHTOP_COPY.failed(splashtopErrorText(caught))))
      .finally(() => setTesting(false));
  };

  return (
    <section aria-label={SPLASHTOP_COPY.name} className="border-t border-[var(--color-border-soft)] py-3">
      <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3">
        <ServiceMark serviceId="splashtop" size="lg" off={!connection} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-base font-medium text-[var(--color-text)]">
            {SPLASHTOP_COPY.name}
            {connection ? <Badge tone="success">{SPLASHTOP_COPY.connected}</Badge> : null}
          </div>
          <div className="truncate text-sm text-[var(--color-text-muted)]">
            {connection ? SPLASHTOP_COPY.connectedFacts(connection.host, connection.teamId, connection.account) : SPLASHTOP_COPY.rowSummaryOff}
          </div>
        </div>
        {connection ? (
          <Menu
            ariaLabel={SPLASHTOP_COPY.manageLabel}
            align="end"
            trigger={
              <Button size="sm" variant="ghost" trailingIcon={<IconChevronDown size={12} />} aria-label={SPLASHTOP_COPY.manageLabel} disabled={testing}>
                {testing ? SPLASHTOP_COPY.testing : SPLASHTOP_COPY.manage}
              </Button>
            }
            items={[
              { id: "plan", label: SPLASHTOP_COPY.planChange, onSelect: () => setDialog("plan") },
              { id: "test", label: SPLASHTOP_COPY.test, onSelect: test },
              { id: "rotate", label: SPLASHTOP_COPY.rotate, onSelect: () => setDialog("rotate") },
              { id: "separator", type: "separator" as const },
              { id: "disconnect", label: SPLASHTOP_COPY.disconnect, danger: true, onSelect: () => setDialog("disconnect") },
            ]}
          />
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setDialog("connect")}>
            {SPLASHTOP_COPY.connect}
          </Button>
        )}
      </div>
      {connection ? (
        <ul aria-label="Splashtop parts" className="mt-2 grid gap-1 pl-[42px] text-sm">
          {connection.parts.map((part) => (
            <li key={part.id} className="flex items-center gap-2 text-[var(--color-text-soft)]">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${part.on ? "bg-[var(--color-success)]" : "bg-[var(--color-text-muted)]"}`} />
              <span>{part.title}</span>
              {part.on ? null : <span className="text-[var(--color-text-muted)]">· {SPLASHTOP_COPY.partOff}</span>}
            </li>
          ))}
          {formatWhen(connection.lastCheckedAt) ? (
            <li className="text-xs text-[var(--color-text-muted)]">{SPLASHTOP_COPY.lastChecked(formatWhen(connection.lastCheckedAt)!)}</li>
          ) : null}
        </ul>
      ) : null}
      <SplashtopTokenDialog
        open={dialog === "connect" || dialog === "rotate"}
        mode={dialog === "rotate" ? "rotate" : "connect"}
        organization={organization}
        connection={connection}
        onClose={() => setDialog(null)}
      />
      {connection ? (
        <>
          <SplashtopDisconnectDialog open={dialog === "disconnect"} organization={organization} onClose={() => setDialog(null)} />
          <SplashtopPlanChangeDialog open={dialog === "plan"} organization={organization} connection={connection} onClose={() => setDialog(null)} />
        </>
      ) : null}
    </section>
  );
}

function Explainer({ host, organization }: { host: string; organization: string }) {
  return (
    <>
      <section aria-labelledby="splashtop-needs" className="text-sm leading-relaxed">
        <h3 id="splashtop-needs" className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.needsHeading}</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-text-soft)]">
          {SPLASHTOP_COPY.needs.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>
      <section aria-labelledby="splashtop-goes" className="text-sm leading-relaxed">
        <h3 id="splashtop-goes" className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.goesHeading}</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-text-soft)]">
          {SPLASHTOP_COPY.goes(host, organization).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>
    </>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
      {message}
    </div>
  );
}

/** Connect, or rotate the token of an existing connection. The token goes to the host once and never comes back. */
export function SplashtopTokenDialog({
  open,
  mode,
  organization,
  connection,
  onClose,
}: {
  open: boolean;
  mode: "connect" | "rotate";
  organization: OrganizationRecord;
  connection: SplashtopConnectionSummary | undefined;
  onClose: () => void;
}) {
  const { refresh } = useAppState();
  const toast = useToast();
  const tokenId = useId();
  const [region, setRegion] = useState<SplashtopRegion>(connection?.region ?? "global");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setToken("");
    setError(null);
    setRegion(connection?.region ?? "global");
  }, [connection?.region, open]);
  const host = splashtopRegion(mode === "rotate" && connection ? connection.region : region).host;
  const close = () => {
    if (busy) return;
    setToken("");
    onClose();
  };
  const submit = () => {
    const api = window.openAdminOS;
    setBusy(true);
    setError(null);
    void Promise.resolve()
      .then(async () => {
        if (mode === "connect") {
          if (!api?.connectSplashtop) throw new Error(SPLASHTOP_COPY.notInBuild);
          await api.connectSplashtop({ organizationId: organization.id, region, token });
        } else {
          if (!api?.rotateSplashtopToken) throw new Error(SPLASHTOP_COPY.notInBuild);
          await api.rotateSplashtopToken({ organizationId: organization.id, token });
        }
        setToken("");
        await refresh();
        toast.success(mode === "connect" ? `Splashtop is connected for ${organization.name}.` : "The new Splashtop token replaced the old one.");
        onClose();
      })
      .catch((caught) => setError(SPLASHTOP_COPY.failed(splashtopErrorText(caught))))
      .finally(() => setBusy(false));
  };
  return (
    <Modal open={open} onClose={close} size="md">
      <ModalHeader
        title={mode === "connect" ? SPLASHTOP_COPY.connectTitle : SPLASHTOP_COPY.rotateTitle}
        subtitle={mode === "connect" ? SPLASHTOP_COPY.connectSubtitle(organization.name) : SPLASHTOP_COPY.rotateSubtitle(host)}
        onClose={close}
      />
      <form
        className="space-y-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && token.trim()) submit();
        }}
      >
        <Explainer host={host} organization={organization.name} />
        {mode === "connect" ? (
          <fieldset className="text-sm">
            <legend className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.regionLabel}</legend>
            <div className="mt-1.5 grid gap-1.5">
              {SPLASHTOP_REGIONS.map((entry) => (
                <label key={entry.id} className="flex items-center gap-2 text-[var(--color-text-soft)]">
                  <input
                    type="radio"
                    name="splashtop-region"
                    value={entry.id}
                    checked={region === entry.id}
                    disabled={busy}
                    onChange={() => setRegion(entry.id)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span className="text-[var(--color-text)]">{entry.label}</span>
                  <span className="text-[var(--color-text-muted)]">{entry.host}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="grid gap-1.5 text-sm">
          <label htmlFor={tokenId} className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.tokenLabel}</label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            disabled={busy}
            placeholder={SPLASHTOP_COPY.tokenPlaceholder}
            onChange={(event) => setToken(event.target.value)}
            className="h-10 rounded-lg bg-[var(--color-bg-raised)] px-3 font-mono text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
          />
        </div>
        <ErrorBox message={error} />
        {busy ? <p role="status" className="text-sm text-[var(--color-text-muted)]">{SPLASHTOP_COPY.checking(host)}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>{SPLASHTOP_COPY.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || token.trim().length === 0}>
            {mode === "connect" ? SPLASHTOP_COPY.connectAction : SPLASHTOP_COPY.rotateAction}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SplashtopDisconnectDialog({ open, organization, onClose }: { open: boolean; organization: OrganizationRecord; onClose: () => void }) {
  const { refresh } = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} size="md">
      <ModalHeader title={SPLASHTOP_COPY.disconnectTitle} subtitle={organization.name} onClose={() => { if (!busy) onClose(); }} />
      <div className="space-y-4 p-6">
        <p className="text-sm leading-relaxed text-[var(--color-text-soft)]">{SPLASHTOP_COPY.disconnectBody(organization.name)}</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{SPLASHTOP_COPY.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              const api = window.openAdminOS;
              setBusy(true);
              setError(null);
              void Promise.resolve()
                .then(async () => {
                  if (!api?.disconnectSplashtop) throw new Error(SPLASHTOP_COPY.notInBuild);
                  await api.disconnectSplashtop(organization.id);
                  await refresh();
                  toast.success(`Splashtop is disconnected for ${organization.name}. Its token was deleted from this device.`);
                  onClose();
                })
                .catch((caught) => setError(SPLASHTOP_COPY.failed(splashtopErrorText(caught))))
                .finally(() => setBusy(false));
            }}
          >
            {SPLASHTOP_COPY.disconnectAction}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Plan a change: the host lists what Splashtop has now, the admin picks
 * targets, and the host builds the plan from the targets read again. The
 * plan opens in Runs, where every change waits for the typed phrase.
 */
export function SplashtopPlanChangeDialog({
  open,
  organization,
  connection,
  onClose,
}: {
  open: boolean;
  organization: OrganizationRecord;
  connection: SplashtopConnectionSummary;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { refresh } = useAppState();
  const filterId = useId();
  const [kind, setKind] = useState<SplashtopChangeKind>("reboot-computers");
  const [rebootOption, setRebootOption] = useState<"normal_reboot" | "restart_streamer">("normal_reboot");
  const [targets, setTargets] = useState<SplashtopChangeTarget[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const api = window.openAdminOS;
    setTargets(null);
    setSelected([]);
    setNames({});
    setError(null);
    setLoading(true);
    void Promise.resolve()
      .then(async () => {
        if (!api?.listSplashtopChangeTargets) throw new Error(SPLASHTOP_COPY.notInBuild);
        const listed = await api.listSplashtopChangeTargets(organization.id, kind);
        if (!cancelled) setTargets(listed);
      })
      .catch((caught) => {
        if (!cancelled) setError(SPLASHTOP_COPY.failed(splashtopErrorText(caught)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, open, organization.id]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (targets ?? []).filter((target) => !needle || `${target.label} ${target.detail ?? ""} ${target.id}`.toLowerCase().includes(needle));
  }, [filter, targets]);
  const renaming = kind === "rename-computers";
  const nameProblems = renaming
    ? selected.map((id) => splashtopComputerNameProblem(names[id] ?? "")).filter((problem): problem is string => Boolean(problem))
    : [];
  const ready = selected.length > 0 && nameProblems.length === 0 && !busy && !loading;

  const toggle = (id: number) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= SPLASHTOP_CHANGE_TARGET_LIMIT ? current : [...current, id],
    );
  };

  const prepare = () => {
    const api = window.openAdminOS;
    setBusy(true);
    setError(null);
    void Promise.resolve()
      .then(async () => {
        if (!api?.prepareSplashtopChange) throw new Error(SPLASHTOP_COPY.notInBuild);
        const run = await api.prepareSplashtopChange({
          organizationId: organization.id,
          kind,
          targetIds: selected,
          ...(renaming ? { names: Object.fromEntries(selected.map((id) => [String(id), (names[id] ?? "").trim()])) } : {}),
          ...(kind === "reboot-computers" ? { rebootOption } : {}),
        });
        await refresh();
        onClose();
        navigate(`/runs/${encodeURIComponent(run.id)}`);
      })
      .catch((caught) => setError(SPLASHTOP_COPY.failed(splashtopErrorText(caught))))
      .finally(() => setBusy(false));
  };

  const team = `${organization.name}, Splashtop team ${connection.teamId}`;
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} size="lg">
      <ModalHeader title={SPLASHTOP_COPY.planTitle} subtitle={SPLASHTOP_COPY.planSubtitle(team)} onClose={() => { if (!busy) onClose(); }} />
      <div className="space-y-4 p-6">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.planKindLabel}</span>
          <select
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as SplashtopChangeKind)}
            className="h-10 rounded-lg bg-[var(--color-bg-raised)] px-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
          >
            {SPLASHTOP_CHANGE_KINDS.map((entry) => <option key={entry} value={entry}>{SPLASHTOP_COPY.planKinds[entry]}</option>)}
          </select>
        </label>
        {kind === "reboot-computers" ? (
          <fieldset className="text-sm">
            <legend className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.rebootOptionLabel}</legend>
            <div className="mt-1.5 flex flex-wrap gap-4 text-[var(--color-text-soft)]">
              {(["normal_reboot", "restart_streamer"] as const).map((option) => (
                <label key={option} className="flex items-center gap-2">
                  <input type="radio" name="splashtop-reboot-option" checked={rebootOption === option} disabled={busy} onChange={() => setRebootOption(option)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  {option === "normal_reboot" ? SPLASHTOP_COPY.rebootNormal : SPLASHTOP_COPY.rebootStreamer}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="grid gap-1.5 text-sm">
          <label htmlFor={filterId} className="font-medium text-[var(--color-text)]">{SPLASHTOP_COPY.filterLabel}</label>
          <input
            id={filterId}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoComplete="off"
            className="h-9 rounded-lg bg-[var(--color-bg-raised)] px-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {SPLASHTOP_COPY.targetsLimit(SPLASHTOP_CHANGE_TARGET_LIMIT)} {SPLASHTOP_COPY.selected(selected.length)}.
          </span>
        </div>
        {loading ? <p role="status" className="text-sm text-[var(--color-text-muted)]">{SPLASHTOP_COPY.loadingTargets}</p> : null}
        {targets && targets.length === 0 ? <p role="status" className="text-sm text-[var(--color-text-muted)]">{SPLASHTOP_COPY.noTargets}</p> : null}
        {shown.length > 0 ? (
          <ul aria-label="Targets" className="max-h-[300px] divide-y divide-[var(--color-border-soft)] overflow-auto rounded-lg ring-1 ring-[var(--color-border-soft)]">
            {shown.map((target) => {
              const checked = selected.includes(target.id);
              return (
                <li key={target.id} className="px-3 py-2 text-sm">
                  <label className="flex items-start gap-2.5">
                    <input type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= SPLASHTOP_CHANGE_TARGET_LIMIT)} onChange={() => toggle(target.id)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                    <span className="min-w-0">
                      <span className="block truncate text-[var(--color-text)]">{target.label}</span>
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">{[`id ${target.id}`, target.detail].filter(Boolean).join(" · ")}</span>
                    </span>
                  </label>
                  {renaming && checked ? (
                    <input
                      aria-label={SPLASHTOP_COPY.newName(target.label)}
                      value={names[target.id] ?? ""}
                      maxLength={64}
                      disabled={busy}
                      onChange={(event) => setNames((current) => ({ ...current, [target.id]: event.target.value }))}
                      className="ml-6 mt-1.5 h-8 w-[calc(100%-1.5rem)] rounded-md bg-[var(--color-bg-raised)] px-2.5 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {renaming && nameProblems.length > 0 && selected.some((id) => (names[id] ?? "").length > 0) ? (
          <p className="text-sm text-[var(--color-warning)]">{nameProblems[0]}</p>
        ) : null}
        <ErrorBox message={error} />
        {busy ? <p role="status" className="text-sm text-[var(--color-text-muted)]">{SPLASHTOP_COPY.preparing}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{SPLASHTOP_COPY.cancel}</Button>
          <Button variant="primary" disabled={!ready} onClick={prepare}>{SPLASHTOP_COPY.prepare}</Button>
        </div>
      </div>
    </Modal>
  );
}
