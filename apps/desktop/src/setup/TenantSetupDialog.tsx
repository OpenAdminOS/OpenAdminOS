import { useMemo, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Badge, StatusDot } from "../components/ui";
import { DetectedHostedProviders } from "../components/provider-setup/DetectedHostedProviders";
import { ProviderNotReadyCard } from "../components/provider-setup/ProviderNotReadyCard";
import { TrustBanner } from "../components/TrustBanner";
import {
  IconCheck,
  IconChevronDown,
  IconCloud,
  IconHardDrive,
  IconRefresh,
  IconShield,
  IconWarning,
} from "../components/icons";
import { POLICY_COPY, SETUP_COPY, pendingIntentCopy, resumeIntentLabel } from "../copy";
import { SetByItBadge } from "../components/ManagedPolicy";
import { copyTextToClipboard } from "../shared/clipboard";
import type {
  ConnectTenantOptions,
  ProviderId,
  ProviderSummary,
  RequestedScope,
  SavedAppRegistration,
  ServiceId,
  TenantRecord,
} from "../shared/openAdminOS";
import {
  AVAILABLE_SERVICES,
  OPENADMINOS_APP_CLIENT_ID,
  SERVICE_PARTS,
  partIdsFor,
  partLabel,
  servicePartById,
  serviceStatus,
} from "../shared/openAdminOS";
import { tenantRegistrationSummary } from "../shared/app-registration";
import { isProviderImplemented } from "../shared/providers";
import { detectedHostedProviders } from "../shared/provider-detection";
import type { PendingIntent } from "./pending-intent";
import {
  groupRequestedScopes,
  includedPartServices,
  includedWithLabel,
  type ScopeGroup,
} from "./scope-groups";
import { PILOT_COPY } from "../shared/pilot-mode";
import { TenantCleanupNotice } from "../components/TenantCleanupNotice";
import {
  DEFAULT_REGISTRATION_DISPLAY_NAME,
  generateRegistrationSetup,
  REGISTRATION_DISPLAY_NAME_MAX_LENGTH,
  validateRegistrationDisplayName,
  type RegistrationSetupOutput,
} from "./registration-script";

export type SetupStage =
  | "own-registration"
  | "permissions"
  | "waiting"
  | "timeout"
  | "error"
  | "provider"
  | "ready";

export function TenantSetupDialog({
  open,
  stage,
  intent,
  scopes,
  scopesError,
  error,
  activeTenant,
  agentName,
  providers,
  activeProviderId,
  savedRegistrations = [],
  registrationLocked = false,
  editOptions,
  onClose,
  onConnect,
  pilotRemoved = false,
  onKeepWaiting,
  onTryAgain,
  onEditSignIn,
  onSelectProvider,
  onRecheckProviders,
  onResume,
}: {
  open: boolean;
  stage: SetupStage;
  intent: PendingIntent | null;
  scopes: RequestedScope[] | null;
  scopesError: string | null;
  error: string | null;
  activeTenant: TenantRecord | undefined;
  agentName?: string;
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  /** Custom registrations remembered on this device, most recent first. */
  savedRegistrations?: SavedAppRegistration[];
  /** The IT policy file locks sign-in to its own registration (the `managed` entry). */
  registrationLocked?: boolean;
  /** Options of the attempt the admin returned to edit after an error. */
  editOptions?: ConnectTenantOptions;
  onClose: () => void;
  onConnect: (options?: ConnectTenantOptions) => void;
  /** True after a connect that ended pilot mode and removed its data. */
  pilotRemoved?: boolean;
  onKeepWaiting: () => void;
  onTryAgain: () => void;
  /** Return from a failed sign-in to the sign-in options. */
  onEditSignIn?: () => void;
  onSelectProvider: (id: ProviderId) => void;
  onRecheckProviders: () => void | Promise<void>;
  onResume: () => void;
}) {
  const statusAnnouncement = setupAnnouncement(stage, activeTenant);

  return (
    <Modal open={open} onClose={onClose} size="md" closeOnScrim={stage !== "waiting"}>
      <ModalHeader
        title={dialogTitle(stage)}
        subtitle={dialogSubtitle(stage)}
        onClose={onClose}
      />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {statusAnnouncement}
      </div>
      {(stage === "permissions" || stage === "own-registration") && (
        <PermissionsStep
          key={stage}
          intent={intent}
          agentName={agentName}
          scopes={scopes}
          scopesError={scopesError}
          savedRegistrations={
            registrationLocked ? savedRegistrations.filter((entry) => entry.managed) : savedRegistrations
          }
          registrationLocked={registrationLocked}
          onCancel={onClose}
          onConnect={onConnect}
          {...(stage === "own-registration" ? { initialChoice: "own" as const } : {})}
          {...(editOptions ? { initialOptions: editOptions } : {})}
        />
      )}
      {stage === "waiting" && <WaitingStep onCancel={onClose} />}
      {stage === "timeout" && (
        <TimeoutStep
          onKeepWaiting={onKeepWaiting}
          onTryAgain={onTryAgain}
          onCancel={onClose}
        />
      )}
      {stage === "error" && (
        <ErrorStep
          error={error}
          onTryAgain={onTryAgain}
          onCancel={onClose}
          {...(onEditSignIn ? { onEditSignIn } : {})}
        />
      )}
      {stage === "provider" && (
        <ProviderStep
          pilotRemoved={pilotRemoved}
          providers={providers}
          activeProviderId={activeProviderId}
          error={error}
          pendingRequired={intentNeedsProvider(intent)}
          onSelectProvider={onSelectProvider}
          onRecheck={onRecheckProviders}
          onCancel={onClose}
        />
      )}
      {stage === "ready" && (
        <ReadyStep
          pilotRemoved={pilotRemoved}
          tenant={activeTenant}
          delegatedPermissionCount={
            activeTenant?.grantedScopes
              ? activeTenant.grantedScopes.length + 3
              : scopes
                ? scopes.length + 3
                : undefined
          }
          intent={intent}
          agentName={agentName}
          onCancel={onClose}
          onResume={onResume}
        />
      )}
    </Modal>
  );
}

export type SignInChoice = "openadminos" | "own";

const NEW_REGISTRATION = "new";
const CLIENT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DIRECTORY_ID_PATTERN = /^[0-9a-zA-Z.-]{1,100}$/;

function savedRegistrationKey(entry: { clientId: string; directoryTenantId?: string }): string {
  return `${entry.clientId.toLowerCase()}|${(entry.directoryTenantId ?? "").toLowerCase()}`;
}

function PermissionsStep({
  intent,
  agentName,
  scopes,
  scopesError,
  savedRegistrations,
  registrationLocked,
  onCancel,
  onConnect,
  initialChoice,
  initialOptions,
}: {
  intent: PendingIntent | null;
  agentName?: string;
  scopes: RequestedScope[] | null;
  scopesError: string | null;
  savedRegistrations: SavedAppRegistration[];
  registrationLocked: boolean;
  onCancel: () => void;
  onConnect: (options?: ConnectTenantOptions) => void;
  /** Set only by entry points that already expressed which app to use. */
  initialChoice?: SignInChoice;
  /** The options of an attempt the admin returns to after an error. */
  initialOptions?: ConnectTenantOptions;
}) {
  const groups = useMemo(() => groupRequestedScopes(scopes ?? []), [scopes]);
  const initialRegistration = initialOptions?.appRegistration;
  // Neither app is preselected: the admin chooses before Approve enables.
  const [choice, setChoice] = useState<SignInChoice | null>(
    registrationLocked
      ? "own"
      : initialOptions ? (initialRegistration ? "own" : "openadminos") : initialChoice ?? null,
  );
  const [savedSelection, setSavedSelection] = useState<string>(() => {
    if (registrationLocked && savedRegistrations[0]) return savedRegistrationKey(savedRegistrations[0]);
    if (initialRegistration) {
      const key = savedRegistrationKey(initialRegistration);
      return savedRegistrations.some((entry) => savedRegistrationKey(entry) === key)
        ? key
        : NEW_REGISTRATION;
    }
    const mostRecent = savedRegistrations[0];
    return mostRecent ? savedRegistrationKey(mostRecent) : NEW_REGISTRATION;
  });
  const [clientId, setClientId] = useState(initialRegistration?.clientId ?? "");
  const [directoryTenantId, setDirectoryTenantId] = useState(
    initialRegistration?.directoryTenantId ?? "",
  );
  const [registrationLabel, setRegistrationLabel] = useState(initialRegistration?.label ?? "");
  // No service is preselected and at least one is required (SPEC.md 2a).
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(
    () =>
      new Set(
        (initialOptions?.partIds ?? []).filter((partId) => {
          const part = servicePartById(partId);
          return Boolean(part && !part.planned);
        }),
      ),
  );
  // Parts whose scopes the selected parts already request, such as Entra
  // users and groups once Intune is selected. They show as included.
  const includedParts = useMemo(() => includedPartServices(selectedPartIds), [selectedPartIds]);
  const [registrationDisplayName, setRegistrationDisplayName] = useState(
    DEFAULT_REGISTRATION_DISPLAY_NAME,
  );
  const [registrationSetup, setRegistrationSetup] =
    useState<RegistrationSetupOutput | null>(null);
  const [registrationSetupError, setRegistrationSetupError] = useState<string | null>(null);
  const [registrationSetupStatus, setRegistrationSetupStatus] = useState<string | null>(null);
  const [registrationActionError, setRegistrationActionError] = useState<string | null>(null);
  // Services share scopes such as User.Read.All, so count unique names.
  const selectedScopeCount = new Set(
    groups.flatMap((group) =>
      group.parts
        .filter((part) => group.id === "other" || selectedPartIds.has(part.id))
        .flatMap((part) => part.scopes.map((scope) => scope.name)),
    ),
  ).size;
  // Registry order, so the request and the script list parts the same way.
  const selectedPartList = SERVICE_PARTS.filter((part) => selectedPartIds.has(part.id)).map(
    (part) => part.id,
  );
  const savedChoice =
    choice === "own" && savedSelection !== NEW_REGISTRATION
      ? savedRegistrations.find((entry) => savedRegistrationKey(entry) === savedSelection)
      : undefined;
  const enteringNew = choice === "own" && !savedChoice;
  const ownRegistration: NonNullable<ConnectTenantOptions["appRegistration"]> | undefined =
    choice !== "own"
      ? undefined
      : savedChoice
        ? {
            clientId: savedChoice.clientId,
            ...(savedChoice.directoryTenantId
              ? { directoryTenantId: savedChoice.directoryTenantId }
              : {}),
            ...(savedChoice.label ? { label: savedChoice.label } : {}),
          }
        : {
            clientId: clientId.trim(),
            ...(directoryTenantId.trim() ? { directoryTenantId: directoryTenantId.trim() } : {}),
            ...(registrationLabel.trim() ? { label: registrationLabel.trim() } : {}),
          };
  const blockedReason =
    choice === null
      ? SETUP_COPY.chooseSignInReason
      : choice === "openadminos" && selectedPartList.length === 0
        ? SETUP_COPY.selectServiceReason
      : ownRegistration && ownRegistration.clientId.length === 0
        ? SETUP_COPY.clientIdRequiredReason
        : ownRegistration && !CLIENT_ID_PATTERN.test(ownRegistration.clientId)
          ? SETUP_COPY.clientIdInvalidReason
          : ownRegistration?.directoryTenantId &&
              !DIRECTORY_ID_PATTERN.test(ownRegistration.directoryTenantId)
            ? SETUP_COPY.directoryIdInvalidReason
            : null;
  const resetScript = () => {
    setRegistrationSetup(null);
    setRegistrationSetupStatus(null);
    setRegistrationActionError(null);
  };
  // A service checkbox selects or clears all of its parts. A part another
  // service already includes counts as selected.
  const toggleService = (serviceId: ServiceId) => {
    const partIds = partIdsFor([serviceId]);
    setSelectedPartIds((current) => {
      const next = new Set(current);
      const included = includedPartServices(current);
      const allSelected = partIds.every((partId) => next.has(partId) || included.has(partId));
      for (const partId of partIds) {
        if (allSelected) next.delete(partId);
        else next.add(partId);
      }
      return next;
    });
    resetScript();
  };
  const togglePart = (partId: string) => {
    setSelectedPartIds((current) => {
      const next = new Set(current);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
    resetScript();
  };
  const generateSetup = () => {
    const validationError =
      selectedPartList.length === 0
        ? SETUP_COPY.selectServiceReason
        : validateRegistrationDisplayName(registrationDisplayName);
    if (validationError) {
      setRegistrationSetupError(validationError);
      setRegistrationSetup(null);
      return;
    }
    setRegistrationSetupError(null);
    setRegistrationSetupStatus(null);
    setRegistrationActionError(null);
    setRegistrationSetup(
      generateRegistrationSetup({
        mode: "create",
        displayName: registrationDisplayName,
        partIds: selectedPartList,
      }),
    );
  };
  const copyRegistrationText = async (text: string, label: string) => {
    try {
      await copyTextToClipboard(text);
      setRegistrationActionError(null);
      setRegistrationSetupStatus(`${label} copied.`);
    } catch (caught) {
      setRegistrationActionError(
        caught instanceof Error ? caught.message : `${label} could not be copied.`,
      );
    }
  };
  const saveRegistrationScript = async () => {
    if (!registrationSetup) return;
    try {
      if (!window.openAdminOS) {
        throw new Error("Saving scripts is unavailable in browser development.");
      }
      const result = await window.openAdminOS.saveTextFile({
        suggestedName: "OpenAdminOS-registration-setup.ps1",
        content: registrationSetup.script,
        filters: [{ name: "PowerShell script", extensions: ["ps1"] }],
      });
      setRegistrationActionError(null);
      if (!result.canceled) setRegistrationSetupStatus("Script saved.");
    } catch (caught) {
      setRegistrationActionError(
        caught instanceof Error ? caught.message : "The script could not be saved.",
      );
    }
  };
  return (
    <>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-6">
        {pendingIntentCopy(intent, agentName) && (
          <div className="mb-5 rounded-lg bg-[var(--color-accent-soft)] px-4 py-3 text-sm leading-5 text-[var(--color-text)] ring-1 ring-[var(--color-accent)]/25">
            {pendingIntentCopy(intent, agentName)}
          </div>
        )}

        <fieldset>
          <legend className="text-xs font-medium text-[var(--color-text-muted)]">
            {SETUP_COPY.signInChoiceLegend}
          </legend>
          <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
            {SETUP_COPY.signInChoiceHint}
          </p>
          {registrationLocked ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-soft)]">
              <SetByItBadge />
              {POLICY_COPY.registrationLocked}
            </p>
          ) : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <SignInChoiceCard
              value="openadminos"
              disabled={registrationLocked}
              checked={choice === "openadminos"}
              title={SETUP_COPY.openAdminOSAppTitle}
              points={SETUP_COPY.openAdminOSAppPoints(OPENADMINOS_APP_CLIENT_ID)}
              onSelect={setChoice}
            />
            <SignInChoiceCard
              value="own"
              checked={choice === "own"}
              title={SETUP_COPY.ownRegistrationTitle}
              points={SETUP_COPY.ownRegistrationPoints}
              onSelect={setChoice}
            />
          </div>
        </fieldset>

        {choice === "own" && (
          <div className="mt-4 space-y-3 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
            {savedRegistrations.length > 0 && (
              <fieldset>
                <legend className="text-xs font-medium text-[var(--color-text-muted)]">
                  {SETUP_COPY.savedRegistrationsLegend}
                </legend>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  {SETUP_COPY.savedRegistrationsHint}
                </p>
                <div className="mt-2 space-y-1.5">
                  {savedRegistrations.map((entry) => {
                    const key = savedRegistrationKey(entry);
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-surface)] px-3 py-2 ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)]"
                      >
                        <input
                          type="radio"
                          name="saved-app-registration"
                          value={key}
                          checked={savedSelection === key}
                          onChange={() => setSavedSelection(key)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-[var(--color-text)]">
                            {entry.label ?? entry.clientId}
                          </span>
                          <span className="block break-all font-mono text-xs text-[var(--color-text-muted)]">
                            {entry.label ? `${entry.clientId}` : null}
                            {entry.label && entry.directoryTenantId ? " · " : null}
                            {entry.directoryTenantId ?? (entry.label ? null : "Multi-tenant")}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                  {registrationLocked ? null : <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-[var(--color-surface-hover)]">
                    <input
                      type="radio"
                      name="saved-app-registration"
                      value={NEW_REGISTRATION}
                      checked={savedSelection === NEW_REGISTRATION}
                      onChange={() => setSavedSelection(NEW_REGISTRATION)}
                      className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                    />
                    <span className="text-sm text-[var(--color-text-soft)]">
                      {SETUP_COPY.newRegistrationOption}
                    </span>
                  </label>}
                </div>
              </fieldset>
            )}
            {enteringNew && (
              <>
                <p className="text-sm leading-5 text-[var(--color-text-soft)]">
                  {SETUP_COPY.ownRegistrationBody}
                </p>
                <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                  {SETUP_COPY.ownRegistrationNoSecret}
                </p>
                <label className="block text-sm text-[var(--color-text-soft)]">
                  {SETUP_COPY.clientIdLabel}
                  <input
                    name="tenant-client-id"
                    autoComplete="off"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    spellCheck={false}
                    className="mt-1 w-full rounded-md bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] focus:outline-none focus:ring-[var(--color-accent)]"
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {SETUP_COPY.clientIdHint}
                  </span>
                </label>
                <label className="block text-sm text-[var(--color-text-soft)]">
                  {SETUP_COPY.directoryIdLabel}
                  <input
                    name="tenant-directory-id"
                    autoComplete="off"
                    value={directoryTenantId}
                    onChange={(event) => setDirectoryTenantId(event.target.value)}
                    placeholder="contoso.onmicrosoft.com"
                    spellCheck={false}
                    className="mt-1 w-full rounded-md bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] focus:outline-none focus:ring-[var(--color-accent)]"
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {SETUP_COPY.directoryIdHint}
                  </span>
                </label>
                <label className="block text-sm text-[var(--color-text-soft)]">
                  {SETUP_COPY.registrationLabelLabel}
                  <input
                    name="tenant-registration-label"
                    autoComplete="off"
                    value={registrationLabel}
                    maxLength={80}
                    onChange={(event) => setRegistrationLabel(event.target.value)}
                    className="mt-1 w-full rounded-md bg-[var(--color-bg)] px-2.5 py-1.5 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] focus:outline-none focus:ring-[var(--color-accent)]"
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {SETUP_COPY.registrationLabelHint}
                  </span>
                </label>
                <section className="rounded-lg bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
                  <h4 className="text-sm font-medium text-[var(--color-text)]">
                    Generate a setup script for your admin
                  </h4>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    The script creates a tenant-owned public client registration for the selected services. Review it before sending it to your Entra administrator.
                  </p>
                  <fieldset className="mt-3">
                    <legend className="text-xs font-medium text-[var(--color-text-muted)]">
                      {SETUP_COPY.scriptServicesLegend}
                    </legend>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                      {AVAILABLE_SERVICES.map((service) => {
                        const partIds = partIdsFor([service.id]);
                        const selected = partIds.filter(
                          (partId) => selectedPartIds.has(partId) || includedParts.has(partId),
                        ).length;
                        return (
                          <label key={service.id} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-soft)]">
                            <TriStateCheckbox
                              ariaLabel={service.title}
                              checked={selected === partIds.length}
                              indeterminate={selected > 0 && selected < partIds.length}
                              onChange={() => toggleService(service.id)}
                            />
                            {service.title}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <label className="mt-3 block text-sm text-[var(--color-text-soft)]">
                    Application display name
                    <input
                      name="registration-display-name"
                      autoComplete="off"
                      value={registrationDisplayName}
                      maxLength={REGISTRATION_DISPLAY_NAME_MAX_LENGTH}
                      onChange={(event) => {
                        setRegistrationDisplayName(event.target.value);
                        setRegistrationSetup(null);
                        setRegistrationSetupError(null);
                        setRegistrationActionError(null);
                      }}
                      className="mt-1 w-full rounded-md bg-[var(--color-bg)] px-2.5 py-1.5 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] focus:outline-none focus:ring-[var(--color-accent)]"
                    />
                  </label>
                  {registrationSetupError && (
                    <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
                      {registrationSetupError}
                    </p>
                  )}
                  <Button className="mt-3" size="sm" variant="secondary" onClick={generateSetup}>
                    Generate setup script
                  </Button>
                  {registrationSetup && (
                    <div className="mt-3 space-y-3">
                      <label className="block text-xs text-[var(--color-text-muted)]">
                        PowerShell script
                        <textarea
                          readOnly
                          aria-label="PowerShell setup script"
                          value={registrationSetup.script}
                          rows={8}
                          spellCheck={false}
                          translate="no"
                          className="mt-1 w-full resize-y rounded-md bg-[var(--color-bg)] p-2 font-mono text-xs leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void copyRegistrationText(registrationSetup.script, "Script")}>Copy script</Button>
                        <Button size="sm" variant="secondary" onClick={() => void saveRegistrationScript()}>Save script</Button>
                      </div>
                      <label className="block text-xs text-[var(--color-text-muted)]">
                        Message for your admin
                        <textarea
                          readOnly
                          aria-label="Message for your admin"
                          value={registrationSetup.message}
                          rows={5}
                          className="mt-1 w-full resize-y rounded-md bg-[var(--color-bg)] p-2 text-xs leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
                        />
                      </label>
                      <Button size="sm" variant="secondary" onClick={() => void copyRegistrationText(registrationSetup.message, "Message")}>Copy message</Button>
                      {registrationSetupStatus && (
                        <p role="status" className="text-xs text-[var(--color-success)]">
                          {registrationSetupStatus}
                        </p>
                      )}
                      {registrationActionError && (
                        <p role="alert" className="text-xs text-[var(--color-danger)]">
                          {registrationActionError}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        )}

        <div className="mt-6 flex items-start gap-3 rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
            <IconShield size={17} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-medium text-[var(--color-text)]">
              Sign in through your system browser
            </h3>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
              {SETUP_COPY.dailyRole}
            </p>
            <p className="mt-2 text-sm leading-5 text-[var(--color-text-soft)]">
              {SETUP_COPY.consentRole}
            </p>
            <p className="mt-2 text-sm leading-5 text-[var(--color-text-soft)]">
              {SETUP_COPY.scopedRoles}
            </p>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
              {SETUP_COPY.tokenStorage}
            </p>
          </div>
        </div>

        {choice === "own" ? (
          <p className="mt-6 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {SETUP_COPY.ownRegistrationServicesNote}
          </p>
        ) : (
          <div className="mt-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-[var(--color-text-muted)]">
                  {SETUP_COPY.servicePickerLegend}
                </div>
                <p className="mt-1 text-sm text-[var(--color-text-soft)]">
                  {SETUP_COPY.servicePickerHint}
                </p>
              </div>
              {scopes && (
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">
                  {selectedScopeCount} scopes selected
                </span>
              )}
            </div>

            <div className="mt-3 space-y-2">
              {scopes === null && !scopesError && (
                <div role="status" className="rounded-xl bg-[var(--color-bg-raised)] px-4 py-5 text-sm text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                  Loading requested permissions…
                </div>
              )}
              {scopesError && (
                <div role="alert" className="rounded-xl bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
                  {scopesError}
                </div>
              )}
              {groups.map((group) => (
                <ServiceDisclosure
                  key={group.id}
                  group={group}
                  selectedPartIds={selectedPartIds}
                  includedParts={includedParts}
                  onToggleService={
                    group.id === "other" ? undefined : () => toggleService(group.id as ServiceId)
                  }
                  onTogglePart={togglePart}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 space-y-2 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-xs leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          <p>{SETUP_COPY.readOnlyNote}</p>
          <p>{SETUP_COPY.signInScopesNote}</p>
          <p>{SETUP_COPY.delegatedPermissionsNote}</p>
          <p>{SETUP_COPY.betaNote}</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3 max-[720px]:flex-col-reverse max-[720px]:items-stretch">
          {blockedReason && (
            <p
              id="setup-approve-blocked-reason"
              className="max-w-[280px] text-right text-xs leading-5 text-[var(--color-text-muted)] max-[720px]:max-w-none max-[720px]:text-left"
            >
              {blockedReason}
            </p>
          )}
          <Button
            data-autofocus
            variant="primary"
            leadingIcon={<IconShield size={13} />}
            aria-describedby={blockedReason ? "setup-approve-blocked-reason" : undefined}
            disabled={scopes === null || scopesError !== null || blockedReason !== null}
            onClick={() =>
              onConnect(
                // An own registration signs in with what the app was granted,
                // so the services only shape the setup script for it. The
                // ready step lists the services its permissions switched on.
                ownRegistration
                  ? { appRegistration: ownRegistration }
                  : { partIds: selectedPartList },
              )
            }
          >
            {choice === "own"
              ? SETUP_COPY.ownRegistrationSignIn
              : `Approve ${selectedScopeCount} read scopes and continue to Microsoft`}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function SignInChoiceCard({
  value,
  checked,
  disabled = false,
  title,
  points,
  onSelect,
}: {
  value: SignInChoice;
  checked: boolean;
  disabled?: boolean;
  title: string;
  points: readonly string[];
  onSelect: (value: SignInChoice) => void;
}) {
  const titleId = `setup-sign-in-${value}-title`;
  const pointsId = `setup-sign-in-${value}-points`;
  return (
    <label
      className={`flex items-start gap-3 rounded-xl px-4 py-3 ring-1 transition-colors focus-within:ring-2 focus-within:ring-[var(--color-accent)] ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${
        checked
          ? "bg-[var(--color-accent-soft)] ring-[var(--color-accent)]/45"
          : "bg-[var(--color-surface)] ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)]"
      }`}
    >
      <input
        type="radio"
        name="sign-in-app"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        aria-labelledby={titleId}
        aria-describedby={pointsId}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)] focus-visible:outline-none"
      />
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-base font-medium text-[var(--color-text)]">
          {title}
        </span>
        <ul id={pointsId} className="mt-1.5 space-y-1 text-xs leading-5 text-[var(--color-text-soft)]">
          {points.map((point) => (
            <li key={point} className="break-words">{point}</li>
          ))}
        </ul>
      </span>
    </label>
  );
}

function TriStateCheckbox({
  ariaLabel,
  checked,
  indeterminate,
  disabled,
  describedBy,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange?: () => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      checked={checked}
      aria-checked={indeterminate ? "mixed" : checked}
      ref={(element) => {
        if (element) element.indeterminate = indeterminate;
      }}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-60"
    />
  );
}

function ServiceDisclosure({
  group,
  selectedPartIds,
  includedParts,
  onToggleService,
  onTogglePart,
}: {
  group: ScopeGroup;
  selectedPartIds: ReadonlySet<string>;
  /** Unselected parts whose scopes other selected parts already request. */
  includedParts: ReadonlyMap<string, readonly ServiceId[]>;
  /** Absent for the Other group, whose rows are always requested. */
  onToggleService?: () => void;
  onTogglePart: (partId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `setup-service-${group.id}`;
  const selectable = Boolean(onToggleService);
  const selectedParts = group.parts.filter(
    (part) => selectedPartIds.has(part.id) || includedParts.has(part.id),
  ).length;
  const allSelected = !selectable || selectedParts === group.parts.length;
  return (
    <div className="overflow-hidden rounded-xl bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <div className="flex min-h-12 items-center gap-3 px-4 py-3">
        <label className={`flex min-w-0 flex-1 items-center gap-3 ${selectable ? "cursor-pointer" : "cursor-not-allowed"}`}>
          <TriStateCheckbox
            ariaLabel={group.title}
            checked={allSelected}
            indeterminate={selectable && selectedParts > 0 && !allSelected}
            disabled={!selectable}
            {...(onToggleService ? { onChange: onToggleService } : {})}
          />
          <span className="min-w-0">
            <span className="block text-base font-medium text-[var(--color-text)]">
              {group.title} · {group.scopes.length} read scope{group.scopes.length === 1 ? "" : "s"}
            </span>
            <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">
              {group.summary}
            </span>
          </span>
        </label>
        <button
          type="button"
          aria-label={`Review ${group.title} parts and scopes`}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          <IconChevronDown
            size={14}
            aria-hidden="true"
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      <div id={panelId} hidden={!expanded} className="border-t border-[var(--color-border-soft)]">
        {group.parts.map((part) => {
          const registryPart = servicePartById(part.id);
          const includedBy = selectedPartIds.has(part.id) ? undefined : includedParts.get(part.id);
          const includedId = `${panelId}-${part.id}-included`;
          return (
            <div key={part.id} className="border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0">
              <label
                className={`flex items-start gap-3 ${selectable && !includedBy ? "cursor-pointer" : ""}`}
              >
                {selectable ? (
                  <span className="mt-0.5">
                    <TriStateCheckbox
                      ariaLabel={registryPart ? partLabel(registryPart) : part.title}
                      checked={selectedPartIds.has(part.id) || Boolean(includedBy)}
                      indeterminate={false}
                      disabled={Boolean(includedBy)}
                      {...(includedBy ? { describedBy: includedId } : {})}
                      onChange={() => onTogglePart(part.id)}
                    />
                  </span>
                ) : null}
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--color-text)]">{part.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">{part.summary}</span>
                  {selectable && includedBy ? (
                    <span id={includedId} className="mt-0.5 block text-xs leading-5 text-[var(--color-text-soft)]">
                      {includedWithLabel(includedBy)}
                    </span>
                  ) : null}
                </span>
              </label>
              <ul className={`mt-2 space-y-2 ${selectable ? "pl-7" : ""}`}>
                {part.scopes.map((scope) => (
                  <li key={scope.name}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-xs text-[var(--color-text)]">
                        {scope.name}
                      </span>
                      <Badge tone="info"><StatusDot tone="info" /> Read</Badge>
                    </div>
                    <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
                      {scope.rationale}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WaitingStep({ onCancel }: { onCancel: () => void }) {
  return (
    <>
      <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-info-soft)] text-[var(--color-info)]">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
        </span>
        <h3 className="mt-5 text-md font-semibold text-[var(--color-text)]">{SETUP_COPY.waitingTitle}</h3>
        <p className="mt-2 max-w-[430px] text-base leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.waitingBody}</p>
      </div>
      <DialogFooter>
        <Button data-autofocus variant="secondary" onClick={onCancel}>Cancel sign-in</Button>
      </DialogFooter>
    </>
  );
}

function TimeoutStep({
  onKeepWaiting,
  onTryAgain,
  onCancel,
}: {
  onKeepWaiting: () => void;
  onTryAgain: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-warning-soft)] text-[var(--color-warning)]">
          <IconWarning size={20} />
        </span>
        <h3 className="mt-5 text-md font-semibold text-[var(--color-text)]">{SETUP_COPY.timeoutTitle}</h3>
        <p className="mt-2 max-w-[460px] text-base leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.timeoutBody}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <div className="flex flex-wrap justify-end gap-2 max-[720px]:w-full max-[720px]:flex-col-reverse">
          <Button variant="secondary" onClick={onKeepWaiting}>Keep waiting</Button>
          <Button data-autofocus variant="primary" onClick={onTryAgain}>Try again</Button>
        </div>
      </DialogFooter>
    </>
  );
}

function ErrorStep({
  error,
  onTryAgain,
  onCancel,
  onEditSignIn,
}: {
  error: string | null;
  onTryAgain: () => void;
  onCancel: () => void;
  onEditSignIn?: () => void;
}) {
  return (
    <>
      <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-danger-soft)] text-[var(--color-danger)]">
          <IconWarning size={20} />
        </span>
        <h3 className="mt-5 text-md font-semibold text-[var(--color-text)]">Microsoft sign-in did not complete</h3>
        <p role="alert" className="mt-2 max-w-[480px] break-words text-base leading-6 text-[var(--color-text-soft)]">
          {error ?? "Review the browser sign-in, then try again."}
        </p>
        {/* Connecting an organization whose disconnect is still cleaning up: retry it here. */}
        <TenantCleanupNotice className="mt-5 w-full max-w-[520px] text-left" />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <div className="flex flex-wrap justify-end gap-2 max-[720px]:w-full max-[720px]:flex-col-reverse">
          {onEditSignIn && (
            <Button variant="secondary" onClick={onEditSignIn}>{SETUP_COPY.editSignIn}</Button>
          )}
          <Button data-autofocus variant="primary" onClick={onTryAgain}>Try again</Button>
        </div>
      </DialogFooter>
    </>
  );
}

function ProviderStep({
  pilotRemoved,
  providers,
  activeProviderId,
  error,
  pendingRequired,
  onSelectProvider,
  onRecheck,
  onCancel,
}: {
  pilotRemoved: boolean;
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  error: string | null;
  pendingRequired: boolean;
  onSelectProvider: (id: ProviderId) => void;
  onRecheck: () => void | Promise<void>;
  onCancel: () => void;
}) {
  // Ready hosted providers lead when no local one is ready. They are
  // listed once, above the grid, and only the user can select them.
  const detected = detectedHostedProviders(providers, activeProviderId);
  const detectedIds = new Set(detected.map((provider) => provider.id));
  const available = providers.filter((provider) => isProviderImplemented(provider.id));
  const selected = available.find((provider) => provider.id === activeProviderId);
  return (
    <>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-6">
        {pilotRemoved ? <div className="-mt-4 mb-4"><PilotRemovedNote /></div> : null}
        <p className="text-base leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.providerBody}</p>
        {pendingRequired && (
          <div className="mt-3 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            {SETUP_COPY.providerRequired}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {error}
          </div>
        )}
        <DetectedHostedProviders
          className="mt-5"
          providers={detected}
          onSelect={onSelectProvider}
        />
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {available.filter((provider) => !detectedIds.has(provider.id)).map((provider) => {
            const active = provider.id === activeProviderId;
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectProvider(provider.id)}
                className={`flex min-h-20 items-start gap-3 rounded-xl px-4 py-3 text-left ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                  active
                    ? "bg-[var(--color-accent-soft)] ring-[var(--color-accent)]/45"
                    : "bg-[var(--color-surface)] ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)]"
                }`}
              >
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${provider.isLocal ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-info-soft)] text-[var(--color-info)]"}`}>
                  {provider.isLocal ? <IconHardDrive size={15} /> : <IconCloud size={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium text-[var(--color-text)]">{provider.name}</span>
                  <span className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                    <StatusDot tone={provider.status === "connected" ? "success" : provider.status === "error" ? "danger" : "neutral"} />
                    {provider.status === "connected" ? "Connected" : provider.status === "error" ? "Needs attention" : "Needs setup"}
                  </span>
                </span>
                {active && <IconCheck size={14} className="mt-1 shrink-0 text-[var(--color-accent)]" />}
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="mt-4 space-y-4">
            <TrustBanner
              variant={selected.isLocal ? "local" : "hosted"}
              title={selected.isLocal ? "Local provider selected" : "Hosted provider selected"}
            >
              {selected.isLocal
                ? "Tenant data and prompts stay on this device while this endpoint remains local."
                : `Tenant prompts and retrieved context are sent to ${selected.name} after the normal hosted-provider confirmation.`}
            </TrustBanner>
            {selected.status !== "connected" && (
              <ProviderNotReadyCard provider={selected} onRecheck={onRecheck} />
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{pendingRequired ? "Cancel" : "Set up later"}</Button>
        <Button variant="secondary" leadingIcon={<IconRefresh size={12} />} onClick={() => void onRecheck()}>Recheck providers</Button>
      </DialogFooter>
    </>
  );
}

function ReadyStep({
  pilotRemoved,
  tenant,
  delegatedPermissionCount,
  intent,
  agentName,
  onCancel,
  onResume,
}: {
  pilotRemoved: boolean;
  tenant: TenantRecord | undefined;
  delegatedPermissionCount: number | undefined;
  intent: PendingIntent | null;
  agentName?: string;
  onCancel: () => void;
  onResume: () => void;
}) {
  const registration = tenant?.appRegistration;
  // Only the OpenAdminOS client is described as the OpenAdminOS enterprise
  // application. Tenants pinned to an earlier client (connected before v0.5)
  // can reach this step through provider setup without reconnecting.
  const registrationSummary = registration?.kind === "custom"
    ? `Signed in with your app registration ${registration.clientId}.`
    : registration?.kind === "openadminos" && registration.clientId === OPENADMINOS_APP_CLIENT_ID
      ? `The enterprise application OpenAdminOS (app ID ${registration.clientId}) is now in ${tenant?.displayName} with ${delegatedPermissionCount === undefined ? "delegated" : `${delegatedPermissionCount} delegated`} Microsoft Graph permissions, all read-only. Find it in Entra admin center under Enterprise applications.`
      : registration && tenant
        ? `Signed in with ${tenantRegistrationSummary(tenant)?.text ?? "an app registration"}, client ID ${registration.clientId}.`
        : "The tenant is connected and active. You can keep exploring or start a tenant-backed action.";

  return (
    <>
      <div className="min-h-[280px] flex-1 p-6">
        <div className="flex items-center gap-3 rounded-xl bg-[var(--color-success-soft)] p-4 ring-1 ring-[var(--color-success)]/25">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)]">
            {tenant ? <Avatar name={tenant.displayName} size={32} /> : <IconCheck size={18} className="text-[var(--color-success)]" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-[var(--color-text)]">{tenant?.displayName ?? SETUP_COPY.connectedTitle}</div>
            {tenant?.username && <div className="mt-0.5 truncate text-sm text-[var(--color-text-soft)]">{tenant.username}</div>}
            {tenant?.id && <div className="mt-1 truncate font-mono text-xs text-[var(--color-text-muted)]">tenant-id: {tenant.id}</div>}
          </div>
          <Badge tone="success"><StatusDot tone="success" /> Active</Badge>
        </div>
        {pilotRemoved ? <PilotRemovedNote /> : null}
        <p className="mt-5 text-base leading-6 text-[var(--color-text-soft)]">
          {registrationSummary}
        </p>
        {tenant && tenant.kind !== "sample" && tenant.grantedScopes !== undefined ? (
          <p className="mt-3 text-sm leading-5 text-[var(--color-text-muted)]">
            {SETUP_COPY.connectedServicesSummary(
              AVAILABLE_SERVICES.filter((service) => serviceStatus(tenant, service.id) !== "missing").map(
                (service) =>
                  serviceStatus(tenant, service.id) === "partial"
                    ? `${service.title} (partial)`
                    : service.title,
              ),
              AVAILABLE_SERVICES.filter((service) => serviceStatus(tenant, service.id) === "missing").map(
                (service) => service.title,
              ),
            )}
          </p>
        ) : null}
        {intent && (
          <p className="mt-3 text-sm leading-5 text-[var(--color-text-muted)]">
            Your original action is ready. Continuing sends it through the normal tenant, provider, and confirmation checks.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{intent ? "Cancel" : "Close"}</Button>
        <Button data-autofocus variant="primary" onClick={onResume}>{resumeIntentLabel(intent, agentName)}</Button>
      </DialogFooter>
    </>
  );
}

function PilotRemovedNote() {
  return (
    <p role="status" className="mt-4 rounded-lg bg-[var(--color-info-soft)] px-3 py-2 text-sm leading-5 text-[var(--color-text)] ring-1 ring-[var(--color-info)]/25">
      {PILOT_COPY.removedAfterConnect}
    </p>
  );
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-elevated)] px-6 py-4 max-[720px]:flex-col-reverse max-[720px]:items-stretch">
      {children}
    </div>
  );
}

function intentNeedsProvider(intent: PendingIntent | null): boolean {
  return (
    intent?.kind === "chat-send" ||
    intent?.kind === "agent-run" ||
    intent?.kind === "scheduled-batch"
  );
}

function dialogTitle(stage: SetupStage): string {
  if (stage === "provider") return SETUP_COPY.providerTitle;
  if (stage === "ready") return SETUP_COPY.connectedTitle;
  return SETUP_COPY.title;
}

function dialogSubtitle(stage: SetupStage): string {
  switch (stage) {
    case "own-registration":
      return SETUP_COPY.subtitle;
    case "permissions":
      return SETUP_COPY.subtitle;
    case "waiting":
      return "Microsoft sign-in is open in your browser.";
    case "timeout":
      return "The local sign-in listener is still waiting.";
    case "error":
      return "Nothing was connected.";
    case "provider":
      return "Choose where answers are generated.";
    case "ready":
      return "Review the next action before continuing.";
  }
}

function setupAnnouncement(stage: SetupStage, tenant: TenantRecord | undefined): string {
  switch (stage) {
    case "own-registration":
      return "Your own app registration form is ready.";
    case "waiting":
      return "Waiting for Microsoft sign-in.";
    case "timeout":
      return "Microsoft sign-in is still waiting.";
    case "error":
      return "Microsoft sign-in did not complete.";
    case "provider":
      return "Tenant connected. Provider setup is required.";
    case "ready":
      return tenant ? `Tenant ${tenant.displayName} connected.` : "Tenant connected.";
    default:
      return "";
  }
}
