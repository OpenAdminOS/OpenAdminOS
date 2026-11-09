import { useEffect, useState } from "react";

import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { useToast } from "./Toast";
import { Badge } from "./ui";
import { ORGANIZATION_COPY, userFacingErrorReason } from "../copy";
import type { OrganizationRecord, TenantRecord } from "../shared/openAdminOS";
import { PILOT_COPY } from "../shared/pilot-mode";
import { useAppState } from "../state";

/**
 * Confirms disconnecting an organization's Microsoft 365 connection, which
 * deletes its local data, or leaving the sample organization.
 */
export function DisconnectOrganizationDialog({
  open,
  organization,
  tenant,
  onClose,
}: {
  open: boolean;
  organization: OrganizationRecord;
  tenant: TenantRecord;
  onClose: () => void;
}) {
  const { disconnectTenant } = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deleting local data is an explicit choice: Disconnect stays off until it is checked.
  const [deleteLocal, setDeleteLocal] = useState(false);
  useEffect(() => {
    if (open) setDeleteLocal(false);
  }, [open]);
  const sample = tenant.kind === "sample";
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} size="md">
      <ModalHeader
        title={sample ? PILOT_COPY.leaveTitle : ORGANIZATION_COPY.disconnectTitle(organization.name)}
        subtitle={sample ? "Delete the sample organization and its local data" : "Remove the connection and its local data"}
        badge={<Badge tone={sample ? "info" : "danger"}>Permanent local deletion</Badge>}
        onClose={() => { if (!busy) onClose(); }}
      />
      <div className="space-y-4 p-6">
        {sample ? (
          <>
            <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
              {PILOT_COPY.leaveBody}
            </div>
            <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">
              {`You can open it again with ${ORGANIZATION_COPY.previewSample} in the organization menu.`}
            </p>
          </>
        ) : (
          <>
            <section aria-labelledby="disconnect-deletes" className="text-sm leading-relaxed">
              <h3 id="disconnect-deletes" className="font-medium text-[var(--color-text)]">{ORGANIZATION_COPY.disconnectDeletesTitle}</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-text-soft)]">
                {ORGANIZATION_COPY.disconnectDeletes.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <p className="mt-1.5 text-[var(--color-text-muted)]">{ORGANIZATION_COPY.disconnectSchedules}</p>
            </section>
            <section aria-labelledby="disconnect-keeps" className="text-sm leading-relaxed">
              <h3 id="disconnect-keeps" className="font-medium text-[var(--color-text)]">{ORGANIZATION_COPY.disconnectKeepsTitle}</h3>
              <p className="mt-1 text-[var(--color-text-soft)]">{ORGANIZATION_COPY.disconnectKeepsBody}</p>
              <button
                type="button"
                className="mt-1 text-[var(--color-text)] underline underline-offset-2 hover:text-[var(--color-text-soft)]"
                onClick={() => void window.openAdminOS?.openExternal(ORGANIZATION_COPY.disconnectRevokeUrl)}
              >
                {ORGANIZATION_COPY.disconnectRevokeLink}
              </button>
            </section>
            {/* TODO(ugur): disconnecting always deletes the local data today. Should admins be able to disconnect and keep it, for example for an audit? */}
            <label className="flex items-start gap-2.5 rounded-lg bg-[var(--color-bg-raised)] px-3.5 py-3 text-sm text-[var(--color-text)] ring-1 ring-inset ring-[var(--color-border-soft)]">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--color-danger)]"
                checked={deleteLocal}
                disabled={busy}
                onChange={(event) => setDeleteLocal(event.target.checked)}
              />
              <span>{ORGANIZATION_COPY.disconnectConfirmLocal(organization.name)}</span>
            </label>
          </>
        )}
        {error ? (
          <div role="alert" className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || (!sample && !deleteLocal)}
            onClick={() => {
              setBusy(true);
              setError(null);
              void disconnectTenant(tenant.id)
                .then(() => {
                  toast.success(sample ? "Pilot mode ended. Its sample data was deleted from this device." : ORGANIZATION_COPY.disconnected(organization.name));
                  onClose();
                })
                .catch((caught) =>
                  setError(
                    userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ??
                      ORGANIZATION_COPY.disconnectFailed(""),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? (sample ? "Removing" : "Disconnecting") : sample ? PILOT_COPY.leaveAction : ORGANIZATION_COPY.disconnectAction}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
