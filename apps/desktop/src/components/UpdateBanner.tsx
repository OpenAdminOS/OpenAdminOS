import { useEffect, useState } from "react";
import { Button } from "./Button";
import { IconCheck, IconClose } from "./icons";
import type { UpdateState } from "../shared/openAdminOS";

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    let cancelled = false;
    api
      .getUpdateState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = api.onUpdateStateChanged((next) => {
      setState(next);
      // A fresh transition unhides any previously-dismissed banner so
      // users still get notified when a new state arrives.
      setDismissed(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (dismissed) return null;
  if (state.status !== "ready" && state.status !== "downloading") return null;

  const isReady = state.status === "ready";

  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)] px-6 py-2.5">
      <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]">
        <IconCheck size={12} className="text-[var(--color-accent)]" />
        <span className="font-medium">
          {isReady
            ? `OpenAdminOS ${state.version ?? ""} is ready to install`
            : `Downloading OpenAdminOS ${state.version ?? "update"}…`}
        </span>
        {isReady && (
          <span className="text-[var(--color-text-soft)]">
            Restart now to apply, or it will install on the next quit.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isReady && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void window.openAdminOS?.applyUpdateNow();
            }}
          >
            Restart now
          </Button>
        )}
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notice"
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
        >
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}
