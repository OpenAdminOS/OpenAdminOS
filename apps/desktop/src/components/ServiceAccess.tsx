import { useEffect, useState, type ReactNode } from "react";
import { ServiceMark } from "./ServiceMark";
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

type CheckTone = "success" | "neutral" | "warning" | "danger";

/** How a tenant check ended: its value, or the host's message and its tone. */
type TenantCheckResult<T> =
  | { status: "done"; value: T }
  | { status: "ended"; tone: Exclude<CheckTone, "success">; message: string };

/** The host's check for a tenant, wherever it was started. */
function useTenantCheckProgress(tenantId: string): TenantCheckProgress | undefined {
  const { state } = useAppState();
  return state.tenantChecks?.find((entry) => entry.tenantId === tenantId);
}

/**
 * Starts a host tenant check (Check again, Retry license check, Add
 * access). `busy` is true while this component's call runs or the host
 * reports any check for the tenant. A cancel, from any view, ends the call
 * with the host's message, which says what was kept.
 */
export function useTenantCheck(tenantId: string) {
  const progress = useTenantCheckProgress(tenantId);
  const [running, setRunning] = useState(false);
  const run = async <T,>(action: () => Promise<T>): Promise<TenantCheckResult<T>> => {
    setRunning(true);
    try {
      return { status: "done", value: await action() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const tone: Exclude<CheckTone, "success"> =
        error.name === "TenantCheckCancelledError"
          ? "neutral"
          : error.name === "TenantCheckTimeoutError"
            ? "warning"
            : "danger";
      return { status: "ended", tone, message: error.message };
    } finally {
      setRunning(false);
    }
  };
  return { progress, running, busy: running || progress !== undefined, run };
}

function tenantCheckLabel(progress: TenantCheckProgress): string {
  if (progress.phase === "sign-in") return SERVICE_COPY.waitingForSignIn;
  if (progress.phase === "licenses" || progress.kind === "license") return SERVICE_COPY.checkingLicenses;
  return progress.kind === "access" ? SERVICE_COPY.addingAccess : SERVICE_COPY.checkingPermissions;
}

/** A short label for the button that started a check, while it runs. */
export function tenantCheckButtonLabel(progress: TenantCheckProgress | undefined): string {
  return progress?.phase === "sign-in" ? SERVICE_COPY.waitingForSignInButton : SERVICE_COPY.checkRunning;
}

/**
 * The check the host is running for a tenant, with its Cancel. Shown
 * wherever the tenant's check state is shown, whichever view started it.
 */
export function TenantCheckStatus({
  tenant,
  className = "mt-2",
  inMenu = false,
}: {
  tenant: TenantRecord;
  className?: string;
  /** Inside a menu, Cancel is a menu item so arrow keys reach it. */
  inMenu?: boolean;
}) {
  const { cancelTenantCheck } = useAppState();
  const progress = useTenantCheckProgress(tenant.id);
  const [cancelling, setCancelling] = useState(false);
  const running = progress !== undefined;
  useEffect(() => {
    if (!running) setCancelling(false);
  }, [running]);
  if (!progress) return null;
  return (
    <div
      role="status"
      aria-label={SERVICE_COPY.checkRunningFor(tenant.displayName)}
      className={`${className} flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-soft)]`}
    >
      <span className="min-w-0 flex-1">{tenantCheckLabel(progress)}</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={cancelling}
        aria-label={SERVICE_COPY.cancelCheckFor(tenant.displayName)}
        {...(inMenu ? { role: "menuitem", tabIndex: -1 } : {})}
        onClick={() => {
          setCancelling(true);
          void cancelTenantCheck(tenant.id).catch(() => setCancelling(false));
        }}
      >
        {cancelling ? SERVICE_COPY.cancellingCheck : SERVICE_COPY.cancelCheck}
      </Button>
    </div>
  );
}

/** A tenant check's result line. */
export function TenantCheckResultLine({
  result,
  className = "mt-2 text-xs",
}: {
  result: { tone: CheckTone; text: string } | null;
  className?: string;
}) {
  if (!result) return null;
  const color = {
    success: "text-[var(--color-success)]",
    neutral: "text-[var(--color-text-soft)]",
    warning: "text-[var(--color-warning)]",
    danger: "text-[var(--color-danger)]",
  }[result.tone];
  return (
    <p role={result.tone === "danger" ? "alert" : "status"} className={`${className} ${color}`}>
      {result.text}
    </p>
  );
}

/** The result of a Check again for display. */
export function checkAgainResult(
  result: TenantCheckResult<{ tenants: TenantRecord[] }>,
  tenantId: string,
): { tone: CheckTone; text: string } {
  if (result.status === "ended") return { tone: result.tone, text: result.message };
  const probe = result.value.tenants.find((entry) => entry.id === tenantId)?.tierProbeWarning;
  return probe
    ? { tone: "warning", text: SERVICE_COPY.checkedAgainWithWarning(probe.message) }
    : { tone: "success", text: SERVICE_COPY.checkedAgain };
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
  const [result, setResult] = useState<{ tone: CheckTone; text: string } | null>(null);
  const selectedParts = missing.filter((part) => selected.has(part.id));
  const scopes = uniqueScopes(selectedParts);
  const partIds = selectedParts.map((part) => part.id);
  // A check for this tenant, from here or another view, holds the actions.
  const locked = busy || tenantCheck.busy;
  const close = () => {
    if (!busy && !tenantCheck.running) onClose();
  };

  const toggle = (partId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
    setResult(null);
  };

  const copy = async (label: string, text: () => string) => {
    setBusy(true);
    setResult(null);
    try {
      await copyTextToClipboard(text());
      setResult({ tone: "success", text: SERVICE_COPY.copied(label) });
    } catch (caught) {
      setResult({ tone: "danger", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    setResult(null);
    setResult(checkAgainResult(await tenantCheck.run(() => refreshTenantGrants(tenant.id)), tenant.id));
  };

  const addAccess = async () => {
    setResult(null);
    const outcome = await tenantCheck.run(() => addTenantAccess(tenant.id, partIds));
    if (outcome.status === "ended") {
      setResult({ tone: outcome.tone, text: outcome.message });
      return;
    }
    const probe = outcome.value.tenants.find((entry) => entry.id === tenant.id)?.tierProbeWarning;
    // A license check that did not finish stays visible here.
    if (probe) setResult({ tone: "warning", text: SERVICE_COPY.accessAddedWithWarning(probe.message) });
    else onClose();
  };

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
                    disabled={locked}
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
        <TenantCheckStatus tenant={tenant} className="" />
        <TenantCheckResultLine result={result} className="text-sm" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy || tenantCheck.running} onClick={close}>
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
              <Button variant="primary" disabled={locked} onClick={() => void checkAgain()}>
                {tenantCheck.running ? tenantCheckButtonLabel(tenantCheck.progress) : SERVICE_COPY.checkAgain}
              </Button>
            </>
          ) : missing.length > 0 ? (
            <Button
              variant="primary"
              disabled={locked || partIds.length === 0}
              onClick={() => void addAccess()}
            >
              {tenantCheck.running ? tenantCheckButtonLabel(tenantCheck.progress) : "Continue to Microsoft"}
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
          <Button size="sm" variant="ghost" onClick={() => navigate("/connections")}>
            Open Connections
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
  primary = false,
}: {
  tenant: TenantRecord;
  serviceIds: readonly ServiceId[];
  /** In the run review the fix is the one filled button. */
  primary?: boolean;
}) {
  const [adding, setAdding] = useState<ServiceId | null>(null);
  if (serviceIds.length === 0) return null;
  const titles = serviceIds.map((id) => serviceById(id).title);
  const ownRegistration = usesOwnRegistration(tenant);
  return (
    // Missing access is neutral and dashed, never amber: amber means data leaves this device.
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-inset ring-[var(--color-border-soft)]">
      <ServiceMark serviceId={serviceIds[0]!} size="lg" off />
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-[var(--color-text)]">
        <span className="font-medium">{SERVICE_COPY.needsNotConnected(titles)}</span>{" "}
        <span className="text-[var(--color-text-soft)]">{SERVICE_COPY.needsNotConnectedBody(tenant.displayName)}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {serviceIds.map((id) => (
          <Button key={id} size="sm" variant={primary ? "primary" : "secondary"} onClick={() => setAdding(id)}>
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
 * Retry license check runs only the probe; its progress and Cancel show
 * in `TenantCheckStatus`.
 */
export function TenantProbeWarning({ tenant }: { tenant: TenantRecord }) {
  const { retryTenantLicenseCheck } = useAppState();
  const check = useTenantCheck(tenant.id);
  const [result, setResult] = useState<{ tone: CheckTone; text: string } | null>(null);
  const warning = tenant.tierProbeWarning;
  const retry = async () => {
    setResult(null);
    const outcome = await check.run(() => retryTenantLicenseCheck(tenant.id));
    if (outcome.status === "ended") {
      setResult({ tone: outcome.tone, text: outcome.message });
    } else {
      const after = outcome.value.tenants.find((entry) => entry.id === tenant.id);
      setResult(
        after?.tierProbeWarning
          ? { tone: "neutral", text: SERVICE_COPY.licenseCheckStillFailing }
          : { tone: "success", text: SERVICE_COPY.licenseCheckFinished },
      );
    }
  };
  if (!warning) return <TenantCheckResultLine result={result} />;
  return (
    <div
      role="alert"
      aria-label={`${tenant.displayName} license check`}
      className="mt-2 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-relaxed ring-1 ring-[var(--color-warning)]/25"
    >
      <span className="font-medium text-[var(--color-warning)]">{SERVICE_COPY.tierProbeWarningTitle}</span>{" "}
      <span className="text-[var(--color-text)]">{warning.message}</span>{" "}
      <span className="text-[var(--color-text-soft)]">{SERVICE_COPY.tierProbeWarningKept}</span>
      <div className="mt-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={check.busy}
          aria-label={SERVICE_COPY.retryLicenseCheckFor(tenant.displayName)}
          onClick={() => void retry()}
        >
          {SERVICE_COPY.retryLicenseCheck}
        </Button>
      </div>
      <TenantCheckResultLine result={result} />
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
