import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "../components/Button";
import { IconLogo } from "../components/icons";
import { MODEL_SCAN_COPY, providerDataLocation } from "../copy";
import type { ModelScanOutcome, ModelScanProbe, ModelScanResult, ProviderId } from "../shared/openAdminOS";
import { useAppState } from "../state";
import { useSetupFlow } from "./SetupFlowContext";

/**
 * The first-launch model scan (SPEC.md 4a, first launch): a full-window
 * screen that checks this device for model runtimes and signed-in AI tools,
 * every check in parallel, and shows each one resolve. It runs once on a
 * fresh install, before anything else, and again from Settings, Providers.
 */

interface ModelScanContextValue {
  /** Opens the scan screen again, from Settings, Providers. */
  openScan(): void;
}

const ModelScanContext = createContext<ModelScanContextValue | null>(null);

export function useModelScan(): ModelScanContextValue {
  const value = useContext(ModelScanContext);
  if (!value) throw new Error("useModelScan must be used inside ModelScanGate.");
  return value;
}

/** Shows the scan screen in place of the shell on a fresh install, or when opened again. */
export function ModelScanGate({ children }: { children: ReactNode }) {
  const { state, loading } = useAppState();
  const location = useLocation();
  const [manual, setManual] = useState(false);
  // Decided once, when app state first loads: later reloads (the scan
  // refreshes state as it selects a provider) never close or restart it.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const supported = typeof window.openAdminOS?.startModelScan === "function";
  useEffect(() => {
    if (loading || firstRun !== null) return;
    setFirstRun(supported && state.firstRunScanPending === true && !location.pathname.startsWith("/companion"));
  }, [firstRun, loading, location.pathname, state.firstRunScanPending, supported]);
  const open = supported && (firstRun === true || manual);
  const value = useMemo<ModelScanContextValue>(() => ({ openScan: () => setManual(true) }), []);
  return (
    <ModelScanContext.Provider value={value}>
      {open ? (
        <ModelScanScreen
          firstRun={firstRun === true}
          onClose={() => {
            setManual(false);
            setFirstRun(false);
          }}
        />
      ) : (
        children
      )}
    </ModelScanContext.Provider>
  );
}

/** The minimum time a check shows as running, staggered, so the scan reads as one sequence. */
const REVEAL_BASE_MS = 520;
const REVEAL_STEP_MS = 190;

function prefersReducedMotion(): boolean {
  try {
    return (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
      document.documentElement.hasAttribute("data-reduced-motion")
    );
  } catch {
    return false;
  }
}

export function ModelScanScreen({ firstRun, onClose }: { firstRun: boolean; onClose: () => void }) {
  const api = window.openAdminOS;
  const navigate = useNavigate();
  const { refresh, setActiveProvider } = useAppState();
  const { startPilot } = useSetupFlow();
  const [probes, setProbes] = useState<ModelScanProbe[]>([]);
  const [shown, setShown] = useState<Record<string, ModelScanProbe>>({});
  const [result, setResult] = useState<ModelScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [run, setRun] = useState(0);
  const timers = useRef<number[]>([]);
  const reduced = useMemo(prefersReducedMotion, []);

  // Every check is listed as soon as the scan starts; each result is held
  // until its staggered reveal time, so fast checks do not flash past.
  useEffect(() => {
    if (!api?.startModelScan) return;
    let cancelled = false;
    const started = performance.now();
    const order: string[] = [];
    setProbes([]);
    setShown({});
    setResult(null);
    setScanError(null);
    const reveal = (probe: ModelScanProbe) => {
      if (probe.state === "checking") {
        if (!order.includes(probe.providerId)) order.push(probe.providerId);
        setProbes((current) => (current.some((entry) => entry.providerId === probe.providerId) ? current : [...current, probe]));
        return;
      }
      const index = Math.max(0, order.indexOf(probe.providerId));
      const wait = reduced ? 0 : Math.max(0, started + REVEAL_BASE_MS + index * REVEAL_STEP_MS - performance.now());
      const show = () => {
        if (cancelled) return;
        setShown((current) => ({ ...current, [probe.providerId]: probe }));
        setAnnouncement(MODEL_SCAN_COPY.announce(probe.name, probe.summary));
      };
      if (wait === 0) show();
      else timers.current.push(window.setTimeout(show, wait));
    };
    const unsubscribe = api.onModelScanProgress?.(reveal);
    void api
      .startModelScan()
      .then((scan) => {
        if (cancelled) return;
        // A renderer without progress events still gets every result.
        for (const probe of scan.probes) {
          if (!order.includes(probe.providerId)) reveal({ ...probe, state: "checking" });
          reveal(probe);
        }
        setResult(scan);
        void refresh();
      })
      .catch((caught: unknown) => {
        if (!cancelled) setScanError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
    };
  }, [api, reduced, refresh, run]);

  const rows = probes.map((probe) => shown[probe.providerId] ?? probe);
  const resolved = rows.filter((probe) => probe.state !== "checking").length;
  const done = Boolean(result) && rows.length > 0 && resolved === rows.length;

  // Announced once per scan, when it settles; a retry announces its own result.
  const announcedResult = useRef<ModelScanResult | null>(null);
  useEffect(() => {
    if (!done || !result || announcedResult.current === result) return;
    announcedResult.current = result;
    setAnnouncement(MODEL_SCAN_COPY.finishedAnnouncement(outcomeTitle(result.outcome, rows)));
  }, [done, result, rows]);

  const retry = async (providerId: ProviderId) => {
    if (!api?.retryModelScanProbe) return;
    const current = rows.find((probe) => probe.providerId === providerId);
    if (!current) return;
    setShown((all) => ({ ...all, [providerId]: { ...current, state: "checking", summary: "Checking", facts: [] } }));
    try {
      const probe = await api.retryModelScanProbe(providerId);
      setShown((all) => ({ ...all, [providerId]: probe }));
      setAnnouncement(MODEL_SCAN_COPY.announce(probe.name, probe.summary));
      await refresh();
    } catch (caught) {
      setShown((all) => ({
        ...all,
        [providerId]: { ...current, state: "could-not-check", summary: MODEL_SCAN_COPY.couldNotCheck, facts: [caught instanceof Error ? caught.message : String(caught)] },
      }));
    }
  };

  const finish = async (to: string | null) => {
    setActionError(null);
    try {
      if (firstRun) await api?.completeFirstRunScan?.();
      await refresh();
      onClose();
      if (to) navigate(to);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const useHosted = async (providerId: ProviderId) => {
    setBusy(providerId);
    setActionError(null);
    try {
      await setActiveProvider(providerId);
      await finish("/chat");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    setBusy("preview");
    setActionError(null);
    try {
      if (firstRun) await api?.completeFirstRunScan?.();
      await startPilot();
      onClose();
    } catch (caught) {
      setActionError(MODEL_SCAN_COPY.previewFailed(caught instanceof Error ? caught.message : String(caught)));
    } finally {
      setBusy(null);
    }
  };

  const platform = api?.platform;
  const draggable = platform === "macos" || platform === "windows";
  const targets = [...new Set(rows.map((probe) => probe.target))];

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header
        className={`flex h-[52px] shrink-0 items-center gap-2 px-4 ${draggable ? "app-region-drag" : ""} ${platform === "macos" ? "pl-[92px]" : ""}`}
        style={platform === "windows" ? { paddingRight: 140 } : undefined}
      >
        <IconLogo size={21} className="text-[var(--color-text)]" />
        <span className="font-semibold tracking-[-0.01em]">OpenAdminOS</span>
      </header>
      <main id="main-content" aria-labelledby="model-scan-heading" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid min-h-full w-full max-w-[1120px] grid-cols-1 content-start gap-x-16 gap-y-10 px-6 pb-12 pt-[9vh] min-[920px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[920px]:px-10">
          <section className="min-w-0 self-start min-[920px]:sticky min-[920px]:top-10">
            <h1 id="model-scan-heading" className="font-serif text-[2.6rem] font-medium leading-[1.08] tracking-[-0.02em] text-[var(--color-text)]">
              {done ? MODEL_SCAN_COPY.titleDone : MODEL_SCAN_COPY.title}
            </h1>
            <p className="mt-4 max-w-[46ch] text-md leading-6 text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.subtitle}</p>
            {scanError ? (
              <div role="alert" className="mt-8 max-w-[46ch] rounded-xl bg-[var(--color-warning-soft)] p-4 text-sm leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                <p className="font-medium">{MODEL_SCAN_COPY.scanFailed}</p>
                <p className="mt-1">{scanError}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setRun((value) => value + 1)}>
                    {MODEL_SCAN_COPY.scanAgain}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void finish("/chat")}>
                    {MODEL_SCAN_COPY.continueToChat}
                  </Button>
                </div>
              </div>
            ) : done && result ? (
              <ScanOutcome
                result={result}
                rows={rows}
                busy={busy}
                onUseHosted={(id) => void useHosted(id)}
                onOpenChat={() => void finish("/chat")}
                onSetUp={() => void finish("/settings/providers")}
                onScanAgain={() => setRun((value) => value + 1)}
              />
            ) : null}
            {actionError ? (
              <p role="alert" className="mt-4 max-w-[46ch] text-sm text-[var(--color-danger)]">
                {actionError}
              </p>
            ) : null}
            {done || scanError ? (
              <p className="mt-6 text-sm text-[var(--color-text-muted)]">
                {MODEL_SCAN_COPY.previewPrefix}{" "}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void preview()}
                  className="rounded font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  {MODEL_SCAN_COPY.previewLink}
                </button>{" "}
                {MODEL_SCAN_COPY.previewSuffix}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="model-scan-list-heading" className="min-w-0">
            <div className="flex items-baseline justify-between gap-4 pb-3">
              <h2 id="model-scan-list-heading" className="text-sm font-medium text-[var(--color-text-soft)]">
                {MODEL_SCAN_COPY.listHeading}
              </h2>
              <span className="text-sm tabular-nums text-[var(--color-text-muted)]" aria-hidden="true">
                {MODEL_SCAN_COPY.progress(resolved, rows.length)}
              </span>
            </div>
            <ul className="border-t border-[var(--color-border)]" aria-busy={!done}>
              {rows.map((probe, index) => (
                <ScanRow key={probe.providerId} probe={probe} index={index} onRetry={() => void retry(probe.providerId)} />
              ))}
            </ul>
            {done ? (
              <p className="scan-resolve mt-4 text-sm leading-5 text-[var(--color-text-muted)]">
                {MODEL_SCAN_COPY.ledger(targets)}
              </p>
            ) : null}
          </section>
        </div>
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function ScanRow({ probe, index, onRetry }: { probe: ModelScanProbe; index: number; onRetry: () => void }) {
  const ready = probe.state === "found" && probe.ready;
  const tone =
    probe.state === "checking"
      ? "checking"
      : probe.state === "could-not-check"
        ? "warning"
        : probe.state === "not-found"
          ? "muted"
          : ready
            ? "ready"
            : "found";
  return (
    <li
      data-state={probe.state}
      data-tone={tone}
      className="scan-row relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 py-3.5 min-[560px]:grid-cols-[22px_minmax(9rem,11rem)_minmax(0,1fr)]"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <span className="scan-mark mt-[3px]" aria-hidden="true" />
      <span className="text-base font-medium text-[var(--color-text)]">
        {probe.name}
        <span className="sr-only">
          {probe.state === "checking" ? `, ${MODEL_SCAN_COPY.checking}` : `, ${probe.summary}`}
        </span>
      </span>
      <div className="col-start-2 min-w-0 min-[560px]:col-start-3" aria-hidden={probe.state === "checking"}>
        {probe.state === "checking" ? (
          <span className="block truncate font-mono text-sm text-[var(--color-text-muted)]">{probe.target}</span>
        ) : (
          <div key={probe.state} className="scan-resolve">
            <span className={`text-base ${tone === "muted" ? "text-[var(--color-text-muted)]" : tone === "warning" ? "text-[var(--color-warning)]" : "text-[var(--color-text)]"}`} aria-hidden="true">
              {probe.summary}
            </span>
            {probe.facts.length > 0 && probe.state !== "not-found" ? (
              <ul className="mt-1 space-y-0.5 text-sm leading-5 text-[var(--color-text-muted)]">
                {probe.facts.map((fact) => (
                  <li key={fact} className={probe.models.includes(fact) ? "font-mono text-xs" : undefined}>
                    <InlineCode text={fact} />
                  </li>
                ))}
              </ul>
            ) : null}
            {probe.state === "could-not-check" ? (
              <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry} aria-label={MODEL_SCAN_COPY.retryLabel(probe.name)}>
                {MODEL_SCAN_COPY.retry}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <span className="scan-line" aria-hidden="true" />
    </li>
  );
}

/** Renders `backticked` commands in the mono face. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={index} className="font-mono text-[0.92em] text-[var(--color-text-soft)]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const linkClass =
  "rounded font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]";

function modelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return /(^|\/)openadmin-8b(:|$)/.test(model) ? "OpenAdmin 8B" : model;
}

function outcomeTitle(outcome: ModelScanOutcome, rows: readonly ModelScanProbe[]): string {
  if (outcome.kind === "local-selected" || outcome.kind === "local-ready") {
    const probe = rows.find((entry) => entry.providerId === outcome.providerId);
    return MODEL_SCAN_COPY.localTitle(modelName(outcome.model) ?? probe?.name ?? outcome.providerId);
  }
  if (outcome.kind === "hosted-detected") return MODEL_SCAN_COPY.hostedTitle;
  return MODEL_SCAN_COPY.nothingTitle;
}

function ScanOutcome({
  result,
  rows,
  busy,
  onUseHosted,
  onOpenChat,
  onSetUp,
  onScanAgain,
}: {
  result: ModelScanResult;
  rows: readonly ModelScanProbe[];
  busy: string | null;
  onUseHosted: (id: ProviderId) => void;
  onOpenChat: () => void;
  onSetUp: () => void;
  onScanAgain: () => void;
}) {
  const { outcome } = result;
  const title = outcomeTitle(outcome, rows);
  const installedNotRunning = rows.find((probe) => probe.where === "local" && probe.state === "found" && !probe.ready);
  return (
    <section aria-labelledby="model-scan-outcome" className="scan-resolve mt-9 max-w-[46ch] border-t border-[var(--color-border)] pt-6">
      <h2 id="model-scan-outcome" className="text-lg font-medium text-[var(--color-text)]">
        {title}
      </h2>
      {outcome.kind === "local-selected" || outcome.kind === "local-ready" ? (
        <>
          <p className="mt-2 text-base leading-6 text-[var(--color-text-soft)]">
            {MODEL_SCAN_COPY.localBody(
              modelName(outcome.model) ?? "the model",
              rows.find((probe) => probe.providerId === outcome.providerId)?.name ?? outcome.providerId,
            )}
          </p>
          <p className="mt-1 text-sm text-[var(--color-success)]">{MODEL_SCAN_COPY.nothingLeaves}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" onClick={onOpenChat}>
              {MODEL_SCAN_COPY.openChat}
            </Button>
          </div>
        </>
      ) : outcome.kind === "hosted-detected" ? (
        <>
          <p className="mt-2 text-base leading-6 text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.hostedBody}</p>
          <ul className="mt-4 space-y-3">
            {outcome.providerIds.map((id, index) => {
              const probe = rows.find((entry) => entry.providerId === id);
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-base font-medium text-[var(--color-text)]">{probe?.name ?? id}</div>
                    <div className="text-sm text-[var(--color-warning)]">{MODEL_SCAN_COPY.hostedWhere(providerDataLocation({ id, name: probe?.name ?? id }))}</div>
                  </div>
                  <Button variant={index === 0 ? "primary" : "secondary"} size="sm" disabled={busy !== null} onClick={() => onUseHosted(id)}>
                    {MODEL_SCAN_COPY.useHosted(probe?.name ?? id)}
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="mt-5 text-sm leading-5 text-[var(--color-text-muted)]">
            {MODEL_SCAN_COPY.keepLocalPrefix}{" "}
            <button type="button" onClick={onSetUp} className="rounded font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
              {MODEL_SCAN_COPY.setUpOpenAdmin}
            </button>
            .
          </p>
          <p className="mt-4 text-sm">
            <button type="button" onClick={onOpenChat} className={linkClass}>
              {MODEL_SCAN_COPY.continueWithoutModel}
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-base leading-6 text-[var(--color-text-soft)]">
            {installedNotRunning ? MODEL_SCAN_COPY.nothingRunningBody(installedNotRunning.name) : MODEL_SCAN_COPY.nothingBody}
          </p>
          <code className="mt-3 inline-block rounded-md bg-[var(--color-bg-raised)] px-2 py-1 font-mono text-sm text-[var(--color-text)]">
            {MODEL_SCAN_COPY.installCommand}
          </code>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" onClick={onSetUp}>
              {MODEL_SCAN_COPY.setUpOpenAdminAction}
            </Button>
            <Button variant="secondary" onClick={onSetUp}>
              {MODEL_SCAN_COPY.allProviders}
            </Button>
            <Button variant="ghost" onClick={onScanAgain}>
              {MODEL_SCAN_COPY.scanAgain}
            </Button>
          </div>
          <p className="mt-4 text-sm">
            <button type="button" onClick={onOpenChat} className={linkClass}>
              {MODEL_SCAN_COPY.continueWithoutModel}
            </button>
          </p>
        </>
      )}
    </section>
  );
}

/** Settings, Providers: run the scan again. */
export function ScanAgainButton() {
  const scan = useContext(ModelScanContext);
  const supported = typeof window.openAdminOS?.startModelScan === "function";
  const handle = useCallback(() => scan?.openScan(), [scan]);
  if (!supported || !scan) return null;
  return (
    <Button size="sm" variant="ghost" onClick={handle}>
      {MODEL_SCAN_COPY.scanAgain}
    </Button>
  );
}
