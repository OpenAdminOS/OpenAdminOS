import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { PageBody, PageHeader } from "../components/AppShell";
import { IconChevronDown, IconRefresh } from "../components/icons";
import { Modal, ModalHeader } from "../components/Modal";
import { DeviceTile } from "../components/DeviceTile";
import { DisconnectOrganizationDialog } from "../components/DisconnectOrganizationDialog";
import { ProviderMark } from "../components/ProviderLogo";
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
import { SetByItBadge } from "../components/ManagedPolicy";
import { Menu, StatusDot, Tabs, Tooltip, Button as UiButton } from "../components/ui";
import { CONNECTIONS_COPY, ORGANIZATION_COPY, SERVICE_COPY, SETUP_COPY, promptsGoTo, providerDataLocation, providerDataLocationDetail, userFacingErrorReason } from "../copy";
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
  isManagedSettingLocked,
  resolveOrganizations,
  serviceStatus,
  type AppState,
  type ConnectorSummary,
  type OrganizationRecord,
  type ProviderId,
  type SavedAppRegistration,
  type ServiceConnectionStatus,
  type ServiceId,
  type TenantRecord,
} from "../shared/openAdminOS";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { MicrosoftStepButton, useOpenMicrosoftStep } from "../setup/FirstRunScan";
import { hostedChannel } from "../shared/providers";
import { chatToolHosts, deriveDataBoundary, novaVoiceSentence, useAppState, useDataBoundaryOptional } from "../state";
import { ConnectorsSettingsSection } from "./Connectors";
import { TenantCleanupNotice } from "../components/TenantCleanupNotice";
import { SplashtopServiceRow } from "../components/SplashtopConnection";
import { SPLASHTOP_COPY } from "../copy/splashtop";

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
  services: ReachService[];
  model: {
    kind: "none" | "local" | "hosted";
    name: string;
    /** The model id alone, as the status strip shows it. */
    modelName?: string;
    /** The provider, for its logo. */
    providerId?: ProviderId;
    providerName?: string;
    channel?: string;
    /** Where prompts go, in the shared sentence form (promptsGoTo). */
    promptsSentence?: string;
    location?: string;
    /** The vendor's documented default for that location. */
    locationDetail?: string;
  };
  referenceHosts: string[];
  /** null while the connector list loads or when it could not be loaded. */
  reportDestinations: string[] | null;
  reportDestinationsState: "ready" | "loading" | "failed";
  /** Set while hosted Nova voice is active, the same state the status strip uses. */
  voice?: { provider: string; location: string; model?: string };
}

export function buildReachModel(state: AppState, connectors?: readonly ConnectorSummary[] | null, voiceHosted = false): ReachModel {
  const organization = activeOrganizationOf(state);
  const tenant = organization
    ? state.tenants.find((entry) => entry.id === organization.connections.microsoft365?.tenantId)
    : undefined;
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
  const model: ReachModel["model"] = boundary.kind === "none" || !provider
    ? { kind: "none", name: CONNECTIONS_COPY.map.modelNone }
    : boundary.kind === "local"
      ? { kind: "local", name: CONNECTIONS_COPY.map.modelLocal(modelName), modelName, providerId: provider.id, providerName: provider.name }
      : { kind: "hosted", name: CONNECTIONS_COPY.map.modelHosted(modelName), modelName, providerId: provider.id, providerName: provider.name, channel: hostedChannel(provider), promptsSentence: promptsGoTo(provider, Boolean(organization)), location: providerDataLocation(provider), ...(providerDataLocationDetail(provider) ? { locationDetail: providerDataLocationDetail(provider)! } : {}) };
  return {
    ...(organization ? { organizationName: organization.name } : {}),
    services,
    model,
    referenceHosts: chatToolHosts(state),
    // Until the connector list resolves, nothing is known about where
    // reports go; the map says so instead of saying nowhere.
    reportDestinations: connectors ? reportDestinations(resultDestinations(state.installedAgents, connectors)) : null,
    reportDestinationsState: connectors ? "ready" : connectors === null ? "failed" : "loading",
    ...(voiceBoundary?.kind === "hosted" && voiceBoundary.isVoiceHosted && voiceBoundary.voiceProvider
      ? { voice: { provider: voiceBoundary.voiceProvider, location: voiceBoundary.voiceLocation ?? voiceBoundary.voiceProvider, ...(voiceBoundary.model ? { model: voiceBoundary.model } : {}) } }
      : {}),
  };
}

function serviceStateText(service: ReachService): string {
  if (service.status === "connected") return SERVICE_COPY.status.connected;
  if (service.status === "partial") return CONNECTIONS_COPY.map.partsSummary(service.granted, service.total);
  return SERVICE_COPY.status.missing;
}

function promptsDestination(model: ReachModel["model"]): string {
  if (model.kind === "hosted") return model.location ?? model.providerName ?? model.name;
  if (model.kind === "local") return CONNECTIONS_COPY.map.promptsLocal;
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
        ? `The model is hosted: ${model.model.name}. ${model.model.promptsSentence ?? "Prompts go to the provider"}.${model.organizationName ? "" : " No tenant data is included, because no organization is active."}${model.model.locationDetail ? ` ${model.model.locationDetail}` : ""}`
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
  const voice = model.voice
    ? ` ${novaVoiceSentence(Boolean(model.organizationName))}${model.voice.model ? ` The voice model is ${model.voice.model}.` : ""}`
    : "";
  return `${services} ${device} ${words} ${reports}${voice}`;
}

/** Below this content width the map stacks and draws no connectors. */
export const REACH_STACK_BELOW = 760;

/** Wide draws three columns with connectors; stacked lists the zones in order. */
export function reachLayout(width: number): "wide" | "stacked" {
  return width > 0 && width < REACH_STACK_BELOW ? "stacked" : "wide";
}

/**
 * Line colours (SPEC section 3): a missing service uses the border colour,
 * and only a line that carries prompts to a hosted provider is amber.
 */
export type ReachLinkTone = "default" | "missing" | "hosted";

export interface ReachLink {
  id: string;
  direction: "in" | "out";
  tone: ReachLinkTone;
}

/** One connector per row that data crosses, in the order the rows render. */
export function reachLinks(model: ReachModel): ReachLink[] {
  return [
    ...model.services.map((service): ReachLink => ({
      id: `service:${service.serviceId}`,
      direction: "in",
      tone: service.status === "missing" ? "missing" : "default",
    })),
    ...(model.model.kind === "hosted" ? [{ id: "prompts", direction: "out", tone: "hosted" } satisfies ReachLink] : []),
    ...(model.voice ? [{ id: "voice", direction: "out", tone: "hosted" } satisfies ReachLink] : []),
    ...model.referenceHosts.map((host): ReachLink => ({ id: `host:${host}`, direction: "out", tone: "default" })),
    ...(model.reportDestinations ?? []).map((name): ReachLink => ({ id: `report:${name}`, direction: "out", tone: "default" })),
  ];
}

export interface ReachPath extends ReachLink {
  d: string;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  height: number;
}

/** Spacing of the line ends at the tile edge. */
const REACH_FAN = 9;
/** The line ends stay this far inside the tile's top and bottom. */
const REACH_FAN_INSET = 8;
/** Where a line bends, as a share of its run measured from the row. */
const REACH_BEND = 0.35;

/**
 * Cubic curves from each row to the tile, fanned at the tile edge. A line
 * leaves the tile level and bends near its row, so it clears the caption
 * under the tile; with many rows the fan tightens instead of leaving the
 * tile edge. Coordinates are relative to `box`.
 */
export function reachPaths(box: Rect, tile: Rect, rows: ReadonlyMap<string, Rect>, links: readonly ReachLink[]): ReachPath[] {
  const tileY = tile.top + tile.height / 2 - box.top;
  const count = { in: links.filter((link) => link.direction === "in").length, out: links.filter((link) => link.direction === "out").length };
  const index = { in: 0, out: 0 };
  const paths: ReachPath[] = [];
  for (const link of links) {
    const row = rows.get(link.id);
    const i = index[link.direction]++;
    if (!row) continue;
    const y = row.top + row.height / 2 - box.top;
    const ends = count[link.direction];
    const step = ends > 1 ? Math.min(REACH_FAN, Math.max(0, tile.height - 2 * REACH_FAN_INSET) / (ends - 1)) : 0;
    const fanY = tileY + (i - (ends - 1) / 2) * step;
    const [x1, y1, x2, y2] =
      link.direction === "in"
        ? [row.right - box.left + 10, y, tile.left - box.left - 6, fanY]
        : [tile.right - box.left + 6, fanY, row.left - box.left - 10, y];
    const bend = link.direction === "in" ? x1 + (x2 - x1) * REACH_BEND : x2 - (x2 - x1) * REACH_BEND;
    const r = (value: number) => Math.round(value * 10) / 10;
    paths.push({ ...link, d: `M${r(x1)} ${r(y1)} C${r(bend)} ${r(y1)}, ${r(bend)} ${r(y2)}, ${r(x2)} ${r(y2)}` });
  }
  return paths;
}

function prefersReducedMotion(): boolean {
  return (
    document.documentElement.hasAttribute("data-reduced-motion") ||
    (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/** Measures the map, picks its layout and computes the connectors. */
function useReachGeometry(model: ReachModel) {
  const ref = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState<"wide" | "stacked">("wide");
  const [paths, setPaths] = useState<ReachPath[]>([]);
  // Lines present on first paint draw in once; later ones appear in place.
  const [drawIn, setDrawIn] = useState<ReadonlySet<string> | null>(null);
  const links = useMemo(() => reachLinks(model), [model]);

  const measure = useCallback(() => {
    const figure = ref.current;
    if (!figure) return;
    const box = figure.getBoundingClientRect();
    const nextLayout = reachLayout(box.width);
    setLayout(nextLayout);
    const tile = figure.querySelector(".device-tile")?.getBoundingClientRect();
    if (nextLayout === "stacked" || !tile || tile.width === 0) {
      setPaths([]);
      return;
    }
    const rows = new Map<string, Rect>();
    figure.querySelectorAll<HTMLElement>("[data-link-id]").forEach((row) => {
      const rect = row.getBoundingClientRect();
      // A row with a detail line is taller than its mark: the line meets the mark, not the middle of the block.
      const mark = row.querySelector(".svc-mark")?.getBoundingClientRect();
      rows.set(row.dataset.linkId!, mark && mark.height > 0 ? { left: rect.left, right: rect.right, top: mark.top, height: mark.height } : rect);
    });
    const next = reachPaths(box, tile, rows, links);
    setPaths(next);
    if (next.length > 0) setDrawIn((current) => current ?? new Set(prefersReducedMotion() ? [] : next.map((path) => path.id)));
  }, [links]);

  useLayoutEffect(() => {
    measure();
  }, [measure, layout]);

  useEffect(() => {
    const figure = ref.current;
    if (!figure) return;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure());
    resize?.observe(figure);
    // Theme and density change type metrics and row heights.
    const theme = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => measure());
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode", "data-density"] });
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      resize?.disconnect();
      theme?.disconnect();
    };
  }, [measure]);

  return { ref, layout, paths, drawIn };
}

type ReachStateTone = "ok" | "part" | "off" | "leaves";

/** A dot and words; colour only where SPEC section 3 gives it a meaning. */
function ReachState({ tone, children }: { tone?: ReachStateTone; children: ReactNode }) {
  return (
    <span className="reach-state" data-tone={tone}>
      {tone && tone !== "leaves" ? <span className="reach-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

function serviceTone(status: ServiceConnectionStatus): ReachStateTone {
  return status === "connected" ? "ok" : status === "partial" ? "part" : "off";
}

function ReachRow({
  linkId,
  mark,
  off = false,
  title,
  titleHint,
  detail,
  state,
}: {
  linkId?: string;
  mark: ReactNode;
  off?: boolean;
  title: string;
  titleHint?: string;
  /** A second line, such as the documented default for a data location. */
  detail?: string;
  state?: ReactNode;
}) {
  return (
    <li className="reach-row" data-link-id={linkId} data-off={off ? "true" : undefined} data-detail={detail ? "true" : undefined}>
      {mark}
      <span className="reach-row-title" title={titleHint ?? title}>{title}</span>
      {state ?? <span />}
      {detail ? <span className="reach-row-detail">{detail}</span> : null}
    </li>
  );
}

function ReachMap({ model }: { model: ReachModel }) {
  const description = reachDescription(model);
  const { ref, layout, paths, drawIn } = useReachGeometry(model);
  const hosted = model.model.kind === "hosted";
  return (
    <figure
      ref={ref}
      className="reach-map"
      data-layout={layout}
      aria-labelledby="reach-map-title"
      aria-describedby="reach-map-description"
    >
      <h2 id="reach-map-title" className="sr-only">{CONNECTIONS_COPY.map.label}</h2>
      <figcaption id="reach-map-description" className="sr-only">{description}</figcaption>
      {layout === "wide" && paths.length > 0 ? (
        <svg className="reach-links" aria-hidden="true">
          {paths.map((path, index) => {
            const draws = drawIn?.has(path.id) ?? false;
            const solid = path.direction === "in" || path.tone === "hosted";
            return (
              <path
                key={path.id}
                d={path.d}
                data-direction={path.direction}
                data-tone={path.tone}
                {...(draws && solid ? { pathLength: 1 } : {})}
                className={draws ? (solid ? "reach-link-draw" : "reach-link-fade") : undefined}
                style={draws ? { animationDelay: `${index * 40}ms` } : undefined}
              />
            );
          })}
        </svg>
      ) : null}
      <div className="reach-zone" data-zone="in" aria-hidden="true">
        <h3>{CONNECTIONS_COPY.map.readFrom}</h3>
        <ul className="reach-rows">
          {model.services.length === 0 ? (
            <ReachRow mark={<ReferenceMark name="" off />} off title={CONNECTIONS_COPY.map.noServices} />
          ) : (
            model.services.map((service) => (
              <ReachRow
                key={service.serviceId}
                linkId={`service:${service.serviceId}`}
                mark={<ServiceMark serviceId={service.serviceId} off={service.status === "missing"} />}
                off={service.status === "missing"}
                title={service.title}
                state={<ReachState tone={serviceTone(service.status)}>{serviceStateText(service)}</ReachState>}
              />
            ))
          )}
        </ul>
      </div>
      <div className="reach-hub" aria-hidden="true">
        <DeviceTile size={layout === "stacked" ? "sm" : "lg"} />
        <div className="reach-hub-caption">
          <div className="reach-hub-name">{CONNECTIONS_COPY.map.device}</div>
          <div className="reach-hub-note">{CONNECTIONS_COPY.map.deviceStays}</div>
        </div>
      </div>
      <div className="reach-zone" data-zone="out" aria-hidden="true">
        <h3>{CONNECTIONS_COPY.map.leaves}</h3>
        <div className="reach-group">
          <h4>{model.organizationName ? CONNECTIONS_COPY.map.prompts : CONNECTIONS_COPY.map.promptsNoOrganization}</h4>
          <ul className="reach-rows">
            {hosted ? (
              <ReachRow
                linkId="prompts"
                mark={model.model.providerId ? <ProviderMark provider={model.model.providerId} /> : <ReferenceMark name={(model.model.location ?? model.model.providerName ?? model.model.name).split(" ")[0] ?? ""} />}
                title={model.model.location ?? promptsDestination(model.model)}
                titleHint={`${model.model.location ?? ""}, ${promptsDestination(model.model)}`}
                {...(model.model.locationDetail ? { detail: model.model.locationDetail } : {})}
                state={model.model.modelName ? <ReachState tone="leaves">{model.model.modelName}</ReachState> : undefined}
              />
            ) : (
              <ReachRow
                mark={<ReferenceMark name="" off />}
                off
                title={promptsDestination(model.model)}
                state={model.model.modelName ? <ReachState>{model.model.modelName}</ReachState> : undefined}
              />
            )}
          </ul>
        </div>
        {model.voice ? (
          <div className="reach-group">
            <h4>{CONNECTIONS_COPY.map.voice}</h4>
            <ul className="reach-rows">
              <ReachRow
                linkId="voice"
                mark={<ProviderMark provider="openai" />}
                title={CONNECTIONS_COPY.map.voiceDestination(model.voice.location)}
                state={model.voice.model ? <ReachState tone="leaves">{model.voice.model}</ReachState> : undefined}
              />
            </ul>
          </div>
        ) : null}
        <div className="reach-group">
          <h4>{CONNECTIONS_COPY.map.questionWords}</h4>
          <ul className="reach-rows">
            {model.referenceHosts.length === 0 ? (
              <ReachRow mark={<ReferenceMark name="" off />} off title={CONNECTIONS_COPY.map.noReferences} />
            ) : (
              model.referenceHosts.map((host) => (
                <ReachRow key={host} linkId={`host:${host}`} mark={<ReferenceMark name={host} />} title={host} />
              ))
            )}
          </ul>
        </div>
        <div className="reach-group">
          <h4>{CONNECTIONS_COPY.map.reports}</h4>
          <ul className="reach-rows" aria-busy={model.reportDestinationsState === "loading" || undefined}>
            {model.reportDestinations === null ? (
              <ReachRow
                mark={<ReferenceMark name="" off />}
                off
                title={model.reportDestinationsState === "failed" ? CONNECTIONS_COPY.map.reportsFailed : CONNECTIONS_COPY.map.reportsLoading}
              />
            ) : model.reportDestinations.length === 0 ? (
              <ReachRow mark={<ReferenceMark name="" off />} off title={CONNECTIONS_COPY.map.noReports} />
            ) : (
              model.reportDestinations.map((name) => (
                <ReachRow key={name} linkId={`report:${name}`} mark={<ReferenceMark name={name} />} title={name} />
              ))
            )}
          </ul>
        </div>
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
      <h2 id={id} className="text-md font-medium text-[var(--color-text)]">{title}</h2>
      {body ? <p className="mt-1 text-sm text-[var(--color-text-muted)]">{body}</p> : null}
    </div>
  );
}

/** Words for a service's state: "4 of 6 parts" instead of "Partial". */
function serviceStatusText(status: ServiceConnectionStatus, granted: number, total: number): string {
  return status === "partial" ? CONNECTIONS_COPY.map.partsSummary(granted, total) : SERVICE_COPY.status[status];
}

/** One row per Microsoft 365 service with its parts and the action that adds what is missing. */
function MicrosoftServiceRows({
  tenant,
  checkResult,
  busy,
}: {
  tenant: TenantRecord;
  checkResult: ReturnType<typeof checkAgainResult> | null;
  busy: boolean;
}) {
  const [access, setAccess] = useState<{ serviceId: ServiceId; partIds?: string[] } | null>(null);
  const ownRegistration = usesOwnRegistration(tenant);
  const grantedPartIds = new Set(grantedParts(tenant).map((part) => part.id));
  return (
    <>
      <TenantCheckResultLine result={checkResult} />
      <ul className="conn-rows">
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
            <li key={service.id} className="conn-row">
              <ServiceMark serviceId={service.id} size="lg" off={status === "missing"} />
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{service.title}</div>
                <div className="text-sm text-[var(--color-text-muted)]">{service.summary}</div>
                {status === "missing" ? null : (
                  <div className="conn-parts">
                    {parts.map((part) =>
                      grantedPartIds.has(part.id) ? (
                        <span key={part.id} className="conn-part">{part.title}</span>
                      ) : (
                        <button
                          key={part.id}
                          type="button"
                          className="conn-part"
                          data-missing="true"
                          aria-label={SERVICE_COPY.addPartLabel(`${service.title} ${partShortLabel(part)}`)}
                          disabled={busy}
                          onClick={() => setAccess({ serviceId: service.id, partIds: [part.id] })}
                        >
                          {part.title}
                          {/* Said in words too, not only by the hollow dot. */}
                          <span className="conn-part-state">, {CONNECTIONS_COPY.permissionNotGranted.toLowerCase()}</span>
                        </button>
                      ),
                    )}
                  </div>
                )}
                {ownRegistration && missingScopes.length > 0 ? (
                  <p className="mt-1.5 break-words font-mono text-xs text-[var(--color-text-muted)]">
                    {SERVICE_COPY.missingPermissions(missingScopes)}
                  </p>
                ) : null}
              </div>
              <span className="conn-row-state">
                <ReachState tone={serviceTone(status)}>
                  {serviceStatusText(status, parts.length - missing.length, parts.length)}
                </ReachState>
              </span>
              <span className="conn-row-action">
                {missing.length > 0 ? (
                  <UiButton
                    size="sm"
                    variant="secondary"
                    aria-label={
                      ownRegistration
                        ? SERVICE_COPY.addPermissionsTitle(service.title)
                        : SERVICE_COPY.addAccessTitle(service.title)
                    }
                    disabled={busy}
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
              </span>
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
    </>
  );
}

function entraLicenseName(tenant: TenantRecord): string | null {
  if (!tenant.entraTier || tenant.entraTier === "unknown") return null;
  return tenant.entraTier === "free" ? "Microsoft Entra ID Free" : `Microsoft Entra ID ${tenant.entraTier.toUpperCase()}`;
}

function tenantDomain(tenant: TenantRecord): string {
  return tenant.username.includes("@") ? tenant.username.slice(tenant.username.lastIndexOf("@") + 1) : tenant.username;
}

/** Renames an organization in place; used in the Organizations tab and the Manage menu. */
function RenameOrganizationForm({
  organization,
  onDone,
  onCancel,
}: {
  organization: OrganizationRecord;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { renameOrganization } = useAppState();
  const toast = useToast();
  const [draft, setDraft] = useState(organization.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void renameOrganization(organization.id, draft)
            .then(() => {
              toast.success(ORGANIZATION_COPY.renamed);
              onDone();
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
          // The field opens on request, so it takes focus; in a dialog,
          // data-autofocus keeps it focused once the menu closes.
          autoFocus
          data-autofocus
          value={draft}
          maxLength={ORGANIZATION_NAME_MAX_LENGTH * 2}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8 min-w-[200px] flex-1 rounded-md bg-[var(--color-surface)] px-2.5 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
        <UiButton size="sm" variant="primary" type="submit" disabled={busy || draft.trim().length === 0}>
          {ORGANIZATION_COPY.renameSave}
        </UiButton>
        <UiButton size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </UiButton>
      </form>
      {error ? <div role="alert" className="mt-1 text-sm text-[var(--color-danger)]">{error}</div> : null}
    </div>
  );
}

/**
 * What this organization's Microsoft 365 connection has granted: each part
 * with its Graph permissions, granted or not. Adding access stays on the
 * service rows.
 */
function GrantedPermissionsDialog({
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
  const granted = new Set(grantedParts(tenant).map((part) => part.id));
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title={CONNECTIONS_COPY.permissionsTitle(organization.name)} subtitle={tenantDomain(tenant)} onClose={onClose} />
      <div className="max-h-[60vh] space-y-5 overflow-y-auto p-6">
        {AVAILABLE_SERVICES.map((service) => (
          <section key={service.id} aria-labelledby={`permissions-${service.id}`}>
            <h3 id={`permissions-${service.id}`} className="flex items-center gap-2 text-md font-medium text-[var(--color-text)]">
              <ServiceMark serviceId={service.id} size="sm" off={serviceStatus(tenant, service.id) === "missing"} />
              {service.title}
            </h3>
            <ul className="mt-2 divide-y divide-[var(--color-border-soft)]">
              {SERVICE_PARTS.filter((part) => part.service === service.id).map((part) => (
                <li key={part.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[var(--color-text)]">{partShortLabel(part).replace(/^./, (letter) => letter.toUpperCase())}</span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--color-text-soft)]">
                      <span className={`h-1.5 w-1.5 rounded-full ${granted.has(part.id) ? "bg-[var(--color-text-soft)]" : "ring-1 ring-inset ring-[var(--color-text-muted)]"}`} aria-hidden="true" />
                      {granted.has(part.id) ? CONNECTIONS_COPY.permissionGranted : CONNECTIONS_COPY.permissionNotGranted}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">{part.scopes.map((scope) => scope.name).join(", ")}</div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.permissionsHint}</p>
      </div>
    </Modal>
  );
}

/**
 * The Microsoft 365 group: the tenant line with a Manage menu (permissions,
 * rename, disconnect), then the service rows.
 */
function MicrosoftGroup({ organization, tenant }: { organization: OrganizationRecord; tenant: TenantRecord }) {
  const { refreshTenantGrants } = useAppState();
  const tenantCheck = useTenantCheck(tenant.id);
  const [checkResult, setCheckResult] = useState<ReturnType<typeof checkAgainResult> | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showingPermissions, setShowingPermissions] = useState(false);
  const ownRegistration = usesOwnRegistration(tenant);
  const registration = tenantRegistrationSummary(tenant);
  const license = entraLicenseName(tenant);
  const licenses = [...(license ? [license] : []), ...(tenant.relevantLicenses ?? []).map((entry) => entry.displayName)];
  // The shared app is the default and goes unsaid; any other registration is named.
  const facts = [
        tenantDomain(tenant),
        ...(registration && registration.text !== "OpenAdminOS app" ? [registration.text] : []),
        `signed in as ${tenant.username}`,
      ].join(", ");
  // Not-checked licenses are explained once, by TenantLicensesNotChecked.
  const licenseHint =
    licenses.length === 0 && licensesNotChecked(tenant)
      ? null
      : licenses.length > 0
        ? CONNECTIONS_COPY.licenses(licenses)
        : CONNECTIONS_COPY.noLicenseDetails;
  const factsText = (
    <span className="min-w-0 truncate text-sm text-[var(--color-text-soft)]" title={registration?.title}>
      {facts}
    </span>
  );
  return (
    <section aria-label={`${tenant.displayName} services`}>
      <div className="conn-m365">
        <strong className="shrink-0 text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.microsoft365}</strong>
        {licenseHint ? (
          <Tooltip content={licenseHint} side="bottom">
            <span tabIndex={0} aria-label={`${facts}. ${licenseHint}`} className="min-w-0 truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
              {factsText}
            </span>
          </Tooltip>
        ) : (
          factsText
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {ownRegistration ? (
            <UiButton
              size="sm"
              variant="ghost"
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
          ) : null}
          <Menu
            ariaLabel={CONNECTIONS_COPY.manageMicrosoft365}
            align="end"
            trigger={
              <UiButton size="sm" variant="ghost" trailingIcon={<IconChevronDown size={12} />} aria-label={CONNECTIONS_COPY.manageMicrosoft365}>
                {CONNECTIONS_COPY.manage}
              </UiButton>
            }
            items={[
              { id: "permissions", label: CONNECTIONS_COPY.permissions, onSelect: () => setShowingPermissions(true) },
              { id: "rename", label: CONNECTIONS_COPY.renameOrganization, onSelect: () => setRenaming(true) },
              { id: "manage-separator", type: "separator" as const },
              {
                id: "disconnect",
                label: CONNECTIONS_COPY.disconnect,
                danger: true,
                onSelect: () => setDisconnecting(true),
              },
            ]}
          />
        </span>
      </div>
      <TenantProbeWarning tenant={tenant} />
      <TenantLicensesNotChecked tenant={tenant} />
      <TenantCheckStatus tenant={tenant} />
      <MicrosoftServiceRows tenant={tenant} checkResult={checkResult} busy={tenantCheck.busy} />
      <DisconnectOrganizationDialog
        open={disconnecting}
        organization={organization}
        tenant={tenant}
        onClose={() => setDisconnecting(false)}
      />
      <GrantedPermissionsDialog open={showingPermissions} organization={organization} tenant={tenant} onClose={() => setShowingPermissions(false)} />
      <Modal open={renaming} onClose={() => setRenaming(false)} size="md">
        <ModalHeader title={CONNECTIONS_COPY.renameOrganization} onClose={() => setRenaming(false)} />
        <div className="p-6">
          {renaming ? (
            <RenameOrganizationForm organization={organization} onDone={() => setRenaming(false)} onCancel={() => setRenaming(false)} />
          ) : null}
        </div>
      </Modal>
    </section>
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
        <ul className="conn-rows">
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
              <li key={server.id} className="conn-row">
                <ReferenceMark name={server.host} size="lg" />
                <div className="min-w-0">
                  <div className="text-base font-medium text-[var(--color-text)]">{server.name}</div>
                  <div className="truncate text-sm text-[var(--color-text-muted)]">{server.host}</div>
                </div>
                <span className="conn-row-state">
                  <ReachState tone={stateText === CONNECTIONS_COPY.referenceOn ? "ok" : "off"}>{stateText}</ReachState>
                </span>
                <UiButton
                  className="conn-row-action"
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

function OrganizationsList({ state, onAdd }: { state: AppState; onAdd: () => void }) {
  const { setActiveOrganization } = useAppState();
  const toast = useToast();
  const organizations = resolveOrganizations(state);
  const active = activeOrganizationOf(state);
  const [editing, setEditing] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const disconnectTarget = organizations.find((organization) => organization.id === disconnecting);
  const disconnectTenantRecord = disconnectTarget
    ? state.tenants.find((entry) => entry.id === disconnectTarget.connections.microsoft365?.tenantId)
    : undefined;
  return (
    <section aria-labelledby="connections-organizations">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading id="connections-organizations" title={CONNECTIONS_COPY.organizationsHeading} body={CONNECTIONS_COPY.organizationsBody} />
        <UiButton variant="secondary" size="sm" onClick={onAdd}>{ORGANIZATION_COPY.addOrganization}</UiButton>
      </div>
      {organizations.length === 0 ? (
        <p className="border-y border-[var(--color-border-soft)] py-3 text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.organizationsEmpty}</p>
      ) : (
      <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {organizations.map((organization) => {
          const tenant = state.tenants.find((entry) => entry.id === organization.connections.microsoft365?.tenantId);
          if (!tenant) return null;
          const isActive = organization.id === active?.id;
          return (
            <li key={organization.id} className="flex flex-wrap items-center gap-3 py-3">
              <TenantTile tenantId={tenant.id} displayName={organization.name} size="row" />
              <div className="min-w-[200px] flex-1">
                {editing === organization.id ? (
                  <RenameOrganizationForm organization={organization} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-base font-medium text-[var(--color-text)]">{organization.name}</span>
                    {isActive ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                        <StatusDot tone="neutral" />{CONNECTIONS_COPY.active}
                      </span>
                    ) : null}
                  </div>
                )}
                <div className="mt-0.5 truncate text-sm text-[var(--color-text-muted)]">
                  {CONNECTIONS_COPY.microsoft365} · {tenantDomain(tenant)}
                </div>
              </div>
              {editing === organization.id ? null : (
                <span className="flex flex-wrap gap-2">
                  <UiButton
                    size="sm"
                    variant="ghost"
                    aria-label={`${ORGANIZATION_COPY.renameAction} ${organization.name}`}
                    onClick={() => setEditing(organization.id)}
                  >
                    {ORGANIZATION_COPY.renameAction}
                  </UiButton>
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
                  <UiButton
                    size="sm"
                    variant="ghost"
                    aria-label={`${CONNECTIONS_COPY.disconnect}, ${organization.name}`}
                    onClick={() => setDisconnecting(organization.id)}
                  >
                    {CONNECTIONS_COPY.disconnect}
                  </UiButton>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      )}
      {disconnectTarget && disconnectTenantRecord ? (
        <DisconnectOrganizationDialog
          open
          organization={disconnectTarget}
          tenant={disconnectTenantRecord}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </section>
  );
}

function SavedRegistrationsList({
  registrations,
  registrationLocked,
  onRemove,
}: {
  registrations: SavedAppRegistration[];
  /** The IT policy file locks its registration, so it cannot be removed. */
  registrationLocked: boolean;
  onRemove: (clientId: string, directoryTenantId?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  return (
    <section aria-labelledby="saved-app-registrations-heading" className="mt-8">
      <h2 id="saved-app-registrations-heading" className="text-md font-medium text-[var(--color-text)]">
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
              {entry.managed ? <SetByItBadge /> : null}
              {entry.managed && registrationLocked ? null : <UiButton
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
              </UiButton>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The CLI or API that carries prompts, by its own name: "Claude Code", "Azure OpenAI API". */
function channelName(channel: string | undefined): string | undefined {
  return channel?.replace(/ to .*$/, "").replace(/^the /, "").replace(/ CLI$/, "");
}

/**
 * Connections with no organization: the figure with the slots it will fill
 * drawn dashed, the way forward, then what leaves this device now.
 */
function NoOrganization({ model, onConnect, onShowReferences }: { model: ReachModel; onConnect: () => void; onShowReferences: () => void }) {
  const navigate = useNavigate();
  const hosted = model.model.kind === "hosted";
  const via = channelName(model.model.channel);
  const prompts = hosted
    ? model.model.location ?? `${model.model.providerName ?? model.model.name}${via ? `, through ${via}` : ""}`
    : promptsDestination(model.model);
  return (
    <>
      <section className="conn-empty" aria-labelledby="connections-empty-title">
        <figure className="conn-empty-fig" aria-labelledby="reach-map-title" aria-describedby="reach-map-description">
          <h2 id="reach-map-title" className="sr-only">{CONNECTIONS_COPY.map.label}</h2>
          <figcaption id="reach-map-description" className="sr-only">{reachDescription(model)}</figcaption>
          <span className="conn-empty-col" aria-hidden="true">
            {AVAILABLE_SERVICES.map((service) => <ServiceMark key={service.id} serviceId={service.id} off />)}
          </span>
          <span className="conn-empty-wire" aria-hidden="true" />
          <DeviceTile size="lg" />
          <span className="conn-empty-wire" aria-hidden="true" />
          <span className="conn-empty-col" aria-hidden="true">
            {model.referenceHosts.length === 0 ? <ReferenceMark name="" off /> : model.referenceHosts.map((host) => <ReferenceMark key={host} name={host} />)}
          </span>
        </figure>
        <h2 id="connections-empty-title" className="font-serif text-lg font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.emptyTitle}</h2>
        <p className="mt-1.5 max-w-[52ch] text-base text-[var(--color-text-soft)]">{CONNECTIONS_COPY.emptyBody}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <UiButton variant="primary" size="lg" onClick={onConnect}>{CONNECTIONS_COPY.connectMicrosoft365}</UiButton>
        </div>
      </section>

      <section aria-labelledby="connections-leaves-now" className="mt-8">
        <SectionHeading id="connections-leaves-now" title={CONNECTIONS_COPY.leavesNowHeading} />
        <ul className="conn-rows">
          <li className="conn-row">
            {hosted && model.model.providerId ? <ProviderMark provider={model.model.providerId} size="lg" /> : hosted ? <ReferenceMark name={prompts.split(" ")[0] ?? ""} size="lg" /> : <ReferenceMark name="" size="lg" off />}
            <div className="min-w-0">
              <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.map.promptsNoOrganization}</div>
              <div className={`text-sm ${hosted ? "text-[var(--color-warning)]" : "text-[var(--color-text-muted)]"}`}>{prompts}</div>
              {hosted && model.model.locationDetail ? (
                <div className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">{model.model.locationDetail}</div>
              ) : null}
            </div>
            <span />
            <UiButton className="conn-row-action" size="sm" variant="ghost" onClick={() => navigate("/settings/providers")}>
              {CONNECTIONS_COPY.changeModel}
            </UiButton>
          </li>
          {model.voice ? (
            <li className="conn-row">
              <ProviderMark provider="openai" size="lg" />
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.map.voice}</div>
                <div className="text-sm text-[var(--color-warning)]">{CONNECTIONS_COPY.map.voiceDestination(model.voice.location)}</div>
              </div>
              <span />
              <span />
            </li>
          ) : null}
          <li className="conn-row">
            {model.referenceHosts[0] ? <ReferenceMark name={model.referenceHosts[0]} size="lg" /> : <ReferenceMark name="" size="lg" off />}
            <div className="min-w-0">
              <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.map.questionWords}</div>
              <div className="truncate text-sm text-[var(--color-text-muted)]">
                {model.referenceHosts.length > 0 ? model.referenceHosts.join(", ") : CONNECTIONS_COPY.map.noReferences}
              </div>
            </div>
            <span />
            <UiButton className="conn-row-action" size="sm" variant="ghost" onClick={onShowReferences}>
              {CONNECTIONS_COPY.references}
            </UiButton>
          </li>
          {model.reportDestinations && model.reportDestinations.length > 0 ? (
            <li className="conn-row">
              <ReferenceMark name={model.reportDestinations[0]!} size="lg" />
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.reportsNowHeading}</div>
                <div className="truncate text-sm text-[var(--color-text-muted)]">{model.reportDestinations.join(", ")}</div>
              </div>
              <span />
              <span />
            </li>
          ) : model.reportDestinations === null ? (
            // Unknown is never shown as nowhere: say it is being checked, or could not be.
            <li className="conn-row" aria-busy={model.reportDestinationsState === "loading" || undefined}>
              <ReferenceMark name="" size="lg" off />
              <div className="min-w-0">
                <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.reportsNowHeading}</div>
                <div className="text-sm text-[var(--color-text-muted)]">
                  {model.reportDestinationsState === "failed" ? CONNECTIONS_COPY.map.reportsFailedSentence : CONNECTIONS_COPY.map.reportsLoadingSentence}
                </div>
              </div>
              <span />
              <span />
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

type ConnectionsView = "connections" | "organizations";

/**
 * Connections: one page per organization. The reach map at the top shows
 * the services read into this device and everything that leaves it; the
 * lists below are the same data, with the actions that change it. The
 * Organizations tab lists every organization and saved app registration on
 * this device. Replaces Settings, Tenants and Settings, Connectors.
 */
export default function Connections() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state, loading, removeSavedAppRegistration } = useAppState();
  const { openSetup } = useSetupFlow();
  // Connect Microsoft 365 opens the onboarding step (services, permissions, sign-in) where it is available.
  const openMicrosoftStep = useOpenMicrosoftStep();
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
  const savedRegistrations = state.savedAppRegistrations ?? [];
  const view: ConnectionsView = searchParams.get("view") === "organizations" ? "organizations" : "connections";
  // The Marketplace Splashtop listing opens the connect step here.
  const connectSplashtop = searchParams.get("connect") === "splashtop";
  const clearConnectParam = useCallback(() => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete("connect");
      return params;
    }, { replace: true });
  }, [setSearchParams]);
  const splashtopConnection = organization
    ? state.splashtopConnections?.find((entry) => entry.organizationId === organization.id)
    : undefined;
  const setView = (next: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "organizations") params.set("view", "organizations");
      else params.delete("view");
      return params;
    });
  };

  const showReferences = () => {
    // The section heading takes focus so keyboard users land on it too.
    const heading = document.getElementById("connections-references");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView?.({ behavior: "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  };

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
        subtitle={organization ? CONNECTIONS_COPY.lede : CONNECTIONS_COPY.ledeNone}
        {...(organization ? { actions: <MicrosoftStepButton /> } : {})}
        wide
      />
      <PageBody>
        {loading ? (
          <div role="status" className="calm-page-column-wide py-10 text-sm text-[var(--color-text-muted)]">
            Loading connections
          </div>
        ) : (
          <div className="connections-page calm-page-column-wide pb-16">
            <TenantCleanupNotice className="mb-5" />
            <Tabs
              className="mb-5"
              ariaLabel={CONNECTIONS_COPY.viewsLabel}
              value={view}
              onValueChange={setView}
              tabs={[
                { id: "connections", label: organization?.name ?? ORGANIZATION_COPY.noOrganization, panelId: "connections-view-connections" },
                { id: "organizations", label: CONNECTIONS_COPY.organizationsTab, panelId: "connections-view-organizations" },
              ]}
            />
            {view === "organizations" ? (
              <div role="tabpanel" id="connections-view-organizations" aria-label={CONNECTIONS_COPY.organizationsTab}>
                <OrganizationsList state={state} onAdd={openSetup} />
                {savedRegistrations.length > 0 ? (
                  <SavedRegistrationsList
                    registrations={savedRegistrations}
                    registrationLocked={isManagedSettingLocked(state.managedPolicy, "appRegistration")}
                    onRemove={removeSavedAppRegistration}
                  />
                ) : null}
              </div>
            ) : (
              <div role="tabpanel" id="connections-view-connections" aria-label={organization?.name ?? ORGANIZATION_COPY.noOrganization}>
                {!organization ? (
                  <>
                    {connectSplashtop ? (
                      <div role="status" className="mb-4 rounded-lg bg-[var(--color-info-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
                        {SPLASHTOP_COPY.needsMicrosoft365}
                      </div>
                    ) : null}
                    <NoOrganization model={reach} onConnect={openMicrosoftStep ?? openSetup} onShowReferences={showReferences} />
                  </>
                ) : (
                  <>
                    <ReachMap model={reach} />

                    <section aria-labelledby="connections-services" className="mt-8">
                      <SectionHeading id="connections-services" title={CONNECTIONS_COPY.servicesHeading} body={CONNECTIONS_COPY.servicesBody} />
                      {tenant ? <MicrosoftGroup organization={organization} tenant={tenant} /> : null}
                      <div className="mb-2 mt-6 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <strong className="text-sm font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.otherServicesHeading}</strong>
                        <span className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.otherServicesBody}</span>
                      </div>
                      <SplashtopServiceRow
                        organization={organization}
                        connection={splashtopConnection}
                        openConnect={connectSplashtop}
                        onConnectHandled={clearConnectParam}
                      />
                      <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 border-y border-[var(--color-border-soft)] py-3">
                        <span aria-hidden="true" className="svc-mark" data-size="lg" data-off="true">+</span>
                        <div className="min-w-0">
                          <div className="text-base font-medium text-[var(--color-text)]">{CONNECTIONS_COPY.addService}</div>
                          <div className="text-sm text-[var(--color-text-muted)]">{CONNECTIONS_COPY.addServiceBody}</div>
                        </div>
                        <UiButton size="sm" variant="secondary" onClick={() => navigate("/marketplace")}>{CONNECTIONS_COPY.openMarketplace}</UiButton>
                      </div>
                    </section>
                  </>
                )}

                <PublicReferences state={state} />

                <section aria-labelledby="connections-results" className="mt-8">
                  <SectionHeading id="connections-results" title={CONNECTIONS_COPY.resultsHeading} body={CONNECTIONS_COPY.resultsBody} />
                  <ResultDestinationsSummary destinations={destinations} loaded={Boolean(connectors)} />
                  <ConnectorsSettingsSection
                    connectorId={searchParams.get("connector")}
                    onConnectorChange={updateConnectorRoute}
                    onConnectorsLoaded={setConnectors}
                  />
                </section>
              </div>
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}
