import { useEffect, useState } from "react";
import type { PendingConnectorConfirmation } from "@openadminos/agent-sdk";
import { MarkdownPreview } from "./MarkdownPreview";
import { Modal, ModalHeader } from "./Modal";
import { Badge, Button } from "./ui";

/**
 * Preview-and-send modal for `notify`/`mutating`/`destructive`
 * connector capability invocations. Fired by the runtime via
 * `confirmCapability`; the user approves or cancels. Cancellation
 * surfaces back to the agent as a failed capability call (the
 * runtime throws `ConnectorRemoteError(recovery: 'fatal')`).
 *
 * The component sits at AppShell level so it can intercept requests
 * regardless of the active route: agents may post to Teams during
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

  const kindLabel: Record<
    string,
    { label: string; tone: "neutral" | "warning" | "danger" | "info" }
  > = {
    notify: {
      label: "Notification",
      tone: "info",
    },
    mutating: {
      label: "Modification",
      tone: "warning",
    },
    destructive: {
      label: "Destructive",
      tone: "danger",
    },
    read: {
      label: "Read",
      tone: "neutral",
    },
  };
  const tag = kindLabel[pending.capability.kind] ?? kindLabel.notify;

  return (
    <Modal
      open
      onClose={() => void dismiss({ approved: false, reason: "User cancelled" })}
      closeOnScrim={false}
      ariaLabel={`Send to ${pending.connectorName}`}
    >
      <ModalHeader
        title={`Send to ${pending.connectorName}?`}
        badge={<Badge tone={tag.tone}>{tag.label}</Badge>}
        onClose={() => void dismiss({ approved: false, reason: "User cancelled" })}
      />
      <div className="min-h-0 overflow-y-auto">
        <section className="border-b border-[var(--color-border-soft)] px-5 py-4">
          <p className="truncate text-base text-[var(--color-text)]" title={pending.targetLabel ?? pending.egressTarget}>
            {pending.targetLabel ?? pending.egressTarget}
          </p>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
            {pending.capability.id}@{pending.capability.version}
          </p>
          <h3 className="mt-4 text-sm font-medium text-[var(--color-text)]">
            Message preview
          </h3>
          {pending.bodyPreview ? (
            <MarkdownPreview
              source={pending.bodyPreview}
              className="mt-1.5 max-h-[320px] overflow-auto rounded-md bg-[var(--color-bg-raised)] p-3 text-base text-[var(--color-text)]"
            />
          ) : (
            <p className="mt-1.5 text-sm italic text-[var(--color-text-muted)]">
              No preview available for this capability.
            </p>
          )}
        </section>
      </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3">
          <p className="text-sm text-[var(--color-text-muted)]">
            The agent will receive a failure if you cancel.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void dismiss({ approved: false, reason: "User cancelled" })
              }
              disabled={rejecting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void dismiss({ approved: true })}
              disabled={rejecting}
            >
              Send
            </Button>
          </div>
        </footer>
    </Modal>
  );
}
