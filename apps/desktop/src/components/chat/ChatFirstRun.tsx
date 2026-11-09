import { useId, useState } from "react";
import { useNavigate } from "react-router";

import { FIRST_RUN_CHAT_COPY, NOT_CONNECTED_COPY, providerDataLocation } from "../../copy";
import { copyTextToClipboard } from "../../shared/clipboard";
import {
  AVAILABLE_SERVICES,
  BASELINE_SCOPES,
  OPENADMINOS_APP_CLIENT_ID,
  adminConsentUrl,
  availableScopeSet,
  formatServiceList,
  partLabel,
  servicePartById,
  servicesOfParts,
  type AppState,
  type IntuneChatNotConnected,
  type ProviderId,
  type ProviderSummary,
  type ServiceId,
  type TenantRecord,
} from "../../shared/openAdminOS";
import { detectedHostedProviders } from "../../shared/provider-detection";
import { useSetupFlow } from "../../setup/SetupFlowContext";
import { McpServerDialog } from "../marketplace/McpServerDialog";
import { ServiceAccessDialog } from "../ServiceAccess";
import { Button } from "../Button";
import { useToast } from "../Toast";
import { IconCheck, IconCloud, IconCopy, IconHardDrive, IconShield } from "../icons";

/**
 * The only setup Chat cannot work without. Shown in place of the empty
 * Chat while no model is ready (mockup 32, section B).
 */
export function ModelChoice({
  providers,
  activeProviderId,
  onSelectProvider,
}: {
  providers: readonly ProviderSummary[];
  activeProviderId: ProviderId;
  onSelectProvider: (id: ProviderId) => Promise<void>;
}) {
  const navigate = useNavigate();
  const { startPilot } = useSetupFlow();
  const [selecting, setSelecting] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const detected = detectedHostedProviders(providers, activeProviderId);

  const select = (id: ProviderId) => {
    setSelecting(id);
    setError(null);
    void onSelectProvider(id)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setSelecting(null));
  };
  const preview = () => {
    setPreviewing(true);
    setError(null);
    void startPilot()
      .catch((caught: unknown) => setError(FIRST_RUN_CHAT_COPY.previewFailed(caught instanceof Error ? caught.message : String(caught))))
      .finally(() => setPreviewing(false));
  };

  return (
    <div>
      <section
        aria-labelledby="model-choice-heading"
        className="rounded-2xl bg-[var(--color-surface)] p-6 ring-1 ring-[var(--color-border-soft)] shadow-[var(--shadow-soft)]"
      >
        <h2 id="model-choice-heading" className="text-lg font-medium text-[var(--color-text)]">
          {FIRST_RUN_CHAT_COPY.modelChoiceTitle}
        </h2>
        <p className="mt-1 text-base leading-6 text-[var(--color-text-muted)]">{FIRST_RUN_CHAT_COPY.modelChoiceBody}</p>
        <ul className="mt-5 space-y-2.5">
          <ModelOption
            icon={<IconHardDrive size={15} />}
            title={FIRST_RUN_CHAT_COPY.localOptionTitle}
            body={FIRST_RUN_CHAT_COPY.localOptionBody}
            command={FIRST_RUN_CHAT_COPY.localOptionCommand}
            where={FIRST_RUN_CHAT_COPY.localOptionWhere}
            whereTone="local"
            action={
              <Button size="sm" variant="primary" onClick={() => navigate("/settings/providers")}>
                {FIRST_RUN_CHAT_COPY.localOptionAction}
              </Button>
            }
          />
          {detected.map((provider) => (
            <ModelOption
              key={provider.id}
              icon={<IconCloud size={15} />}
              title={FIRST_RUN_CHAT_COPY.hostedOptionTitle(provider.name)}
              body={FIRST_RUN_CHAT_COPY.hostedOptionBody}
              where={FIRST_RUN_CHAT_COPY.hostedOptionWhere(providerDataLocation(provider))}
              whereTone="hosted"
              action={
                <Button size="sm" variant="secondary" disabled={selecting !== null} onClick={() => select(provider.id)}>
                  {FIRST_RUN_CHAT_COPY.hostedOptionAction(provider.name)}
                </Button>
              }
            />
          ))}
          <ModelOption
            title={FIRST_RUN_CHAT_COPY.otherOptionTitle}
            body={FIRST_RUN_CHAT_COPY.otherOptionBody}
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate("/settings/providers")}>
                {FIRST_RUN_CHAT_COPY.otherOptionAction}
              </Button>
            }
          />
        </ul>
        {error ? (
          <p role="alert" className="mt-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </section>
      <p className="mt-4 text-sm text-[var(--color-text-muted)]">
        {FIRST_RUN_CHAT_COPY.previewPrefix}{" "}
        <button
          type="button"
          disabled={previewing}
          onClick={preview}
          className="rounded font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          {FIRST_RUN_CHAT_COPY.previewLink}
        </button>{" "}
        {FIRST_RUN_CHAT_COPY.previewSuffix}
      </p>
    </div>
  );
}

function ModelOption({
  icon,
  title,
  body,
  command,
  where,
  whereTone,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  command?: string;
  where?: string;
  whereTone?: "local" | "hosted";
  action: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-hover)] text-[var(--color-text-muted)]">
        {icon ?? <IconShield size={15} />}
      </span>
      <div className="min-w-[200px] flex-1">
        <div className="text-base font-medium text-[var(--color-text)]">{title}</div>
        <p className="mt-0.5 text-sm leading-5 text-[var(--color-text-soft)]">{body}</p>
        {command ? (
          <code className="mt-1.5 inline-block rounded-md bg-[var(--color-surface)] px-2 py-0.5 font-mono text-xs text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]">
            {command}
          </code>
        ) : null}
        {where ? (
          <p className={`mt-1 text-sm ${whereTone === "hosted" ? "text-[var(--color-warning)]" : "text-[var(--color-success)]"}`}>{where}</p>
        ) : null}
      </div>
      <div className="shrink-0 self-center">{action}</div>
    </li>
  );
}

/** One starter per service, from the registry's first standalone example question. */
export function serviceStarters(): Array<{ question: string; service: string }> {
  return AVAILABLE_SERVICES.slice(0, 2).flatMap((service) => {
    const question = service.parts
      .filter((part) => !part.planned)
      .flatMap((part) => part.chatExamples)
      .find((example) => !/\bthis\b/i.test(example));
    return question ? [{ question, service: service.title }] : [];
  });
}

/**
 * The empty Chat with a model and nothing connected: starters labeled
 * Works now or Needs a service, and the public references with the host
 * each one sends question words to (mockup 32, section A).
 */
export function NoTenantChatHome({
  state,
  disabled,
  onAsk,
}: {
  state: Pick<AppState, "mcpServers" | "chatToolUse">;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readReferencesDismissed);
  const [installing, setInstalling] = useState<string | null>(null);
  const servers = state.mcpServers ?? [];
  const suggestions = servers.filter((server) => !server.installed);
  // The list hides after the admin adds one reference or dismisses it.
  const showReferences = !dismissed && suggestions.length > 0 && !servers.some((server) => server.installed);
  const shown = suggestions.slice(0, 3);
  const installServer = installing ? servers.find((server) => server.id === installing) : undefined;
  const starters = [
    ...FIRST_RUN_CHAT_COPY.worksNowStarters.map((question) => ({ question, label: FIRST_RUN_CHAT_COPY.worksNow, needs: false })),
    ...serviceStarters().map((starter) => ({ question: starter.question, label: FIRST_RUN_CHAT_COPY.needs(starter.service), needs: true })),
  ];

  return (
    <div className="mt-5 space-y-5">
      <ul aria-label={FIRST_RUN_CHAT_COPY.startersLabel} className="grid gap-2 min-[680px]:grid-cols-2">
        {starters.map((starter) => (
          <li key={starter.question}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAsk(starter.question)}
              className="flex h-full w-full flex-col items-start gap-1.5 rounded-xl bg-[var(--color-surface)] px-3.5 py-3 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60"
            >
              <span className="text-base leading-5 text-[var(--color-text)]">{starter.question}</span>
              <span className={`text-xs font-medium ${starter.needs ? "text-[var(--color-text-muted)]" : "text-[var(--color-success)]"}`}>{starter.label}</span>
            </button>
          </li>
        ))}
      </ul>

      {showReferences ? (
        <section aria-labelledby="reference-suggestions-heading" className="rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="reference-suggestions-heading" className="text-base font-medium text-[var(--color-text)]">
              {FIRST_RUN_CHAT_COPY.referencesTitle}
            </h2>
            <button
              type="button"
              aria-label={FIRST_RUN_CHAT_COPY.hideReferencesLabel}
              onClick={() => {
                writeReferencesDismissed();
                setDismissed(true);
              }}
              className="rounded text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {FIRST_RUN_CHAT_COPY.hideReferences}
            </button>
          </div>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{FIRST_RUN_CHAT_COPY.referencesHint}</p>
          <ul className="mt-3 divide-y divide-[var(--color-border-soft)]">
            {shown.map((server) => (
              <li key={server.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-base text-[var(--color-text)]">{server.name}</div>
                  <div className="text-sm text-[var(--color-text-soft)]">{FIRST_RUN_CHAT_COPY.referenceHost(server.host)}</div>
                </div>
                <Button size="sm" variant="secondary" aria-label={FIRST_RUN_CHAT_COPY.addReferenceLabel(server.name)} onClick={() => setInstalling(server.id)}>
                  {FIRST_RUN_CHAT_COPY.addReference}
                </Button>
              </li>
            ))}
          </ul>
          {suggestions.length > shown.length ? (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {FIRST_RUN_CHAT_COPY.moreReferences(suggestions.length - shown.length)}{" "}
              <button
                type="button"
                onClick={() => navigate("/marketplace?kind=mcp")}
                className="rounded font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                {FIRST_RUN_CHAT_COPY.marketplace}
              </button>
              .
            </p>
          ) : null}
        </section>
      ) : null}
      {installServer ? (
        // The existing Marketplace install review, with its authentication step and acknowledgement.
        <McpServerDialog key={installServer.id} server={installServer} toolUse={state.chatToolUse} startWithInstall onClose={() => setInstalling(null)} />
      ) : null}
    </div>
  );
}

const REFERENCES_DISMISSED_KEY = "openadminos:chat-reference-suggestions-dismissed:v1";

function readReferencesDismissed(): boolean {
  try {
    return window.localStorage.getItem(REFERENCES_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeReferencesDismissed(): void {
  try {
    window.localStorage.setItem(REFERENCES_DISMISSED_KEY, "true");
  } catch {
    // The list shows again next launch when storage is unavailable.
  }
}

/** Whether what a not-connected card asked for is now connected, so the admin can ask again. */
export function notConnectedResolved(notConnected: IntuneChatNotConnected, activeTenant: TenantRecord | undefined): boolean {
  if (!activeTenant || activeTenant.kind === "sample") return false;
  if (notConnected.tenantId && notConnected.tenantId !== activeTenant.id) return false;
  const available = availableScopeSet(activeTenant);
  return notConnected.partIds.every((id) => servicePartById(id)?.scopes.every((scope) => available.has(scope.name)) ?? true);
}

/** The message and admin consent link an admin who cannot consent sends to one who can. */
export function adminApprovalMessage(notConnected: IntuneChatNotConnected, tenant: TenantRecord | undefined): string {
  const parts = notConnected.partIds.flatMap((id) => {
    const part = servicePartById(id);
    return part ? [part] : [];
  });
  const scopes = [...new Set(parts.flatMap((part) => part.scopes.map((scope) => scope.name)))];
  const signIn = notConnected.reason === "no-tenant" ? [...BASELINE_SCOPES] : [];
  const services = formatServiceList(servicesOfParts(notConnected.partIds).map((service) => service.title)) || "Microsoft 365";
  return NOT_CONNECTED_COPY.adminMessage({
    services,
    permissions: [...scopes, ...signIn].join(", ") || BASELINE_SCOPES.join(", "),
    link: adminConsentUrl({
      clientId: tenant?.appRegistration?.clientId ?? OPENADMINOS_APP_CLIENT_ID,
      partIds: notConnected.partIds,
      ...(tenant && notConnected.reason !== "no-tenant" ? { tenant: tenant.id } : {}),
    }),
  });
}

/**
 * The answer to a tenant or mixed question that needs a service that is
 * not connected (mockup 32, section D). No Graph call was made, and the
 * question stays in the transcript; once the service is connected the
 * card offers Ask again and nothing is sent before that.
 */
export function NotConnectedCard({
  notConnected,
  tenants,
  activeTenant,
  onAskAgain,
}: {
  notConnected: IntuneChatNotConnected;
  tenants: readonly TenantRecord[];
  activeTenant: TenantRecord | undefined;
  onAskAgain?: () => void;
}) {
  const toast = useToast();
  const { openSetupForParts, openOwnRegistration } = useSetupFlow();
  const [adding, setAdding] = useState<ServiceId | null>(null);
  const headingId = useId();
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const parts = notConnected.partIds.flatMap((id) => {
    const part = servicePartById(id);
    return part ? [part] : [];
  });
  const services = servicesOfParts(notConnected.partIds);
  const serviceNames = formatServiceList(services.map((service) => service.title));
  const askedTenant = notConnected.tenantId ? tenants.find((entry) => entry.id === notConnected.tenantId) : undefined;
  // The tenant the question was about was removed since: the card offers to connect one again.
  const tenantRemoved = Boolean(notConnected.tenantId && !askedTenant);
  const noTenant = notConnected.reason === "no-tenant";
  // A no-tenant card whose Connect added a tenant with only some of the
  // services follows that tenant and offers what is still missing there.
  const connectedSince = noTenant && activeTenant && activeTenant.kind !== "sample" ? activeTenant : undefined;
  const tenant = askedTenant ?? connectedSince;
  const resolved = notConnectedResolved(notConnected, activeTenant);
  // The next action follows what is still missing: after one service is
  // granted, the card offers the others, and Ask again once none is left.
  const grantsFrom = tenant ?? (noTenant || tenantRemoved ? undefined : activeTenant);
  const available = grantsFrom ? availableScopeSet(grantsFrom) : undefined;
  const missingParts = available ? parts.filter((part) => !part.scopes.every((scope) => available.has(scope.name))) : parts;
  const missingServices = servicesOfParts(missingParts.map((part) => part.id));
  const connectFirst = (noTenant && !connectedSince) || tenantRemoved;

  if (resolved && activeTenant) {
    return (
      <section aria-label="Connected" className="rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)]">
            <IconCheck size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-[var(--color-text)]">
              {serviceNames
                ? NOT_CONNECTED_COPY.resolvedTitle(serviceNames, activeTenant.displayName)
                : NOT_CONNECTED_COPY.resolvedTenantTitle(activeTenant.displayName)}
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{NOT_CONNECTED_COPY.resolvedBody}</p>
          </div>
          {onAskAgain ? (
            <Button size="sm" variant="primary" onClick={onAskAgain}>
              {NOT_CONNECTED_COPY.askAgain}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  const missingNames = formatServiceList(missingServices.map((service) => service.title));
  const title = connectedSince && missingNames
    ? `${missingNames} ${missingServices.length === 1 ? "is" : "are"} not connected for ${connectedSince.displayName}`
    : noTenant || tenantRemoved
      ? serviceNames
        ? NOT_CONNECTED_COPY.needsTitle(serviceNames)
        : NOT_CONNECTED_COPY.needsTenantTitle
      : notConnected.reason === "service-missing"
        ? `${serviceNames} ${services.length === 1 ? "is" : "are"} not connected for ${tenant?.displayName ?? "this tenant"}`
        : NOT_CONNECTED_COPY.needsTitle(formatServiceList(parts.map(partLabel)));
  const body = connectedSince
    ? NOT_CONNECTED_COPY.tenantBody(connectedSince.displayName)
    : tenantRemoved
      ? NOT_CONNECTED_COPY.removedTenantBody(serviceNames || "Microsoft 365")
      : noTenant
        ? serviceNames
          ? NOT_CONNECTED_COPY.noTenantBody(serviceNames)
          : NOT_CONNECTED_COPY.noTenantGenericBody
        : NOT_CONNECTED_COPY.tenantBody(tenant?.displayName ?? "this tenant");
  const otherParts = services.flatMap((service) => {
    const rest = service.parts.filter((part) => !part.planned && !notConnected.partIds.includes(part.id));
    return rest.length > 0 ? [NOT_CONNECTED_COPY.otherParts(service.title, rest.map((part) => part.title.toLowerCase()).join(", "))] : [];
  });

  const askAdmin = async () => {
    const message = adminApprovalMessage(notConnected, tenant);
    setCopyFailed(null);
    try {
      await copyTextToClipboard(message);
      toast.success(NOT_CONNECTED_COPY.askAdminCopied);
    } catch {
      setCopyFailed(message);
    }
  };

  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border)]">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
          <IconShield size={16} />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-md font-semibold text-[var(--color-text)]">
            {title}
          </h3>
          <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">{body}</p>
        </div>
      </div>
      {parts.length > 0 || connectFirst ? (
        <ul aria-label="Permissions" className="mt-3 space-y-2 border-t border-[var(--color-border-soft)] pt-3">
          {parts.map((part) => (
            <PermissionRow key={part.id} label={services.length > 1 ? partLabel(part) : part.title} scopes={part.scopes.map((scope) => scope.name)} />
          ))}
          {connectFirst ? <PermissionRow label={NOT_CONNECTED_COPY.signInPart} scopes={[...BASELINE_SCOPES]} /> : null}
          {otherParts.map((line) => (
            <li key={line} className="text-sm text-[var(--color-text-muted)]">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {connectFirst ? (
          <>
            <Button size="sm" variant="primary" onClick={() => openSetupForParts(notConnected.partIds)}>
              {serviceNames ? NOT_CONNECTED_COPY.connect(serviceNames) : NOT_CONNECTED_COPY.connectTenant}
            </Button>
            <Button size="sm" variant="secondary" onClick={openOwnRegistration}>
              {NOT_CONNECTED_COPY.ownRegistration}
            </Button>
          </>
        ) : tenant ? (
          missingServices.map((service, index) => (
            <Button key={service.id} size="sm" variant={index === 0 ? "primary" : "secondary"} onClick={() => setAdding(service.id)}>
              {NOT_CONNECTED_COPY.add(service.title)}
            </Button>
          ))
        ) : null}
        <Button size="sm" variant="ghost" leadingIcon={<IconCopy size={12} />} onClick={() => void askAdmin()}>
          {NOT_CONNECTED_COPY.askAdmin}
        </Button>
      </div>
      {copyFailed ? (
        <div role="alert" className="mt-3 text-sm text-[var(--color-warning)]">
          <p>{NOT_CONNECTED_COPY.askAdminFailed}</p>
          <textarea readOnly aria-label="Message for an admin" value={copyFailed} rows={6} className="mt-2 w-full rounded-lg bg-[var(--color-bg-raised)] p-2 font-mono text-xs text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]" />
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{NOT_CONNECTED_COPY.fine}</p>
      {tenant ? (
        <ServiceAccessDialog
          tenant={tenant}
          serviceId={adding}
          initialPartIds={missingParts.filter((part) => part.service === adding).map((part) => part.id)}
          open={adding !== null}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </section>
  );
}

function PermissionRow({ label, scopes }: { label: string; scopes: readonly string[] }) {
  return (
    <li className="flex flex-col gap-1 min-[560px]:flex-row min-[560px]:gap-3">
      <span className="w-[170px] shrink-0 text-sm font-medium text-[var(--color-text)]">{label}</span>
      <span className="flex flex-wrap gap-1">
        {scopes.map((scope) => (
          <code key={scope} className="rounded-md bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {scope}
          </code>
        ))}
      </span>
    </li>
  );
}

