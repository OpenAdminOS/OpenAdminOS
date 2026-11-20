import { useEffect, useState } from "react";

import { Button } from "../components/Button";
import { LOCAL_RESET_COPY } from "../copy";
import type { LocalResetReport } from "../shared/openAdminOS";

/** The route the main process opens instead of the app while a reset has not finished. */
export const LOCAL_RESET_INCOMPLETE_HASH = "#/reset-incomplete";

/**
 * Shown instead of the app when the reset at launch could not empty the
 * data folder. Rendered without the app state providers: no store runs.
 */
export function LocalResetIncomplete() {
  const [report, setReport] = useState<LocalResetReport | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const api = window.openAdminOS;

  useEffect(() => {
    void api?.getLocalResetReport?.().then(setReport).catch(() => setActionFailed(true));
  }, [api]);

  const act = (action: (() => Promise<void>) | undefined) => {
    setActionFailed(false);
    if (!action) {
      setActionFailed(true);
      return;
    }
    void action().catch(() => setActionFailed(true));
  };

  return (
    // The page root hides overflow, so this screen scrolls itself and keeps
    // the actions in view however long the list is.
    <main className="h-screen w-full overflow-y-auto bg-[var(--color-bg)] px-6 py-10 text-[var(--color-text)]">
      <section aria-labelledby="local-reset-incomplete-title" className="mx-auto w-full max-w-xl space-y-4">
        <h1 id="local-reset-incomplete-title" className="text-lg font-semibold">
          {LOCAL_RESET_COPY.incompleteTitle}
        </h1>
        <p className="text-sm leading-relaxed text-[var(--color-text-soft)]">{LOCAL_RESET_COPY.incompleteBody}</p>
        {report ? (
          <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
            <h2 className="text-sm font-medium">{LOCAL_RESET_COPY.incompleteFailedTitle}</h2>
            <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-text-muted)]">{report.dataFolder}</p>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm">
              {report.failed.map((entry) => (
                <li key={entry.item}>
                  <span className="font-mono">{entry.item}</span>
                  <span className="text-[var(--color-text-muted)]">: {entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">{LOCAL_RESET_COPY.incompleteHint}</p>
        {actionFailed ? (
          <div role="alert" className="text-sm text-[var(--color-danger)]">{LOCAL_RESET_COPY.incompleteActionFailed}</div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => act(api?.retryLocalReset)}>
            {LOCAL_RESET_COPY.incompleteRetry}
          </Button>
          <Button variant="secondary" onClick={() => act(api?.showLocalResetDataFolder)}>
            {LOCAL_RESET_COPY.incompleteShowFolder}
          </Button>
          <Button variant="ghost" onClick={() => act(api?.quitAfterIncompleteReset)}>
            {LOCAL_RESET_COPY.incompleteQuit}
          </Button>
        </div>
      </section>
    </main>
  );
}

/** After a completed reset: what was removed, what could not be, and what stays in Entra. */
export function LocalResetNotice() {
  const [report, setReport] = useState<LocalResetReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.openAdminOS?.getLocalResetReport?.()
      .then((next) => {
        if (!cancelled && next?.status === "completed") setReport(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!report) return null;
  const dismiss = () => {
    setReport(null);
    void window.openAdminOS?.dismissLocalResetReport?.().catch(() => undefined);
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center px-4">
      <section
        role="status"
        aria-labelledby="local-reset-notice-title"
        className="pointer-events-auto w-full max-w-2xl rounded-lg bg-[var(--color-bg-elevated)] px-4 py-3 shadow-lg ring-1 ring-[var(--color-border)]"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-sm leading-relaxed">
            <h2 id="local-reset-notice-title" className="font-medium text-[var(--color-text)]">
              {LOCAL_RESET_COPY.noticeTitle}
            </h2>
            <p className="mt-0.5 text-[var(--color-text-soft)]">{LOCAL_RESET_COPY.noticeBody}</p>
            {report.warnings.length > 0 ? (
              <div className="mt-2">
                <h3 className="font-medium text-[var(--color-warning)]">{LOCAL_RESET_COPY.noticeWarningsTitle}</h3>
                <ul className="mt-0.5 space-y-0.5 text-[var(--color-text-soft)]">
                  {report.warnings.map((entry) => (
                    <li key={`${entry.item}:${entry.reason}`}>
                      <span className="break-all">{entry.item}</span>: {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {LOCAL_RESET_COPY.noticeDismiss}
          </Button>
        </div>
      </section>
    </div>
  );
}
