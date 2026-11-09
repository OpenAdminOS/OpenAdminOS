import { useId, useState } from "react";
import { useNavigate } from "react-router";

import { FIRST_RUN_CHAT_COPY, MODEL_SCAN_COPY, NOT_CONNECTED_COPY } from "../../copy";
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
import { actionLabel, actionNote, optionsFromProviders, preselect, type ChoiceOption } from "../../setup/model-choice";
import { ModelChoiceList } from "../ModelChoiceList";
import { useSetupFlow } from "../../setup/SetupFlowContext";
import { useAppState } from "../../state";
import { McpServerDialog } from "../marketplace/McpServerDialog";
import { ServiceAccessDialog } from "../ServiceAccess";
import { ReferenceMark, ServiceMark } from "../ServiceMark";
import { Button } from "../Button";
import { useToast } from "../Toast";
import { IconCheck, IconShield } from "../icons";

/**
 * The only setup Chat cannot work without, shown in place of the empty Chat
 * while no model is ready. It is the scan's choice list (mockup 32,
 * section B), so first launch and Chat show the same decision the same way.
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
  const { refresh } = useAppState();
  const options = optionsFromProviders(providers);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [working, setWorking] = useState<ProviderId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({});
  const picked = selected && options.some((option) => option.providerId === selected) ? selected : preselect(options);
  const chosen = options.find((option) => option.providerId === picked);
  const note = actionNote(chosen);

  const act = async (option: ChoiceOption) => {
    if (working) return;
    if (option.action === "get-model") {
      navigate("/settings/providers");
      return;
    }
    if (option.action === "rescan") {
      // LM Studio runs without a loaded model: check the providers again once one is loaded.
      setWorking(option.providerId);
      try {
        await window.openAdminOS?.refreshProviders?.();
        await refresh();
      } finally {
        setWorking(null);
      }
      return;
    }
    setWorking(option.providerId);
    setErrors(({ [option.providerId]: _cleared, ...rest }) => rest);
    try {
      if (option.action === "start") {
        const started = await window.openAdminOS?.startLocalRuntime?.(option.providerId);
        if (!started?.started) {
          setErrors((all) => ({ ...all, [option.providerId]: started?.message ?? MODEL_SCAN_COPY.startFailed(option.name) }));
          return;
        }
      }
      await onSelectProvider(option.providerId);
    } catch (caught) {
      setErrors((all) => ({ ...all, [option.providerId]: caught instanceof Error ? caught.message : String(caught) }));
    } finally {
      setWorking(null);
    }
  };
  return (
    <section aria-labelledby="model-choice-heading">
      <h2 id="model-choice-heading" className="text-md font-medium text-[var(--color-text)]">
        {FIRST_RUN_CHAT_COPY.modelChoiceTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--color-text-soft)]">{MODEL_SCAN_COPY.chooseBody}</p>
      <div className="mt-4">
        <ModelChoiceList options={options} selected={picked} onSelect={setSelected} disabled={working !== null} errors={errors} label={FIRST_RUN_CHAT_COPY.modelChoiceTitle} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" size="lg" disabled={!chosen || working !== null} onClick={() => chosen && void act(chosen)}>
          {actionLabel(chosen, activeProviderId, "chat")}
        </Button>
        <button type="button" onClick={() => navigate("/settings/providers")} className={quietLink}>
          {MODEL_SCAN_COPY.allProviders}
        </button>
      </div>
      {note ? <p className="mt-2 text-xs text-[var(--color-text-muted)]">{note}</p> : null}
    </section>
  );
}

const quietLink =
  "rounded-sm text-sm text-[var(--color-text-soft)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60";

/**
 * The "Needs a service" column of the empty Chat: the first service's
 * standalone example questions, so the heading names the one service they
 * all need.
 */
export function serviceStarterColumn(limit = 2): { service: (typeof AVAILABLE_SERVICES)[number]; questions: string[] } | undefined {
  for (const service of AVAILABLE_SERVICES) {
    const questions = service.parts
      .filter((part) => !part.planned)
      .flatMap((part) => part.chatExamples)
      .filter((example) => !/\bthis\b/i.test(example))
      .slice(0, limit);
    if (questions.length > 0) return { service, questions };
  }
  return undefined;
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
  const shown = suggestions.slice(0, 2);
  const installServer = installing ? servers.find((server) => server.id === installing) : undefined;
  const needs = serviceStarterColumn();
  const columns = [
    { key: "works", heading: FIRST_RUN_CHAT_COPY.worksNow, mark: null, questions: [...FIRST_RUN_CHAT_COPY.worksNowStarters] },
    ...(needs
      ? [{ key: "needs", heading: FIRST_RUN_CHAT_COPY.needs(needs.service.title), mark: <ServiceMark serviceId={needs.service.id} size="sm" off />, questions: needs.questions }]
      : []),
  ];

  return (
    <div className="@container mt-7 space-y-7">
      {/* Two columns of plain rows (mockup 32, section C); one column on a narrow window. */}
      <div aria-label={FIRST_RUN_CHAT_COPY.startersLabel} role="group" className="grid gap-x-8 gap-y-5 @[600px]:grid-cols-2">
        {columns.map((column) => (
          <section key={column.key} aria-labelledby={`starters-${column.key}`}>
            <h2 id={`starters-${column.key}`} className="flex items-center gap-2 px-2 text-sm font-medium text-[var(--color-text-soft)]">
              {column.mark}
              {column.heading}
            </h2>
            <ul className="mt-1.5">
              {column.questions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onAsk(question)}
                    className="flex min-h-10 w-full items-center rounded-md px-2 py-2 text-left text-base leading-5 text-[var(--color-text)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60"
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {showReferences ? (
        <section aria-labelledby="reference-suggestions-heading" className="border-t border-[var(--color-border-soft)] pt-4">
          <div className="flex items-center justify-between gap-2 px-2">
            <h2 id="reference-suggestions-heading" className="text-sm font-medium text-[var(--color-text)]">
              {FIRST_RUN_CHAT_COPY.referencesTitle}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              aria-label={FIRST_RUN_CHAT_COPY.hideReferencesLabel}
              onClick={() => {
                writeReferencesDismissed();
                setDismissed(true);
              }}
            >
              {FIRST_RUN_CHAT_COPY.hideReferences}
            </Button>
          </div>
          <p className="px-2 text-xs text-[var(--color-text-muted)]">{FIRST_RUN_CHAT_COPY.referencesHint}</p>
          <ul className="mt-2 divide-y divide-[var(--color-border-soft)]">
            {shown.map((server) => (
              <li key={server.id} className="flex items-center gap-3 px-2 py-2.5">
                <ReferenceMark name={server.host} />
                <div className="min-w-0 flex-1">
                  <div className="text-base text-[var(--color-text)]">{server.name}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{FIRST_RUN_CHAT_COPY.referenceHost(server.host)}</div>
                </div>
                <Button size="sm" variant="secondary" aria-label={FIRST_RUN_CHAT_COPY.addReferenceLabel(server.name)} onClick={() => setInstalling(server.id)}>
                  {FIRST_RUN_CHAT_COPY.addReference}
                </Button>
              </li>
            ))}
          </ul>
          {suggestions.length > shown.length ? (
            <p className="mt-1 px-2 text-xs text-[var(--color-text-muted)]">
              {FIRST_RUN_CHAT_COPY.moreReferences(suggestions.length - shown.length)}{" "}
              <button
                type="button"
                onClick={() => navigate("/marketplace?kind=mcp")}
                className="rounded-sm text-[var(--color-text-soft)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                {FIRST_RUN_CHAT_COPY.marketplace}
              </button>
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
  if (!activeTenant) return false;
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
  const connectedSince = noTenant && activeTenant ? activeTenant : undefined;
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
  // Every read-only scope the connect asks for, sign-in included when nothing is connected yet.
  const scopeCount = new Set([...parts.flatMap((part) => part.scopes.map((scope) => scope.name)), ...(connectFirst ? BASELINE_SCOPES : [])]).size;
  const markService = services[0];

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
    <section aria-labelledby={headingId} className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 rounded-lg bg-[var(--color-surface)] p-4 ring-1 ring-inset ring-[var(--color-border-soft)]">
      {/* The service it needs, dashed because it is not connected (mockup 32, section E). */}
      {markService ? (
        <ServiceMark serviceId={markService.id} size="lg" off />
      ) : (
        <span aria-hidden="true" className="svc-mark" data-service="reference" data-size="lg" data-off="true">
          <IconShield size={14} />
        </span>
      )}
      <div className="min-w-0">
        <h3 id={headingId} className="pt-1 text-md font-medium leading-[22px] text-[var(--color-text)]">
          {title}
        </h3>
        <p className="mt-1 text-base text-[var(--color-text-soft)]">{body}</p>
        {scopeCount > 0 ? (
          <details className="not-connected-permissions mt-3 text-sm">
            <summary className="cursor-pointer select-none rounded-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
              {NOT_CONNECTED_COPY.permissionsSummary(scopeCount)}
            </summary>
            <ul aria-label="Permissions" className="mt-2 space-y-2">
              {parts.map((part) => (
                <PermissionRow key={part.id} label={services.length > 1 ? partLabel(part) : part.title} scopes={part.scopes.map((scope) => scope.name)} />
              ))}
              {connectFirst ? <PermissionRow label={NOT_CONNECTED_COPY.signInPart} scopes={[...BASELINE_SCOPES]} /> : null}
            </ul>
          </details>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {connectFirst ? (
            <>
              <Button variant="primary" onClick={() => openSetupForParts(notConnected.partIds)}>
                {serviceNames ? NOT_CONNECTED_COPY.connect(serviceNames) : NOT_CONNECTED_COPY.connectTenant}
              </Button>
              <Button variant="secondary" onClick={() => openOwnRegistration(notConnected.partIds)}>
                {NOT_CONNECTED_COPY.ownRegistration}
              </Button>
            </>
          ) : tenant ? (
            missingServices.map((service, index) => (
              <Button key={service.id} variant={index === 0 ? "primary" : "secondary"} onClick={() => setAdding(service.id)}>
                {NOT_CONNECTED_COPY.add(service.title)}
              </Button>
            ))
          ) : null}
          <Button variant="ghost" onClick={() => void askAdmin()}>
            {NOT_CONNECTED_COPY.askAdmin}
          </Button>
        </div>
        {copyFailed ? (
          <div role="alert" className="mt-3 text-sm text-[var(--color-warning)]">
            <p>{NOT_CONNECTED_COPY.askAdminFailed}</p>
            <textarea readOnly aria-label="Message for an admin" value={copyFailed} rows={6} className="mt-2 w-full rounded-md bg-[var(--color-bg-raised)] p-2 font-mono text-xs text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]" />
          </div>
        ) : null}
        <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{NOT_CONNECTED_COPY.fine}</p>
      </div>
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

/** One part's scopes as a plain mono list, grouped under the part's name. */
function PermissionRow({ label, scopes }: { label: string; scopes: readonly string[] }) {
  return (
    <li>
      <span className="text-xs font-medium text-[var(--color-text-soft)]">{label}</span>
      <span className="mt-0.5 block font-mono text-xs leading-5 text-[var(--color-text-muted)]">{scopes.join(", ")}</span>
    </li>
  );
}

