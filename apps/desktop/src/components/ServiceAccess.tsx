import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { IconShield } from "./icons";
import { Badge, StatusDot } from "./ui";
import { SERVICE_COPY, SETUP_COPY } from "../copy";
import { copyTextToClipboard } from "../shared/clipboard";
import {
  SERVICE_PARTS,
  agentServiceIds,
  grantedParts,
  grantedScopeSet,
  missingServicesForAgent,
  normalizeGraphScopeName,
  serviceById,
  serviceStatus,
  type ServiceConnectionStatus,
  type ServiceId,
  type ServicePart,
  type ServiceScope,
  type TenantCheckProgress,
  type TenantRecord,
} from "../shared/openAdminOS";
import {
  REQUIRED_RESOURCE_ACCESS_NOTES,
  generateRegistrationSetup,
  generateRequiredResourceAccessSnippet,
} from "../setup/registration-script";
import { useAppState } from "../state";

/**
 * True when the license check cannot run because the tenant has not
 * granted Organization.Read.All. A designed "not checked" state, not a
 * warning.
 */
export function licensesNotChecked(tenant: TenantRecord): boolean {
  return (
    tenant.kind !== "sample" &&
    tenant.grantedScopes !== undefined &&
    !grantedScopeSet(tenant).has("Organization.Read.All")
  );
}

type TenantCheckResult<T> =
  | { status: "done"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * Runs a host tenant check (Check again, Retry license check, Add access)
 * with a cancel that aborts the host operation. `progress` is the host's
 * view, including whether a Microsoft sign-in is open.
 */
export function useTenantCheck(tenantId: string) {
  const { state, cancelTenantCheck } = useAppState();
  const progress: TenantCheckProgress | undefined = state.tenantChecks?.find(
    (entry) => entry.tenantId === tenantId,
  );
  const cancelRequested = useRef(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const run = async <T,>(action: () => Promise<T>): Promise<TenantCheckResult<T>> => {
    cancelRequested.current = false;
    setRunning(true);
    try {
      return { status: "done", value: await action() };
    } catch (caught) {
      if (cancelRequested.current) return { status: "cancelled" };
      return { status: "failed", message: caught instanceof Error ? caught.message : String(caught) };
    } finally {
      setRunning(false);
      setCancelling(false);
    }
  };
  const cancel = () => {
    cancelRequested.current = true;
    setCancelling(true);
    void cancelTenantCheck(tenantId).catch(() => undefined);
  };
  const signingIn = progress?.phase === "sign-in";
  return { progress, running, cancelling, signingIn, run, cancel };
}

/** The line shown while a tenant check runs, with its Cancel action. */
export function TenantCheckProgressLine({
  label,
  signingIn,
  cancelling,
  onCancel,
  cancelLabel,
}: {
  label: string;
  signingIn: boolean;
  cancelling: boolean;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-soft)]">
      <span className="min-w-0 flex-1">{signingIn ? SERVICE_COPY.waitingForSignIn : label}</span>
      <Button size="sm" variant="ghost" disabled={cancelling} aria-label={cancelLabel} onClick={onCancel}>
        {cancelling ? SERVICE_COPY.cancellingCheck : SERVICE_COPY.cancelCheck}
      </Button>
    </div>
  );
}

/** True when the tenant signs in with the admin's own app registration. */
export function usesOwnRegistration(tenant: TenantRecord): boolean {
  return tenant.appRegistration?.kind === "custom";
}

/**
 * The line under an agent's permissions. A service with nothing granted
 * blocks the run; a scope a connected service has not granted is
 * requested when the run starts.
 */
export function agentConsentNote(
  tenant: TenantRecord | undefined,
  agent: { scopes: readonly string[]; services?: readonly ServiceId[] },
): string {
  if (!tenant) return SERVICE_COPY.consentNoteGeneric;
  if (tenant.kind === "sample") return SERVICE_COPY.consentNotePilot;
  const missing = missingServicesForAgent(tenant, agentServiceIds(agent));
  if (missing.length > 0) {
    return SERVICE_COPY.consentNoteBlocked(
      missing.map((service) => service.title),
      tenant.displayName,
    );
  }
  const granted = grantedScopeSet(tenant);
  return agent.scopes.every((scope) => granted.has(normalizeGraphScopeName(scope)))
    ? SERVICE_COPY.consentNoteGranted(tenant.displayName)
    : SERVICE_COPY.consentNotePending(tenant.displayName);
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
  const tenantCheck = useTenantCheck(tenant.id);
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
  const [warning, setWarning] = useState<string | null>(null);
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
    setWarning(null);
    try {
      const message = await action();
      if (message) setStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  // Check again and Add access run in the host with a cancel and a deadline.
  const runCheck = async (
    kind: "permissions" | "access",
    action: () => Promise<{ message: string | null; warning?: string }>,
  ) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setWarning(null);
    const result = await tenantCheck.run(action);
    setBusy(false);
    if (result.status === "cancelled") setStatus(SERVICE_COPY.checkCancelled[kind]);
    else if (result.status === "failed") setError(result.message);
    else {
      if (result.value.warning) setWarning(result.value.warning);
      if (result.value.message) setStatus(result.value.message);
    }
  };
  const checking = tenantCheck.running;

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
        {checking ? (
          <p role="status" className="text-sm text-[var(--color-text-soft)]">
            {tenantCheck.signingIn
              ? SERVICE_COPY.waitingForSignIn
              : ownRegistration
                ? SERVICE_COPY.checkingPermissions
                : SERVICE_COPY.addingAccess}
          </p>
        ) : null}
        {status && (
          <p
            role="status"
            className={`text-sm ${
              status === SERVICE_COPY.checkCancelled.permissions || status === SERVICE_COPY.checkCancelled.access
                ? "text-[var(--color-text-soft)]"
                : "text-[var(--color-success)]"
            }`}
          >
            {status}
          </p>
        )}
        {warning && (
          <div role="alert" className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            {warning}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {checking ? (
            <Button variant="ghost" disabled={tenantCheck.cancelling} onClick={tenantCheck.cancel}>
              {tenantCheck.cancelling ? SERVICE_COPY.cancellingCheck : SERVICE_COPY.cancelCheck}
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={close}>
              {missing.length === 0 ? "Close" : "Cancel"}
            </Button>
          )}
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
                  void runCheck("permissions", async () => {
                    const next = await refreshTenantGrants(tenant.id);
                    const probe = next.tenants.find((entry) => entry.id === tenant.id)?.tierProbeWarning;
                    return probe
                      ? { message: null, warning: SERVICE_COPY.checkedAgainWithWarning(probe.message) }
                      : { message: SERVICE_COPY.checkedAgain };
                  })
                }
              >
                {checking && tenantCheck.signingIn
                  ? SERVICE_COPY.waitingForSignInButton
                  : checking
                    ? "Checking"
                    : SERVICE_COPY.checkAgain}
              </Button>
            </>
          ) : missing.length > 0 ? (
            <Button
              variant="primary"
              disabled={busy || partIds.length === 0}
              onClick={() =>
                void runCheck("access", async () => {
                  const next = await addTenantAccess(tenant.id, partIds);
                  const probe = next.tenants.find((entry) => entry.id === tenant.id)?.tierProbeWarning;
                  // A license check that did not finish stays visible here.
                  if (probe) return { message: null, warning: SERVICE_COPY.accessAddedWithWarning(probe.message) };
                  onClose();
                  return { message: null };
                })
              }
            >
              {checking && tenantCheck.signingIn
                ? SERVICE_COPY.waitingForSignInButton
                : checking
                  ? SERVICE_COPY.addingAccess
                  : "Continue to Microsoft"}
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
/** Small chips naming the services an agent needs. */
export function ServiceChips({ services }: { services: readonly ServiceId[] }) {
  if (services.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label={SERVICE_COPY.chipsLabel(services.map((id) => serviceById(id).title))}>
      {services.map((id) => (
        <Badge key={id} tone="neutral" aria-hidden="true">
          {serviceById(id).title}
        </Badge>
      ))}
    </span>
  );
}


/**
 * One line for a run or detail view: "Needs Defender, not connected", with
 * an Add action that opens the same dialog as Settings.
 */
export function ServiceNotConnectedNotice({
  tenant,
  serviceIds,
}: {
  tenant: TenantRecord;
  serviceIds: readonly ServiceId[];
}) {
  const [adding, setAdding] = useState<ServiceId | null>(null);
  if (serviceIds.length === 0) return null;
  const titles = serviceIds.map((id) => serviceById(id).title);
  const ownRegistration = usesOwnRegistration(tenant);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 ring-1 ring-[var(--color-warning)]/25">
      <div className="min-w-0 text-sm leading-relaxed text-[var(--color-text)]">
        <span className="font-medium">{SERVICE_COPY.needsNotConnected(titles)}</span>{" "}
        <span className="text-[var(--color-text-soft)]">{SERVICE_COPY.needsNotConnectedBody(tenant.displayName)}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {serviceIds.map((id) => (
          <Button key={id} size="sm" variant="secondary" onClick={() => setAdding(id)}>
            {ownRegistration
              ? SERVICE_COPY.addPermissionsAction(serviceById(id).title)
              : SERVICE_COPY.addAction(serviceById(id).title)}
          </Button>
        ))}
      </div>
      <ServiceAccessDialog
        tenant={tenant}
        serviceId={adding}
        open={adding !== null}
        onClose={() => setAdding(null)}
      />
    </div>
  );
}

/**
 * A tenant whose Entra tier and license probe did not finish, for example
 * because another account signed in. The stored tier and licenses stay.
 * Retry license check runs only the probe, with a cancel.
 */
export function TenantProbeWarning({ tenant }: { tenant: TenantRecord }) {
  const { retryTenantLicenseCheck } = useAppState();
  const check = useTenantCheck(tenant.id);
  const [result, setResult] = useState<{ tone: "success" | "neutral" | "danger"; text: string } | null>(null);
  const warning = tenant.tierProbeWarning;
  const retry = async () => {
    setResult(null);
    const outcome = await check.run(() => retryTenantLicenseCheck(tenant.id));
    if (outcome.status === "cancelled") {
      setResult({ tone: "neutral", text: SERVICE_COPY.checkCancelled.license });
    } else if (outcome.status === "failed") {
      setResult({ tone: "danger", text: outcome.message });
    } else {
      const after = outcome.value.tenants.find((entry) => entry.id === tenant.id);
      setResult(
        after?.tierProbeWarning
          ? { tone: "neutral", text: SERVICE_COPY.licenseCheckStillFailing }
          : { tone: "success", text: SERVICE_COPY.licenseCheckFinished },
      );
    }
  };
  const resultLine = result ? (
    <p
      role={result.tone === "danger" ? "alert" : "status"}
      className={`mt-2 text-xs ${
        result.tone === "success"
          ? "text-[var(--color-success)]"
          : result.tone === "danger"
            ? "text-[var(--color-danger)]"
            : "text-[var(--color-text-soft)]"
      }`}
    >
      {result.text}
    </p>
  ) : null;
  if (!warning) return resultLine;
  return (
    <div
      role="alert"
      aria-label={`${tenant.displayName} license check`}
      className="mt-2 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-relaxed ring-1 ring-[var(--color-warning)]/25"
    >
      <span className="font-medium text-[var(--color-warning)]">{SERVICE_COPY.tierProbeWarningTitle}</span>{" "}
      <span className="text-[var(--color-text)]">{warning.message}</span>{" "}
      <span className="text-[var(--color-text-soft)]">{SERVICE_COPY.tierProbeWarningKept}</span>
      {check.running ? (
        <TenantCheckProgressLine
          label={SERVICE_COPY.checkingLicenses}
          signingIn={check.signingIn}
          cancelling={check.cancelling}
          onCancel={check.cancel}
          cancelLabel={SERVICE_COPY.cancelLicenseCheckFor(tenant.displayName)}
        />
      ) : (
        <div className="mt-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={check.progress !== undefined}
            aria-label={SERVICE_COPY.retryLicenseCheckFor(tenant.displayName)}
            onClick={() => void retry()}
          >
            {SERVICE_COPY.retryLicenseCheck}
          </Button>
        </div>
      )}
      {resultLine}
    </div>
  );
}

/** The designed state for a tenant whose licenses cannot be checked yet. */
export function TenantLicensesNotChecked({ tenant }: { tenant: TenantRecord }) {
  if (!licensesNotChecked(tenant) || tenant.tierProbeWarning) return null;
  return (
    <div className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
      <span className="font-medium text-[var(--color-text-soft)]">{SERVICE_COPY.licensesNotChecked}.</span>{" "}
      {SERVICE_COPY.licensesNotCheckedBody}
    </div>
  );
}

/**
 * Shows the designed not-connected panel instead of a page whose data
 * comes from services the active tenant has not connected. With no tenant,
 * the sample tenant, or any listed service connected, the page renders.
 */
export function ServiceGate({
  anyOf,
  feature,
  children,
}: {
  /** The page works when at least one of these services is connected. */
  anyOf: readonly ServiceId[];
  feature: string;
  children: ReactNode;
}) {
  const { state } = useAppState();
  const tenant = state.tenants.find((entry) => entry.id === state.activeTenantId);
  if (
    !tenant ||
    tenant.kind === "sample" ||
    anyOf.some((serviceId) => serviceStatus(tenant, serviceId) !== "missing")
  ) {
    return <>{children}</>;
  }
  return <ServiceNotConnectedPanel tenant={tenant} serviceIds={anyOf} feature={feature} />;
}
