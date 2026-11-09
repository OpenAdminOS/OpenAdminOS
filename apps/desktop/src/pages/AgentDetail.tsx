import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ServiceMark } from "../components/ServiceMark";
import { Select } from "../components/Select";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { AgentScheduleCard } from "../components/AgentScheduleCard";
import { InvalidAgentNotice } from "../components/InvalidAgentNotice";
import { AGENT_COPY, providerDataLocation } from "../copy";
import {
  DeclaredGraphOperations,
  ManifestPreview,
  ManifestSections,
} from "../components/ManifestPreview";
import { stripMarkdownToPlainText } from "../components/MarkdownPreview";
import { Modal, ModalHeader } from "../components/Modal";
import { ConfigureAgentModal } from "../components/ConfigureAgentModal";
import { RunWithMenu } from "../components/RunWithMenu";
import { useToast } from "../components/Toast";
import {
  ServiceChips,
  ServiceNotConnectedNotice,
  agentConsentNote,
} from "../components/ServiceAccess";
import { NewAgentModal } from "../components/NewAgentModal";
import { CommunityShareModal } from "../components/CommunityShareModal";
import {
  IconBadgeCheck,
  IconChevronDown,
  IconClock,
  IconConnectors,
  IconShare,
} from "../components/icons";
import {
  Badge,
  Button,
  Drawer,
  IconButton,
  KeyValue,
  Menu,
  Section,
  Skeleton,
} from "../components/ui";
import { useAppState } from "../state";
import { agentNeeds } from "../shared/agent-needs";
import { manualRunReportDestinations } from "../shared/delivery-destinations";
import { AgentNeedChips } from "../components/AgentNeedChips";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { PILOT_COPY, isPilotAgentSlug } from "../shared/pilot-mode";
import { isProviderImplemented } from "../shared/providers";
import { extractWhatsAppRecipientInput } from "../shared/whatsappTarget";
import {
  agentCallsNoServiceApi,
  organizationForTenant,
  formatServiceList,
  resolveOrganizations,
  serviceById,
  agentServiceIds,
  availableScopeSet,
  missingPartsForScopes,
  missingServicesForAgent,
  partLabel,
  uncoveredScopesCopy,
  unmappedScopesCopy,
  type ServiceId,
  resolveRunModel,
  type AgentManifestPreview,
  type AgentSummary,
  type AgentDiscordDelivery,
  type AgentOutlookDelivery,
  type AgentSignalDelivery,
  type AgentSlackDelivery,
  type AgentTeamsDelivery,
  type AgentWhatsAppWebDelivery,
  type AgentUpdateReview,
  type ConnectorChannelRef,
  type ConnectorSummary,
  type ConnectorTeamRef,
  type ProviderId,
  type ProviderSummary,
  type RequestedScope,
  type RegistryAgentSummary,
  type RunRecord,
  type TenantRecord,
  type WhatsAppWebGroupRef,
  type WhatsAppWebRecipientType,
} from "../shared/openAdminOS";

function manifestLoadErrorCopy(error: string, recovery: string): string {
  const reason = error.trim();
  const sentence = /[.?]$/.test(reason) ? reason : `${reason}.`;
  return `The manifest could not be loaded: ${sentence} ${recovery}`;
}

function scrollAgentSection(targetId: string) {
  const target = document.getElementById(targetId);
  const scrollRoot = target?.closest<HTMLElement>("[data-drawer-scroll-root]");
  if (!(target instanceof HTMLElement) || !scrollRoot) return;
  const rootRect = scrollRoot.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = Math.max(
    0,
    scrollRoot.scrollTop + targetRect.top - rootRect.top - 12,
  );
  if (typeof scrollRoot.scrollTo === "function") {
    scrollRoot.scrollTo({ top, behavior: "auto" });
  } else {
    scrollRoot.scrollTop = top;
  }
}

export default function AgentDetail({
  startRunOnOpen = false,
}: {
  startRunOnOpen?: boolean;
}) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { requireTenantAndProvider, openSetup } = useSetupFlow();
  const {
    state,
    loading: appStateLoading,
    registryAgents,
    installAgent,
    startRun,
    updateAgentSettings,
    uninstallAgent,
    getAgentUpdateReview,
    updateAgent,
    updateAgentSchedule,
    updateAgentTeamsDelivery,
    updateAgentWhatsAppWebDelivery,
    updateAgentOutlookDelivery,
    updateAgentSlackDelivery,
    updateAgentDiscordDelivery,
    updateAgentSignalDelivery,
    exportAgentDraftBundle,
  } = useAppState();
  const toast = useToast();
  const agent = state.installedAgents.find((a) => a.slug === slug);
  const registryAgent = registryAgents.find((candidate) => candidate.slug === slug);
  const recentRuns = state.runs
    .filter((run) => run.agentSlug === slug)
    .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))
    .slice(0, 5);
  const [preview, setPreview] = useState<AgentManifestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editInvalidOpen, setEditInvalidOpen] = useState(false);
  const invalidEntry = agent?.manifestError
    ? state.invalidAgents?.find((entry) => entry.registryPath === agent.registryPath)
    : undefined;
  const editableInvalid =
    invalidEntry?.source === "user" && invalidEntry.sourceText !== undefined ? invalidEntry : undefined;
  const [communityShareOpen, setCommunityShareOpen] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [hubInstallConfirm, setHubInstallConfirm] = useState(false);
  const [hubInstalling, setHubInstalling] = useState(false);
  const [updateReview, setUpdateReview] = useState<AgentUpdateReview | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [requestedScopes, setRequestedScopes] = useState<RequestedScope[]>([]);
  const [pendingRunChoice, setPendingRunChoice] = useState<
    { dryRun?: boolean; runForRealOfRunId?: string; retryOfRunId?: string; tenantId?: string; providerId?: ProviderId; model?: string } | null
  >(null);
  const consumedStartRunOnOpen = useRef(false);
  const resumedIntentRef = useRef<string | null>(null);
  const pendingDeliverySaves = useRef(new Set<Promise<void>>());
  const [pendingDeliverySaveCount, setPendingDeliverySaveCount] = useState(0);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const licenseMissing = agent
    ? hasLicenseShortfall(agent.requiresEntraTier, activeTenant?.entraTier)
    : false;
  // In pilot mode only the three pilot agents run, with prepared text.
  const pilot = activeTenant?.kind === "sample";
  const missingAgentServices =
    agent && activeTenant ? missingServicesForAgent(activeTenant, agentServiceIds(agent)) : [];
  const pilotRunnable = pilot && Boolean(agent && isPilotAgentSlug(agent.slug));
  const pendingTenant = pendingRunChoice?.tenantId
    ? state.tenants.find((tenant) => tenant.id === pendingRunChoice.tenantId)
    : activeTenant;
  const pendingProviderId = pendingRunChoice?.providerId ?? state.activeProviderId;
  const pendingProvider = state.providers.find(
    (provider) => provider.id === pendingProviderId,
  );
  const pendingModel = resolveRunModel({
    provider: pendingProvider,
    activeModelByProviderId: state.activeModelByProviderId,
    preferredModel: agent?.preferredModel,
    explicitModel: pendingRunChoice?.model,
  }).model;

  const handleUninstallAgent = async () => {
    if (!agent || uninstalling) return;
    setUninstalling(true);
    try {
      await uninstallAgent(agent.slug);
      toast.success(`${agent.name} uninstalled.`);
      setUninstallOpen(false);
      navigate("/agents");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setUninstalling(false);
    }
  };

  const queueRunPreflight = useCallback((choice?: {
    dryRun?: boolean;
    runForRealOfRunId?: string;
    retryOfRunId?: string;
    tenantId?: string;
    providerId?: ProviderId;
    model?: string;
  }) => {
    if (agent && pilot && !isPilotAgentSlug(agent.slug)) {
      setRunError(PILOT_COPY.agentRefused(agent.name));
      return;
    }
    // With no organization the preflight opens instead of setup: it names
    // the services the agent needs, and starts an agent that calls no
    // service API. Its Connect action opens setup with this run kept.
    if (agent && !activeTenant && !choice?.tenantId) {
      setRunError(null);
      setPendingRunChoice(choice ?? {});
      return;
    }
    if (
      agent &&
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "agent-run",
          slug: agent.slug,
          ...(choice?.dryRun ? { dryRun: true } : {}),
          ...(choice?.runForRealOfRunId ? { runForRealOfRunId: choice.runForRealOfRunId } : {}),
          ...(choice?.retryOfRunId ? { retryOfRunId: choice.retryOfRunId } : {}),
          ...(choice?.tenantId ? { tenantId: choice.tenantId } : {}),
          ...(choice?.providerId ? { providerId: choice.providerId } : {}),
          ...(choice?.model ? { model: choice.model } : {}),
          returnTo: `/agents/${encodeURIComponent(agent.slug)}`,
        }),
      )
    ) {
      return;
    }
    setRunError(null);
    setPendingRunChoice(choice ?? {});
  }, [activeTenant, agent, pilot, requireTenantAndProvider]);

  const trackDeliverySave = (save: Promise<void>): Promise<void> => {
    const tracked = save.finally(() => {
      pendingDeliverySaves.current.delete(tracked);
      setPendingDeliverySaveCount(pendingDeliverySaves.current.size);
    });
    pendingDeliverySaves.current.add(tracked);
    setPendingDeliverySaveCount(pendingDeliverySaves.current.size);
    return tracked;
  };

  const waitForDeliverySaves = async () => {
    while (pendingDeliverySaves.current.size > 0) {
      await Promise.allSettled([...pendingDeliverySaves.current]);
    }
  };

  useEffect(() => {
    if (!startRunOnOpen || consumedStartRunOnOpen.current || !agent) return;
    consumedStartRunOnOpen.current = true;
    // Run again passes the original run's provider and model.
    const runChoice = (location.state as { runChoice?: RerunChoice } | null)?.runChoice;
    queueRunPreflight({
      ...(runChoice?.providerId ? { providerId: runChoice.providerId } : {}),
      ...(typeof runChoice?.model === "string" ? { model: runChoice.model } : {}),
    });
    // Only the first open reads the route state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, queueRunPreflight, startRunOnOpen]);

  useEffect(() => {
    const routeState = location.state as { resumePendingIntent?: PendingIntent } | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind !== "agent-run" ||
      resumed.slug !== agent?.slug ||
      resumedIntentRef.current === resumed.createdAt
    ) {
      return;
    }
    resumedIntentRef.current = resumed.createdAt;
    navigate(location.pathname, { replace: true, state: null });
    const restoredTenantId = resumed.tenantId
      ? state.tenants.some((tenant) => tenant.id === resumed.tenantId)
        ? resumed.tenantId
        : state.activeTenantId
      : undefined;
    if (resumed.tenantId && restoredTenantId !== resumed.tenantId && activeTenant) {
      toast.info(
        `The original tenant is no longer connected. Review this run against ${activeTenant.displayName}.`,
      );
    }
    queueRunPreflight({
      ...(resumed.dryRun ? { dryRun: true } : {}),
      ...(resumed.runForRealOfRunId ? { runForRealOfRunId: resumed.runForRealOfRunId } : {}),
      ...(restoredTenantId ? { tenantId: restoredTenantId } : {}),
      ...(resumed.providerId ? { providerId: resumed.providerId } : {}),
      ...(resumed.model ? { model: resumed.model } : {}),
      ...(resumed.retryOfRunId ? { retryOfRunId: resumed.retryOfRunId } : {}),
    });
  }, [
    activeTenant,
    agent,
    location.pathname,
    location.state,
    navigate,
    queueRunPreflight,
    state.activeTenantId,
    state.tenants,
    toast,
  ]);

  const reviewAndApplyUpdate = async () => {
    if (!agent) return;
    setUpdating(true);
    try {
      const review = await getAgentUpdateReview(agent.slug);
      if (review.requiresConfirmation) {
        setUpdateReview(review);
        return;
      }
      await updateAgent(agent.slug);
      toast.success(`${agent.name} updated.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const applyReviewedUpdate = async () => {
    if (!agent) return;
    setUpdating(true);
    try {
      await updateAgent(agent.slug, { confirmTrustChanges: true });
      setUpdateReview(null);
      toast.success(`${agent.name} updated.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const handleStartRun = async (choice?: {
    dryRun?: boolean;
    runForRealOfRunId?: string;
    retryOfRunId?: string;
    tenantId?: string;
    providerId?: ProviderId;
    model?: string;
  }) => {
    if (!agent) return;
    setRunError(null);
    try {
      await waitForDeliverySaves();
      const options =
        choice && (choice.dryRun || choice.runForRealOfRunId || choice.retryOfRunId || choice.tenantId || choice.providerId || choice.model)
          ? {
              ...(choice.dryRun ? { dryRun: true } : {}),
              ...(choice.runForRealOfRunId ? { runForRealOfRunId: choice.runForRealOfRunId } : {}),
              ...(choice.retryOfRunId ? { retryOfRunId: choice.retryOfRunId } : {}),
              ...(choice.tenantId ? { tenantId: choice.tenantId } : {}),
              ...(choice.providerId ? { providerId: choice.providerId } : {}),
              ...(choice.model ? { model: choice.model } : {}),
            }
          : undefined;
      const run = await startRun(agent.slug, options);
      setPendingRunChoice(null);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const manifestError = agent?.manifestError;
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const api = window.openAdminOS;
    // Wait for the installed agents, because an invalid manifest has its
    // own notice and loading it again would only repeat the same error.
    if (appStateLoading) return;
    if (!api || manifestError) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    api
      .getAgentManifest(slug)
      .then((result) => {
        if (cancelled) return;
        setPreview(result ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, agent?.version, registryAgent?.version, manifestError, appStateLoading]);

  useEffect(() => {
    window.openAdminOS
      ?.getRequestedScopes()
      .then(setRequestedScopes)
      .catch(() => setRequestedScopes([]));
  }, []);

  const closeDrawer = () => {
    // Listings opened from the Marketplace return there.
    if (searchParams.get("from") === "marketplace") {
      navigate("/marketplace?kind=agents");
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    next.delete("install");
    next.delete("add");
    navigate({
      pathname: "/agents",
      search: next.toString() ? `?${next.toString()}` : "",
    });
  };

  const clearAction = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("action");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const action = searchParams.get("action");
    if (!slug) return;
    if (!agent) {
      // Agent install is a production feature; pilot mode only shows details.
      if (action === "install" && !pilot) setHubInstallConfirm(true);
      return;
    }
    if (action === "configure") {
      setConfigureOpen(true);
      clearAction();
    } else if (action === "uninstall") {
      setUninstallOpen(true);
      clearAction();
    } else if (action === "manifest") {
      setManifestOpen(true);
      clearAction();
    } else if (action === "schedule") {
      window.requestAnimationFrame(() => {
        scrollAgentSection("agent-schedule");
      });
      clearAction();
    } else if (action === "share" && preview) {
      if (preview.isUserAuthored) {
        setCommunityShareOpen(true);
      } else {
        void window.openAdminOS?.openExternal(
          `https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/${agent.slug}`,
        );
      }
      clearAction();
    }
  }, [agent, clearAction, pilot, preview, searchParams, slug]);

  if (!slug) return null;

  if (!agent) {
    return registryAgent ? (
      <HubAgentDrawer
        agent={registryAgent}
        preview={preview}
        previewLoading={previewLoading}
        previewError={previewError}
        installConfirm={hubInstallConfirm}
        installing={hubInstalling}
        onClose={closeDrawer}
        onRequestInstall={() => setHubInstallConfirm(true)}
        onCancelInstall={() => setHubInstallConfirm(false)}
        onInstall={() => {
          setHubInstalling(true);
          void installAgent(registryAgent.registryId)
            .then(() => {
              toast.success(`${registryAgent.name} installed.`);
              setHubInstallConfirm(false);
            })
            .catch((caught) => {
              toast.error(caught instanceof Error ? caught.message : String(caught));
            })
            .finally(() => setHubInstalling(false));
        }}
        onViewManifest={() => setManifestOpen(true)}
        manifestOpen={manifestOpen}
        onCloseManifest={() => setManifestOpen(false)}
        tenantTier={activeTenant?.entraTier}
        activeTenant={activeTenant}
        pilot={pilot}
        onConnectTenant={openSetup}
      />
    ) : (
      <Drawer open title="Agent not found" onClose={closeDrawer}>
        <div className="p-5 text-sm text-[var(--color-text-muted)]">
          This agent is not installed and is not present in the current hub catalog.
        </div>
      </Drawer>
    );
  }

  return (
    <>
      <Drawer
        open
        title={agent.name}
        onClose={closeDrawer}
        actions={
          <>
            {agent.mode === "write" && (!pilot || pilotRunnable) ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={agent.compatibility?.supported === false || Boolean(agent.manifestError)}
                onClick={() => queueRunPreflight({ dryRun: true })}
              >
                Dry run
              </Button>
            ) : null}
            {pilot && !pilotRunnable ? (
              <Button variant="secondary" size="sm" title={PILOT_COPY.agentRefused(agent.name)} onClick={openSetup}>
                {PILOT_COPY.agentConnectToRun}
              </Button>
            ) : pilot ? (
              <Button
                variant="primary"
                size="sm"
                disabled={agent.compatibility?.supported === false || Boolean(agent.manifestError)}
                onClick={() => queueRunPreflight()}
              >
                Run
              </Button>
            ) : (
              <RunWithMenu
                providers={state.providers}
                activeProviderId={state.activeProviderId}
                activeModelByProviderId={state.activeModelByProviderId}
                disabled={agent.compatibility?.supported === false || Boolean(agent.manifestError)}
                onRun={(choice) => {
                  queueRunPreflight(choice);
                }}
              />
            )}
            <Menu
              ariaLabel={`${agent.name} actions`}
              trigger={
                <IconButton
                  label={`${agent.name} actions`}
                  icon={<IconChevronDown size={13} />}
                  size="sm"
                />
              }
              items={[
                {
                  id: "configure",
                  label: "Configure",
                  disabled:
                    previewLoading ||
                    !preview ||
                    (preview.manifest.definition.settings ?? []).length === 0,
                  onSelect: () => setConfigureOpen(true),
                },
                {
                  id: "share",
                  label: "Share",
                  icon: <IconShare size={13} />,
                  onSelect: () => {
                    if (preview?.isUserAuthored) setCommunityShareOpen(true);
                    else void window.openAdminOS?.openExternal(
                      `https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/${agent.slug}`,
                    );
                  },
                },
                {
                  id: "schedule",
                  label: "Schedule",
                  icon: <IconClock size={13} />,
                  onSelect: () => scrollAgentSection("agent-schedule"),
                },
                {
                  id: "manifest",
                  label: "View manifest",
                  onSelect: () => setManifestOpen(true),
                },
                ...(preview?.isUserAuthored
                  ? [
                      { id: "edit", label: "Edit", onSelect: () => setEditOpen(true) },
                      {
                        id: "export",
                        label: "Export bundle",
                        onSelect: () => {
                          void exportAgentDraftBundle(preview.sourceText)
                            .then((path) => {
                              if (path) toast.success("Agent bundle exported.");
                            })
                            .catch((caught) => toast.error(caught instanceof Error ? caught.message : String(caught)));
                        },
                      },
                    ]
                  : []),
                { id: "separator", type: "separator" as const },
                {
                  id: "uninstall",
                  label: "Uninstall",
                  danger: true,
                  onSelect: () => setUninstallOpen(true),
                },
              ]}
            />
          </>
        }
      >
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-soft)] pb-4">
          <Badge tone={agent.mode === "write" ? "warning" : "neutral"}>
            {agent.mode === "write" ? "Write" : "Read"}
          </Badge>
          <span className="text-sm text-[var(--color-text-soft)]">v{agent.version}</span>
          <span className="text-sm text-[var(--color-text-muted)]">{agent.author.name}</span>
          {agent.author.verified ? (
            <IconBadgeCheck aria-label="Verified publisher" size={13} className="text-[var(--color-info)]" />
          ) : null}
          {agent.compatibility?.supported === false ? (
            <Badge tone="warning">Incompatible</Badge>
          ) : null}
          {agent.manifestError ? <Badge tone="danger">{AGENT_COPY.invalidBadge}</Badge> : null}
          {licenseMissing ? <Badge tone="warning">License required</Badge> : null}
        </div>
        <AgentNeedChips needs={agentNeeds(agent, activeTenant, resolveOrganizations(state).length > 0)} />
        {activeTenant && !pilot && missingAgentServices.length > 0 ? (
          <ServiceNotConnectedNotice
            tenant={activeTenant}
            serviceIds={missingAgentServices.map((service) => service.id)}
          />
        ) : null}
        {agent.manifestError ? (
          <InvalidAgentNotice
            name={agent.name}
            reason={agent.manifestError}
            manifestPath={invalidEntry?.manifestPath}
            source={invalidEntry?.source}
            onEdit={editableInvalid ? () => setEditInvalidOpen(true) : undefined}
            onUninstall={() => setUninstallOpen(true)}
          />
        ) : null}
        {agent.compatibility?.supported === false && (
          <div className="mb-4 rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 ring-1 ring-[var(--color-warning)]/30">
            <div className="text-sm font-medium text-[var(--color-text)]">
              Update OpenAdminOS before running this agent.
            </div>
            <div className="mt-1 text-sm leading-relaxed text-[var(--color-text-soft)]">
              {agent.name} requires OpenAdminOS {agent.compatibility.minAppVersion} or newer.
              You are running {agent.compatibility.appVersion}.
            </div>
          </div>
        )}
        {agent.updateAvailable && (
          <div className={`mb-4 flex items-start justify-between gap-3 rounded-lg px-4 py-3 ring-1 ${
            updateRequiresNewerApp(agent)
              ? "bg-[var(--color-warning-soft)] ring-[var(--color-warning)]/30"
              : "bg-[var(--color-accent-soft)] ring-[var(--color-accent)]/30"
          }`}>
            <div className="text-sm leading-relaxed text-[var(--color-text)]">
              <span className="font-medium">
                {updateRequiresNewerApp(agent) ? "App update required." : "Update available."}
              </span>{" "}
              <span>v{agent.version}</span>
              <span className="opacity-50"> → </span>
              <span>v{agent.updateAvailable.version}</span>
              <span className="opacity-70">
                {" "}
                {updateRequiresNewerApp(agent)
                  ? `, this agent update requires OpenAdminOS ${agent.updateAvailable.minAppVersion}. Update the app before applying it.`
                  : ", this fetches the new manifest from GitHub and replaces the local copy. Settings and schedule are preserved."}
              </span>
            </div>
            <Button
              variant="secondary"
              disabled={updating || updateRequiresNewerApp(agent)}
              onClick={() => {
                void reviewAndApplyUpdate();
              }}
            >
              {updateRequiresNewerApp(agent) ? "Update OpenAdminOS" : updating ? "Checking…" : "Review update"}
            </Button>
          </div>
        )}
        {/* While the run review is open, it shows the error itself. */}
        {runError && pendingRunChoice === null && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 ring-1 ring-[var(--color-danger)]/30">
            <div className="text-sm leading-relaxed text-[var(--color-danger)]">
              {runError}
            </div>
            <button
              onClick={() => setRunError(null)}
              aria-label="Dismiss"
              className="text-[var(--color-danger)]/70 hover:text-[var(--color-danger)]"
            >
              ×
            </button>
          </div>
        )}
        <div className="space-y-6">
          <Section title="About">
            <p className="text-base leading-relaxed text-[var(--color-text-soft)]">
              {agent.description}
            </p>
          </Section>

          {previewLoading ? (
            <div className="space-y-3" role="status" aria-label="Loading agent details">
              <Skeleton className="w-2/3" />
              <Skeleton className="w-full" />
            </div>
          ) : null}

          {previewError ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {manifestLoadErrorCopy(previewError, "Refresh the agent and try again.")}
            </p>
          ) : null}

          {!previewLoading && !previewError && preview ? (
            <ManifestSections
              preview={preview}
              sections={["permissions"]}
              consentNote={agentConsentNote(activeTenant, agent)}
            />
          ) : null}

          {!previewLoading && !preview ? (
            <FallbackScopesCard
              scopes={agent.scopes}
              consentNote={agentConsentNote(activeTenant, agent)}
            />
          ) : null}

          <Section id="agent-schedule" title="Schedule" className="scroll-mt-4">
            <AgentScheduleCard
              key={agent.slug}
              agent={agent}
              onChange={async (next) => {
                await updateAgentSchedule(agent.slug, next);
                toast.success(
                  next === null
                    ? "Schedule disabled."
                    : `Schedule saved, every ${Math.round(next.intervalSeconds / 60)}m.`,
                );
              }}
            />
          </Section>

          <DeliveryDisclosure
            configured={Boolean(
              agent.delivery &&
                Object.values(agent.delivery).some((entry) => entry != null),
            )}
          >
            <AgentTeamsDeliveryCard
              delivery={agent.delivery?.teams}
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(updateAgentTeamsDelivery(agent.slug, next));
              }}
            />

            <AgentWhatsAppWebDeliveryCard
              delivery={agent.delivery?.whatsappWeb}
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(
                  updateAgentWhatsAppWebDelivery(agent.slug, next),
                );
              }}
            />

            <AgentDefaultConnectorDeliveryCard
              connectorId="outlook"
              connectorName="Outlook"
              delivery={agent.delivery?.outlook}
              defaultFlag="useDefaultRecipients"
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(
                  updateAgentOutlookDelivery(
                    agent.slug,
                    next as AgentOutlookDelivery | null,
                  ),
                );
              }}
            />

            <AgentDefaultConnectorDeliveryCard
              connectorId="slack"
              connectorName="Slack"
              delivery={agent.delivery?.slack}
              defaultFlag="useDefaultChannel"
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(
                  updateAgentSlackDelivery(
                    agent.slug,
                    next as AgentSlackDelivery | null,
                  ),
                );
              }}
            />

            <AgentDefaultConnectorDeliveryCard
              connectorId="discord"
              connectorName="Discord"
              delivery={agent.delivery?.discord}
              defaultFlag="useDefaultWebhook"
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(
                  updateAgentDiscordDelivery(
                    agent.slug,
                    next as AgentDiscordDelivery | null,
                  ),
                );
              }}
            />

            <AgentDefaultConnectorDeliveryCard
              connectorId="signal"
              connectorName="Signal"
              delivery={agent.delivery?.signal}
              defaultFlag="useDefaultRecipient"
              onOpenConnectors={() => navigate("/connections")}
              onChange={async (next) => {
                await trackDeliverySave(
                  updateAgentSignalDelivery(
                    agent.slug,
                    next as AgentSignalDelivery | null,
                  ),
                );
              }}
            />
          </DeliveryDisclosure>

          {preview ? (
            <ManifestSections
              preview={preview}
              settingsOverrides={agent.settings}
              sections={["settings", "result"]}
            />
          ) : null}

          <Section
            title="Recent runs"
            action={
              <Link
                to={`/runs?agent=${encodeURIComponent(agent.slug)}`}
                className="rounded-md text-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                View all
              </Link>
            }
          >
            <div className="divide-y divide-[var(--color-border-soft)]">
              {recentRuns.length === 0 ? (
                <div className="py-2 text-sm text-[var(--color-text-muted)]">
                  No runs recorded for this agent.
                </div>
              ) : (
                recentRuns.map((run) => (
                  <div key={run.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="line-clamp-2 text-base text-[var(--color-text)]">
                        {run.summary ? stripMarkdownToPlainText(run.summary) : run.status}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        {run.status === "planned" ? "Dry run: not applied · " : ""}{formatDate(run.queuedAt)} · {formatDuration(run)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/runs/${run.id}`)}>
                      View
                    </Button>
                  </div>
                ))
              )}
            </div>
          </Section>

          {preview ? <ManifestSections preview={preview} sections={["pipeline"]} /> : null}

          <Section title="Model">
            <ModelCardBody
              agent={agent}
              providers={state.providers}
              activeProviderId={state.activeProviderId}
              activeModelByProviderId={state.activeModelByProviderId}
            />
          </Section>
        </div>
      </div>
      </Drawer>
      <Modal open={manifestOpen} onClose={() => setManifestOpen(false)} size="lg">
        <ModalHeader
          title={`${agent.name} manifest`}
          onClose={() => setManifestOpen(false)}
        />
        <div className="overflow-y-auto p-5">
          {previewLoading ? (
            <div className="space-y-3" role="status" aria-label="Loading manifest">
              <Skeleton className="w-2/3" />
              <Skeleton className="w-full" />
              <Skeleton className="w-5/6" />
            </div>
          ) : previewError ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {manifestLoadErrorCopy(previewError, "Refresh the agent and try again.")}
            </p>
          ) : preview ? (
            <ManifestPreview preview={preview} settingsOverrides={agent.settings} />
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">No manifest is available.</p>
          )}
        </div>
      </Modal>
      {preview && (
        <ConfigureAgentModal
          open={configureOpen}
          onClose={() => setConfigureOpen(false)}
          agent={agent}
          manifest={preview.manifest}
          onSave={(values) => updateAgentSettings(agent.slug, values)}
        />
      )}
      {editableInvalid ? (
        <NewAgentModal
          open={editInvalidOpen}
          onClose={() => setEditInvalidOpen(false)}
          initialYamlSource={editableInvalid.sourceText}
          editingSlug={editableInvalid.folder}
        />
      ) : null}
      {preview?.isUserAuthored && (
        <NewAgentModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          initialYamlSource={preview.sourceText}
          editingSlug={agent.slug}
        />
      )}
      {preview?.isUserAuthored && (
        <CommunityShareModal
          open={communityShareOpen}
          onClose={() => setCommunityShareOpen(false)}
          preview={preview}
          slug={agent.slug}
        />
      )}
      <Modal
        open={updateReview !== null}
        onClose={() => {
          if (!updating) setUpdateReview(null);
        }}
        size="lg"
      >
        <ModalHeader
          title="Review trust changes"
          subtitle={
            updateReview
              ? `${agent.name} v${updateReview.fromVersion} -> v${updateReview.toVersion}`
              : undefined
          }
          onClose={() => setUpdateReview(null)}
          badge={<Pill tone="warning">Registry update</Pill>}
        />
        {updateReview && (
          <div className="space-y-3 overflow-y-auto p-6">
            <div className="rounded-md bg-[var(--color-bg-subtle)] p-3 text-sm leading-relaxed text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
              Manifest SHA-256{" "}
              <span className="break-all font-mono text-[var(--color-text)]">
                {updateReview.manifestSha256}
              </span>
            </div>
            <div className="space-y-2">
              {updateReview.changes.map((change) => (
                <div
                  key={change.id}
                  className="rounded-md bg-[var(--color-bg-subtle)] p-3 ring-1 ring-[var(--color-border)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">
                      {change.label}
                    </div>
                    <Pill
                      tone={
                        change.severity === "danger"
                          ? "danger"
                          : change.severity === "warn"
                            ? "warning"
                            : "default"
                      }
                    >
                      {change.severity}
                    </Pill>
                  </div>
                  <p className="mt-1 text-base leading-relaxed text-[var(--color-text-muted)]">
                    {change.detail}
                  </p>
                  {(change.before || change.after) && (
                    <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[var(--color-text-muted)]">
                          Before
                        </div>
                        <div className="break-words font-mono text-[var(--color-text)]">
                          {change.before ?? "none"}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[var(--color-text-muted)]">
                          After
                        </div>
                        <div className="break-words font-mono text-[var(--color-text)]">
                          {change.after ?? "none"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => setUpdateReview(null)}
              >
                Cancel
              </Button>
              <Button disabled={updating} onClick={() => void applyReviewedUpdate()}>
                {updating ? "Updating..." : "Apply update"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <UninstallAgentModal
        open={uninstallOpen}
        agentName={agent.name}
        userAuthored={preview?.isUserAuthored === true}
        busy={uninstalling}
        onClose={() => {
          if (!uninstalling) setUninstallOpen(false);
        }}
        onConfirm={() => void handleUninstallAgent()}
      />
      {agent && (
        <RunPreflightModal
          open={pendingRunChoice !== null}
          dryRun={pendingRunChoice?.dryRun === true}
          agent={agent}
          activeTenant={pendingTenant}
          providerName={pendingTenant?.kind === "sample" ? PILOT_COPY.providerName : pendingProvider?.name ?? pendingProviderId}
          providerId={pendingProviderId}
          providerIsLocal={pendingTenant?.kind === "sample" || pendingProvider?.isLocal === true}
          requestedScopes={requestedScopes}
          pilot={pendingTenant?.kind === "sample"}
          organizationName={organizationForTenant(resolveOrganizations(state), pendingTenant?.id)?.name}
          organizationInactive={pendingTenant !== undefined && pendingTenant.id !== state.activeTenantId}
          hasOrganizations={resolveOrganizations(state).length > 0}
          model={pendingTenant?.kind === "sample" ? "Prepared sample text" : pendingModel}
          deliverySaving={pendingDeliverySaveCount > 0}
          // Provider readiness is checked on its own, whatever the
          // organization state; pilot runs use prepared text.
          providerReady={
            pendingTenant?.kind === "sample" ||
            Boolean(
              pendingProvider &&
                isProviderImplemented(pendingProvider.id) &&
                (pendingProvider.status === "connected" || pendingProvider.status === "available"),
            )
          }
          providerStatusDetail={pendingProvider?.detail}
          startError={runError}
          onOpenProviderSettings={() => {
            setPendingRunChoice(null);
            navigate("/settings/providers");
          }}
          onConnect={() => {
            const choice = pendingRunChoice ?? {};
            setPendingRunChoice(null);
            requireTenantAndProvider(
              createPendingIntent({
                kind: "agent-run",
                slug: agent.slug,
                ...(choice.dryRun ? { dryRun: true } : {}),
                ...(choice.providerId ? { providerId: choice.providerId } : {}),
                ...(choice.model ? { model: choice.model } : {}),
                returnTo: `/agents/${encodeURIComponent(agent.slug)}`,
              }),
            );
          }}
          onOpenConnections={() => {
            setPendingRunChoice(null);
            navigate("/connections");
          }}
          onClose={() => setPendingRunChoice(null)}
          onConfirm={() => {
            void handleStartRun(pendingRunChoice ?? undefined);
          }}
        />
      )}
    </>
  );
}

function HubAgentDrawer({
  agent,
  preview,
  previewLoading,
  previewError,
  installConfirm,
  installing,
  manifestOpen,
  tenantTier,
  activeTenant,
  onClose,
  onRequestInstall,
  onCancelInstall,
  onInstall,
  onViewManifest,
  onCloseManifest,
  pilot,
  onConnectTenant,
}: {
  agent: RegistryAgentSummary;
  preview: AgentManifestPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  installConfirm: boolean;
  installing: boolean;
  manifestOpen: boolean;
  tenantTier?: "free" | "p1" | "p2" | "unknown";
  activeTenant: TenantRecord | undefined;
  onClose: () => void;
  onRequestInstall: () => void;
  onCancelInstall: () => void;
  onInstall: () => void;
  onViewManifest: () => void;
  onCloseManifest: () => void;
  pilot: boolean;
  onConnectTenant: () => void;
}) {
  const licenseMissing = hasLicenseShortfall(agent.requiresEntraTier, tenantTier);
  return (
    <>
      <Drawer
        open
        title={agent.name}
        onClose={onClose}
        actions={
          <>
            {pilot ? (
              <Button size="sm" variant="secondary" title={PILOT_COPY.featureInProduction("Agent install")} onClick={onConnectTenant}>
                Connect your tenant to install
              </Button>
            ) : !installConfirm ? (
              <Button
                size="sm"
                variant="primary"
                disabled={agent.compatibility?.supported === false}
                onClick={onRequestInstall}
              >
                Install
              </Button>
            ) : null}
            <Menu
              ariaLabel={`${agent.name} actions`}
              trigger={
                <IconButton
                  label={`${agent.name} actions`}
                  icon={<IconChevronDown size={13} />}
                  size="sm"
                />
              }
              items={[
                { id: "manifest", label: "View manifest", onSelect: onViewManifest },
              ]}
            />
          </>
        }
      >
        <div className="space-y-6 p-5">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-soft)] pb-4">
            <Badge tone={agent.mode === "write" ? "warning" : "neutral"}>
              {agent.mode === "write" ? "Write" : "Read"}
            </Badge>
            <span className="text-sm text-[var(--color-text-soft)]">v{agent.version}</span>
            <span className="text-sm text-[var(--color-text-muted)]">{agent.author.name}</span>
            {agent.author.verified ? (
              <IconBadgeCheck aria-label="Verified publisher" size={13} className="text-[var(--color-info)]" />
            ) : null}
            {agent.compatibility?.supported === false ? (
              <Badge tone="warning">Incompatible</Badge>
            ) : null}
            {licenseMissing ? <Badge tone="warning">License required</Badge> : null}
            <ServiceChips services={agentServiceIds(agent)} />
          </div>

          {installConfirm ? (
            <div className="space-y-3 rounded-lg bg-[var(--color-warning-soft)] p-4 ring-1 ring-[var(--color-warning)]/30">
              <div>
                <div className="font-medium text-[var(--color-text)]">Review permissions</div>
                <p className="mt-1 text-sm text-[var(--color-text-soft)]">
                  OpenAdminOS will pin this manifest locally. Write agents still pause for review before tenant changes.
                </p>
              </div>
              <div className="space-y-1.5">
                {agent.scopes.map((scope) => (
                  <div key={scope} className="break-all font-mono text-xs text-[var(--color-text)]">
                    {scope}
                  </div>
                ))}
              </div>
              {preview ? <DeclaredGraphOperations manifest={preview.manifest} /> : null}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={installing} onClick={onCancelInstall}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" disabled={installing} onClick={onInstall}>
                  {installing ? "Installing" : "Confirm install"}
                </Button>
              </div>
            </div>
          ) : null}

          <Section title="About">
            <p className="text-base leading-relaxed text-[var(--color-text-soft)]">{agent.description}</p>
            <dl className="mt-3 divide-y divide-[var(--color-border-soft)]">
              <KeyValue label="Category" value={<span className="capitalize">{agent.category}</span>} />
              <KeyValue label="Minimum app" value={agent.minAppVersion ?? "0.1.0"} />
              <KeyValue
                label="License"
                value={agent.requiresEntraTier === "free" ? "No premium tier declared" : `Entra ID ${agent.requiresEntraTier.toUpperCase()}`}
              />
              {typeof agent.installs === "number" ? (
                <KeyValue label="Installs" value={new Intl.NumberFormat().format(agent.installs)} />
              ) : null}
            </dl>
          </Section>

          <Section title="Permissions">
            <div className="space-y-1.5">
              {agent.scopes.length > 0 ? agent.scopes.map((scope) => (
                <div key={scope} className="break-all font-mono text-xs text-[var(--color-text)]">{scope}</div>
              )) : <p className="text-sm text-[var(--color-text-muted)]">No Microsoft Graph scopes declared.</p>}
            </div>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {agentConsentNote(activeTenant, agent)}
            </p>
            {!installConfirm && preview ? (
              <DeclaredGraphOperations manifest={preview.manifest} />
            ) : null}
          </Section>

          {previewLoading ? (
            <div className="space-y-3" role="status" aria-label="Loading agent details">
              <Skeleton className="w-2/3" />
              <Skeleton className="w-full" />
            </div>
          ) : previewError ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {manifestLoadErrorCopy(previewError, "Refresh the hub and try again.")}
            </p>
          ) : preview ? (
            <ManifestSections preview={preview} sections={["settings", "result", "pipeline"]} />
          ) : null}
        </div>
      </Drawer>
      <Modal open={manifestOpen} onClose={onCloseManifest} size="lg">
        <ModalHeader title={`${agent.name} manifest`} onClose={onCloseManifest} />
        <div className="overflow-y-auto p-5">
          {preview ? (
            <ManifestPreview preview={preview} />
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">No manifest is available.</p>
          )}
        </div>
      </Modal>
    </>
  );
}

function UninstallAgentModal({
  open,
  agentName,
  userAuthored,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  agentName: string;
  userAuthored: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Uninstall agent"
        subtitle={agentName}
        badge={<Pill tone="danger">Local deletion</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          This removes the installed agent from this device.
          {userAuthored
            ? " The local user-authored manifest folder is deleted from disk."
            : " Registry agents can be installed again from Agent Hub."}{" "}
          Run history is kept.
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Uninstalling" : "Uninstall"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AgentTeamsDeliveryCard({
  delivery,
  onChange,
  onOpenConnectors,
}: {
  delivery: AgentTeamsDelivery | undefined;
  onChange: (delivery: AgentTeamsDelivery | null) => Promise<void>;
  onOpenConnectors: () => void;
}) {
  const [summary, setSummary] = useState<ConnectorSummary | null>(null);
  const [teams, setTeams] = useState<ConnectorTeamRef[]>([]);
  const [channels, setChannels] = useState<ConnectorChannelRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  const lastSavedKey = useRef(stableDeliveryKey(delivery ?? null));
  const [enabled, setEnabled] = useState(delivery?.enabled === true);
  const [useDefaultTarget, setUseDefaultTarget] = useState(
    delivery?.useDefaultTarget !== false,
  );
  const [teamId, setTeamId] = useState(delivery?.teamId ?? "");
  const [channelId, setChannelId] = useState(delivery?.channelId ?? "");
  const [includeManualRuns, setIncludeManualRuns] = useState(
    delivery?.includeManualRuns ?? true,
  );
  const [includeScheduledRuns, setIncludeScheduledRuns] = useState(
    delivery?.includeScheduledRuns ?? true,
  );
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(
    delivery?.notifyOnSuccess ?? true,
  );
  const [notifyOnFailure, setNotifyOnFailure] = useState(
    delivery?.notifyOnFailure ?? false,
  );
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(
    delivery?.notifyOnChangeOnly ?? false,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setSummary(
          connectors.find((connector) => connector.descriptor.id === "teams") ?? null,
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (useDefaultTarget || !enabled || teams.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectorTeams("teams")
      .then((list) => {
        if (!cancelled) setTeams(list);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, teams.length, useDefaultTarget]);

  useEffect(() => {
    if (useDefaultTarget || !enabled || !teamId) {
      setChannels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectorChannels("teams", teamId)
      .then((list) => {
        if (!cancelled) setChannels(list);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, teamId, useDefaultTarget]);

  const defaultTargetLabel =
    typeof summary?.config.defaultTeamName === "string" &&
    typeof summary?.config.defaultChannelName === "string"
      ? `${summary.config.defaultTeamName} → #${summary.config.defaultChannelName}`
      : "Connector default";
  const hasDefaultTarget =
    typeof summary?.config.defaultTeamId === "string" &&
    typeof summary?.config.defaultChannelId === "string";
  const connected = summary?.status === "connected";
  const selectedTeam = teams.find((team) => team.id === teamId);
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  const desiredDelivery: AgentTeamsDelivery | null | undefined = !enabled
    ? null
    : useDefaultTarget
      ? hasDefaultTarget
        ? {
            enabled: true,
            useDefaultTarget: true,
            includeManualRuns,
            includeScheduledRuns,
            notifyOnSuccess,
            notifyOnFailure,
            notifyOnChangeOnly,
          }
        : undefined
      : teamId && channelId
        ? {
            enabled: true,
            useDefaultTarget: false,
            includeManualRuns,
            includeScheduledRuns,
            notifyOnSuccess,
            notifyOnFailure,
            notifyOnChangeOnly,
            teamId,
            channelId,
            ...(selectedTeam ? { teamName: selectedTeam.displayName } : {}),
            ...(selectedChannel ? { channelName: selectedChannel.displayName } : {}),
          }
        : undefined;
  const desiredDeliveryKey =
    desiredDelivery === undefined ? undefined : stableDeliveryKey(desiredDelivery);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (desiredDeliveryKey === undefined) return;
    if (desiredDeliveryKey === lastSavedKey.current) return;

    let cancelled = false;
    const nextDelivery = parseDeliveryKey<AgentTeamsDelivery>(desiredDeliveryKey);
    setSaving(true);
    setError(null);
    void onChangeRef
      .current(nextDelivery)
      .then(() => {
        if (cancelled) return;
        lastSavedKey.current = desiredDeliveryKey;
        setSavedAt(new Date().toISOString());
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setSaving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desiredDeliveryKey]);

  const deliveryStatus = !enabled
    ? saving
      ? "Disabling delivery…"
      : savedAt
        ? `Delivery disabled · saved ${formatRelative(savedAt)}`
        : "Delivery off."
    : desiredDeliveryKey === undefined
      ? useDefaultTarget
        ? "Choose a default channel or switch to a custom channel."
        : "Choose a team and channel to save delivery."
      : saving
        ? "Saving delivery…"
        : savedAt
          ? `Saved ${formatRelative(savedAt)}`
          : "Delivery saved.";

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Delivery</SectionLabel>
          <Pill tone={enabled ? "success" : "default"}>
            {enabled ? "Teams on" : "Manual only"}
          </Pill>
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
          <IconConnectors
            size={18}
            className={enabled ? "text-[var(--color-success)]" : "text-[var(--color-text-soft)]"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-[var(--color-text)]">
              Microsoft Teams
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Send terminal run reports to a Teams channel. Saved delivery
              rules post without another prompt.
            </div>
          </div>
        </div>

        {!connected && (
          <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            Connect and test Microsoft Teams before enabling delivery.
            <button
              type="button"
              className="ml-1 font-medium underline"
              onClick={onOpenConnectors}
            >
              Open Connectors
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Send to Teams"
            checked={enabled}
            onChange={(checked) => {
              setEnabled(checked);
              if (checked && !hasDefaultTarget) setUseDefaultTarget(false);
            }}
            disabled={!connected}
          />

          {enabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ChoiceButton
                  active={useDefaultTarget}
                  label="Default channel"
                  detail={defaultTargetLabel}
                  onClick={() => setUseDefaultTarget(true)}
                />
                <ChoiceButton
                  active={!useDefaultTarget}
                  label="Custom channel"
                  detail="Per-agent target"
                  onClick={() => setUseDefaultTarget(false)}
                />
              </div>

              {!useDefaultTarget && (
                <div className="grid gap-2">
                  <Select
                    value={teamId}
                    onChange={(event) => {
                      setTeamId(event.target.value);
                      setChannelId("");
                    }}
                    className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                  >
                    <option value="">{loading ? "Loading teams…" : "Select team"}</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.displayName}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={channelId}
                    disabled={!teamId}
                    onChange={(event) => setChannelId(event.target.value)}
                    className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-sm text-[var(--color-text)] disabled:opacity-60"
                  >
                    <option value="">
                      {!teamId
                        ? "Pick a team first"
                        : loading
                          ? "Loading channels…"
                          : "Select channel"}
                    </option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.displayName}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              <div className="grid gap-2">
                <ToggleRow
                  label="Manual runs"
                  checked={includeManualRuns}
                  onChange={setIncludeManualRuns}
                />
                <ToggleRow
                  label="Scheduled runs"
                  checked={includeScheduledRuns}
                  onChange={setIncludeScheduledRuns}
                />
                <ToggleRow
                  label="Completed runs"
                  checked={notifyOnSuccess}
                  onChange={setNotifyOnSuccess}
                />
                <ToggleRow
                  label="Failed runs"
                  checked={notifyOnFailure}
                  onChange={setNotifyOnFailure}
                />
                <ToggleRow
                  label="Only when scheduled findings changed"
                  checked={notifyOnChangeOnly}
                  onChange={setNotifyOnChangeOnly}
                />
              </div>
            </>
          )}
        </div>

        {enabled && useDefaultTarget && !hasDefaultTarget && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            Set a default Teams channel on the Connectors page, or choose a
            custom channel for this agent.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-3">
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-[var(--color-text-muted)]"
          >
            {deliveryStatus}
          </span>
        </div>
      </div>
    </Card>
  );
}

function AgentWhatsAppWebDeliveryCard({
  delivery,
  onChange,
  onOpenConnectors,
}: {
  delivery: AgentWhatsAppWebDelivery | undefined;
  onChange: (delivery: AgentWhatsAppWebDelivery | null) => Promise<void>;
  onOpenConnectors: () => void;
}) {
  const [summary, setSummary] = useState<ConnectorSummary | null>(null);
  const [groups, setGroups] = useState<WhatsAppWebGroupRef[]>([]);
  const [statusState, setStatusState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  const lastSavedKey = useRef(stableDeliveryKey(delivery ?? null));
  const [enabled, setEnabled] = useState(delivery?.enabled === true);
  const [useDefaultRecipient, setUseDefaultRecipient] = useState(
    delivery?.useDefaultRecipient !== false,
  );
  const [recipientType, setRecipientType] = useState<WhatsAppWebRecipientType>(
    inferWhatsAppRecipientType(delivery?.recipientType, delivery?.recipient),
  );
  const [recipient, setRecipient] = useState(delivery?.recipient ?? "");
  const [recipientLabel, setRecipientLabel] = useState(
    delivery?.recipientLabel ?? "WhatsApp recipient",
  );
  const [dropActive, setDropActive] = useState(false);
  const [includeManualRuns, setIncludeManualRuns] = useState(
    delivery?.includeManualRuns ?? true,
  );
  const [includeScheduledRuns, setIncludeScheduledRuns] = useState(
    delivery?.includeScheduledRuns ?? true,
  );
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(
    delivery?.notifyOnSuccess ?? true,
  );
  const [notifyOnFailure, setNotifyOnFailure] = useState(
    delivery?.notifyOnFailure ?? false,
  );
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(
    delivery?.notifyOnChangeOnly ?? false,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.openAdminOS?.listConnectors(),
      window.openAdminOS?.getWhatsAppWebStatus(),
    ])
      .then(([connectors, status]) => {
        if (cancelled) return;
        setSummary(
          connectors?.find((connector) => connector.descriptor.id === "whatsapp-web") ??
            null,
        );
        setStatusState(status?.state ?? null);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      useDefaultRecipient ||
      !enabled ||
      recipientType !== "group" ||
      statusState !== "connected" ||
      groups.length > 0
    ) {
      return;
    }
    let cancelled = false;
    setLoadingGroups(true);
    setError(null);
    window.openAdminOS
      ?.listWhatsAppWebGroups()
      .then((list) => {
        if (!cancelled) setGroups(list);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingGroups(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    groups.length,
    recipientType,
    statusState,
    useDefaultRecipient,
  ]);

  const loadGroups = async () => {
    setLoadingGroups(true);
    setError(null);
    try {
      setGroups((await window.openAdminOS?.listWhatsAppWebGroups()) ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingGroups(false);
    }
  };

  const defaultTarget = summary
    ? readWhatsAppTargetFromConnectorConfig(summary.config)
    : null;
  const connected = statusState === "connected";
  const hasDefaultRecipient = Boolean(defaultTarget?.recipient);
  const customTarget = buildAgentWhatsAppTarget(
    recipientType,
    recipient,
    recipientLabel,
    groups,
  );
  const desiredDelivery: AgentWhatsAppWebDelivery | null | undefined = !enabled
    ? null
    : useDefaultRecipient
      ? hasDefaultRecipient
        ? {
            enabled: true,
            useDefaultRecipient: true,
            includeManualRuns,
            includeScheduledRuns,
            notifyOnSuccess,
            notifyOnFailure,
            notifyOnChangeOnly,
          }
        : undefined
      : customTarget.recipient.trim().length > 0
        ? {
            enabled: true,
            useDefaultRecipient: false,
            includeManualRuns,
            includeScheduledRuns,
            notifyOnSuccess,
            notifyOnFailure,
            notifyOnChangeOnly,
            recipientType: customTarget.type,
            recipient: customTarget.recipient,
            recipientLabel: customTarget.label,
          }
        : undefined;
  const desiredDeliveryKey =
    desiredDelivery === undefined ? undefined : stableDeliveryKey(desiredDelivery);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (desiredDeliveryKey === undefined) return;
    if (desiredDeliveryKey === lastSavedKey.current) return;

    let cancelled = false;
    const nextDelivery =
      parseDeliveryKey<AgentWhatsAppWebDelivery>(desiredDeliveryKey);
    setSaving(true);
    setError(null);
    void onChangeRef
      .current(nextDelivery)
      .then(() => {
        if (cancelled) return;
        lastSavedKey.current = desiredDeliveryKey;
        setSavedAt(new Date().toISOString());
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setSaving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desiredDeliveryKey]);

  const deliveryStatus = !enabled
    ? saving
      ? "Disabling delivery…"
      : savedAt
        ? `Delivery disabled · saved ${formatRelative(savedAt)}`
        : connected
          ? "Delivery off."
          : "Not linked."
    : desiredDeliveryKey === undefined
      ? useDefaultRecipient
        ? "Choose a default target or switch to a custom target."
        : "Choose a WhatsApp target to save delivery."
      : saving
        ? "Saving delivery…"
        : savedAt
          ? `Saved ${formatRelative(savedAt)}`
          : "Delivery saved.";

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Delivery</SectionLabel>
          <Pill tone={enabled ? "success" : "default"}>
            {enabled ? "WhatsApp on" : "Manual only"}
          </Pill>
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
          <IconConnectors
            size={18}
            className={enabled ? "text-[var(--color-success)]" : "text-[var(--color-text-soft)]"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-[var(--color-text)]">
              WhatsApp Web
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Send terminal run reports through the linked local WhatsApp
              session. Saved delivery rules post without another prompt.
            </div>
          </div>
        </div>

        {!connected && (
          <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            Link WhatsApp Web before enabling delivery.
            <button
              type="button"
              className="ml-1 font-medium underline"
              onClick={onOpenConnectors}
            >
              Open Connectors
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Send to WhatsApp"
            checked={enabled}
            onChange={setEnabled}
            disabled={!connected}
          />

          {enabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ChoiceButton
                  active={useDefaultRecipient}
                  label="Default target"
                  detail={defaultTarget?.label ?? "Connector default"}
                  onClick={() => setUseDefaultRecipient(true)}
                />
                <ChoiceButton
                  active={!useDefaultRecipient}
                  label="Custom target"
                  detail="Per-agent target"
                  onClick={() => setUseDefaultRecipient(false)}
                />
              </div>

              {!useDefaultRecipient && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <ChoiceButton
                      active={recipientType === "self"}
                      label="Me"
                      detail="Linked account"
                      onClick={() => {
                        setRecipientType("self");
                        setRecipient("self");
                        setRecipientLabel("My WhatsApp");
                      }}
                    />
                    <ChoiceButton
                      active={recipientType === "group"}
                      label="Group"
                      detail="Pick locally"
                      onClick={() => {
                        const currentRecipient = recipient.trim();
                        setRecipientType("group");
                        setRecipient(
                          currentRecipient.endsWith("@g.us") ? currentRecipient : "",
                        );
                        setRecipientLabel(
                          currentRecipient.endsWith("@g.us")
                            ? recipientLabel || "WhatsApp group"
                            : "WhatsApp group",
                        );
                      }}
                    />
                    <ChoiceButton
                      active={recipientType === "manual"}
                      label="Number/JID"
                      detail="Paste or drop"
                      onClick={() => {
                        const currentRecipient = recipient.trim();
                        setRecipientType("manual");
                        setRecipient(
                          recipientType === "manual" &&
                            currentRecipient !== "self" &&
                            !currentRecipient.endsWith("@g.us")
                            ? currentRecipient
                            : "",
                        );
                        setRecipientLabel("WhatsApp recipient");
                      }}
                    />
                  </div>

                  {recipientType === "self" && (
                    <div className="rounded-md bg-[var(--color-success-soft)]/15 px-3 py-2 text-sm leading-relaxed text-[var(--color-text-muted)] ring-1 ring-[var(--color-success-soft)]">
                      Sends to the linked WhatsApp account. The account number is
                      resolved locally when the run report is sent.
                    </div>
                  )}

                  {recipientType === "group" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-[var(--color-text-soft)]">
                          WhatsApp group
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void loadGroups();
                          }}
                          disabled={!connected || loadingGroups}
                          className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-soft)] hover:bg-[var(--color-bg-raised)] disabled:opacity-50"
                        >
                          {loadingGroups ? "Loading…" : "Refresh groups"}
                        </button>
                      </div>
                      <Select
                        value={recipient}
                        disabled={!connected || loadingGroups}
                        onChange={(event) => {
                          const group = groups.find(
                            (entry) => entry.id === event.target.value,
                          );
                          setRecipient(event.target.value);
                          setRecipientLabel(group?.subject ?? "WhatsApp group");
                        }}
                        className="w-full rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-sm text-[var(--color-text)] disabled:opacity-60"
                      >
                        <option value="">
                          {!connected
                            ? "Link WhatsApp Web first"
                            : loadingGroups
                              ? "Loading groups…"
                              : "Select group"}
                        </option>
                        {recipient &&
                          !groups.some((group) => group.id === recipient) && (
                            <option value={recipient}>
                              {recipientLabel || "Saved group"}
                            </option>
                          )}
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.subject}
                            {group.participantCount !== undefined
                              ? ` (${group.participantCount})`
                              : ""}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}

                  {recipientType === "manual" && (
                    <div
                      className={`rounded-md border border-dashed px-3 py-2 transition-colors ${
                        dropActive
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/25"
                          : "border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/40"
                      }`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDropActive(true);
                      }}
                      onDragLeave={() => setDropActive(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDropActive(false);
                        const parsed = extractWhatsAppRecipientInput(
                          event.dataTransfer.getData("text"),
                        );
                        if (!parsed) return;
                        setRecipient(parsed);
                        setRecipientLabel("WhatsApp recipient");
                      }}
                    >
                      <label className="flex flex-col gap-1 text-sm text-[var(--color-text-soft)]">
                        <span>Number, wa.me link, or raw JID</span>
                        <input
                          value={recipient}
                          onChange={(event) => {
                            setRecipient(event.target.value);
                            setRecipientLabel("WhatsApp recipient");
                          }}
                          placeholder="+15551234567"
                          inputMode="tel"
                          className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-2">
                <ToggleRow
                  label="Manual runs"
                  checked={includeManualRuns}
                  onChange={setIncludeManualRuns}
                />
                <ToggleRow
                  label="Scheduled runs"
                  checked={includeScheduledRuns}
                  onChange={setIncludeScheduledRuns}
                />
                <ToggleRow
                  label="Completed runs"
                  checked={notifyOnSuccess}
                  onChange={setNotifyOnSuccess}
                />
                <ToggleRow
                  label="Failed runs"
                  checked={notifyOnFailure}
                  onChange={setNotifyOnFailure}
                />
                <ToggleRow
                  label="Only when scheduled findings changed"
                  checked={notifyOnChangeOnly}
                  onChange={setNotifyOnChangeOnly}
                />
              </div>
            </>
          )}
        </div>

        {enabled && useDefaultRecipient && !hasDefaultRecipient && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            Set a default WhatsApp target on the Connectors page, or choose a
            custom target for this agent.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-[var(--color-text-muted)]"
          >
            {loading ? "Checking WhatsApp Web…" : deliveryStatus}
          </span>
        </div>
      </div>
    </Card>
  );
}

type AgentDefaultNotificationDelivery =
  | AgentOutlookDelivery
  | AgentSlackDelivery
  | AgentDiscordDelivery
  | AgentSignalDelivery;

type AgentDefaultNotificationFlag =
  | "useDefaultRecipients"
  | "useDefaultChannel"
  | "useDefaultWebhook"
  | "useDefaultRecipient";

function AgentDefaultConnectorDeliveryCard({
  connectorId,
  connectorName,
  delivery,
  defaultFlag,
  onChange,
  onOpenConnectors,
}: {
  connectorId: "outlook" | "slack" | "discord" | "signal";
  connectorName: string;
  delivery: AgentDefaultNotificationDelivery | undefined;
  defaultFlag: AgentDefaultNotificationFlag;
  onChange: (delivery: AgentDefaultNotificationDelivery | null) => Promise<void>;
  onOpenConnectors: () => void;
}) {
  const [summary, setSummary] = useState<ConnectorSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  const lastSavedKey = useRef(stableDeliveryKey(delivery ?? null));
  const [enabled, setEnabled] = useState(delivery?.enabled === true);
  const [includeManualRuns, setIncludeManualRuns] = useState(
    delivery?.includeManualRuns ?? true,
  );
  const [includeScheduledRuns, setIncludeScheduledRuns] = useState(
    delivery?.includeScheduledRuns ?? true,
  );
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(
    delivery?.notifyOnSuccess ?? true,
  );
  const [notifyOnFailure, setNotifyOnFailure] = useState(
    delivery?.notifyOnFailure ?? false,
  );
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(
    delivery?.notifyOnChangeOnly ?? false,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setSummary(
          connectors.find((connector) => connector.descriptor.id === connectorId) ??
            null,
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const defaultStatus = connectorDefaultStatus(connectorId, summary);
  const ready = defaultStatus.ready;
  const desiredDelivery: AgentDefaultNotificationDelivery | null | undefined =
    !enabled
      ? null
      : ready
        ? ({
            enabled: true,
            [defaultFlag]: true,
            includeManualRuns,
            includeScheduledRuns,
            notifyOnSuccess,
            notifyOnFailure,
            notifyOnChangeOnly,
          } as AgentDefaultNotificationDelivery)
        : undefined;
  const desiredDeliveryKey =
    desiredDelivery === undefined ? undefined : stableDeliveryKey(desiredDelivery);

  useEffect(() => {
    if (desiredDeliveryKey === undefined) return;
    if (desiredDeliveryKey === lastSavedKey.current) return;

    let cancelled = false;
    const nextDelivery =
      parseDeliveryKey<AgentDefaultNotificationDelivery>(desiredDeliveryKey);
    setSaving(true);
    setError(null);
    void onChangeRef
      .current(nextDelivery)
      .then(() => {
        if (cancelled) return;
        lastSavedKey.current = desiredDeliveryKey;
        setSavedAt(new Date().toISOString());
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setSaving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desiredDeliveryKey]);

  const deliveryStatus = !enabled
    ? saving
      ? "Disabling delivery…"
      : savedAt
        ? `Delivery disabled · saved ${formatRelative(savedAt)}`
        : "Delivery off."
    : desiredDeliveryKey === undefined
      ? defaultStatus.reason
      : saving
        ? "Saving delivery…"
        : savedAt
          ? `Saved ${formatRelative(savedAt)}`
          : "Delivery saved.";

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Delivery</SectionLabel>
          <Pill tone={enabled ? "success" : "default"}>
            {enabled ? `${connectorName} on` : "Manual only"}
          </Pill>
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
          <IconConnectors
            size={18}
            className={enabled ? "text-[var(--color-success)]" : "text-[var(--color-text-soft)]"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-[var(--color-text)]">
              {connectorName}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Send terminal run reports through the connector default. Saved
              delivery rules post without another prompt.
            </div>
          </div>
        </div>

        {!ready && (
          <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            {defaultStatus.reason}
            <button
              type="button"
              className="ml-1 font-medium underline"
              onClick={onOpenConnectors}
            >
              Open Connectors
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <ToggleRow
            label={`Send to ${connectorName}`}
            checked={enabled}
            onChange={setEnabled}
            disabled={!ready && !enabled}
          />

          {enabled && (
            <>
              <div className="rounded-md bg-[var(--color-bg-raised)] px-3 py-2 text-sm text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
                Default target: {defaultStatus.label}
              </div>
              <div className="grid gap-2">
                <ToggleRow
                  label="Manual runs"
                  checked={includeManualRuns}
                  onChange={setIncludeManualRuns}
                />
                <ToggleRow
                  label="Scheduled runs"
                  checked={includeScheduledRuns}
                  onChange={setIncludeScheduledRuns}
                />
                <ToggleRow
                  label="Completed runs"
                  checked={notifyOnSuccess}
                  onChange={setNotifyOnSuccess}
                />
                <ToggleRow
                  label="Failed runs"
                  checked={notifyOnFailure}
                  onChange={setNotifyOnFailure}
                />
                <ToggleRow
                  label="Only when scheduled findings changed"
                  checked={notifyOnChangeOnly}
                  onChange={setNotifyOnChangeOnly}
                />
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-[var(--color-text-muted)]"
          >
            {loading ? `Checking ${connectorName}…` : deliveryStatus}
          </span>
        </div>
      </div>
    </Card>
  );
}

function connectorDefaultStatus(
  connectorId: "outlook" | "slack" | "discord" | "signal",
  summary: ConnectorSummary | null,
): { ready: boolean; label: string; reason: string } {
  if (!summary) {
    return {
      ready: false,
      label: "Connector not found",
      reason: "Connector setup is unavailable.",
    };
  }
  if (summary.status !== "connected") {
    return {
      ready: false,
      label: "Connector not connected",
      reason: `Configure and test ${summary.descriptor.name} before enabling delivery.`,
    };
  }
  switch (connectorId) {
    case "outlook": {
      const recipients = readConnectorConfigString(summary.config, "defaultRecipients");
      const count = recipients ? recipients.split(/[,\n;]/g).filter(Boolean).length : 0;
      return count > 0
        ? {
            ready: true,
            label: count === 1 ? "1 Outlook recipient" : `${count} Outlook recipients`,
            reason: "Outlook delivery ready.",
          }
        : {
            ready: false,
            label: "No default recipients",
            reason: "Set default Outlook recipients on the Connectors page.",
          };
    }
    case "slack": {
      const channel = readConnectorConfigString(summary.config, "defaultChannel");
      const label =
        readConnectorConfigString(summary.config, "defaultChannelLabel") ??
        channel;
      return channel
        ? { ready: true, label: label ?? "Slack channel", reason: "Slack delivery ready." }
        : {
            ready: false,
            label: "No default channel",
            reason: "Set a default Slack channel on the Connectors page.",
          };
    }
    case "discord": {
      const label =
        readConnectorConfigString(summary.config, "defaultTargetLabel") ??
        "Discord webhook";
      return { ready: true, label, reason: "Discord delivery ready." };
    }
    case "signal": {
      const account = readConnectorConfigString(summary.config, "account");
      const recipient = readConnectorConfigString(summary.config, "defaultRecipient");
      const label =
        readConnectorConfigString(summary.config, "defaultRecipientLabel") ??
        "Signal recipient";
      return account && recipient
        ? { ready: true, label, reason: "Signal delivery ready." }
        : {
            ready: false,
            label: "No default Signal recipient",
            reason: "Set the Signal account and default recipient on the Connectors page.",
          };
    }
  }
}

function readConnectorConfigString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readWhatsAppTargetFromConnectorConfig(
  config: Record<string, unknown>,
): {
  type: WhatsAppWebRecipientType;
  recipient: string;
  label: string;
} {
  const type = inferWhatsAppRecipientType(
    typeof config.defaultRecipientType === "string"
      ? config.defaultRecipientType
      : undefined,
    typeof config.defaultRecipient === "string"
      ? config.defaultRecipient
      : undefined,
  );
  const recipient =
    typeof config.defaultRecipient === "string"
      ? config.defaultRecipient.trim()
      : "";
  const label =
    typeof config.defaultRecipientLabel === "string" &&
    config.defaultRecipientLabel.trim()
      ? config.defaultRecipientLabel.trim()
      : undefined;

  if (type === "self" || recipient === "self" || !recipient) {
    return { type: "self", recipient: "self", label: label ?? "My WhatsApp" };
  }
  if (type === "group") {
    return { type, recipient, label: label ?? "WhatsApp group" };
  }
  return { type, recipient, label: label ?? "WhatsApp recipient" };
}

function buildAgentWhatsAppTarget(
  type: WhatsAppWebRecipientType,
  recipient: string,
  label: string,
  groups: WhatsAppWebGroupRef[],
): {
  type: WhatsAppWebRecipientType;
  recipient: string;
  label: string;
} {
  if (type === "self") {
    return { type, recipient: "self", label: "My WhatsApp" };
  }
  const value = recipient.trim();
  if (type === "group") {
    const group = groups.find((entry) => entry.id === value);
    const fallbackLabel = label.trim() || "WhatsApp group";
    return {
      type,
      recipient: value,
      label: group?.subject ?? fallbackLabel,
    };
  }
  return {
    type,
    recipient: value,
    label: "WhatsApp recipient",
  };
}

function stableDeliveryKey(delivery: unknown): string {
  return JSON.stringify(sortSerializable(delivery ?? null));
}

function parseDeliveryKey<T>(key: string): T | null {
  return JSON.parse(key) as T | null;
}

function sortSerializable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSerializable);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        sortSerializable((value as Record<string, unknown>)[key]),
      ]),
  );
}

function inferWhatsAppRecipientType(
  type: unknown,
  recipient: string | undefined,
): WhatsAppWebRecipientType {
  if (type === "self" || type === "group" || type === "manual") return type;
  if (!recipient || recipient === "self") return "self";
  if (recipient.endsWith("@g.us")) return "group";
  return "manual";
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-soft)]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[var(--color-accent)] disabled:opacity-60"
      />
    </label>
  );
}

function ChoiceButton({
  active,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-left ring-1 transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-[var(--color-accent)]/30"
          : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)]"
      }`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-0.5 truncate text-xs opacity-75">{detail}</div>
    </button>
  );
}

/** Where the report of a run with no organization goes, from the agent's saved delivery rules. */
function noOrganizationReportLine(destinations: { mayGo: string[]; skipped: string[]; noTarget: string[] }): string {
  const list = (names: string[]) =>
    names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const sent = destinations.mayGo.length > 0
    ? `Saved delivery rules can send its report to ${list(destinations.mayGo)}.`
    : "No saved delivery rule sends its report.";
  const skipped = destinations.skipped.length > 0
    ? ` ${list(destinations.skipped)} ${destinations.skipped.length === 1 ? "is" : "are"} skipped: ${destinations.skipped.length === 1 ? "it posts" : "they post"} with an organization's Microsoft sign-in.`
    : "";
  const notSetUp = destinations.noTarget.length > 0
    ? ` ${list(destinations.noTarget)} ${destinations.noTarget.length === 1 ? "has" : "have"} no destination set, so nothing is sent there.`
    : "";
  return `${sent}${skipped}${notSetUp}`;
}

/** What Run again keeps from the original run when it opens the preflight. */
export interface RerunChoice {
  providerId?: ProviderId;
  model?: string;
}

function RunPreflightModal({
  dryRun,
  open,
  agent,
  activeTenant,
  providerName,
  providerId,
  providerIsLocal,
  requestedScopes,
  pilot = false,
  organizationName,
  organizationInactive = false,
  hasOrganizations = false,
  model,
  deliverySaving,
  onConnect,
  onOpenConnections,
  providerReady = true,
  providerStatusDetail,
  startError,
  onOpenProviderSettings,
  onClose,
  onConfirm,
}: {
  /** The run's provider can start a run now. */
  providerReady?: boolean;
  providerStatusDetail?: string | undefined;
  /** Why the last Start was refused; shown inside the review with a recovery action. */
  startError?: string | null;
  onOpenProviderSettings?: () => void;
  pilot?: boolean;
  organizationName?: string | undefined;
  /** The run is pinned to an organization that is not the active one. */
  organizationInactive?: boolean;
  hasOrganizations?: boolean;
  onConnect?: () => void;
  onOpenConnections?: () => void;
  dryRun: boolean;
  open: boolean;
  agent: { name: string; mode: "read" | "write"; scopes: string[]; services?: ServiceId[]; schedule?: unknown; connectors?: readonly unknown[]; graphOperations?: readonly unknown[]; delivery?: AgentSummary["delivery"] };
  activeTenant: TenantRecord | undefined;
  providerName: string;
  providerId: ProviderId;
  providerIsLocal: boolean;
  requestedScopes: RequestedScope[];
  model: string | undefined;
  deliverySaving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // The pilot tenant has every service and never asks Microsoft for consent.
  // A service with nothing granted blocks the run; a missing part of a
  // connected service is consented when the run starts.
  const missingServices = activeTenant && !pilot
    ? missingServicesForAgent(activeTenant, agentServiceIds(agent))
    : [];
  const missingParts = activeTenant && !pilot
    ? missingPartsForScopes(agent.scopes, availableScopeSet(activeTenant)).filter(
        (part) => !missingServices.some((service) => service.id === part.service),
      )
    : [];
  // Scopes the services cannot account for block the run, as in preflight.
  const scopeBlockCopy = unmappedScopesCopy(agent.scopes) ?? uncoveredScopesCopy(agent);
  // Report destinations depend on which connectors are set up.
  // null while loading, "failed" when the list could not be read: a failed
  // load is never treated as "nothing is set up".
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null | "failed">(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnectors(null);
    void Promise.resolve(window.openAdminOS?.listConnectors?.() ?? [])
      .then((list) => {
        if (!cancelled) setConnectors(list);
      })
      .catch(() => {
        if (!cancelled) setConnectors("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  // Only an agent that calls no service API runs without an organization.
  const serviceFree = agentCallsNoServiceApi(agent);
  const neededTitles = agentServiceIds(agent).map((id) => serviceById(id).title);
  const canStart =
    (Boolean(activeTenant) || serviceFree) &&
    providerReady &&
    !organizationInactive &&
    !deliverySaving &&
    missingServices.length === 0 &&
    !scopeBlockCopy;
  const firstNeeded = agentServiceIds(agent)[0];
  const neededText = neededTitles.length > 0 ? formatServiceList(neededTitles) : "Microsoft 365";
  // One blocker at a time, the first that stops this run. Its fix is the
  // only filled button in the review.
  const blocker: PreflightBlocker | null = startError
    ? {
        tone: "danger",
        title: "The run did not start.",
        body: startError,
        primary: { label: "Try again", onClick: onConfirm },
        ...(onOpenProviderSettings ? { secondary: { label: "Open provider settings", onClick: onOpenProviderSettings } } : {}),
        hint: "Fix the reason above, then try again.",
      }
    : !activeTenant && !serviceFree
      ? {
          tone: "neutral",
          ...(firstNeeded ? { serviceId: firstNeeded } : {}),
          title: `Needs ${neededText} in an active organization`,
          body: hasOrganizations
            ? `No organization is active, so this agent has nothing to read. Connect ${neededTitles[0] ?? "Microsoft 365"}, or switch to an organization that has it.`
            : `No organization is active, so this agent has nothing to read. Connect ${neededTitles[0] ?? "Microsoft 365"} to add an organization.`,
          ...(onConnect ? { primary: { label: `Connect ${neededTitles[0] ?? "Microsoft 365"}`, onClick: onConnect } } : {}),
          ...(hasOrganizations && onOpenConnections ? { secondary: { label: "Choose organization", onClick: onOpenConnections } } : {}),
          hint: `Connect ${neededTitles[0] ?? "Microsoft 365"} to start this run.`,
        }
      : activeTenant && organizationInactive
        ? {
            tone: "neutral",
            title: `Set up for ${organizationName ?? activeTenant.displayName}`,
            body: `This run is set up for ${organizationName ?? activeTenant.displayName}, which is not the active organization. Switch to it in the organization menu to start it there.`,
            ...(onOpenConnections ? { primary: { label: "Choose an organization", onClick: onOpenConnections } } : {}),
            hint: `Switch to ${organizationName ?? activeTenant.displayName} to start this run.`,
          }
        : !providerReady
          ? {
              tone: "neutral",
              title: `${providerName} is not ready to run this agent.`,
              body: `${providerStatusDetail ? `${providerStatusDetail} ` : ""}Choose or start a model in provider settings, then start the run.`,
              ...(onOpenProviderSettings ? { primary: { label: "Open provider settings", onClick: onOpenProviderSettings } } : {}),
              hint: "Start a model to start this run.",
            }
          : scopeBlockCopy
            ? { tone: "danger", title: "This agent cannot start as declared.", body: scopeBlockCopy, hint: "Fix the agent's declared permissions to start it." }
            : null;
  const missingServicesBlock = !blocker && activeTenant && missingServices.length > 0;
  const hint = blocker?.hint ?? (missingServicesBlock ? `Connect ${formatServiceList(missingServices.map((service) => service.title))} to start this run.` : deliverySaving ? "Saving connector delivery changes before the run starts." : undefined);
  const location = providerDataLocation({ id: providerId, name: providerName });
  const changes = dryRun
    ? "None. This run only prepares a plan. Graph writes, connector changes and automatic result delivery are blocked."
    : agent.mode === "write"
      ? "Pauses for a diff and typed confirmation before anything is applied."
      : "None. This agent cannot change tenant state.";
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title={dryRun ? "Review dry run" : "Review run"}
        subtitle={agent.name}
        onClose={onClose}
      />
      <div className="space-y-4 px-6 pb-6 pt-4">
        {blocker ? <PreflightBlockerBlock blocker={blocker} /> : null}
        {missingServicesBlock ? (
          <ServiceNotConnectedNotice tenant={activeTenant} serviceIds={missingServices.map((service) => service.id)} primary />
        ) : null}
        <dl className="preflight-facts" aria-label="What this run uses">
          <PreflightFact label="Organization">
            {activeTenant ? organizationName ?? activeTenant.displayName : serviceFree ? "None needed" : "None active"}
          </PreflightFact>
          <PreflightFact label="Reads">
            {serviceFree
              ? "Nothing. It reads no service data."
              : `${neededTitles.length > 0 ? formatServiceList(neededTitles) : "Microsoft 365 sign-in"}, ${agent.mode === "write" ? "read and write" : "read-only"}`}
            {pilot ? (
              <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
                Pilot mode runs this agent on the fictional sample tenant with prepared text instead of a model. Changes only touch the in-memory sample data.
              </span>
            ) : null}
          </PreflightFact>
          <PreflightFact label="Model">
            {model ?? "Provider default"}
            {pilot ? null : providerIsLocal ? (
              <span className="mt-0.5 block text-xs text-[var(--color-success)]">{`${providerName}. Prompts stay on this device.`}</span>
            ) : (
              <span className="mt-0.5 block text-xs text-[var(--color-warning)]">
                {activeTenant
                  ? `Prompts, tenant data and agent context go to ${location}, through ${providerName}.`
                  : `Prompts and agent context go to ${location}, through ${providerName}. No organization is active, so no tenant data is included.`}
              </span>
            )}
          </PreflightFact>
          {agent.scopes.length > 0 ? (
            <PreflightFact label="Permissions">
              <span className="block space-y-0.5 font-mono text-sm">
                {agent.scopes.map((scope) => (
                  <span key={scope} className="block break-all">{scopeLabel(scope, requestedScopes)}</span>
                ))}
              </span>
              {missingParts.length > 0 && activeTenant ? (
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  {`${missingParts.map(partLabel).join(", ")} was not granted for ${activeTenant.displayName}. Starting the run asks Microsoft for consent first.`}
                </span>
              ) : null}
            </PreflightFact>
          ) : null}
          {!activeTenant && serviceFree ? (
            <PreflightFact label="Report">
              {connectors === "failed"
                ? "Where its report goes could not be checked: saved delivery rules may still send it. Review them in Connections, under Results go to."
                : connectors
                  ? noOrganizationReportLine(manualRunReportDestinations(agent, false, connectors))
                  : "Checking where its report goes."}
            </PreflightFact>
          ) : null}
          <PreflightFact label="Changes">{changes}</PreflightFact>
        </dl>
        <div className="flex items-center justify-end gap-2 pt-1">
          {hint && !canStart ? <p className="mr-auto text-sm text-[var(--color-text-muted)]">{hint}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={canStart ? "primary" : "secondary"} disabled={!canStart} onClick={onConfirm}>
            {deliverySaving ? "Saving delivery…" : dryRun ? "Start dry run" : "Start run"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface PreflightBlocker {
  tone: "neutral" | "danger";
  serviceId?: ServiceId;
  title: string;
  body: string;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  hint: string;
}

/** The one thing that stops this run, with its fix as the only filled button. */
function PreflightBlockerBlock({ blocker }: { blocker: PreflightBlocker }) {
  return (
    <div
      role="alert"
      data-tone={blocker.tone}
      className={`flex gap-3 rounded-lg px-4 py-3.5 ${
        blocker.tone === "danger"
          ? "bg-[var(--color-danger-soft)] ring-1 ring-inset ring-[var(--color-danger)]/25"
          : "bg-[var(--color-bg-raised)] ring-1 ring-inset ring-[var(--color-border-soft)]"
      }`}
    >
      {blocker.serviceId ? <ServiceMark serviceId={blocker.serviceId} size="lg" off /> : null}
      <div className="min-w-0 flex-1">
        <div className={`text-md font-medium ${blocker.tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"}`}>{blocker.title}</div>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--color-text-soft)]">{blocker.body}</p>
        {blocker.primary || blocker.secondary ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {blocker.primary ? <Button size="sm" variant="primary" onClick={blocker.primary.onClick}>{blocker.primary.label}</Button> : null}
            {blocker.secondary ? <Button size="sm" variant="secondary" onClick={blocker.secondary.onClick}>{blocker.secondary.label}</Button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function scopeLabel(scope: string, requestedScopes: RequestedScope[]): string {
  const requested = requestedScopes.find((entry) => entry.name === scope);
  if (requested) return `${scope} · ${requested.mode}`;
  const known = GRAPH_SCOPE_LABELS[scope];
  return known ? `${scope} · ${known}` : scope;
}

const GRAPH_SCOPE_LABELS: Record<string, string> = {
  "Application.Read.All": "Read applications",
  "AuditLog.Read.All": "Read audit logs",
  "Device.Read.All": "Read devices",
  "DeviceManagementManagedDevices.Read.All": "Read Intune devices",
  "DeviceManagementManagedDevices.PrivilegedOperations.All": "Privileged Intune device actions",
  "Directory.Read.All": "Read directory",
  "Group.Read.All": "Read groups",
  "IdentityRiskyUser.Read.All": "Read risky users",
  "Organization.Read.All": "Read organization",
  "Policy.Read.All": "Read policies",
  "SecurityEvents.Read.All": "Read security events",
  "User.Read.All": "Read users",
  "User.ReadWrite.All": "Read and write users",
};

/** One fact of the run review: a term and its value on a hairline row. */
function PreflightFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="preflight-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ModelCardBody({
  agent,
  providers,
  activeProviderId,
  activeModelByProviderId,
}: {
  agent: { preferredModel?: string };
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
}) {
  const provider = providers.find((p) => p.id === activeProviderId);
  const installed = provider?.models ?? [];
  const preferred = agent.preferredModel;
  const resolvedModel = resolveRunModel({
    provider,
    activeModelByProviderId,
    preferredModel: preferred,
  });
  const resolved = resolvedModel.model;
  const source = modelSourceLabel(
    resolvedModel.source,
    provider?.name ?? activeProviderId,
  );

  const preferredButMissing =
    preferred && !installed.includes(preferred) && installed.length > 0;

  return (
    <>
      <div className="mt-3">
        <div className="font-mono text-base font-medium text-[var(--color-text)]">
          {resolved ?? "-"}
        </div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          {source}
        </div>
      </div>
      {preferredButMissing && (
        <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 ring-1 ring-[var(--color-warning)]/30">
          <div className="text-xs leading-relaxed text-[var(--color-text-soft)]">
            <span className="font-medium text-[var(--color-text)]">
              {preferred}
            </span>{" "}
            is the agent's preferred model but isn't installed for{" "}
            {provider?.name ?? activeProviderId}. Pull it with{" "}
            <span className="font-mono">{`ollama pull ${preferred}`}</span> to
            match the author's intent.
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill tone={provider?.isLocal ? "success" : "warning"}>
          {provider?.isLocal ? "Local" : "Hosted"}
        </Pill>
      </div>
    </>
  );
}

function modelSourceLabel(
  source: ReturnType<typeof resolveRunModel>["source"],
  providerName: string,
): string {
  if (source === "agent-preferred") return "Agent prefers this model (manifest)";
  if (source === "user-default") return `Your default for ${providerName}`;
  if (source === "provider-default") return `Provider default · ${providerName}`;
  if (source === "explicit") return "Selected for this run";
  return "No model installed for the active provider";
}

function FallbackScopesCard({ scopes, consentNote }: { scopes: string[]; consentNote: string }) {
  return (
    <Section title="Permissions">
      {scopes.length > 0 ? (
        <div className="divide-y divide-[var(--color-border-soft)]">
          {scopes.map((scope) => (
            <div key={scope} className="break-all py-2 font-mono text-sm text-[var(--color-text)]">
              {scope}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">No Microsoft Graph scopes declared.</p>
      )}
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{consentNote}</p>
    </Section>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-xs font-medium text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(run: RunRecord) {
  if (!run.startedAt || !run.finishedAt) return "-";
  const durationMs =
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (Number.isNaN(durationMs) || durationMs < 0) return "-";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function updateRequiresNewerApp(agent: {
  compatibility?: { appVersion: string };
  updateAvailable?: { minAppVersion?: string };
}) {
  const min = agent.updateAvailable?.minAppVersion;
  const current = agent.compatibility?.appVersion;
  if (!min || !current) return false;
  return compareSemver(current, min) < 0;
}

function hasLicenseShortfall(
  required: "free" | "p1" | "p2",
  actual: "free" | "p1" | "p2" | "unknown" | undefined,
) {
  if (!actual || actual === "unknown") return false;
  const rank = { free: 0, p1: 1, p2: 2 } as const;
  return rank[actual] < rank[required];
}

function compareSemver(left: string, right: string): number {
  const l = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const r = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (l[i] ?? 0) - (r[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Run delivery is six connector cards, and on an install with no
 * connectors set up each one renders its own "connect this first"
 * warning. That wall of near-identical warnings dominates the sidebar
 * and tells the admin nothing they can act on six times over. Collapse
 * it to a single entry point until this agent actually has delivery
 * configured.
 */
function DeliveryDisclosure({
  configured,
  children,
}: {
  configured: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(configured);
  if (open) {
    return (
      <Section title="Delivery">
      <div className="flex flex-col gap-4">
        {children}
        {!configured && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="self-start text-xs text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text)]"
          >
            Hide delivery options
          </button>
        )}
      </div>
      </Section>
    );
  }
  return (
    <Section title="Delivery">
        <p className="text-sm leading-relaxed text-[var(--color-text-soft)]">
          Run reports stay in local history. You can also send them to Teams,
          WhatsApp, Outlook, Slack, Discord, or Signal once a connector is set up.
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onClick={() => setOpen(true)}
        >
          Set up run delivery
        </Button>
    </Section>
  );
}
