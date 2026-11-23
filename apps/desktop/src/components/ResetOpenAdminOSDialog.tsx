import { useCallback, useEffect, useState } from "react";

import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { Badge } from "./ui";
import { LOCAL_RESET_COPY, userFacingErrorReason } from "../copy";
import { LOCAL_RESET_PHRASE } from "../shared/local-reset";
import type { LocalResetInfo } from "../shared/openAdminOS";

const REMOTE_ERROR_PREFIX = /^Error invoking remote method ['"][^'"]+['"]: (?:\w*Error: )?/;
const RESET_REFUSAL_PREFIX = /^Error invoking remote method ['"][^'"]+['"]: LocalResetRequestError: /;

/**
 * A refusal the main process wrote for this dialog is shown in full, however
 * long, since it says what to do; any other error goes through the general
 * filter that keeps stack traces and paths out of the UI.
 */
function resetErrorText(raw: string): string {
  if (RESET_REFUSAL_PREFIX.test(raw)) {
    const message = raw.replace(RESET_REFUSAL_PREFIX, "").trim();
    if (message && message.length <= 800 && !/[\r\n]/.test(message)) return message;
  }
  return userFacingErrorReason(raw.replace(REMOTE_ERROR_PREFIX, "")) ?? LOCAL_RESET_COPY.failedFallback;
}

type Phase = "idle" | "resetting" | "restarting";

/**
 * Confirms Reset OpenAdminOS with the typed phrase. On success the main
 * process restarts the app, which empties the data folder before anything
 * else runs; the dialog stays on its restarting state until then.
 */
export function ResetOpenAdminOSDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<LocalResetInfo>();
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);

  // Reset stays off until the dialog can say exactly what goes, so the
  // admin never confirms a list that left out the Keychain or the scheduler.
  const loadInfo = useCallback((isCancelled: () => boolean = () => false) => {
    setInfoFailed(false);
    const request = window.openAdminOS?.getLocalResetInfo?.();
    if (!request) {
      setInfoFailed(true);
      return;
    }
    void request
      .then((next) => {
        if (!isCancelled()) setInfo(next);
      })
      .catch(() => {
        if (!isCancelled()) setInfoFailed(true);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setTyped("");
    setError(null);
    setPhase("idle");
    setInfo(undefined);
    let cancelled = false;
    loadInfo(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open, loadInfo]);

  const busy = phase !== "idle";
  const armed = typed === LOCAL_RESET_PHRASE && info !== undefined;
  const close = () => {
    if (!busy) onClose();
  };
  const reset = async () => {
    const api = window.openAdminOS;
    if (!armed || busy) return;
    if (!api?.resetOpenAdminOS) {
      setError(LOCAL_RESET_COPY.failedFallback);
      return;
    }
    setPhase("resetting");
    setError(null);
    try {
      await api.resetOpenAdminOS(typed);
      setPhase("restarting");
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      setError(resetErrorText(raw));
      setPhase("idle");
    }
  };

  return (
    <Modal open={open} onClose={close} size="md" closeOnScrim={!busy}>
      <ModalHeader
        title={LOCAL_RESET_COPY.dialogTitle}
        subtitle={info?.dataFolder}
        badge={<Badge tone="danger">{LOCAL_RESET_COPY.dialogBadge}</Badge>}
        onClose={close}
      />
      {/* The list scrolls and the buttons stay in view, also at the smallest window height. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        <section aria-labelledby="local-reset-removed" className="text-sm leading-relaxed">
          <h3 id="local-reset-removed" className="font-medium text-[var(--color-text)]">
            {LOCAL_RESET_COPY.removedTitle}
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-text-soft)]">
            {LOCAL_RESET_COPY.removed(info).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {info && !info.packaged ? (
            <p className="mt-1.5 text-[var(--color-text-muted)]">{LOCAL_RESET_COPY.developmentBuild}</p>
          ) : null}
        </section>
        <section aria-labelledby="local-reset-keeps" className="text-sm leading-relaxed">
          <h3 id="local-reset-keeps" className="font-medium text-[var(--color-text)]">
            {LOCAL_RESET_COPY.keepsTitle}
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-text-soft)]">
            <li>
              {LOCAL_RESET_COPY.keepsConsent}{" "}
              <button
                type="button"
                className="text-[var(--color-text)] underline underline-offset-2 hover:text-[var(--color-text-soft)]"
                onClick={() => void window.openAdminOS?.openExternal(LOCAL_RESET_COPY.revokeUrl)}
              >
                {LOCAL_RESET_COPY.revokeLink}
              </button>
            </li>
            {info?.policyFilePresent ? <li>{LOCAL_RESET_COPY.keepsPolicy}</li> : null}
            <li>{LOCAL_RESET_COPY.keepsExports}</li>
            <li>{LOCAL_RESET_COPY.keepsOllamaModels} <code>{LOCAL_RESET_COPY.removeOllamaIndexModel}</code>.</li>
          </ul>
        </section>
        <p className="text-sm text-[var(--color-text-muted)]">{LOCAL_RESET_COPY.restartNote}</p>

        <div className="space-y-2">
          <div className="flex min-h-10 items-center rounded-lg bg-[var(--color-danger-soft)] px-4 font-mono text-base text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {LOCAL_RESET_PHRASE}
          </div>
          <label htmlFor="local-reset-phrase" className="block text-sm text-[var(--color-text-muted)]">
            {LOCAL_RESET_COPY.phraseLabel}
          </label>
          <input
            id="local-reset-phrase"
            name="local-reset-phrase"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={LOCAL_RESET_COPY.phrasePlaceholder}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onKeyDown={(event) => {
              if (event.key === "Enter") void reset();
            }}
            className={`h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-4 font-mono text-base text-[var(--color-text)] ring-1 placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 ${
              armed
                ? "ring-[var(--color-danger)] focus:ring-[var(--color-danger)]"
                : "ring-[var(--color-border)] focus:ring-[var(--color-focus)]"
            }`}
          />
        </div>

        {infoFailed ? (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
          >
            {LOCAL_RESET_COPY.infoFailed}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => loadInfo()}>
              {LOCAL_RESET_COPY.infoRetry}
            </button>
          </div>
        ) : null}
        {phase === "resetting" ? (
          <p role="status" className="text-sm text-[var(--color-text-muted)]">{LOCAL_RESET_COPY.progress}</p>
        ) : phase === "restarting" ? (
          <p role="status" className="text-sm text-[var(--color-text)]">{LOCAL_RESET_COPY.restarting}</p>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
          >
            {error}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void window.openAdminOS?.openExternal(LOCAL_RESET_COPY.docsUrl)}
            >
              {LOCAL_RESET_COPY.docsLink}
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border-soft)] px-6 py-4">
        <Button variant="ghost" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!armed || busy} onClick={() => void reset()}>
          {busy ? LOCAL_RESET_COPY.busyAction : LOCAL_RESET_COPY.action}
        </Button>
      </div>
    </Modal>
  );
}
