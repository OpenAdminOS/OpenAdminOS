import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { IconShield } from "./icons";
import { Badge, StatusDot } from "./ui";
import { SERVICE_COPY, SETUP_COPY } from "../copy";
import { copyTextToClipboard } from "../shared/clipboard";
import {
  SERVICE_PARTS,
  grantedParts,
  serviceById,
  serviceStatus,
  type ServiceConnectionStatus,
  type ServiceId,
  type ServicePart,
  type ServiceScope,
  type TenantRecord,
} from "../shared/openAdminOS";
import {
  REQUIRED_RESOURCE_ACCESS_NOTES,
  generateRegistrationSetup,
  generateRequiredResourceAccessSnippet,
} from "../setup/registration-script";
import { useAppState } from "../state";

/** True when the tenant signs in with the admin's own app registration. */
export function usesOwnRegistration(tenant: TenantRecord): boolean {
  return tenant.appRegistration?.kind === "custom";
}

/** Requestable parts of a service that the tenant has not been granted. */
export function missingServiceParts(tenant: TenantRecord, serviceId: ServiceId): ServicePart[] {
  const granted = new Set(grantedParts(tenant).map((part) => part.id));
  return SERVICE_PARTS.filter((part) => part.service === serviceId && !granted.has(part.id));
}

function uniqueScopes(parts: readonly ServicePart[]): ServiceScope[] {
  return [
    ...new Map(
      parts.flatMap((part) => part.scopes).map((scope) => [scope.name, scope] as const),
    ).values(),
  ];
}

export function ServiceStatusBadge({ status }: { status: ServiceConnectionStatus }) {
  const tone = status === "connected" ? "success" : status === "partial" ? "warning" : "neutral";
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} />
      {SERVICE_COPY.status[status]}
    </Badge>
  );
}

/**
 * Adds a service or some of its parts to a tenant. With the OpenAdminOS app
 * this asks Microsoft for consent to those scopes only. With an own app
 * registration it lists the exact permissions to add, the script that adds
 * them to the existing app, the manifest snippet, and Check again.
 */
export function ServiceAccessDialog({
  tenant,
  serviceId,
  initialPartIds,
  open,
  onClose,
}: {
  tenant: TenantRecord;
  serviceId: ServiceId | null;
  /** Parts to start with. Defaults to every missing part of the service. */
  initialPartIds?: readonly string[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open && serviceId !== null} onClose={onClose} size="md">
      {serviceId ? (
        <ServiceAccessBody
          key={`${serviceId}:${(initialPartIds ?? []).join(",")}`}
          tenant={tenant}
          serviceId={serviceId}
          {...(initialPartIds ? { initialPartIds } : {})}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function ServiceAccessBody({
  tenant,
  serviceId,
  initialPartIds,
  onClose,
}: {
  tenant: TenantRecord;
  serviceId: ServiceId;
  initialPartIds?: readonly string[];
  onClose: () => void;
}) {
  const { addTenantAccess, refreshTenantGrants } = useAppState();
  const service = serviceById(serviceId);
  const ownRegistration = usesOwnRegistration(tenant);
  const missing = missingServiceParts(tenant, serviceId);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        (initialPartIds ?? missing.map((part) => part.id)).filter((id) =>
          missing.some((part) => part.id === id),
        ),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const selectedParts = missing.filter((part) => selected.has(part.id));
  const scopes = uniqueScopes(selectedParts);
  const partIds = selectedParts.map((part) => part.id);
  const close = () => {
    if (!busy) onClose();
  };

  const toggle = (partId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
    setStatus(null);
    setError(null);
  };

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const message = await action();
      if (message) setStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = (label: string, text: () => string) =>
    run(async () => {
      await copyTextToClipboard(text());
      return SERVICE_COPY.copied(label);
    });

  return (
    <>
      <ModalHeader
        title={ownRegistration ? SERVICE_COPY.addPermissionsTitle(service.title) : SERVICE_COPY.addAccessTitle(service.title)}
        subtitle={
          ownRegistration && tenant.appRegistration
            ? SERVICE_COPY.ownRegistrationSubtitle(tenant.displayName, tenant.appRegistration.clientId)
            : SERVICE_COPY.sharedAppSubtitle(tenant.displayName)
        }
        onClose={close}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        <p className="text-sm leading-6 text-[var(--color-text-soft)]">{service.summary}</p>
        {missing.length === 0 ? (
          <p role="status" className="rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)]">
            {SERVICE_COPY.alreadyConnected(service.title, tenant.displayName)}
          </p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[var(--color-text-muted)]">
              {scopes.length} delegated read scopes
            </legend>
            {missing.map((part) => (
              <div key={part.id} className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    aria-label={part.title}
                    checked={selected.has(part.id)}
                    disabled={busy}
                    onChange={() => toggle(part.id)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--color-text)]">{part.title}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">{part.summary}</span>
                  </span>
                </label>
                <ul className="mt-2 space-y-2 pl-6">
                  {part.scopes.map((scope) => (
                    <li key={scope.name}>
                      <div className="break-all font-mono text-xs text-[var(--color-text-soft)]">{scope.name}</div>
                      <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">{scope.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </fieldset>
        )}
        {ownRegistration ? (
          <div className="space-y-1 text-xs leading-5 text-[var(--color-text-muted)]">
            <p>{SERVICE_COPY.ownRegistrationSteps}</p>
            {REQUIRED_RESOURCE_ACCESS_NOTES.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : (
          <div className="space-y-1 text-xs leading-5 text-[var(--color-text-muted)]">
            <p>Microsoft opens in your system browser for interactive consent.</p>
            <p>{SETUP_COPY.readOnlyNote}</p>
            <p>{SETUP_COPY.signInScopesNote}</p>
            <p>{SETUP_COPY.delegatedPermissionsNote}</p>
          </div>
        )}
        {status && (
          <p role="status" className="text-sm text-[var(--color-success)]">{status}</p>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {missing.length === 0 ? "Close" : "Cancel"}
          </Button>
          {ownRegistration && tenant.appRegistration ? (
            <>
              <Button
                variant="secondary"
                disabled={busy || partIds.length === 0}
                onClick={() =>
                  void copy("Script", () =>
                    generateRegistrationSetup({
                      mode: "extend",
                      clientId: tenant.appRegistration!.clientId,
                      partIds,
                    }).script,
                  )
                }
              >
                Copy script
              </Button>
              <Button
                variant="secondary"
                disabled={busy || partIds.length === 0}
                onClick={() =>
                  void copy("JSON snippet", () => generateRequiredResourceAccessSnippet(partIds).json)
                }
              >
                Copy JSON snippet
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await refreshTenantGrants(tenant.id);
                    return SERVICE_COPY.checkedAgain;
                  })
                }
              >
                {busy ? "Checking" : SERVICE_COPY.checkAgain}
              </Button>
            </>
          ) : missing.length > 0 ? (
            <Button
              variant="primary"
              disabled={busy || partIds.length === 0}
              onClick={() =>
                void run(async () => {
                  await addTenantAccess(tenant.id, partIds);
                  onClose();
                  return null;
                })
              }
            >
              {busy ? "Waiting for Microsoft" : "Continue to Microsoft"}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * The designed state for a page or action that needs a service the active
 * tenant has not connected. It always offers a way to add the service.
 */
export function ServiceNotConnectedPanel({
  tenant,
  serviceIds,
  feature,
}: {
  tenant: TenantRecord;
  /** Services that would each unlock the feature, in preference order. */
  serviceIds: readonly ServiceId[];
  /** What the admin tried to open, for example "Changes". */
  feature: string;
}) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState<ServiceId | null>(null);
  const services = serviceIds.map(serviceById);
  const ownRegistration = usesOwnRegistration(tenant);
  return (
    <div className="flex h-full items-center justify-center px-6 py-12">
      <section
        aria-labelledby="service-not-connected-title"
        className="w-full max-w-[560px] rounded-xl bg-[var(--color-surface)] p-6 ring-1 ring-[var(--color-border)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
            <IconShield size={16} />
          </span>
          <div className="min-w-0">
            <h2 id="service-not-connected-title" className="text-md font-semibold text-[var(--color-text)]">
              {SERVICE_COPY.notConnectedTitle(services.map((service) => service.title), tenant.displayName)}
            </h2>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">
              {SERVICE_COPY.notConnectedBody(feature, services.map((service) => service.title), ownRegistration)}
            </p>
          </div>
        </div>
        <ul className="mt-4 space-y-2">
          {services.map((service) => (
            <li key={service.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                  {service.title}
                  <ServiceStatusBadge status={serviceStatus(tenant, service.id)} />
                </div>
                <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">{service.summary}</p>
              </div>
              <Button size="sm" variant="primary" onClick={() => setAdding(service.id)}>
                {ownRegistration ? SERVICE_COPY.addPermissionsAction(service.title) : SERVICE_COPY.addAction(service.title)}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => navigate("/settings/tenants")}>
            Open Settings, Tenants
          </Button>
        </div>
      </section>
      <ServiceAccessDialog
        tenant={tenant}
        serviceId={adding}
        open={adding !== null}
        onClose={() => setAdding(null)}
      />
    </div>
  );
}
