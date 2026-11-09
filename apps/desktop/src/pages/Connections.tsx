import { useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { IconRefresh } from "../components/icons";
import { Modal, ModalHeader } from "../components/Modal";
import { ReferenceMark, ServiceMark } from "../components/ServiceMark";
import {
  ServiceAccessDialog,
  TenantCheckResultLine,
  TenantCheckStatus,
  TenantLicensesNotChecked,
  TenantProbeWarning,
  checkAgainResult,
  licensesNotChecked,
  tenantCheckButtonLabel,
  useTenantCheck,
  usesOwnRegistration,
} from "../components/ServiceAccess";
import { TenantTile } from "../components/TenantTile";
import { useToast } from "../components/Toast";
import { Badge, Button as UiButton, StatusDot } from "../components/ui";
import { CONNECTIONS_COPY, ORGANIZATION_COPY, SERVICE_COPY, SETUP_COPY, providerDataLocation, userFacingErrorReason } from "../copy";
import { tenantRegistrationSummary, savedRegistrationName } from "../shared/app-registration";
import { partShortLabel } from "../shared/agent-needs";
import { reportDestinations, resultDestinations, targetlessDestinations } from "../shared/delivery-destinations";
import {
  AVAILABLE_SERVICES,
  ORGANIZATION_NAME_MAX_LENGTH,
  SERVICE_PARTS,
  activeOrganizationOf,
  grantedParts,
  grantedScopeSet,
  resolveOrganizations,
  serviceStatus,
  type AppState,
  type ConnectorSummary,
  type OrganizationRecord,
  type SavedAppRegistration,
  type ServiceConnectionStatus,
  type ServiceId,
  type TenantRecord,
} from "../shared/openAdminOS";
import { PILOT_COPY } from "../shared/pilot-mode";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { hostedChannel } from "../shared/providers";
import { chatToolHosts, deriveDataBoundary, useAppState, useDataBoundaryOptional } from "../state";
import { ConnectorsSettingsSection } from "./Connectors";

interface ReachService {
  serviceId: ServiceId;
  title: string;
  status: ServiceConnectionStatus;
  granted: number;
  total: number;
}

/**
 * Everything the reach map shows, built from the same lists as the status
 * strip: the MCP hosts Chat can send question words to, the active model,
 * and the result connectors with saved delivery rules.
 */
export interface ReachModel {
  organizationName?: string;
  sample: boolean;
  services: ReachService[];
  model: { kind: "none" | "local" | "hosted" | "sample"; name: string; providerName?: string; channel?: string; location?: string };
  referenceHosts: string[];
  /** null while the connector list loads or when it could not be loaded. */
  reportDestinations: string[] | null;
  reportDestinationsState: "ready" | "loading" | "failed";
  /** Set while hosted Nova voice is active, the same state the status strip uses. */
  voice?: { provider: string; model?: string };
}

export function buildReachModel(state: AppState, connectors?: readonly ConnectorSummary[] | null, voiceHosted = false): ReachModel {
  const organization = activeOrganizationOf(state);
  const tenant = organization
    ? state.tenants.find((entry) => entry.id === organization.connections.microsoft365?.tenantId)
    : undefined;
  const sample = organization?.kind === "sample";
  const services = tenant
    ? AVAILABLE_SERVICES.map((service) => {
        const parts = SERVICE_PARTS.filter((part) => part.service === service.id);
        const granted = new Set(grantedParts(tenant).map((part) => part.id));
        return {
          serviceId: service.id,
          title: service.title,
          status: serviceStatus(tenant, service.id),
          granted: parts.filter((part) => granted.has(part.id)).length,
          total: parts.length,
        };
      })
    : [];
  // The model and where prompts go come from the status strip's own
  // function, so the map and the strip cannot disagree.
  const boundary = deriveDataBoundary(state);
  // Hosted voice is a separate destination: the strip shows it instead of
  // the Chat model, the map shows both.
  const voiceBoundary = voiceHosted ? deriveDataBoundary(state, true) : undefined;
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const modelName = boundary.model ?? provider?.name ?? "";
  const model: ReachModel["model"] = sample
    ? { kind: "sample", name: CONNECTIONS_COPY.map.modelSample }
    : boundary.kind === "none" || !provider
      ? { kind: "none", name: CONNECTIONS_COPY.map.modelNone }
      : boundary.kind === "local"
        ? { kind: "local", name: CONNECTIONS_COPY.map.modelLocal(modelName), providerName: provider.name }
        : { kind: "hosted", name: CONNECTIONS_COPY.map.modelHosted(modelName), providerName: provider.name, channel: hostedChannel(provider), location: providerDataLocation(provider) };
  return {
    ...(organization ? { organizationName: organization.name } : {}),
    sample,
    services,
    model,
    // Pilot Chat never calls a model or a tool.
    referenceHosts: sample ? [] : chatToolHosts(state),
    // Until the connector list resolves, nothing is known about where
    // reports go; the map says so instead of saying nowhere.
    reportDestinations: sample ? [] : connectors ? reportDestinations(resultDestinations(state.installedAgents, connectors)) : null,
    reportDestinationsState: sample || connectors ? "ready" : connectors === null ? "failed" : "loading",
    ...(voiceBoundary?.kind === "hosted" && voiceBoundary.isVoiceHosted && voiceBoundary.voiceProvider
      ? { voice: { provider: voiceBoundary.voiceProvider, ...(voiceBoundary.model ? { model: voiceBoundary.model } : {}) } }
      : {}),
  };
}

function serviceStateText(service: ReachService): string {
  if (service.status === "connected") return SERVICE_COPY.status.connected;
  if (service.status === "partial") return CONNECTIONS_COPY.map.partsSummary(service.granted, service.total);
  return SERVICE_COPY.status.missing;
}

function promptsDestination(model: ReachModel["model"]): string {
  if (model.kind === "hosted") return `${model.providerName ?? model.name}, through ${model.channel?.replace(/ to .*$/, "") ?? "its API"}`;
  if (model.kind === "local") return CONNECTIONS_COPY.map.promptsLocal;
  if (model.kind === "sample") return CONNECTIONS_COPY.map.promptsSample;
  return CONNECTIONS_COPY.map.promptsNoModel;
}

function listText(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/** The map's text alternative: the same facts as one paragraph. */
export function reachDescription(model: ReachModel): string {
  const who = model.organizationName ?? "No organization";
  const services = model.services.length > 0
    ? `${who} reads ${listText(model.services.map((service) => `${service.title}, ${serviceStateText(service).toLowerCase()}`))} into this device.`
    : `${who} reads no service into this device.`;
  const device =
    model.model.kind === "local"
      ? `The model runs on this device: ${model.model.name}.`
      : model.model.kind === "hosted"
        ? `The model is hosted: ${model.model.name}. ${model.organizationName ? "Prompts and tenant data go" : "Prompts and agent context go"} through ${model.model.channel}.${model.organizationName ? "" : " No tenant data is included, because no organization is active."} Prompts go to ${model.model.location ?? "the provider"}.`
        : model.model.kind === "sample"
          ? "Sample answers are prepared on this device. No model is used."
          : "No model is ready.";
  const words = model.referenceHosts.length > 0
    ? `Words from questions go to ${listText(model.referenceHosts)}.`
    : "Words from questions go nowhere: no public reference is on.";
  const reports = model.reportDestinations === null
    ? model.reportDestinationsState === "failed"
      ? CONNECTIONS_COPY.map.reportsFailedSentence
      : CONNECTIONS_COPY.map.reportsLoadingSentence
    : model.reportDestinations.length > 0
      ? `Run reports and agent messages can go to ${listText(model.reportDestinations)} under saved delivery rules and agent steps.`
      : "Run reports and agent messages go nowhere: no saved rule or step sends to a connector.";
  const voice = model.voice ? ` ${CONNECTIONS_COPY.map.voiceSentence(model.voice.provider)}` : "";
  return `${services} ${device} ${words} ${reports}${voice}`;
}

function ReachMap({ model }: { model: ReachModel }) {
  const description = reachDescription(model);
  return (
    <figure className="reach-map m-0" aria-labelledby="reach-map-title" aria-describedby="reach-map-description">
      <h2 id="reach-map-title" className="sr-only">{CONNECTIONS_COPY.map.label}</h2>
      <figcaption id="reach-map-description" className="sr-only">{description}</figcaption>
      <div className="reach-zone" aria-hidden="true">
        <h3>{CONNECTIONS_COPY.map.readFrom}</h3>
        <ul className="reach-items">
          {model.services.length === 0 ? (
            <li className="reach-item" data-off="true"><span className="reach-item-text">{CONNECTIONS_COPY.map.noServices}</span></li>
          ) : (
            model.services.map((service) => (
              <li key={service.serviceId} className="reach-item" data-off={service.status === "missing" ? "true" : undefined}>
                <ServiceMark serviceId={service.serviceId} off={service.status === "missing"} />
                <span className="reach-item-text">{service.title}</span>
                <span className="reach-state" data-tone={service.status === "connected" ? "ok" : undefined}>
                  {serviceStateText(service)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
      <div className="reach-lane" data-direction="in" aria-hidden="true"><span>{CONNECTIONS_COPY.map.tenantData}</span></div>
      <div className="reach-device" aria-hidden="true">
        <div className="reach-device-title">{CONNECTIONS_COPY.map.device}</div>
        <ul>
          <li>{model.model.name}</li>
          <li>{CONNECTIONS_COPY.map.deviceHistory}</li>
          <li>{model.sample ? CONNECTIONS_COPY.map.deviceSample : CONNECTIONS_COPY.map.deviceTokens}</li>
        </ul>
      </div>
      <div className="reach-lane" data-direction="out" aria-hidden="true"><span>{CONNECTIONS_COPY.map.sentOut}</span></div>
      <div className="reach-zone" aria-hidden="true">
        <h3>{CONNECTIONS_COPY.map.leaves}</h3>
        <h4>{CONNECTIONS_COPY.map.questionWords}</h4>
        <ul className="reach-items">
          {model.referenceHosts.length === 0 ? (
            <li className="reach-item" data-off="true"><span className="reach-item-text">{CONNECTIONS_COPY.map.noReferences}</span></li>
          ) : (
            model.referenceHosts.map((host) => (
              <li key={host} className="reach-item"><ReferenceMark name={host} /><span className="reach-item-text">{host}</span></li>
            ))
          )}
        </ul>
        <h4>{CONNECTIONS_COPY.map.reports}</h4>
        <ul className="reach-items">
          {model.reportDestinations === null ? (
            <li className="reach-item" data-off="true" aria-busy={model.reportDestinationsState === "loading"}>
              <span className="reach-item-text">
                {model.reportDestinationsState === "failed" ? CONNECTIONS_COPY.map.reportsFailed : CONNECTIONS_COPY.map.reportsLoading}
              </span>
            </li>
          ) : model.reportDestinations.length === 0 ? (
            <li className="reach-item" data-off="true"><span className="reach-item-text">{CONNECTIONS_COPY.map.noReports}</span></li>
          ) : (
            model.reportDestinations.map((name) => (
              <li key={name} className="reach-item"><ReferenceMark name={name} /><span className="reach-item-text">{name}</span></li>
            ))
          )}
        </ul>
        <h4>{model.organizationName ? CONNECTIONS_COPY.map.prompts : CONNECTIONS_COPY.map.promptsNoOrganization}</h4>
        <ul className="reach-items">
          <li className="reach-item" data-off={model.model.kind === "hosted" ? undefined : "true"}>
            <span className="reach-item-text">
              {promptsDestination(model.model)}
              {model.model.kind === "hosted" ? (
                <span className="block text-xs text-[var(--color-text-muted)]">
                  {model.model.location}
                </span>
              ) : null}
            </span>
            {model.model.kind === "hosted" ? <span className="reach-state" data-tone="warning">Leaves</span> : null}
          </li>
        </ul>
        {model.voice ? (
          <>
            <h4>{CONNECTIONS_COPY.map.voice}</h4>
            <ul className="reach-items">
              <li className="reach-item">
                <span className="reach-item-text">{CONNECTIONS_COPY.map.voiceDestination(model.voice.provider)}</span>
                <span className="reach-state" data-tone="warning">Leaves</span>
              </li>
            </ul>
          </>
        ) : null}
      </div>
    </figure>
  );
}

/** The Results section's view of the same destination list as the map. */
function ResultDestinationsSummary({
  destinations,
  loaded,
}: {
  destinations: ReturnType<typeof resultDestinations>;
  loaded: boolean;
}) {
  if (!loaded) return null;
  const sent = reportDestinations(destinations);
  const unset = targetlessDestinations(destinations);
  return (
    <div className="mb-3 space-y-2 text-sm" data-testid="result-destinations">
      <p className="text-[var(--color-text-soft)]">
        {sent.length > 0 ? CONNECTIONS_COPY.resultsSent(sent) : CONNECTIONS_COPY.resultsNone}
      </p>
      {unset.length > 0 ? (
        <p role="status" className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
          {CONNECTIONS_COPY.resultsUnset(unset)}
        </p>
      ) : null}
    </div>
  );
}

function SectionHeading({ id, title, body }: { id: string; title: string; body?: string }) {
  return (
    <div className="mb-2">
      <h2 id={id} className="text-base font-medium text-[var(--color-text)]">{title}</h2>
      {body ? <p className="mt-0.5 text-sm leading-5 text-[var(--color-text-muted)]">{body}</p> : null}
    </div>
  );
}

function StateText({ status }: { status: ServiceConnectionStatus }) {
  const tone =
    status === "connected"
      ? "text-[var(--color-success)]"
      : status === "partial"
        ? "text-[var(--color-warning)]"
        : "text-[var(--color-text-muted)]";
  return <span className={`whitespace-nowrap text-sm ${tone}`}>{SERVICE_COPY.status[status]}</span>;
}

/** One row per Microsoft 365 service with its parts and the action that adds what is missing. */
function MicrosoftServiceRows({ tenant }: { tenant: TenantRecord }) {
  const { refreshTenantGrants } = useAppState();
  const tenantCheck = useTenantCheck(tenant.id);
  const [checkResult, setCheckResult] = useState<ReturnType<typeof checkAgainResult> | null>(null);
  const [access, setAccess] = useState<{ serviceId: ServiceId; partIds?: string[] } | null>(null);
  const ownRegistration = usesOwnRegistration(tenant);
  const sample = tenant.kind === "sample";
  const grantedPartIds = new Set(grantedParts(tenant).map((part) => part.id));
  return (
    <section aria-label={`${tenant.displayName} services`}>
      {ownRegistration ? (
        <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
          <UiButton
            size="sm"
            variant="secondary"
            leadingIcon={<IconRefresh size={12} />}
            disabled={tenantCheck.busy}
            title={SERVICE_COPY.checkAgainHint}
            onClick={() => {
              setCheckResult(null);
              void tenantCheck
                .run(() => refreshTenantGrants(tenant.id))
                .then((result) => setCheckResult(checkAgainResult(result, tenant.id)));
            }}
          >
            {tenantCheck.running ? tenantCheckButtonLabel(tenantCheck.progress) : SERVICE_COPY.checkAgain}
          </UiButton>
        </div>
      ) : null}
      <TenantCheckResultLine result={checkResult} />
      <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {AVAILABLE_SERVICES.map((service) => {
          const status = serviceStatus(tenant, service.id);
          const parts = SERVICE_PARTS.filter((part) => part.service === service.id);
          const missing = parts.filter((part) => !grantedPartIds.has(part.id));
          const missingScopes = [
            ...new Set(missing.flatMap((part) => part.scopes.map((scope) => scope.name))),
          ].filter((name) => !grantedScopeSet(tenant).has(name));
          const firstMissing = missing[0];
          const actionLabel =
            status === "missing"
              ? CONNECTIONS_COPY.connect
              : missing.length === 1 && firstMissing
                ? CONNECTIONS_COPY.addPart(partShortLabel(firstMissing))
                : ownRegistration
                  ? "Add permissions"
                  : "Add access";
          return (
            <li key={service.id} className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3 py-3 sm:grid-cols-[30px_minmax(0,1fr)_auto_auto] sm:items-center">
              <ServiceMark serviceId={service.id} size="lg" off={status === "missing"} />
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{service.title}</div>
                <div className="text-sm text-[var(--color-text-muted)]">
                  {status === "partial"
                    ? CONNECTIONS_COPY.partsMissing(missing.map((part) => part.title))
                    : service.summary}
                </div>
                {sample ? null : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {parts.map((part) =>
                      grantedPartIds.has(part.id) ? (
                        <span key={part.id} className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-soft)]">
                          <StatusDot tone="success" />
                          {part.title}
                        </span>
                      ) : (
                        <button
                          key={part.id}
                          type="button"
                          aria-label={SERVICE_COPY.addPartLabel(`${service.title} ${partShortLabel(part)}`)}
                          disabled={tenantCheck.busy}
                          onClick={() => setAccess({ serviceId: service.id, partIds: [part.id] })}
                          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:pointer-events-none disabled:opacity-50"
                        >
                          <StatusDot tone="neutral" />
                          {part.title}
                        </button>
                      ),
                    )}
                  </div>
                )}
                {ownRegistration && missingScopes.length > 0 ? (
                  <p className="mt-1.5 break-words font-mono text-xs leading-5 text-[var(--color-text-muted)]">
                    {SERVICE_COPY.missingPermissions(missingScopes)}
                  </p>
                ) : null}
              </div>
              <div className="col-start-2 sm:col-start-auto"><StateText status={status} /></div>
              <div className="col-start-2 sm:col-start-auto">
                {!sample && missing.length > 0 ? (
                  <UiButton
                    size="sm"
                    variant="secondary"
                    aria-label={
                      ownRegistration
                        ? SERVICE_COPY.addPermissionsTitle(service.title)
                        : SERVICE_COPY.addAccessTitle(service.title)
                    }
                    disabled={tenantCheck.busy}
                    onClick={() =>
                      setAccess(
                        missing.length === 1 && firstMissing && status !== "missing"
                          ? { serviceId: service.id, partIds: [firstMissing.id] }
                          : { serviceId: service.id },
                      )
                    }
                  >
                    {actionLabel}
                  </UiButton>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <ServiceAccessDialog
        tenant={tenant}
        serviceId={access?.serviceId ?? null}
        {...(access?.partIds ? { initialPartIds: access.partIds } : {})}
        open={access !== null}
        onClose={() => setAccess(null)}
      />
    </section>
  );
}

function entraLicenseName(tenant: TenantRecord): string | null {
  if (!tenant.entraTier || tenant.entraTier === "unknown") return null;
  return tenant.entraTier === "free" ? "Microsoft Entra ID Free" : `Microsoft Entra ID ${tenant.entraTier.toUpperCase()}`;
}

function tenantDomain(tenant: TenantRecord): string {
  return tenant.username.includes("@") ? tenant.username.slice(tenant.username.lastIndexOf("@") + 1) : tenant.username;
}

/** The Microsoft 365 group: tenant facts, sign-in, licenses, then the service rows. */
function MicrosoftGroup({ organization, tenant }: { organization: OrganizationRecord; tenant: TenantRecord }) {
  const { openSetup } = useSetupFlow();
  const [disconnecting, setDisconnecting] = useState(false);
  const sample = tenant.kind === "sample";
  const registration = tenantRegistrationSummary(tenant);
  const license = entraLicenseName(tenant);
  const licenses = [...(license ? [license] : []), ...(tenant.relevantLicenses ?? []).map((entry) => entry.displayName)];
  const facts = sample
    ? ["Fictional company, stored on this device"]
    : [
        tenantDomain(tenant),
        ...(registration ? [registration.text] : []),
        `signed in as ${tenant.username}`,
      ];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="text-sm font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.microsoft365}</strong>
        <span className="min-w-0 text-sm text-[var(--color-text-muted)]">{facts.join(" · ")}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          {sample ? null : (
            <UiButton variant="ghost" size="sm" onClick={openSetup}>Permissions</UiButton>
          )}
          <UiButton variant="ghost" size="sm" onClick={() => setDisconnecting(true)}>
            {sample ? PILOT_COPY.leaveAction : "Disconnect"}
          </UiButton>
        </span>
      </div>
      {/* Not-checked licenses are explained once, by TenantLicensesNotChecked. */}
      {sample || (licenses.length === 0 && licensesNotChecked(tenant)) ? null : (
        <div className="mb-2 text-sm text-[var(--color-text-muted)]">
          {licenses.length > 0 ? licenses.join(", ") : "No license details"}
        </div>
      )}
      <TenantProbeWarning tenant={tenant} />
      <TenantLicensesNotChecked tenant={tenant} />
      <TenantCheckStatus tenant={tenant} />
      <MicrosoftServiceRows tenant={tenant} />
      <DisconnectDialog
        open={disconnecting}
        organization={organization}
        tenant={tenant}
        onClose={() => setDisconnecting(false)}
      />
    </div>
  );
}

function DisconnectDialog({
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

function PublicReferences({ state }: { state: AppState }) {
  const navigate = useNavigate();
  const { refresh } = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const installed = (state.mcpServers ?? []).filter((server) => server.installed);
  const toolsOff = state.chatToolUse?.available === false;
  return (
    <section aria-labelledby="connections-references" className="mt-8">
      <SectionHeading id="connections-references" title={CONNECTIONS_COPY.referencesHeading} body={CONNECTIONS_COPY.referencesBody} />
      {installed.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--color-border-soft)] py-3 text-sm text-[var(--color-text-muted)]">
          <span className="min-w-0 flex-1">{CONNECTIONS_COPY.referencesEmpty}</span>
          <UiButton size="sm" variant="secondary" onClick={() => navigate("/marketplace?kind=mcp")}>{CONNECTIONS_COPY.openMarketplace}</UiButton>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          {installed.map((server) => {
            const unusable = server.enabled && (server.missingTools?.length ?? 0) > 0;
            const stateText = !server.enabled
              ? CONNECTIONS_COPY.referenceOff
              : unusable
                ? CONNECTIONS_COPY.referenceUnavailable
                : toolsOff
                  ? CONNECTIONS_COPY.referenceToolsOff
                  : CONNECTIONS_COPY.referenceOn;
            return (
              <li key={server.id} className="grid grid-cols-[30px_minmax(0,1fr)] items-center gap-3 py-3 sm:grid-cols-[30px_minmax(0,1fr)_auto_auto]">
                <ReferenceMark name={server.name} size="lg" />
                <div className="min-w-0">
                  <div className="text-base font-medium text-[var(--color-text)]">{server.name}</div>
                  <div className="truncate text-sm text-[var(--color-text-muted)]">{server.host}</div>
                </div>
                <span className={`col-start-2 whitespace-nowrap text-sm sm:col-start-auto ${stateText === CONNECTIONS_COPY.referenceOn ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}`}>
                  {stateText}
                </span>
                <UiButton
                  className="col-start-2 justify-self-start sm:col-start-auto"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`${server.enabled ? CONNECTIONS_COPY.referenceTurnOff : CONNECTIONS_COPY.referenceTurnOn} ${server.name}`}
                  onClick={() => {
                    const api = window.openAdminOS;
                    setBusy(server.id);
                    void Promise.resolve()
                      .then(async () => {
                        if (!api?.setMcpServerEnabled) {
                          throw new Error("This build of OpenAdminOS cannot manage MCP servers. Update the app, then try again.");
                        }
                        await api.setMcpServerEnabled(server.id, !server.enabled);
                        await refresh();
                      })
                      .catch((caught) =>
                        toast.error(
                          CONNECTIONS_COPY.referenceToggleFailed(
                            server.name,
                            userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                          ),
                        ),
                      )
                      .finally(() => setBusy(null));
                  }}
                >
                  {server.enabled ? CONNECTIONS_COPY.referenceTurnOff : CONNECTIONS_COPY.referenceTurnOn}
                </UiButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OrganizationsList({ state }: { state: AppState }) {
  const { setActiveOrganization, renameOrganization } = useAppState();
  const toast = useToast();
  const organizations = resolveOrganizations(state);
  const active = activeOrganizationOf(state);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (organizations.length === 0) return null;
  return (
    <section aria-labelledby="connections-organizations" className="mt-8">
      <SectionHeading id="connections-organizations" title={CONNECTIONS_COPY.organizationsHeading} body={CONNECTIONS_COPY.organizationsBody} />
      <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {organizations.map((organization) => {
          const tenant = state.tenants.find((entry) => entry.id === organization.connections.microsoft365?.tenantId);
          if (!tenant) return null;
          const isActive = organization.id === active?.id;
          const sample = organization.kind === "sample";
          return (
            <li key={organization.id} className="flex flex-wrap items-center gap-3 py-3">
              <TenantTile tenantId={tenant.id} displayName={organization.name} size="row" />
              <div className="min-w-[200px] flex-1">
                {editing === organization.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setBusy(true);
                      setError(null);
                      void renameOrganization(organization.id, draft)
                        .then(() => {
                          toast.success(ORGANIZATION_COPY.renamed);
                          setEditing(null);
                        })
                        .catch((caught) =>
                          setError(
                            ORGANIZATION_COPY.renameFailed(
                              userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                            ),
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    <label className="sr-only" htmlFor={`organization-name-${organization.id}`}>{ORGANIZATION_COPY.renameLabel}</label>
                    <input
                      id={`organization-name-${organization.id}`}
                      name="organization-name"
                      autoComplete="off"
                      value={draft}
                      maxLength={ORGANIZATION_NAME_MAX_LENGTH * 2}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                      className="h-8 min-w-[200px] rounded-md bg-[var(--color-surface)] px-2.5 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                    />
                    <UiButton size="sm" variant="primary" type="submit" disabled={busy || draft.trim().length === 0}>
                      {ORGANIZATION_COPY.renameSave}
                    </UiButton>
                    <UiButton size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>
                      Cancel
                    </UiButton>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-base font-medium text-[var(--color-text)]">{organization.name}</span>
                    {sample ? <Badge tone="info">{ORGANIZATION_COPY.sampleLabel}</Badge> : null}
                    {isActive ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                        <StatusDot tone="success" />{CONNECTIONS_COPY.active}
                      </span>
                    ) : null}
                  </div>
                )}
                <div className="mt-0.5 truncate text-sm text-[var(--color-text-muted)]">
                  {sample ? ORGANIZATION_COPY.sampleDetail : `${CONNECTIONS_COPY.microsoft365} · ${tenantDomain(tenant)}`}
                </div>
                {editing === organization.id && error ? (
                  <div role="alert" className="mt-1 text-sm text-[var(--color-danger)]">{error}</div>
                ) : null}
              </div>
              {editing === organization.id ? null : (
                <span className="flex flex-wrap gap-2">
                  {sample ? null : (
                    <UiButton
                      size="sm"
                      variant="ghost"
                      aria-label={`${ORGANIZATION_COPY.renameAction} ${organization.name}`}
                      onClick={() => {
                        setDraft(organization.name);
                        setError(null);
                        setEditing(organization.id);
                      }}
                    >
                      {ORGANIZATION_COPY.renameAction}
                    </UiButton>
                  )}
                  {isActive ? null : (
                    <UiButton
                      size="sm"
                      variant="secondary"
                      aria-label={`${CONNECTIONS_COPY.makeActive}, ${organization.name}`}
                      onClick={() =>
                        void setActiveOrganization(organization.id).catch((caught) =>
                          toast.error(
                            ORGANIZATION_COPY.switchFailed(
                              userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                            ),
                          ),
                        )
                      }
                    >
                      {CONNECTIONS_COPY.makeActive}
                    </UiButton>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SavedRegistrationsList({
  registrations,
  onRemove,
}: {
  registrations: SavedAppRegistration[];
  onRemove: (clientId: string, directoryTenantId?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  return (
    <section aria-labelledby="saved-app-registrations-heading" className="mt-8">
      <h2 id="saved-app-registrations-heading" className="text-base font-medium text-[var(--color-text)]">
        {SETUP_COPY.savedRegistrationsSettingsTitle}
      </h2>
      <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">
        {SETUP_COPY.savedRegistrationsSettingsBody}
      </p>
      {removeError && (
        <div role="alert" className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
          {removeError}
        </div>
      )}
      <ul className="mt-3 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {registrations.map((entry) => {
          const key = `${entry.clientId}|${entry.directoryTenantId ?? ""}`;
          const name = savedRegistrationName(entry);
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 py-[var(--row-y)]">
              <div className="min-w-[220px] flex-1">
                <div className="truncate text-base text-[var(--color-text)]" title={name}>{name}</div>
                <div className="mt-0.5 break-all font-mono text-xs text-[var(--color-text-muted)]">
                  {entry.label ? `${entry.clientId} · ` : ""}
                  {entry.directoryTenantId ?? "Multi-tenant"}
                </div>
              </div>
              <UiButton
                variant="ghost"
                size="sm"
                aria-label={SETUP_COPY.removeSavedRegistration(name)}
                disabled={removing !== null}
                onClick={() => {
                  setRemoving(key);
                  setRemoveError(null);
                  void onRemove(entry.clientId, entry.directoryTenantId)
                    .then(() => toast.success(SETUP_COPY.savedRegistrationRemoved))
                    .catch((caught) =>
                      setRemoveError(
                        SETUP_COPY.removeSavedRegistrationFailed(
                          userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                        ).replace(/\s+/g, " "),
                      ),
                    )
                    .finally(() => setRemoving(null));
                }}
              >
                {removing === key ? "Removing" : "Remove"}
              </UiButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Connections: one page per organization. The reach map at the top shows
 * the services read into this device and everything that leaves it; the
 * lists below are the same data, with the actions that change it. Replaces
 * Settings, Tenants and Settings, Connectors.
 */
export default function Connections() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { state, loading, removeSavedAppRegistration } = useAppState();
  const { openSetup } = useSetupFlow();
  // The Results section loads the connector list; the map uses the same one.
  // undefined while loading, null when the list could not be loaded.
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null | undefined>(undefined);
  const voiceHosted = useDataBoundaryOptional()?.boundary.isVoiceHosted ?? false;
  const reach = useMemo(() => buildReachModel(state, connectors, voiceHosted), [connectors, state, voiceHosted]);
  const destinations = useMemo(() => resultDestinations(state.installedAgents, connectors ?? undefined), [connectors, state.installedAgents]);
  const organization = activeOrganizationOf(state);
  const tenant = organization
    ? state.tenants.find((entry) => entry.id === organization.connections.microsoft365?.tenantId)
    : undefined;
  const sample = organization?.kind === "sample";
  const savedRegistrations = state.savedAppRegistrations ?? [];

  const updateConnectorRoute = (connectorId: string | null) => {
    const next = new URLSearchParams(location.search);
    if (connectorId) next.set("connector", connectorId);
    else next.delete("connector");
    const query = next.toString();
    navigate(`/connections${query ? `?${query}` : ""}${location.hash}`, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={organization ? CONNECTIONS_COPY.title(organization.name) : CONNECTIONS_COPY.pageTitle}
        subtitle={CONNECTIONS_COPY.lede}
        wide
        actions={
          <UiButton variant="secondary" size="sm" onClick={openSetup}>{ORGANIZATION_COPY.addOrganization}</UiButton>
        }
      />
      <PageBody>
        {loading ? (
          <div role="status" className="calm-page-column-wide py-10 text-sm text-[var(--color-text-muted)]">
            Loading connections
          </div>
        ) : (
        <div className="calm-page-column-wide pb-16">
          {!organization ? (
            <div role="status" className="mb-4 rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {CONNECTIONS_COPY.noOrganization}
            </div>
          ) : sample ? (
            <div role="status" className="mb-4 rounded-lg bg-[var(--color-info-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {CONNECTIONS_COPY.sampleOrganization}
            </div>
          ) : null}

          <ReachMap model={reach} />

          <section aria-labelledby="connections-services" className="mt-8">
            <SectionHeading id="connections-services" title={CONNECTIONS_COPY.servicesHeading} body={CONNECTIONS_COPY.servicesBody} />
            {organization && tenant ? (
              <MicrosoftGroup organization={organization} tenant={tenant} />
            ) : (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="text-sm font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.microsoft365}</strong>
                  <span className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.microsoft365NotConnected}</span>
                </div>
                <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
                  {AVAILABLE_SERVICES.map((service) => (
                    <li key={service.id} className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 py-3">
                      <ServiceMark serviceId={service.id} size="lg" off />
                      <div className="min-w-0">
                        <div className="text-base font-medium text-[var(--color-text)]">{service.title}</div>
                        <div className="text-sm text-[var(--color-text-muted)]">{service.summary}</div>
                      </div>
                      <StateText status="missing" />
                    </li>
                  ))}
                </ul>
                <div className="mt-3">
                  <UiButton variant="primary" size="sm" onClick={openSetup}>{CONNECTIONS_COPY.connectMicrosoft365}</UiButton>
                </div>
              </div>
            )}
            <div className="mb-2 mt-6 flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="text-sm font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.otherServicesHeading}</strong>
              <span className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.otherServicesBody}</span>
            </div>
            <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 border-y border-[var(--color-border-soft)] py-3">
              <span aria-hidden="true" className="svc-mark" data-size="lg" data-off="true">+</span>
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.addService}</div>
                <div className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.addServiceBody}</div>
              </div>
              <UiButton size="sm" variant="secondary" onClick={() => navigate("/marketplace")}>{CONNECTIONS_COPY.openMarketplace}</UiButton>
            </div>
          </section>

          <PublicReferences state={state} />

          <section aria-labelledby="connections-results" className="mt-8">
            <SectionHeading id="connections-results" title={CONNECTIONS_COPY.resultsHeading} body={CONNECTIONS_COPY.resultsBody} />
            {sample ? (
              <p className="border-y border-[var(--color-border-soft)] py-3 text-sm text-[var(--color-text-muted)]">
                {PILOT_COPY.featureInProduction("Connector deliveries", true)}
              </p>
            ) : (
              <>
                <ResultDestinationsSummary destinations={destinations} loaded={Boolean(connectors)} />
                <ConnectorsSettingsSection
                  connectorId={searchParams.get("connector")}
                  onConnectorChange={updateConnectorRoute}
                  onConnectorsLoaded={setConnectors}
                />
              </>
            )}
          </section>

          <OrganizationsList state={state} />

          {savedRegistrations.length > 0 ? (
            <SavedRegistrationsList registrations={savedRegistrations} onRemove={removeSavedAppRegistration} />
          ) : null}
        </div>
        )}
      </PageBody>
    </>
  );
}
