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

/**
 * The scan as one orchestrated sequence: the device tile springs in, rings
 * radiate while every check runs, nodes appear and resolve one by one, and
 * at the settle the result hero slides in. Skippable; reduced motion shows
 * the settled state. Timings are minimums: a slow check resolves when it
 * answers.
 */
const NODE_APPEAR_MS = 300;
const NODE_APPEAR_STEP_MS = 70;
const REVEAL_BASE_MS = 900;
const REVEAL_STEP_MS = 170;
const SETTLE_AFTER_MS = 450;

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

const INITIALS: Partial<Record<ProviderId, string>> = {
  ollama: "Ol",
  "lm-studio": "LM",
  "apple-foundation": "Ai",
  anthropic: "Cc",
  openai: "Cx",
  copilot: "Gh",
  gemini: "Ge",
  "azure-openai": "Az",
};

type NodeTone = "checking" | "ready" | "installed" | "muted" | "warning" | "starting";

function toneOf(probe: ModelScanProbe, starting: boolean): NodeTone {
  if (starting) return "starting";
  if (probe.state === "checking") return "checking";
  if (probe.state === "could-not-check") return "warning";
  if (probe.state === "not-found") return "muted";
  return probe.ready ? "ready" : "installed";
}

function modelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return /(^|\/)openadmin-8b(:|$)/.test(model) ? "OpenAdmin 8B" : model;
}

type Recommendation =
  | { kind: "local"; providerId: ProviderId; title: string; runtime: string }
  | { kind: "switch"; providerId: ProviderId; model?: string; title: string; runtime: string; selectedProviderId: ProviderId }
  | { kind: "hosted"; providerId: ProviderId; title: string; others: ProviderId[]; startable?: ModelScanProbe }
  | { kind: "start"; probe: ModelScanProbe }
  | { kind: "nothing" };

/** The one choice the result leads with, under the provider rules. */
export function recommend(outcome: ModelScanOutcome, rows: readonly ModelScanProbe[]): Recommendation {
  const startable = rows.find((probe) => (probe.providerId === "ollama" || probe.providerId === "lm-studio") && probe.state === "found" && !probe.ready && probe.summary === "Installed, not running");
  if (outcome.kind === "local-selected" || outcome.kind === "local-ready") {
    const runtime = rows.find((probe) => probe.providerId === outcome.providerId)?.name ?? outcome.providerId;
    return { kind: "local", providerId: outcome.providerId, title: modelName(outcome.model) ?? runtime, runtime };
  }
  if (outcome.kind === "local-available") {
    const runtime = rows.find((probe) => probe.providerId === outcome.providerId)?.name ?? outcome.providerId;
    return { kind: "switch", providerId: outcome.providerId, ...(outcome.model ? { model: outcome.model } : {}), title: modelName(outcome.model) ?? runtime, runtime, selectedProviderId: outcome.selectedProviderId };
  }
  if (outcome.kind === "hosted-detected") {
    const [first, ...others] = outcome.providerIds;
    const title = rows.find((probe) => probe.providerId === first)?.name ?? first!;
    return { kind: "hosted", providerId: first!, title, others, ...(startable ? { startable } : {}) };
  }
  if (startable) return { kind: "start", probe: startable };
  return { kind: "nothing" };
}

export function ModelScanScreen({ firstRun, onClose }: { firstRun: boolean; onClose: () => void }) {
  const api = window.openAdminOS;
  const navigate = useNavigate();
  const { refresh, setActiveProvider } = useAppState();
  const { startPilot } = useSetupFlow();
  const reduced = useMemo(prefersReducedMotion, []);
  const [probes, setProbes] = useState<ModelScanProbe[]>([]);
  const [shown, setShown] = useState<Record<string, ModelScanProbe>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<ModelScanResult | null>(null);
  const [settled, setSettled] = useState(false);
  const [skipped, setSkipped] = useState(reduced);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ providerId: ProviderId; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [run, setRun] = useState(0);
  const timers = useRef<number[]>([]);
  const skippedRef = useRef(skipped);
  skippedRef.current = skipped;
  const pending = useRef<ModelScanProbe[]>([]);

  const later = (ms: number, task: () => void) => {
    if (ms <= 0 || skippedRef.current) task();
    else timers.current.push(window.setTimeout(task, ms));
  };

  // Every check is listed as soon as the scan starts; each node appears and
  // each result is held until its staggered time, so the scan reads as one
  // sequence. Skipping shows whatever has arrived at once.
  useEffect(() => {
    if (!api?.startModelScan) return;
    let cancelled = false;
    const started = performance.now();
    const order: string[] = [];
    setProbes([]);
    setShown({});
    setVisible({});
    setResult(null);
    setSettled(false);
    setScanError(null);
    pending.current = [];
    const elapsed = () => performance.now() - started;
    const reveal = (probe: ModelScanProbe) => {
      if (cancelled) return;
      if (probe.state === "checking") {
        if (order.includes(probe.providerId)) return;
        order.push(probe.providerId);
        const index = order.length - 1;
        setProbes((current) => [...current, probe]);
        later(NODE_APPEAR_MS + index * NODE_APPEAR_STEP_MS - elapsed(), () => {
          if (!cancelled) setVisible((current) => ({ ...current, [probe.providerId]: true }));
        });
        return;
      }
      const index = Math.max(0, order.indexOf(probe.providerId));
      pending.current.push(probe);
      later(REVEAL_BASE_MS + index * REVEAL_STEP_MS - elapsed(), () => {
        if (cancelled) return;
        setVisible((current) => ({ ...current, [probe.providerId]: true }));
        setShown((current) => ({ ...current, [probe.providerId]: probe }));
        setAnnouncement(MODEL_SCAN_COPY.announce(probe.name, probe.summary));
      });
    };
    const unsubscribe = api.onModelScanProgress?.(reveal);
    void api
      .startModelScan()
      .then((scan) => {
        if (cancelled) return;
        for (const probe of scan.probes) {
          if (!order.includes(probe.providerId)) reveal({ ...probe, state: "checking" });
          if (!pending.current.some((entry) => entry.providerId === probe.providerId)) reveal(probe);
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
    // `later` reads the skip state through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refresh, run]);

  const rows = probes.map((probe) => shown[probe.providerId] ?? probe);
  const resolved = rows.filter((probe) => probe.state !== "checking").length;
  const allResolved = Boolean(result) && rows.length > 0 && resolved === rows.length;

  // Skipping flushes every result that has arrived and settles at once.
  const skip = useCallback(() => {
    if (skippedRef.current) return;
    skippedRef.current = true;
    setSkipped(true);
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    setVisible(Object.fromEntries(probes.map((probe) => [probe.providerId, true])));
    setShown((current) => ({ ...current, ...Object.fromEntries(pending.current.map((probe) => [probe.providerId, probe])) }));
  }, [probes]);

  useEffect(() => {
    if (!allResolved) return;
    if (skipped) {
      setSettled(true);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), SETTLE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [allResolved, skipped]);

  useEffect(() => {
    if (settled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter" || event.key === " ") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settled, skip]);

  // Announced once per scan, when it settles; a retry or a start announces its own result.
  const announcedResult = useRef<ModelScanResult | null>(null);
  useEffect(() => {
    if (!settled || !result || announcedResult.current === result) return;
    announcedResult.current = result;
    const pick = recommend(result.outcome, rows);
    setAnnouncement(MODEL_SCAN_COPY.finishedAnnouncement(heroTitle(pick)));
  }, [settled, result, rows]);

  const retry = async (providerId: ProviderId) => {
    if (!api?.retryModelScanProbe) return;
    const current = rows.find((probe) => probe.providerId === providerId);
    if (!current) return;
    setShown((all) => ({ ...all, [providerId]: { ...current, state: "checking", summary: "Checking", facts: [] } }));
    try {
      // The retry returns the whole scan, so a check that now succeeds changes what the result leads with.
      const scan = await api.retryModelScanProbe(providerId);
      announcedResult.current = scan;
      setShown(Object.fromEntries(scan.probes.map((entry) => [entry.providerId, entry])));
      setResult(scan);
      const probe = scan.probes.find((entry) => entry.providerId === providerId);
      if (probe) setAnnouncement(MODEL_SCAN_COPY.announce(probe.name, probe.summary));
      await refresh();
    } catch (caught) {
      setShown((all) => ({
        ...all,
        [providerId]: { ...current, state: "could-not-check", summary: MODEL_SCAN_COPY.couldNotCheck, facts: [caught instanceof Error ? caught.message : String(caught)] },
      }));
    }
  };

  const start = async (probe: ModelScanProbe) => {
    if (!api?.startLocalRuntime) return;
    setBusy(`start:${probe.providerId}`);
    setStartError(null);
    setAnnouncement(MODEL_SCAN_COPY.starting(probe.name));
    try {
      const outcome = await api.startLocalRuntime(probe.providerId);
      // The start announces its own result, not the settled scan again.
      announcedResult.current = outcome.scan;
      setShown(Object.fromEntries(outcome.scan.probes.map((entry) => [entry.providerId, entry])));
      setResult(outcome.scan);
      if (outcome.started) setAnnouncement(MODEL_SCAN_COPY.started(probe.name));
      else {
        const message = outcome.message ?? MODEL_SCAN_COPY.startFailed(probe.name);
        setStartError({ providerId: probe.providerId, message });
        setAnnouncement(message);
      }
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setStartError({ providerId: probe.providerId, message });
      setAnnouncement(message);
    } finally {
      setBusy(null);
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

  // An explicit switch to a local model the admin did not choose before.
  const switchLocal = async (providerId: ProviderId, model?: string) => {
    setBusy(providerId);
    setActionError(null);
    try {
      await setActiveProvider(providerId);
      if (model) await api?.setActiveModel?.(providerId, model);
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
  const pick = settled && result ? recommend(result.outcome, rows) : null;
  const startingId = busy?.startsWith("start:") ? busy.slice(6) : null;

  return (
    <div
      className="scan-screen flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]"
      data-motion={reduced ? "reduced" : "full"}
      data-phase={scanError ? "error" : settled ? "settled" : "scanning"}
    >
      <header
        className={`flex h-[52px] shrink-0 items-center gap-2 px-4 ${draggable ? "app-region-drag" : ""} ${platform === "macos" ? "pl-[92px]" : ""}`}
        style={platform === "windows" ? { paddingRight: 140 } : undefined}
      >
        <IconLogo size={21} className="text-[var(--color-text)]" />
        <span className="font-semibold tracking-[-0.01em]">OpenAdminOS</span>
        <span className="flex-1" />
        {!settled && !scanError ? (
          <button type="button" onClick={skip} className="app-region-no-drag rounded-md px-2 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
            {MODEL_SCAN_COPY.skip}
          </button>
        ) : null}
      </header>
      <main id="main-content" aria-labelledby="model-scan-heading" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-1 items-start gap-x-12 gap-y-6 px-6 pb-10 pt-6 min-[900px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[900px]:px-10">
          <ScanStage rows={rows} visible={visible} settled={settled} startingId={startingId} onSkip={skip} />

          <section className="min-w-0 self-center" aria-labelledby="model-scan-heading">
            {pick ? (
              <ScanHero
                key={`${pick.kind}:${result?.finishedAt ?? ""}`}
                pick={pick}
                rows={rows}
                busy={busy}
                startError={startError}
                onUseHosted={(id) => void useHosted(id)}
                onSwitchLocal={(id, model) => void switchLocal(id, model)}
                onOpenChat={() => void finish("/chat")}
                onSetUp={() => void finish("/settings/providers")}
                onStart={(probe) => void start(probe)}
              />
            ) : (
              <div>
                <h1 id="model-scan-heading" className="font-serif text-[2.75rem] font-medium leading-[1.05] tracking-[-0.022em]">
                  {MODEL_SCAN_COPY.title}
                </h1>
                <p className="mt-4 max-w-[42ch] text-md leading-6 text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.subtitle}</p>
                <p className="mt-7 font-serif text-[1.65rem] tabular-nums leading-none text-[var(--color-text)]" aria-hidden="true">
                  {MODEL_SCAN_COPY.progress(resolved, rows.length)}
                </p>
                {scanError ? (
                  <div role="alert" className="mt-8 max-w-[44ch] rounded-xl bg-[var(--color-warning-soft)] p-4 text-sm leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
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
                ) : null}
              </div>
            )}
            {actionError ? (
              <p role="alert" className="mt-4 max-w-[46ch] text-sm text-[var(--color-danger)]">
                {actionError}
              </p>
            ) : null}
            {settled || scanError ? (
              <p className="scan-hero-in mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-text-muted)]" style={{ animationDelay: "160ms" }}>
                <button type="button" onClick={() => void finish("/chat")} className={linkClass}>
                  {MODEL_SCAN_COPY.continueWithoutModel}
                </button>
                <span>
                  {MODEL_SCAN_COPY.previewPrefix}{" "}
                  <button type="button" disabled={busy !== null} onClick={() => void preview()} className={linkClass}>
                    {MODEL_SCAN_COPY.previewLink}
                  </button>
                </span>
              </p>
            ) : null}

            <section aria-labelledby="model-scan-list-heading" className="mt-8">
              <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] pb-2">
                <h2 id="model-scan-list-heading" className="text-sm font-medium text-[var(--color-text-soft)]">
                  {MODEL_SCAN_COPY.listHeading}
                </h2>
                {settled ? (
                  <button type="button" onClick={() => setRun((value) => value + 1)} className={`${linkClass} text-sm`}>
                    {MODEL_SCAN_COPY.scanAgain}
                  </button>
                ) : null}
              </div>
              <ul aria-busy={!settled} className="divide-y divide-[var(--color-border-soft)]">
                {rows.map((probe) => (
                  <ScanRow
                    key={probe.providerId}
                    probe={probe}
                    starting={startingId === probe.providerId}
                    canStart={Boolean(api?.startLocalRuntime) && (probe.providerId === "ollama" || probe.providerId === "lm-studio") && probe.summary === "Installed, not running"}
                    onRetry={() => void retry(probe.providerId)}
                    onStart={() => void start(probe)}
                  />
                ))}
              </ul>
              {settled ? <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.ledger(targets)}</p> : null}
            </section>
          </section>
        </div>
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

/** The radial map: this device in the centre, each tool a node on the orbit. Decorative; the list is the accessible source. */
function ScanStage({
  rows,
  visible,
  settled,
  startingId,
  onSkip,
}: {
  rows: readonly ModelScanProbe[];
  visible: Record<string, boolean>;
  settled: boolean;
  startingId: string | null;
  onSkip: () => void;
}) {
  const count = Math.max(rows.length, 1);
  const position = (index: number) => {
    const angle = (-90 + (index * 360) / count) * (Math.PI / 180);
    return { x: 50 + 38 * Math.cos(angle), y: 50 + 38 * Math.sin(angle), angle };
  };
  return (
    <div className="scan-stage relative mx-auto aspect-square w-full max-w-[540px] select-none min-[900px]:sticky min-[900px]:top-4 min-[900px]:self-start" aria-hidden="true" onClick={settled ? undefined : onSkip}>
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100">
        <circle className="scan-orbit" cx="50" cy="50" r="38" />
        <circle className="scan-orbit scan-orbit-inner" cx="50" cy="50" r="22" />
        <g className="scan-rings">
          <circle className="scan-ring" cx="50" cy="50" r="38" />
          <circle className="scan-ring" cx="50" cy="50" r="38" style={{ animationDelay: "0.55s" }} />
          <circle className="scan-ring" cx="50" cy="50" r="38" style={{ animationDelay: "1.1s" }} />
        </g>
        <g className="scan-sweep">
          <line x1="50" y1="50" x2="50" y2="9" />
        </g>
        {rows.map((probe, index) => {
          const { angle } = position(index);
          const tone = toneOf(probe, startingId === probe.providerId);
          if (tone !== "ready" || !visible[probe.providerId]) return null;
          const from = { x: 50 + 10.5 * Math.cos(angle), y: 50 + 10.5 * Math.sin(angle) };
          const to = { x: 50 + 32.2 * Math.cos(angle), y: 50 + 32.2 * Math.sin(angle) };
          return (
            <line
              key={probe.providerId}
              className="scan-link"
              data-where={probe.where}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              pathLength={1}
            />
          );
        })}
      </svg>
      <div className="scan-device absolute left-1/2 top-1/2 flex h-[19%] w-[19%] items-center justify-center rounded-[26%] bg-[var(--color-surface)]">
        <IconLogo size={40} className="text-[var(--color-text)]" />
      </div>
      {rows.map((probe, index) => {
        const { x, y } = position(index);
        const tone = toneOf(probe, startingId === probe.providerId);
        return (
          <div
            key={probe.providerId}
            className="scan-node absolute flex w-[23%] flex-col items-center text-center"
            style={{ left: `${x}%`, top: `${y}%` }}
            data-tone={tone}
            data-where={probe.where}
            data-visible={visible[probe.providerId] ? "true" : "false"}
            data-settled={settled ? "true" : "false"}
          >
            <span className="scan-node-dot flex h-14 w-14 items-center justify-center rounded-full text-[15px] font-semibold tracking-[-0.01em]">
              {INITIALS[probe.providerId] ?? probe.name.slice(0, 2)}
            </span>
            <span className="mt-2 text-[13px] font-medium leading-4 text-[var(--color-text)]">{probe.name}</span>
            <span className="scan-node-status mt-0.5 text-xs leading-4">{probe.state === "checking" ? MODEL_SCAN_COPY.checking : probe.summary}</span>
          </div>
        );
      })}
    </div>
  );
}

function ScanRow({
  probe,
  starting,
  canStart,
  onRetry,
  onStart,
}: {
  probe: ModelScanProbe;
  starting: boolean;
  canStart: boolean;
  onRetry: () => void;
  onStart: () => void;
}) {
  const tone = toneOf(probe, starting);
  return (
    <li data-tone={tone} className="scan-list-row grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 py-2">
      <span className="scan-list-mark mt-[5px]" aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-[var(--color-text)]">{probe.name}</span>
          <span className={`text-sm ${tone === "muted" ? "text-[var(--color-text-muted)]" : tone === "warning" ? "text-[var(--color-warning)]" : "text-[var(--color-text-soft)]"}`}>
            {starting ? MODEL_SCAN_COPY.startingShort : probe.state === "checking" ? MODEL_SCAN_COPY.checking : probe.summary}
          </span>
          <span className="truncate font-mono text-xs text-[var(--color-text-muted)]">{probe.target}</span>
        </div>
        {probe.facts.length > 0 && probe.state !== "not-found" && probe.state !== "checking" ? (
          <ul className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">
            {probe.facts.map((fact) => (
              <li key={fact} className={probe.models.includes(fact) ? "font-mono" : undefined}>
                <InlineCode text={fact} />
              </li>
            ))}
          </ul>
        ) : null}
        {probe.state === "could-not-check" ? (
          <Button size="sm" variant="secondary" className="mt-1.5" onClick={onRetry} aria-label={MODEL_SCAN_COPY.retryLabel(probe.name)}>
            {MODEL_SCAN_COPY.retry}
          </Button>
        ) : canStart && !starting ? (
          <Button size="sm" variant="secondary" className="mt-1.5" onClick={onStart}>
            {MODEL_SCAN_COPY.start(probe.name)}
          </Button>
        ) : null}
      </div>
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

function heroTitle(pick: Recommendation): string {
  if (pick.kind === "local") return MODEL_SCAN_COPY.localTitle(pick.title);
  if (pick.kind === "switch") return MODEL_SCAN_COPY.availableTitle(pick.title);
  if (pick.kind === "hosted") return MODEL_SCAN_COPY.hostedReady(pick.title);
  if (pick.kind === "start") return MODEL_SCAN_COPY.installedTitle(pick.probe.name);
  return MODEL_SCAN_COPY.nothingTitle;
}

/** The result: the recommended choice large, its data line, one primary action, alternatives secondary. */
function ScanHero({
  pick,
  rows,
  busy,
  startError,
  onUseHosted,
  onSwitchLocal,
  onOpenChat,
  onSetUp,
  onStart,
}: {
  pick: Recommendation;
  rows: readonly ModelScanProbe[];
  busy: string | null;
  startError: { providerId: ProviderId; message: string } | null;
  onUseHosted: (id: ProviderId) => void;
  onSwitchLocal: (id: ProviderId, model?: string) => void;
  onOpenChat: () => void;
  onSetUp: () => void;
  onStart: (probe: ModelScanProbe) => void;
}) {
  const name = (id: ProviderId) => rows.find((probe) => probe.providerId === id)?.name ?? id;
  const startButton = (probe: ModelScanProbe, primary: boolean) => (
    <Button variant={primary ? "primary" : "secondary"} size={primary ? "md" : "sm"} disabled={busy !== null} onClick={() => onStart(probe)}>
      {busy === `start:${probe.providerId}` ? MODEL_SCAN_COPY.starting(probe.name) : MODEL_SCAN_COPY.start(probe.name)}
    </Button>
  );
  const failure = (id: ProviderId) =>
    startError?.providerId === id ? (
      <p role="alert" className="mt-3 max-w-[44ch] text-sm leading-5 text-[var(--color-warning)]">
        <InlineCode text={startError.message} />
      </p>
    ) : null;
  return (
    <div className="scan-hero-in">
      <p className="text-sm text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.heroLead(pick.kind)}</p>
      <h1 id="model-scan-heading" className="mt-2 font-serif text-[3.25rem] font-medium leading-[1] tracking-[-0.025em]">
        <span className="sr-only">{heroTitle(pick)}</span>
        <span aria-hidden="true">{pick.kind === "local" || pick.kind === "hosted" || pick.kind === "switch" ? pick.title : pick.kind === "start" ? pick.probe.name : MODEL_SCAN_COPY.nothingShort}</span>
      </h1>
      {pick.kind === "local" ? (
        <>
          <p className="mt-3 text-md text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.localLine(pick.runtime)}</p>
          <p className="mt-1 text-sm font-medium text-[var(--color-success)]">{MODEL_SCAN_COPY.nothingLeaves}</p>
          <div className="mt-6">
            <Button variant="primary" onClick={onOpenChat}>
              {MODEL_SCAN_COPY.openChat}
            </Button>
          </div>
        </>
      ) : pick.kind === "switch" ? (
        <>
          <p className="mt-3 max-w-[44ch] text-md leading-6 text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.availableLine(pick.runtime, name(pick.selectedProviderId))}</p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy !== null} onClick={() => onSwitchLocal(pick.providerId, pick.model)}>
              {MODEL_SCAN_COPY.useHosted(pick.title)}
            </Button>
            <Button variant="secondary" size="sm" onClick={onOpenChat}>
              {MODEL_SCAN_COPY.keepSelected(name(pick.selectedProviderId))}
            </Button>
          </div>
        </>
      ) : pick.kind === "hosted" ? (
        <>
          <p className="mt-3 max-w-[44ch] text-md leading-6 text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.hostedLine}</p>
          <p className="mt-1 text-sm font-medium text-[var(--color-warning)]">{MODEL_SCAN_COPY.hostedWhere(providerDataLocation({ id: pick.providerId, name: pick.title }))}</p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy !== null} onClick={() => onUseHosted(pick.providerId)}>
              {MODEL_SCAN_COPY.useHosted(pick.title)}
            </Button>
            {pick.others.map((id) => (
              <Button key={id} variant="secondary" size="sm" disabled={busy !== null} onClick={() => onUseHosted(id)}>
                {MODEL_SCAN_COPY.useHosted(name(id))}
              </Button>
            ))}
          </div>
          {pick.others.map((id) => (
            <p key={id} className="mt-2 text-xs text-[var(--color-warning)]">
              {MODEL_SCAN_COPY.hostedWhereNamed(name(id), providerDataLocation({ id, name: name(id) }))}
            </p>
          ))}
          {pick.startable ? (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--color-border-soft)] pt-4">
              <p className="text-sm text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.keepLocal(pick.startable.name)}</p>
              {startButton(pick.startable, false)}
            </div>
          ) : (
            <p className="mt-5 text-sm text-[var(--color-text-muted)]">
              {MODEL_SCAN_COPY.keepLocalPrefix}{" "}
              <button type="button" onClick={onSetUp} className={linkClass}>
                {MODEL_SCAN_COPY.setUpOpenAdmin}
              </button>
              .
            </p>
          )}
          {pick.startable ? failure(pick.startable.providerId) : null}
        </>
      ) : pick.kind === "start" ? (
        <>
          <p className="mt-3 max-w-[44ch] text-md leading-6 text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.installedLine}</p>
          <p className="mt-1 text-sm font-medium text-[var(--color-success)]">{MODEL_SCAN_COPY.nothingLeaves}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {startButton(pick.probe, true)}
            <Button variant="secondary" size="sm" onClick={onSetUp}>
              {MODEL_SCAN_COPY.allProviders}
            </Button>
          </div>
          {failure(pick.probe.providerId)}
        </>
      ) : (
        <>
          <p className="mt-3 max-w-[44ch] text-md leading-6 text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.nothingBody}</p>
          <code className="mt-3 inline-block rounded-md bg-[var(--color-bg-raised)] px-2 py-1 font-mono text-sm text-[var(--color-text)]">
            {MODEL_SCAN_COPY.installCommand}
          </code>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={onSetUp}>
              {MODEL_SCAN_COPY.setUpOpenAdminAction}
            </Button>
            <Button variant="secondary" size="sm" onClick={onSetUp}>
              {MODEL_SCAN_COPY.allProviders}
            </Button>
          </div>
        </>
      )}
    </div>
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
