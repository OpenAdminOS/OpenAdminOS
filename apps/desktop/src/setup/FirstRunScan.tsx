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
import { ModelChoiceList } from "../components/ModelChoiceList";
import { ProviderLogo, providerLogoKind } from "../components/ProviderLogo";
import { IconLogo } from "../components/icons";
import { DeviceTile } from "../components/DeviceTile";
import { MICROSOFT_STEP_COPY, MODEL_SCAN_COPY, deriveToolHostsCopy, providerDataLocationDetail } from "../copy";
import { chatToolHosts } from "../state/data-boundary";
import type { ModelScanOutcome, ModelScanProbe, ModelScanResult, ProviderId } from "../shared/openAdminOS";
import { useAppState } from "../state";
import { actionLabel, actionNote, modelDisplayName, optionsFromProbes, preselect, type ChoiceOption } from "./model-choice";
import { MicrosoftStepScreen } from "./MicrosoftStep";
import { isProviderReady } from "../shared/provider-detection";
import { OnboardingSteps } from "./OnboardingSteps";

/**
 * The first-launch model scan (SPEC.md 4a, first launch): a full-window
 * screen that checks this device for model runtimes and signed-in AI tools,
 * every check in parallel, and shows each one resolve. It runs once on a
 * fresh install, before anything else, and again from Settings, Providers.
 * On a fresh install the second step, Connect Microsoft 365, follows it
 * before Chat opens.
 */

interface ModelScanContextValue {
  /** Opens the scan screen again, from Settings, Providers. */
  openScan(): void;
  /** Opens the Connect Microsoft 365 step again. */
  openMicrosoftStep(): void;
}

const ModelScanContext = createContext<ModelScanContextValue | null>(null);

export function useModelScan(): ModelScanContextValue {
  const value = useContext(ModelScanContext);
  if (!value) throw new Error("useModelScan must be used inside ModelScanGate.");
  return value;
}

/** Shows the onboarding steps in place of the shell on a fresh install, or one of them when opened again. */
export function ModelScanGate({ children }: { children: ReactNode }) {
  const { state, loading, refresh } = useAppState();
  const location = useLocation();
  const navigate = useNavigate();
  const [manual, setManual] = useState<"model" | "microsoft" | null>(null);
  // On a fresh install the Microsoft 365 step follows the model step.
  // "handoff" waits one render for the state the scan refreshed before choosing.
  const [firstRunStep, setFirstRunStep] = useState<"model" | "handoff" | "microsoft">("model");
  // Decided once, when app state first loads: later reloads (the scan
  // refreshes state as it selects a provider) never close or restart it.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const supported = typeof window.openAdminOS?.startModelScan === "function";
  useEffect(() => {
    if (loading || firstRun !== null) return;
    setFirstRun(supported && state.firstRunScanPending === true && !location.pathname.startsWith("/companion"));
  }, [firstRun, loading, location.pathname, state.firstRunScanPending, supported]);
  // A first launch that left the scan for provider setup still owes Connect
  // Microsoft 365: it shows once a model is ready and the admin is outside
  // Settings, in this session or a later one, and stays open until it is left.
  const [deferredOpen, setDeferredOpen] = useState(false);
  const [deferredDone, setDeferredDone] = useState(false);
  const hasOrganization = state.tenants.length > 0;
  const modelReady = isProviderReady(state.providers.find((provider) => provider.id === state.activeProviderId));
  const deferredDue =
    supported &&
    firstRun === false &&
    manual === null &&
    !deferredDone &&
    state.firstRunMicrosoftStepPending === true &&
    !hasOrganization &&
    modelReady &&
    !location.pathname.startsWith("/settings") &&
    !location.pathname.startsWith("/companion");
  useEffect(() => {
    if (deferredDue && !deferredOpen) setDeferredOpen(true);
  }, [deferredDue, deferredOpen]);
  // Connected another way meanwhile: the deferred step is no longer owed.
  useEffect(() => {
    if (!supported || deferredOpen || deferredDone || state.firstRunMicrosoftStepPending !== true || !hasOrganization) return;
    setDeferredDone(true);
    void window.openAdminOS?.completeFirstRunMicrosoftStep?.().then(() => refresh());
  }, [deferredDone, deferredOpen, hasOrganization, refresh, state.firstRunMicrosoftStepPending, supported]);
  const screen = !supported ? null : firstRun === true ? firstRunStep : manual ?? (deferredOpen ? "deferred-microsoft" : null);
  // Until app state says whether the first-run scan is pending, show a quiet
  // surface rather than the shell, so nothing claims a provider not yet checked.
  const deciding = supported && firstRun === null && !location.pathname.startsWith("/companion");
  // Focus returns to whatever opened the scan when it closes.
  const invoker = useRef<HTMLElement | null>(null);
  const value = useMemo<ModelScanContextValue>(
    () => ({
      openScan: () => {
        invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setManual("model");
      },
      openMicrosoftStep: () => {
        invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setManual("microsoft");
      },
    }),
    [],
  );
  const close = (to: string | null) => {
    setManual(null);
    setFirstRun(false);
    const target = invoker.current;
    invoker.current = null;
    if (to) navigate(to);
    else if (target) window.setTimeout(() => target.focus(), 0);
  };
  // The scan leaving for Chat on a fresh install goes to the Microsoft 365
  // step instead, unless an organization is already connected.
  useEffect(() => {
    if (firstRunStep !== "handoff") return;
    if (hasOrganization) close("/chat");
    else setFirstRunStep("microsoft");
    // `close` only sets state and navigates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRunStep, hasOrganization]);
  return (
    <ModelScanContext.Provider value={value}>
      {deciding || screen === "handoff" ? (
        <div className="h-full w-full bg-[var(--color-bg)]" aria-busy="true" />
      ) : screen === "model" ? (
        <ModelScanScreen
          firstRun={firstRun === true}
          onClose={(to) => {
            if (firstRun === true && to === "/chat") setFirstRunStep("handoff");
            else close(to);
          }}
        />
      ) : screen === "microsoft" ? (
        <MicrosoftStepScreen firstRun={firstRun === true} onClose={close} />
      ) : screen === "deferred-microsoft" ? (
        <MicrosoftStepScreen
          firstRun
          onClose={(to) => {
            setDeferredOpen(false);
            setDeferredDone(true);
            void window.openAdminOS?.completeFirstRunMicrosoftStep?.().then(() => refresh());
            close(to);
          }}
        />
      ) : (
        children
      )}
    </ModelScanContext.Provider>
  );
}

/**
 * The scan as one orchestrated sequence of about 2.4 seconds: the device
 * tile springs in, two rings radiate and a sweep turns while every check
 * runs, nodes appear and resolve one by one, and at the settle the choice
 * rises in. Skippable; reduced motion shows the end state. Timings are
 * minimums: a slow check resolves when it answers.
 */
const NODE_APPEAR_MS = 240;
const NODE_APPEAR_STEP_MS = 60;
const REVEAL_BASE_MS = 760;
const REVEAL_STEP_MS = 160;
const SETTLE_AFTER_MS = 300;

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

type NodeTone = "checking" | "ready" | "installed" | "muted" | "unknown" | "starting";

function toneOf(probe: ModelScanProbe, starting: boolean): NodeTone {
  if (starting) return "starting";
  if (probe.state === "checking") return "checking";
  if (probe.state === "could-not-check") return "unknown";
  if (probe.state === "not-found") return "muted";
  return probe.ready ? "ready" : "installed";
}

/** The status under a node and in the check list: short, in the scan's words. */
function statusOf(probe: ModelScanProbe, starting: boolean): string {
  if (starting) return MODEL_SCAN_COPY.startingShort;
  if (probe.state === "checking") return MODEL_SCAN_COPY.checking;
  return probe.summary;
}

export function ModelScanScreen({ firstRun, onClose }: { firstRun: boolean; onClose: (to: string | null) => void }) {
  const api = window.openAdminOS;
  const { state, refresh, setActiveProvider } = useAppState();
  const reduced = useMemo(prefersReducedMotion, []);
  const [probes, setProbes] = useState<ModelScanProbe[]>([]);
  const [shown, setShown] = useState<Record<string, ModelScanProbe>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<ModelScanResult | null>(null);
  const [settled, setSettled] = useState(false);
  const [skipped, setSkipped] = useState(reduced);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // A failed Start is written under its own row, so a secondary runtime's failure is never lost.
  const [startErrors, setStartErrors] = useState<Partial<Record<ProviderId, string>>>({});
  const [retrying, setRetrying] = useState<ProviderId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Any action or Retry in progress: every exit and every other action waits for it.
  const activity: string | null = busy ?? (retrying ? `retry:${retrying}` : null);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  // Scan, Retry and Start results carry a host generation; an older one never overwrites a newer one.
  const latestGeneration = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
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
    setStartErrors({});
    setActionError(null);
    setSelected(null);
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
    // Only this run's progress is shown: an older scan's events are ignored.
    const scanId = window.crypto.randomUUID();
    const unsubscribe = api.onModelScanProgress?.((probe, id) => {
      if (id === scanId) reveal(probe);
    });
    void api
      .startModelScan(scanId)
      .then((scan) => {
        if (cancelled) return;
        if (scan.generation !== undefined) {
          if (scan.generation <= latestGeneration.current) return;
          latestGeneration.current = scan.generation;
        }
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
    // Only Escape skips: Enter and Space belong to whatever button has focus.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settled, skip]);

  const options = useMemo(() => (settled && result ? optionsFromProbes(rows, result.outcome) : []), [settled, result, rows]);
  // The choice opens on the first model on this device, in the same frame as
  // the result; the admin's own pick stays while a later result still offers it.
  const picked = selected && options.some((option) => option.providerId === selected && !option.unavailable) ? selected : preselect(options);
  const chosen = options.find((option) => option.providerId === picked);

  // Announced once per scan, when it settles; a retry or a start announces its own result.
  const announcedResult = useRef<ModelScanResult | null>(null);
  useEffect(() => {
    if (!settled || !result || announcedResult.current === result) return;
    announcedResult.current = result;
    setAnnouncement(MODEL_SCAN_COPY.finishedAnnouncement(resultTitle(result.outcome, options, chosen)));
  }, [settled, result, options, chosen]);

  /** Applies a Retry or Start rescan unless a newer result is already shown. */
  const applyScan = (scan: ModelScanResult): boolean => {
    if (scan.generation !== undefined) {
      if (scan.generation <= latestGeneration.current) return false;
      latestGeneration.current = scan.generation;
    }
    announcedResult.current = scan;
    setShown(Object.fromEntries(scan.probes.map((entry) => [entry.providerId, entry])));
    setResult(scan);
    return true;
  };

  // Set while the window is leaving: no second exit, Start or switch runs meanwhile.
  const finishing = useRef(false);

  const retry = async (providerId: ProviderId) => {
    if (!api?.retryModelScanProbe || finishing.current || activity !== null) return;
    const current = rows.find((probe) => probe.providerId === providerId);
    if (!current) return;
    setRetrying(providerId);
    try {
      // The retry returns the whole scan, so a check that now succeeds changes what the result offers.
      const scan = await api.retryModelScanProbe(providerId);
      if (applyScan(scan)) {
        const probe = scan.probes.find((entry) => entry.providerId === providerId);
        if (probe) setAnnouncement(MODEL_SCAN_COPY.announce(probe.name, probe.summary));
      }
      await refresh();
    } catch (caught) {
      setShown((all) => ({
        ...all,
        [providerId]: { ...current, state: "could-not-check", summary: MODEL_SCAN_COPY.couldNotCheck, facts: [caught instanceof Error ? caught.message : String(caught)] },
      }));
    } finally {
      setRetrying(null);
    }
  };

  // `activity` here is the value when the action began: an exit pressed while a
  // Start or another action runs is refused, so a Start's later scan never
  // lands after the window left. The choice's own actions call it from the
  // render in which they started, where it is still null.
  const finish = async (to: string | null) => {
    if (finishing.current || activity !== null) return;
    finishing.current = true;
    setBusy((current) => current ?? "finish");
    setActionError(null);
    try {
      // Leaving for provider setup keeps Connect Microsoft 365 for when a model is ready.
      if (firstRun) await api?.completeFirstRunScan?.(to === "/settings/providers" ? { microsoftStepPending: true } : undefined);
      await refresh();
      onClose(to);
    } catch (caught) {
      finishing.current = false;
      setBusy((current) => (current === "finish" ? null : current));
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /** Selects a provider (and its model, in one validated write), then opens Chat. */
  const select = async (providerId: ProviderId, model: string | undefined) => {
    if (model && api?.setActiveProviderAndModel) await api.setActiveProviderAndModel(providerId, model);
    else await setActiveProvider(providerId);
  };

  const act = async (option: ChoiceOption) => {
    if (finishing.current || activity !== null) return;
    if (option.action === "get-model") return finish("/settings/providers");
    if (option.action === "rescan") return setRun((value) => value + 1);
    if (option.action === "start") return start(option);
    setBusy(option.providerId);
    setActionError(null);
    try {
      if (option.action === "use" || option.providerId !== state.activeProviderId) await select(option.providerId, option.model);
      await finish("/chat");
    } catch (caught) {
      setStartErrors((all) => ({ ...all, [option.providerId]: caught instanceof Error ? caught.message : String(caught) }));
    } finally {
      setBusy(null);
    }
  };

  /** Starts a runtime, and opens Chat with it once it answers with a model. */
  const start = async (option: ChoiceOption) => {
    if (!api?.startLocalRuntime) return;
    setBusy(`start:${option.providerId}`);
    setStartErrors(({ [option.providerId]: _cleared, ...others }) => others);
    setAnnouncement(MODEL_SCAN_COPY.starting(option.name));
    try {
      const outcome = await api.startLocalRuntime(option.providerId);
      if (!outcome.started) {
        const message = outcome.message ?? MODEL_SCAN_COPY.startFailed(option.name);
        setStartErrors((all) => ({ ...all, [option.providerId]: message }));
        setAnnouncement(message);
        await refresh();
        return;
      }
      setAnnouncement(MODEL_SCAN_COPY.started(option.name));
      if (outcome.scan) applyScan(outcome.scan);
      const now = outcome.scan ? optionsFromProbes(outcome.scan.probes, outcome.scan.outcome).find((entry) => entry.providerId === option.providerId) : undefined;
      if (now?.action === "open") {
        // It answers with a model: select it and open Chat, as the button said.
        await select(option.providerId, now.model);
        finishing.current = false;
        setBusy(null);
        await finishFrom(true);
        return;
      }
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setStartErrors((all) => ({ ...all, [option.providerId]: message }));
      setAnnouncement(message);
    } finally {
      setBusy((current) => (current === `start:${option.providerId}` ? null : current));
    }
  };

  /** Leaves for Chat from inside an action that already holds the lock. */
  const finishFrom = async (fromAction: boolean) => {
    if (!fromAction) return;
    finishing.current = true;
    try {
      if (firstRun) await api?.completeFirstRunScan?.();
      await refresh();
      onClose("/chat");
    } catch (caught) {
      finishing.current = false;
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const platform = api?.platform;
  const draggable = platform === "macos" || platform === "windows";
  // A refused off-device endpoint ran nothing; the closing line names it as not contacted.
  const targets = [...new Set(rows.filter((probe) => !probe.notContacted).map((probe) => probe.target))];
  const notContacted = [...new Set(rows.filter((probe) => probe.notContacted).map((probe) => probe.target))];
  const startingId = busy?.startsWith("start:") ? (busy.slice(6) as ProviderId) : null;
  // The local data line follows the existing trust copy: with a public
  // reference enabled, question words leave the device for its host.
  const referenceHosts = chatToolHosts(state);
  const localLine = referenceHosts.length > 0 ? MODEL_SCAN_COPY.localWithReferences(deriveToolHostsCopy(referenceHosts)!.strip) : MODEL_SCAN_COPY.nothingLeaves;
  const found = rows.filter((probe) => probe.state === "found").length;

  // Focus the heading when the screen opens and when the result settles, so
  // keyboard and screen reader users start from it.
  useEffect(() => {
    headingRef.current?.focus();
  }, [settled]);

  const showResult = settled && result && !scanError;

  return (
    <div
      className="scan-screen flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]"
      data-motion={reduced ? "reduced" : "full"}
      data-phase={scanError ? "error" : settled ? "settled" : "scanning"}
    >
      <header
        className={`relative flex h-[52px] shrink-0 items-center gap-2 px-4 ${draggable ? "app-region-drag" : ""} ${platform === "macos" ? "pl-[92px]" : ""}`}
        style={platform === "windows" ? { paddingRight: 140 } : undefined}
      >
        <IconLogo size={21} className="text-[var(--color-text)]" />
        <span className="font-serif text-md font-medium">OpenAdminOS</span>
        <span className="flex-1" />
        {firstRun ? (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-[640px]:hidden">
            <OnboardingSteps current={0} />
          </div>
        ) : null}
        {!settled && !scanError ? (
          <Button size="sm" variant="ghost" className="app-region-no-drag" onClick={skip}>
            {MODEL_SCAN_COPY.skip}
          </Button>
        ) : null}
      </header>
      <main id="main-content" aria-labelledby="model-scan-heading" className="min-h-0 flex-1 overflow-y-auto">
        <div className="scan-grid mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-1 items-center gap-x-8 gap-y-6 px-6 py-6 min-[860px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[860px]:px-12 min-[1000px]:gap-x-12">
          <ScanStage
            rows={rows}
            visible={visible}
            settled={settled}
            startingId={startingId}
            selected={showResult ? picked : null}
            selectable={showResult ? options.filter((option) => !option.unavailable).map((option) => option.providerId) : []}
            onSelect={(id) => activity === null && setSelected(id)}
            onSkip={skip}
          />

          <section className="w-full min-w-0 max-w-[440px] justify-self-center min-[860px]:justify-self-start" aria-labelledby="model-scan-heading">
            {showResult ? (
              <ScanResult
                key={result.finishedAt}
                result={result}
                options={options}
                chosen={chosen}
                selected={picked}
                found={found}
                total={rows.length}
                activity={activity}
                startingId={startingId}
                retrying={retrying}
                errors={startErrors}
                localLine={localLine}
                activeProviderId={state.activeProviderId}
                headingRef={headingRef}
                onSelect={setSelected}
                onRetry={(id) => void retry(id)}
                onAct={(option) => void act(option)}
                onShowProviders={() => void finish("/settings/providers")}
              />
            ) : (
              <div>
                <h1 id="model-scan-heading" ref={headingRef} tabIndex={-1} className="font-serif text-display font-medium focus:outline-none">
                  {MODEL_SCAN_COPY.title}
                </h1>
                <p className="mt-3 text-base text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.subtitle}</p>
                {scanError ? (
                  <div role="alert" className="mt-6 rounded-lg bg-[var(--color-surface)] p-4 text-sm ring-1 ring-inset ring-[var(--color-border-soft)]">
                    <p className="font-medium text-[var(--color-text)]">{MODEL_SCAN_COPY.scanFailed}</p>
                    <p className="mt-1 text-[var(--color-text-soft)]">{scanError}</p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="primary" disabled={activity !== null} onClick={() => setRun((value) => value + 1)}>
                        {MODEL_SCAN_COPY.scanAgain}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={activity !== null} onClick={() => void finish("/chat")}>
                        {MODEL_SCAN_COPY.continueToChat}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ScanChecklist rows={rows} resolved={resolved} startingId={startingId} settled={settled} />
                )}
                {!scanError ? (
                  // A scan that stalls before its checks can still be left; nothing is selected.
                  <p className="mt-5 text-sm">
                    <button type="button" disabled={activity !== null} onClick={() => void finish("/chat")} className={linkClass}>
                      {MODEL_SCAN_COPY.continueToChat}
                    </button>
                  </p>
                ) : null}
              </div>
            )}
            {actionError ? (
              <p role="alert" className="mt-4 text-sm text-[var(--color-danger)]">
                {actionError}
              </p>
            ) : null}
            {showResult || scanError ? (
              <div className="scan-rise mt-5 border-t border-[var(--color-border-soft)] pt-4" style={{ animationDelay: "180ms" }}>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <button type="button" disabled={activity !== null} onClick={() => void finish("/chat")} className={linkClass}>
                    {MODEL_SCAN_COPY.continueWithoutModel}
                  </button>
                </p>
                <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
                  <details className="scan-what-ran min-w-0 flex-1">
                    <summary className="cursor-pointer select-none rounded-sm hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
                      {MODEL_SCAN_COPY.whatRan}
                    </summary>
                    <div className="mt-2 space-y-1.5 leading-5">
                      <p>{MODEL_SCAN_COPY.whatRanDetail}</p>
                      <ul className="font-mono text-[var(--color-text-soft)]">
                        {rows.map((probe) => (
                          <li key={probe.providerId}>
                            {probe.name}: {probe.target}
                          </li>
                        ))}
                      </ul>
                      <p>{MODEL_SCAN_COPY.ledger(targets, notContacted)}</p>
                      {/* Where each signed-in tool would send prompts depends on its account or deployment. */}
                      {rows
                        .filter((probe) => probe.where === "hosted" && probe.state === "found" && providerDataLocationDetail({ id: probe.providerId }))
                        .map((probe) => (
                          <p key={`where-${probe.providerId}`}>
                            {MODEL_SCAN_COPY.whereDetail(probe.name, providerDataLocationDetail({ id: probe.providerId })!)}
                          </p>
                        ))}
                    </div>
                  </details>
                  <button type="button" disabled={activity !== null} onClick={() => setRun((value) => value + 1)} className={linkClass}>
                    {MODEL_SCAN_COPY.scanAgain}
                  </button>
                </div>
              </div>
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

/** The check list while the scan runs: one line per check. It is the accessible source of each result. */
function ScanChecklist({ rows, resolved, startingId, settled }: { rows: readonly ModelScanProbe[]; resolved: number; startingId: ProviderId | null; settled: boolean }) {
  const segments = 8;
  const total = Math.max(rows.length, 1);
  const filled = Math.round((resolved / total) * segments);
  return (
    <section aria-labelledby="model-scan-list-heading" className="mt-6">
      <h2 id="model-scan-list-heading" className="sr-only">
        {MODEL_SCAN_COPY.listHeading}
      </h2>
      <div className="flex items-center gap-3">
        <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.progress(resolved, rows.length)}</span>
        <span className="flex max-w-[200px] flex-1 gap-[3px]" aria-hidden="true">
          {Array.from({ length: segments }, (_, index) => (
            <span key={index} className="scan-segment h-[3px] flex-1 rounded-full" data-done={index < filled ? "true" : "false"} />
          ))}
        </span>
      </div>
      <ul aria-busy={!settled} className="mt-3 divide-y divide-[var(--color-border-soft)]">
        {rows.map((probe) => {
          const starting = startingId === probe.providerId;
          return (
            <li key={probe.providerId} data-tone={toneOf(probe, starting)} data-where={probe.where} className="scan-list-row flex h-8 items-center gap-2.5">
              <span className="scan-list-mark shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{probe.name}</span>
              <span className="shrink-0 text-sm text-[var(--color-text-soft)]">{statusOf(probe, starting)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The radial map: this device in the centre, each tool a node on the orbit. Decorative; the lists are the accessible source. */
function ScanStage({
  rows,
  visible,
  settled,
  startingId,
  selected,
  selectable,
  onSelect,
  onSkip,
}: {
  rows: readonly ModelScanProbe[];
  visible: Record<string, boolean>;
  settled: boolean;
  startingId: ProviderId | null;
  selected: ProviderId | null;
  selectable: readonly ProviderId[];
  onSelect: (id: ProviderId) => void;
  onSkip: () => void;
}) {
  const count = Math.max(rows.length, 1);
  const position = (index: number) => {
    const angle = (-90 + (index * 360) / count) * (Math.PI / 180);
    return { x: 50 + 38 * Math.cos(angle), y: 50 + 38 * Math.sin(angle), angle };
  };
  return (
    <div
      className="scan-stage relative mx-auto aspect-square w-full select-none"
      style={{ maxWidth: "min(520px, calc(100vh - 150px))" }}
      aria-hidden="true"
      onClick={settled ? undefined : onSkip}
      data-has-selection={selected ? "true" : "false"}
    >
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100">
        <circle className="scan-orbit" cx="50" cy="50" r="38" />
        <circle className="scan-orbit scan-orbit-inner" cx="50" cy="50" r="22" />
        <g className="scan-rings">
          <circle className="scan-ring" cx="50" cy="50" r="38" />
          <circle className="scan-ring" cx="50" cy="50" r="38" style={{ animationDelay: "0.9s" }} />
        </g>
        {rows.map((probe, index) => {
          const { angle } = position(index);
          const tone = toneOf(probe, startingId === probe.providerId);
          if ((tone !== "ready" && tone !== "installed") || !visible[probe.providerId]) return null;
          const from = { x: 50 + 11 * Math.cos(angle), y: 50 + 11 * Math.sin(angle) };
          // Stops short of the node, outside its selection ring.
          const to = { x: 50 + 31.6 * Math.cos(angle), y: 50 + 31.6 * Math.sin(angle) };
          return (
            <line
              key={probe.providerId}
              className="scan-link"
              data-where={probe.where}
              data-selected={selected === probe.providerId ? "true" : "false"}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              pathLength={1}
            />
          );
        })}
      </svg>
      <div className="scan-sweep absolute inset-[12%] rounded-full" />
      {/* #174's shared device tile, sized to the stage. */}
      <div className="scan-device absolute left-1/2 top-1/2 aspect-square w-[20%]">
        <DeviceTile size="xl" />
      </div>
      {rows.map((probe, index) => {
        const { x, y } = position(index);
        const starting = startingId === probe.providerId;
        const tone = toneOf(probe, starting);
        const canSelect = selectable.includes(probe.providerId);
        return (
          <div
            key={probe.providerId}
            className="scan-node absolute flex w-[25%] flex-col items-center text-center"
            style={{ left: `${x}%`, top: `${y}%` }}
            data-tone={tone}
            data-where={probe.where}
            data-visible={visible[probe.providerId] ? "true" : "false"}
            data-settled={settled ? "true" : "false"}
            data-selected={selected === probe.providerId ? "true" : "false"}
            data-selectable={canSelect ? "true" : "false"}
            onClick={canSelect ? () => onSelect(probe.providerId) : undefined}
          >
            <span className="scan-node-dot flex items-center justify-center rounded-full text-sm font-semibold" data-kind={providerLogoKind(probe.providerId)}>
              <ProviderLogo provider={probe.providerId} size={settled && tone === "muted" ? 16 : 22} />
            </span>
            <span className="scan-node-plate mt-1.5 flex flex-col items-center rounded-[6px] px-1.5">
              <span className="scan-node-name text-sm font-medium leading-[18px]">{probe.name}</span>
              <span className="scan-node-status text-xs leading-4">{statusOf(probe, starting)}</span>
            </span>
          </div>
        );
      })}
    </div>
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
  "rounded-sm text-[var(--color-text-soft)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60";

/** The heading the result leads with, by outcome and choice. */
function resultTitle(outcome: ModelScanOutcome, options: readonly ChoiceOption[], chosen: ChoiceOption | undefined): string {
  if (options.length === 0) return MODEL_SCAN_COPY.nothingTitle;
  const selectedLocal = (outcome.kind === "local-selected" || outcome.kind === "local-ready") && chosen?.providerId === outcome.providerId && chosen.action === "open";
  if (selectedLocal) return MODEL_SCAN_COPY.localTitle(modelDisplayName(chosen.model) ?? chosen.name);
  return MODEL_SCAN_COPY.chooseTitle;
}

/** The result: one choice of what answers in Chat and one button whose label follows it (mockup 32, section B). */
function ScanResult({
  result,
  options,
  chosen,
  selected,
  found,
  total,
  activity,
  startingId,
  retrying,
  errors,
  localLine,
  activeProviderId,
  headingRef,
  onSelect,
  onRetry,
  onAct,
  onShowProviders,
}: {
  result: ModelScanResult;
  options: readonly ChoiceOption[];
  chosen: ChoiceOption | undefined;
  selected: ProviderId | null;
  found: number;
  total: number;
  activity: string | null;
  startingId: ProviderId | null;
  retrying: ProviderId | null;
  errors: Partial<Record<ProviderId, string>>;
  localLine: string;
  activeProviderId: ProviderId;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onSelect: (id: ProviderId) => void;
  onRetry: (id: ProviderId) => void;
  onAct: (option: ChoiceOption) => void;
  onShowProviders: () => void;
}) {
  const title = resultTitle(result.outcome, options, chosen);
  const localReady = title !== MODEL_SCAN_COPY.chooseTitle && title !== MODEL_SCAN_COPY.nothingTitle;
  if (options.length === 0) {
    return (
      <div className="scan-rise">
        <p className="text-sm text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.found(found, total)}</p>
        <h1 id="model-scan-heading" ref={headingRef} tabIndex={-1} className="mt-1.5 font-serif text-display font-medium focus:outline-none">
          {title}
        </h1>
        <p className="mt-3 text-base text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.nothingBody}</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-text)] ring-1 ring-inset ring-[var(--color-border-soft)]">
          {MODEL_SCAN_COPY.installCommand}
        </pre>
        <div className="mt-5">
          <Button variant="primary" size="lg" disabled={activity !== null} onClick={onShowProviders}>
            {MODEL_SCAN_COPY.allProviders}
          </Button>
        </div>
      </div>
    );
  }
  const note = chosen?.where === "local" && chosen.action === "open" ? localLine : actionNote(chosen);
  const starting = chosen && startingId === chosen.providerId;
  return (
    <div className="scan-rise">
      <p className="text-sm text-[var(--color-text-muted)]">{MODEL_SCAN_COPY.found(found, total)}</p>
      <h1 id="model-scan-heading" ref={headingRef} tabIndex={-1} className="mt-1.5 font-serif text-display font-medium focus:outline-none">
        {title}
      </h1>
      <p className="mt-3 text-base text-[var(--color-text-soft)]">{localReady ? localLine : MODEL_SCAN_COPY.chooseBody}</p>
      <div className="mt-5">
        <ModelChoiceList
          options={options}
          selected={selected}
          onSelect={onSelect}
          disabled={activity !== null}
          errors={Object.fromEntries(Object.entries(errors).map(([id, message]) => [id, <InlineCode key={id} text={message ?? ""} />]))}
          retrying={retrying}
          onRetry={onRetry}
        />
      </div>
      <div className="mt-4">
        <Button
          variant="primary"
          size="lg"
          disabled={!chosen || chosen.unavailable || activity !== null}
          onClick={() => chosen && onAct(chosen)}
          leadingIcon={starting ? <span className="scan-spinner" aria-hidden="true" /> : undefined}
        >
          {actionLabel(chosen, activeProviderId)}
        </Button>
        {note ? <p className="mt-2 text-xs text-[var(--color-text-muted)]">{note}</p> : null}
      </div>
    </div>
  );
}


/** Opens Connect Microsoft 365 from Connections, or undefined where the onboarding gate is not available. */
export function useOpenMicrosoftStep(): (() => void) | undefined {
  const scan = useContext(ModelScanContext);
  const supported = typeof window.openAdminOS?.startModelScan === "function";
  return supported && scan ? scan.openMicrosoftStep : undefined;
}

/** Connections: open the Connect Microsoft 365 step again. */
export function MicrosoftStepButton() {
  const scan = useContext(ModelScanContext);
  const supported = typeof window.openAdminOS?.startModelScan === "function";
  const handle = useCallback(() => scan?.openMicrosoftStep(), [scan]);
  if (!supported || !scan) return null;
  return (
    <Button size="sm" variant="secondary" onClick={handle}>
      {MICROSOFT_STEP_COPY.reopen}
    </Button>
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
