import { useMemo, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Badge, StatusDot } from "../components/ui";
import { ProviderNotReadyCard } from "../components/provider-setup/ProviderNotReadyCard";
import { TrustBanner } from "../components/TrustBanner";
import {
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconCloud,
  IconHardDrive,
  IconRefresh,
  IconShield,
  IconWarning,
} from "../components/icons";
import { SETUP_COPY, pendingIntentCopy, resumeIntentLabel } from "../copy";
import { copyTextToClipboard } from "../shared/clipboard";
import type {
  ConnectTenantOptions,
  PermissionAreaId,
  ProviderId,
  ProviderSummary,
  RequestedScope,
  TenantRecord,
} from "../shared/openAdminOS";
import { PERMISSION_AREAS } from "../shared/openAdminOS";
import { isProviderImplemented } from "../shared/providers";
import type { PendingIntent } from "./pending-intent";
import { groupRequestedScopes } from "./scope-groups";
import {
  DEFAULT_REGISTRATION_DISPLAY_NAME,
  generateRegistrationSetup,
  REGISTRATION_DISPLAY_NAME_MAX_LENGTH,
  validateRegistrationDisplayName,
  type RegistrationSetupOutput,
} from "./registration-script";

export type SetupStage =
  | "first-run"
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
  onClose,
  onConnect,
  onAddSampleTenant,
  onChooseConnect,
  onChooseOwnRegistration,
  onKeepWaiting,
  onTryAgain,
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
  onClose: () => void;
  onConnect: (options?: ConnectTenantOptions) => void;
  onAddSampleTenant: () => void;
  onChooseConnect: () => void;
  onChooseOwnRegistration: () => void;
  onKeepWaiting: () => void;
  onTryAgain: () => void;
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
      {stage === "first-run" && (
        <FirstRunStep
          onAddSampleTenant={onAddSampleTenant}
          onChooseConnect={onChooseConnect}
          onChooseOwnRegistration={onChooseOwnRegistration}
          onCancel={onClose}
        />
      )}
      {stage === "permissions" && (
        <PermissionsStep
          intent={intent}
          agentName={agentName}
          scopes={scopes}
          scopesError={scopesError}
          onCancel={onClose}
          onConnect={onConnect}
        />
      )}
      {stage === "own-registration" && (
        <PermissionsStep
          intent={intent}
          agentName={agentName}
          scopes={scopes}
          scopesError={scopesError}
          onCancel={onClose}
          onConnect={onConnect}
          initialCustomOpen
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
        <ErrorStep error={error} onTryAgain={onTryAgain} onCancel={onClose} />
      )}
      {stage === "provider" && (
        <ProviderStep
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

function FirstRunStep({
  onAddSampleTenant,
  onChooseConnect,
  onChooseOwnRegistration,
  onCancel,
}: {
  onAddSampleTenant: () => void;
  onChooseConnect: () => void;
  onChooseOwnRegistration: () => void;
  onCancel: () => void;
}) {
  const options = [
    {
      label: SETUP_COPY.sampleAction,
      description: SETUP_COPY.sampleDescription,
      action: onAddSampleTenant,
      primary: true,
    },
    {
      label: SETUP_COPY.connectAction,
      description: SETUP_COPY.connectDescription,
      action: onChooseConnect,
      primary: false,
    },
    {
      label: SETUP_COPY.ownRegistrationAction,
      description: SETUP_COPY.ownRegistrationDescription,
      action: onChooseOwnRegistration,
      primary: false,
    },
  ];
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
        {options.map((option) => (
          <section
            key={option.label}
            className={`rounded-xl p-4 ring-1 ${
              option.primary
                ? "bg-[var(--color-accent-soft)] ring-[var(--color-accent)]/30"
                : "bg-[var(--color-surface)] ring-[var(--color-border-soft)]"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-base font-medium text-[var(--color-text)]">
                  {option.label}
                </h3>
                <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
                  {option.description}
                </p>
              </div>
              <Button
                data-autofocus={option.primary || undefined}
                variant={option.primary ? "primary" : "secondary"}
                size="sm"
                aria-label={option.label}
                onClick={option.action}
                trailingIcon={<IconArrowRight size={12} />}
              >
                {option.primary ? "Open" : "Choose"}
              </Button>
            </div>
          </section>
        ))}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Not now</Button>
      </DialogFooter>
    </>
  );
}

function PermissionsStep({
  intent,
  agentName,
  scopes,
  scopesError,
  onCancel,
  onConnect,
  initialCustomOpen = false,
}: {
  intent: PendingIntent | null;
  agentName?: string;
  scopes: RequestedScope[] | null;
  scopesError: string | null;
  onCancel: () => void;
  onConnect: (options?: ConnectTenantOptions) => void;
  initialCustomOpen?: boolean;
}) {
  const groups = useMemo(() => groupRequestedScopes(scopes ?? []), [scopes]);
  // Bring-your-own app registration: closed by default so the common
  // path stays one button, but always visible as an option.
  const [customOpen, setCustomOpen] = useState(initialCustomOpen);
  const [clientId, setClientId] = useState("");
  const [directoryTenantId, setDirectoryTenantId] = useState("");
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<PermissionAreaId>>(
    () => new Set(PERMISSION_AREAS.map((area) => area.id)),
  );
  const [registrationDisplayName, setRegistrationDisplayName] = useState(
    DEFAULT_REGISTRATION_DISPLAY_NAME,
  );
  const [registrationSetup, setRegistrationSetup] =
    useState<RegistrationSetupOutput | null>(null);
  const [registrationSetupError, setRegistrationSetupError] = useState<string | null>(null);
  const [registrationSetupStatus, setRegistrationSetupStatus] = useState<string | null>(null);
  const [registrationActionError, setRegistrationActionError] = useState<string | null>(null);
  const selectedGroups = groups.filter(
    (group) => group.id === "other" || selectedAreaIds.has(group.id),
  );
  const selectedScopeCount = selectedGroups.reduce(
    (total, group) => total + group.scopes.length,
    0,
  );
  const selectedAreaIdList = PERMISSION_AREAS.filter((area) =>
    selectedAreaIds.has(area.id),
  ).map((area) => area.id);
  const toggleArea = (areaId: PermissionAreaId) => {
    const area = PERMISSION_AREAS.find((candidate) => candidate.id === areaId);
    if (area?.required) return;
    setSelectedAreaIds((current) => {
      const next = new Set(current);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
    setRegistrationSetup(null);
    setRegistrationSetupStatus(null);
    setRegistrationActionError(null);
  };
  const generateSetup = () => {
    const validationError = validateRegistrationDisplayName(registrationDisplayName);
    if (validationError) {
      setRegistrationSetupError(validationError);
      setRegistrationSetup(null);
      return;
    }
    setRegistrationSetupError(null);
    setRegistrationSetupStatus(null);
    setRegistrationActionError(null);
    setRegistrationSetup(
      generateRegistrationSetup(registrationDisplayName, selectedAreaIdList),
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

        <div className="flex items-start gap-3 rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
            <IconShield size={17} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-medium text-[var(--color-text)]">
              Sign in through your system browser
            </h3>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
              Use a Microsoft 365 admin account. Tokens are stored through the operating system’s protected credential store and are never sent to an OpenAdminOS server.
            </p>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
              Microsoft shows the enterprise application as OpenAdminOS. Access can be revoked from Entra Enterprise applications.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-[var(--color-text-muted)]">
                Read permissions
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-soft)]">
                Expand a group to review each exact Microsoft Graph scope and why it is needed.
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
            {groups.map((group) => {
              const areaId = group.id === "other" ? undefined : group.id;
              return (
                <ScopeDisclosure
                  key={group.id}
                  group={group}
                  defaultOpen={false}
                  checked={!areaId || selectedAreaIds.has(areaId)}
                  onCheckedChange={areaId ? () => toggleArea(areaId) : undefined}
                />
              );
            })}
          </div>
        </div>

        <div className="mt-5 space-y-2 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-xs leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          <p>{SETUP_COPY.readOnlyNote}</p>
          <p>{SETUP_COPY.signInScopesNote}</p>
          <p>{SETUP_COPY.delegatedPermissionsNote}</p>
          <p>{SETUP_COPY.betaNote}</p>
        </div>

        <div className="mt-4 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
          <div className="text-xs font-medium text-[var(--color-text-muted)]">
            {SETUP_COPY.appIdentityTitle}
          </div>
          {customOpen ? (
            <div className="mt-2 space-y-3">
              <p className="text-sm leading-5 text-[var(--color-text-soft)]">
                {SETUP_COPY.ownRegistrationBody}
              </p>
              <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                {SETUP_COPY.ownRegistrationNoSecret}
              </p>
              <section className="rounded-lg bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
                <h4 className="text-sm font-medium text-[var(--color-text)]">
                  Generate a setup script for your admin
                </h4>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  The script creates a tenant-owned public client registration for the selected areas. Review it before sending it to your Entra administrator.
                </p>
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
              <button
                type="button"
                onClick={() => setCustomOpen(false)}
                className="text-xs text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text)]"
              >
                {SETUP_COPY.useDefaultRegistration}
              </button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-sm leading-5 text-[var(--color-text-soft)]">
                {SETUP_COPY.appIdentityDefault}
              </p>
              <button
                type="button"
                onClick={() => setCustomOpen(true)}
                className="text-xs text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text)]"
              >
                {SETUP_COPY.useOwnRegistration}
              </button>
            </div>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button
          data-autofocus
          variant="primary"
          leadingIcon={<IconShield size={13} />}
          disabled={
            scopes === null ||
            scopesError !== null ||
            (customOpen && clientId.trim().length === 0)
          }
          onClick={() =>
            onConnect({
              permissionAreaIds: selectedAreaIdList,
              ...(customOpen
                ? {
                    appRegistration: {
                      clientId: clientId.trim(),
                      ...(directoryTenantId.trim()
                        ? { directoryTenantId: directoryTenantId.trim() }
                        : {}),
                    },
                  }
                : {}),
            })
          }
        >
          Approve {selectedScopeCount} read scopes and continue to Microsoft
        </Button>
      </DialogFooter>
    </>
  );
}

function ScopeDisclosure({
  group,
  defaultOpen,
  checked,
  onCheckedChange,
}: {
  group: ReturnType<typeof groupRequestedScopes>[number];
  defaultOpen: boolean;
  checked: boolean;
  onCheckedChange?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const panelId = `setup-scope-group-${group.id}`;
  const checkboxId = `setup-scope-checkbox-${group.id}`;
  return (
    <div className="overflow-hidden rounded-xl bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <div className="flex min-h-12 items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          id={checkboxId}
          aria-label={group.title}
          checked={checked}
          disabled={group.required || !onCheckedChange}
          onChange={onCheckedChange}
          className="h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-60"
        />
        <label
          htmlFor={checkboxId}
          className={`min-w-0 flex-1 ${onCheckedChange && !group.required ? "cursor-pointer" : "cursor-not-allowed"}`}
        >
          <span className="block text-base font-medium text-[var(--color-text)]">
            {group.title} · {group.scopes.length} read scope{group.scopes.length === 1 ? "" : "s"}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">
            {group.summary}
          </span>
        </label>
        <button
          type="button"
          aria-label={`Review ${group.title} scopes`}
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
      <div
        id={panelId}
        hidden={!expanded}
        className="border-t border-[var(--color-border-soft)]"
      >
          {group.scopes.map((scope) => (
            <div key={scope.name} className="border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs text-[var(--color-text)]">
                  {scope.name}
                </span>
                <Badge tone="info"><StatusDot tone="info" /> Read</Badge>
              </div>
              <p className="mt-1.5 text-sm leading-5 text-[var(--color-text-soft)]">
                {scope.rationale}
              </p>
            </div>
          ))}
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

function ErrorStep({ error, onTryAgain, onCancel }: { error: string | null; onTryAgain: () => void; onCancel: () => void }) {
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
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button data-autofocus variant="primary" onClick={onTryAgain}>Try again</Button>
      </DialogFooter>
    </>
  );
}

function ProviderStep({
  providers,
  activeProviderId,
  error,
  pendingRequired,
  onSelectProvider,
  onRecheck,
  onCancel,
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  error: string | null;
  pendingRequired: boolean;
  onSelectProvider: (id: ProviderId) => void;
  onRecheck: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const available = providers.filter((provider) => isProviderImplemented(provider.id));
  const selected = available.find((provider) => provider.id === activeProviderId);
  return (
    <>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-6">
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
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {available.map((provider) => {
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
  tenant,
  delegatedPermissionCount,
  intent,
  agentName,
  onCancel,
  onResume,
}: {
  tenant: TenantRecord | undefined;
  delegatedPermissionCount: number | undefined;
  intent: PendingIntent | null;
  agentName?: string;
  onCancel: () => void;
  onResume: () => void;
}) {
  const registrationSummary = tenant?.appRegistration?.kind === "custom"
    ? `Signed in with your app registration ${tenant.appRegistration.clientId}.`
    : tenant?.appRegistration?.kind === "openadminos"
      ? `The enterprise application OpenAdminOS (app ID ${tenant.appRegistration.clientId}) is now in ${tenant.displayName} with ${delegatedPermissionCount === undefined ? "delegated" : `${delegatedPermissionCount} delegated`} Microsoft Graph permissions, all read-only. Find it in Entra admin center under Enterprise applications.`
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
        <p className="mt-5 text-base leading-6 text-[var(--color-text-soft)]">
          {registrationSummary}
        </p>
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
  if (stage === "first-run") return SETUP_COPY.firstRunTitle;
  if (stage === "provider") return SETUP_COPY.providerTitle;
  if (stage === "ready") return SETUP_COPY.connectedTitle;
  return SETUP_COPY.title;
}

function dialogSubtitle(stage: SetupStage): string {
  switch (stage) {
    case "first-run":
      return SETUP_COPY.firstRunSubtitle;
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
    case "first-run":
      return "Choose how to start OpenAdminOS.";
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
