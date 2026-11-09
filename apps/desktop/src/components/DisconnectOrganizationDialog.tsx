import { useState } from "react";

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
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          {sample ? PILOT_COPY.leaveBody : ORGANIZATION_COPY.disconnectBody}
        </div>
        <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">
          {sample
            ? `You can open it again with ${ORGANIZATION_COPY.previewSample} in the organization menu.`
            : ORGANIZATION_COPY.disconnectNote}
        </p>
        {error ? (
          <div role="alert" className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
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
