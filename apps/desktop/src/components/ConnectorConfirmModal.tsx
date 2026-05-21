import { useEffect, useState } from "react";
import type { PendingConnectorConfirmation } from "@openadminos/agent-sdk";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * Preview-and-send modal for `notify`/`mutating`/`destructive`
 * connector capability invocations. Fired by the runtime via
 * `confirmCapability`; the user approves or cancels. Cancellation
 * surfaces back to the agent as a failed capability call (the
 * runtime throws `ConnectorRemoteError(recovery: 'fatal')`).
 *
 * The component sits at AppShell level so it can intercept requests
 * regardless of the active route — agents may post to Teams during
 * a run that the user is viewing on a different screen.
 */
export function ConnectorConfirmModal() {
  const [pending, setPending] = useState<PendingConnectorConfirmation | null>(
    null,
  );
  const [rejecting, setRejecting] = useState(false);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    return api.onConnectorConfirmRequest((request) => {
      setPending(request);
    });
  }, []);

  if (!pending) return null;

  const dismiss = async (
    decision:
      | { approved: true }
      | { approved: false; reason: string },
  ) => {
    const api = window.openAdminOS;
    if (!api) return;
    setRejecting(decision.approved === false);
    await api.respondToConnectorConfirm(pending.requestId, decision);
    setPending(null);
    setRejecting(false);
  };

  const kindLabel: Record<string, { label: string; tone: string }> = {
    notify: {
      label: "Notification",
      tone: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
    },
    mutating: {
      label: "Modification",
      tone: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    },
    destructive: {
      label: "Destructive",
      tone: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
    },
    read: {
      label: "Read",
      tone: "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]",
    },
  };
  const tag = kindLabel[pending.capability.kind] ?? kindLabel.notify;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 animate-fade-in">
      <div className="w-full max-w-[560px] rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border-soft)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[14.5px] font-semibold text-[var(--color-text)]">
                Send to {pending.connectorName}?
              </h2>
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider ${tag.tone}`}
              >
                {tag.label}
              </span>
            </div>
            <p className="mt-1 truncate text-[12.5px] text-[var(--color-text)]">
              {pending.targetLabel ?? pending.egressTarget}
            </p>
            <p className="mt-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">
              {pending.capability.id}@{pending.capability.version}
            </p>
          </div>
        </header>

        <section className="px-5 py-4">
          <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Message preview
          </h3>
          {pending.bodyPreview ? (
            <MarkdownPreview
              source={pending.bodyPreview}
              className="mt-1.5 max-h-[320px] overflow-auto rounded-md bg-[var(--color-bg-raised)] p-3 text-[13px] text-[var(--color-text)]"
            />
          ) : (
            <p className="mt-1.5 text-[12px] italic text-[var(--color-text-muted)]">
              No preview available for this capability.
            </p>
          )}
        </section>

        <footer className="flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] px-5 py-3">
          <p className="text-[11.5px] text-[var(--color-text-muted)]">
            The agent will receive a failure if you cancel.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void dismiss({ approved: false, reason: "User cancelled" })
              }
              disabled={rejecting}
              className="rounded-md px-3 py-1 text-[12px] font-medium text-[var(--color-text-soft)] hover:bg-[var(--color-bg-raised)] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void dismiss({ approved: true })}
              disabled={rejecting}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-on-accent)] disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
