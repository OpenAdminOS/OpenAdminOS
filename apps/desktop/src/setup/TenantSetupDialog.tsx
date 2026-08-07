import { useMemo, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Pill, StatusDot } from "../components/Pill";
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
import { SETUP_COPY, pendingIntentCopy, resumeIntentLabel } from "../copy";
import type { ProviderId, ProviderSummary, RequestedScope, TenantRecord } from "../shared/openAdminOS";
import { isProviderImplemented } from "../shared/providers";
import type { PendingIntent } from "./pending-intent";
import { groupRequestedScopes } from "./scope-groups";

export type SetupStage =
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
  onConnect: () => void;
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
          intent={intent}
          agentName={agentName}
          onCancel={onClose}
          onResume={onResume}
        />
      )}
    </Modal>
  );
}

function PermissionsStep({
  intent,
  agentName,
  scopes,
  scopesError,
  onCancel,
  onConnect,
}: {
  intent: PendingIntent | null;
  agentName?: string;
  scopes: RequestedScope[] | null;
  scopesError: string | null;
  onCancel: () => void;
  onConnect: () => void;
}) {
  const groups = useMemo(() => groupRequestedScopes(scopes ?? []), [scopes]);
  return (
    <>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-6">
        {pendingIntentCopy(intent, agentName) && (
          <div className="mb-5 rounded-lg bg-[var(--color-accent-soft)] px-4 py-3 text-[12px] leading-5 text-[var(--color-text)] ring-1 ring-[var(--color-accent)]/25">
            {pendingIntentCopy(intent, agentName)}
          </div>
        )}

        <div className="flex items-start gap-3 rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
            <IconShield size={17} />
          </div>
          <div className="min-w-0">
            <h3 className="text-[13px] font-medium text-[var(--color-text)]">
              Sign in through your system browser
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-soft)]">
              Use a Microsoft 365 admin account. Tokens are stored through the operating system’s protected credential store and are never sent to an OpenAdminOS server.
            </p>
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
              Microsoft shows the app registration as Microsoft Graph Command Line Tools. Access can be revoked from Entra Enterprise applications.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                Read permissions
              </div>
              <p className="mt-1 text-[12px] text-[var(--color-text-soft)]">
                Expand a group to review each exact Microsoft Graph scope and why it is needed.
              </p>
            </div>
            {scopes && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                {scopes.length} scopes
              </span>
            )}
          </div>

          <div className="mt-3 space-y-2">
            {scopes === null && !scopesError && (
              <div role="status" className="rounded-xl bg-[var(--color-bg-raised)] px-4 py-5 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                Loading requested permissions…
              </div>
            )}
            {scopesError && (
              <div role="alert" className="rounded-xl bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
                {scopesError}
              </div>
            )}
            {groups.map((group) => (
              <ScopeDisclosure key={group.id} group={group} defaultOpen={false} />
            ))}
          </div>
        </div>

        <div className="mt-5 space-y-2 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-[11px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          <p>{SETUP_COPY.readOnlyNote}</p>
          <p>{SETUP_COPY.signInScopesNote}</p>
          <p>{SETUP_COPY.betaNote}</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button
          data-autofocus
          variant="primary"
          leadingIcon={<IconShield size={13} />}
          disabled={scopes === null || scopesError !== null}
          onClick={onConnect}
        >
          {SETUP_COPY.approve}
        </Button>
      </DialogFooter>
    </>
  );
}

function ScopeDisclosure({
  group,
  defaultOpen,
}: {
  group: ReturnType<typeof groupRequestedScopes>[number];
  defaultOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const panelId = `setup-scope-group-${group.id}`;
  return (
    <div className="overflow-hidden rounded-xl bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-[var(--color-text)]">
            {group.title} · {group.scopes.length} read scope{group.scopes.length === 1 ? "" : "s"}
          </span>
          <span className="mt-0.5 block text-[11px] leading-5 text-[var(--color-text-muted)]">
            {group.summary}
          </span>
        </span>
        <IconChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={panelId}
        hidden={!expanded}
        className="border-t border-[var(--color-border-soft)]"
      >
          {group.scopes.map((scope) => (
            <div key={scope.name} className="border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-[11px] text-[var(--color-text)]">
                  {scope.name}
                </span>
                <Pill tone="info"><StatusDot tone="info" /> Read</Pill>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-5 text-[var(--color-text-soft)]">
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
        <h3 className="mt-5 text-[16px] font-semibold text-[var(--color-text)]">{SETUP_COPY.waitingTitle}</h3>
        <p className="mt-2 max-w-[430px] text-[12.5px] leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.waitingBody}</p>
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
        <h3 className="mt-5 text-[16px] font-semibold text-[var(--color-text)]">{SETUP_COPY.timeoutTitle}</h3>
        <p className="mt-2 max-w-[460px] text-[12.5px] leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.timeoutBody}</p>
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
        <h3 className="mt-5 text-[16px] font-semibold text-[var(--color-text)]">Microsoft sign-in did not complete</h3>
        <p role="alert" className="mt-2 max-w-[480px] break-words text-[12.5px] leading-6 text-[var(--color-text-soft)]">
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
        <p className="text-[12.5px] leading-6 text-[var(--color-text-soft)]">{SETUP_COPY.providerBody}</p>
        {pendingRequired && (
          <div className="mt-3 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[11.5px] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            {SETUP_COPY.providerRequired}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[11.5px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
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
                  <span className="block text-[12.5px] font-medium text-[var(--color-text)]">{provider.name}</span>
                  <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                    <StatusDot tone={provider.status === "connected" ? "success" : provider.status === "error" ? "danger" : "muted"} />
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
  intent,
  agentName,
  onCancel,
  onResume,
}: {
  tenant: TenantRecord | undefined;
  intent: PendingIntent | null;
  agentName?: string;
  onCancel: () => void;
  onResume: () => void;
}) {
  return (
    <>
      <div className="min-h-[280px] flex-1 p-6">
        <div className="flex items-center gap-3 rounded-xl bg-[var(--color-success-soft)] p-4 ring-1 ring-[var(--color-success)]/25">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)]">
            {tenant ? <Avatar name={tenant.displayName} size={32} /> : <IconCheck size={18} className="text-[var(--color-success)]" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--color-text)]">{tenant?.displayName ?? SETUP_COPY.connectedTitle}</div>
            {tenant?.username && <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-soft)]">{tenant.username}</div>}
            {tenant?.id && <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">tenant-id: {tenant.id}</div>}
          </div>
          <Pill tone="success"><StatusDot tone="success" /> Active</Pill>
        </div>
        <p className="mt-5 text-[12.5px] leading-6 text-[var(--color-text-soft)]">
          {intent
            ? "Your original action is ready. Continuing sends it through the normal tenant, provider, and confirmation checks."
            : "The tenant is connected and active. You can keep exploring or start a tenant-backed action."}
        </p>
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
  if (stage === "provider") return SETUP_COPY.providerTitle;
  if (stage === "ready") return SETUP_COPY.connectedTitle;
  return SETUP_COPY.title;
}

function dialogSubtitle(stage: SetupStage): string {
  switch (stage) {
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
