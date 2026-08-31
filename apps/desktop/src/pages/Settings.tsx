import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Select } from "../components/Select";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { OutputJsonBlock } from "../components/OutputPane";
import { useReportIssue } from "../components/ReportIssueModal";
import {
  IconCheck,
  IconChat,
  IconClock,
  IconClose,
  IconCloud,
  IconExternal,
  IconHardDrive,
  IconHash,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
  IconWarning,
} from "../components/icons";
import {
  DEFAULT_DRIFT_RETENTION_DAYS,
  DEFAULT_RUN_HISTORY_RETENTION_KEEP_DAYS,
  DEFAULT_RUN_HISTORY_RETENTION_KEEP_LAST_RUNS,
  resolveProviderDefaultModel,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  type AuditLogExportFormat,
  type AzureOpenAIProviderConfig,
  type ChatInvestigationMode,
  type ChatInvestigationSettings,
  type CompanionLaunchSettings,
  type DriftHistoryPruneResult,
  type DriftRetentionSettings,
  type GraphCacheStatus,
  type GatewayPublicStatus,
  type LocalDataSummary,
  type ProviderId,
  type ProviderTestResult,
  type ProviderSummary,
  type ReleaseDiagnostics,
  type RetrievalStatus,
  type RunHistoryPruneResult,
  type RunHistoryRetentionSettings,
  type SandboxSettings,
  type SchedulerLaunchSettings,
  type SelfTrainingSettings,
  type SelfTrainingSuggestion,
  type SetAzureOpenAIProviderConfigInput,
  type TenantRecord,
  type TrustState,
  type UsageTelemetryPayload,
} from "../shared/openAdminOS";
import { copyTextToClipboard } from "../shared/clipboard";
import { isProviderImplemented } from "../shared/providers";
import { useAppState } from "../state";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import {
  SETTINGS_ITEMS,
  SETTINGS_SECTIONS,
  searchSettings,
  userFacingErrorReason,
  type SettingsItemId,
  type SettingsSectionId,
} from "../copy";

interface RunHistoryRetentionDraft {
  neverPrune: boolean;
  keepLastRunsEnabled: boolean;
  keepLastRuns: number;
  keepDaysEnabled: boolean;
  keepDays: number;
}

interface DriftRetentionDraft {
  neverPrune: boolean;
  keepDays: number;
}

const OFFICIAL_REGISTRY_SOURCE =
  "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents";

export default function Settings() {
  const navigate = useNavigate();
  const { section: sectionPath } = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();
  const legacySectionParam = searchParams.get("section");
  const sectionParam = sectionPath ?? legacySectionParam;
  const initialSection = SETTINGS_SECTIONS.some((entry) => entry.id === sectionParam)
    ? (sectionParam as SettingsSectionId)
    : "providers";
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const settingsSearchInputRef = useRef<HTMLInputElement | null>(null);
  const settingsResults = useMemo(() => searchSettings(settingsQuery), [settingsQuery]);
  const {
    state,
    setActiveProvider,
    setActiveModel,
    setActiveTenant,
    disconnectTenant,
    setRegistrySource,
    setRegistryInstallCountsEnabled,
    setUsageTelemetryEnabled,
    refresh,
  } = useAppState();
  const { openSetup } = useSetupFlow();

  useEffect(() => {
    if (SETTINGS_SECTIONS.some((entry) => entry.id === sectionParam)) {
      setSection(sectionParam as SettingsSectionId);
      return;
    }
    if (sectionPath !== undefined) {
      setSection("providers");
      navigate("/settings/providers", { replace: true });
    }
  }, [navigate, sectionParam, sectionPath]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [settingsQuery]);

  useEffect(() => {
    const target = searchParams.get("target");
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const row = document.getElementById(`setting-${target}`);
      if (!(row instanceof HTMLElement)) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      row.focus({ preventScroll: true });
      row.dataset.highlighted = "true";
      window.setTimeout(() => delete row.dataset.highlighted, 1800);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchParams, section]);

  const selectSettingsTarget = (target: {
    section: SettingsSectionId;
    id?: string;
  }) => {
    setSection(target.section);
    navigate(
      target.id
        ? `/settings/${target.section}?target=${encodeURIComponent(target.id)}`
        : `/settings/${target.section}`,
    );
  };

  const onSettingsSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchIndex((index) => Math.min(index + 1, settingsResults.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveSearchIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveSearchIndex(Math.max(0, settingsResults.length - 1));
    } else if (event.key === "Enter") {
      const result = settingsResults[activeSearchIndex];
      if (!result) return;
      event.preventDefault();
      selectSettingsTarget({
        section: result.section,
        ...(result.kind === "setting" ? { id: result.id } : {}),
      });
      setSettingsQuery("");
    } else if (event.key === "Escape") {
      setSettingsQuery("");
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Search first. Detailed configuration stays out of the daily Chat surface." />
      <div className="flex h-full min-h-0 flex-1">
        <nav aria-label="Settings sections" className="relative flex w-[232px] shrink-0 flex-col gap-0.5 border-r border-[var(--color-border-soft)] px-3 py-6">
          <div className="relative mb-3">
            <IconSearch
              size={13}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <label htmlFor="settings-search" className="sr-only">
              Search settings
            </label>
            <input
              id="settings-search"
              ref={settingsSearchInputRef}
              name="settings-search"
              type="search"
              role="combobox"
              aria-expanded={settingsQuery.trim().length > 0}
              aria-controls="settings-search-results"
              aria-autocomplete="list"
              aria-activedescendant={
                settingsResults[activeSearchIndex]
                  ? `settings-search-result-${settingsResults[activeSearchIndex]!.id}`
                  : undefined
              }
              autoComplete="off"
              value={settingsQuery}
              onChange={(event) => setSettingsQuery(event.target.value)}
              onKeyDown={onSettingsSearchKeyDown}
              placeholder="Search settings…"
              className="h-8 w-full rounded-lg bg-[var(--color-bg-raised)] pl-8 pr-2 text-[12px] text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-[var(--color-accent)]"
            />
            {settingsQuery.trim() && (
              <div
                id="settings-search-results"
                role="listbox"
                aria-label="Settings search results"
                className="absolute inset-x-0 top-10 z-20 max-h-[320px] overscroll-contain overflow-y-auto rounded-lg bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)]"
              >
                {settingsResults.length === 0 ? (
                  <div role="status" className="px-3 py-4 text-[12px] leading-5 text-[var(--color-text-muted)]">
                    No matching setting. Try “provider”, “cache”, or “privacy”.
                  </div>
                ) : (
                  settingsResults.map((result, index) => (
                    <button
                      key={result.id}
                      id={`settings-search-result-${result.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeSearchIndex}
                      tabIndex={-1}
                      onMouseEnter={() => setActiveSearchIndex(index)}
                      onClick={() => {
                        selectSettingsTarget({
                          section: result.section,
                          ...(result.kind === "setting" ? { id: result.id } : {}),
                        });
                        setSettingsQuery("");
                      }}
                      className={`block w-full rounded-md px-2.5 py-2 text-left ${
                        index === activeSearchIndex
                          ? "bg-[var(--color-surface-hover)]"
                          : "hover:bg-[var(--color-surface)]"
                      }`}
                    >
                      <span className="block text-[12px] font-medium text-[var(--color-text)]">
                        {result.title}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
                        {result.description}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSettingsTarget({ section: s.id })}
              className={`rounded-lg px-3 py-1.5 text-left text-[13px] font-medium transition-colors ${
                s.id === section
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                  : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              {s.title}
            </button>
          ))}
          <div className="mt-auto border-t border-[var(--color-border-soft)] pt-4">
            <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              More
            </div>
            <button
              onClick={() => navigate("/workspaces")}
              className="w-full rounded-lg px-3 py-2 text-left transition-colors text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <span className="block text-[13px] font-medium">Workspaces</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                Saved multi-tenant working sets
              </span>
            </button>
            <button
              onClick={() => navigate("/connectors")}
              className="mt-1 w-full rounded-lg px-3 py-2 text-left transition-colors text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <span className="block text-[13px] font-medium">Connectors</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                External integrations
              </span>
            </button>
          </div>
        </nav>
        <PageBody>
          {section === "providers" && (
            <ProvidersSection
              providers={state.providers}
              activeProviderId={state.activeProviderId}
              activeModelByProviderId={state.activeModelByProviderId}
              onSetActiveProvider={setActiveProvider}
              onSetActiveModel={setActiveModel}
              onProviderConfigSaved={refresh}
            />
          )}
          {section === "tenants" && (
            <TenantsSection
              tenants={state.tenants}
              activeTenantId={state.activeTenantId}
              busy={false}
              error={null}
              onConnect={async () => openSetup()}
              onSetActive={setActiveTenant}
              onDisconnect={disconnectTenant}
            />
          )}
          {section === "chat" && <ChatSettingsSection />}
          {section === "gateway" && (
            <GatewaySection
              tenants={state.tenants}
              activeTenantId={state.activeTenantId}
            />
          )}
          {section === "general" && <GeneralSection />}
          {section === "privacy" && (
            <PrivacySection
              trust={state.trust}
              registrySource={state.registrySource}
              registryRefreshError={state.registryRefreshError}
              lastRegistryRefresh={state.lastRegistryRefresh}
              registryInstallCountsEnabled={state.registryInstallCountsEnabled}
              usageTelemetryEnabled={state.usageTelemetryEnabled ?? false}
              onSetRegistrySource={setRegistrySource}
              onSetRegistryInstallCountsEnabled={setRegistryInstallCountsEnabled}
              onSetUsageTelemetryEnabled={setUsageTelemetryEnabled}
            />
          )}
          {section === "about" && <AboutSection />}
        </PageBody>
      </div>
    </>
  );
}

function ProvidersSection({
  providers,
  activeProviderId,
  activeModelByProviderId,
  onSetActiveProvider,
  onSetActiveModel,
  onProviderConfigSaved,
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModelByProviderId: Partial<Record<ProviderId, string>> | undefined;
  onSetActiveProvider: (id: ProviderId) => Promise<void>;
  onSetActiveModel: (id: ProviderId, model: string | null) => Promise<void>;
  onProviderConfigSaved: () => Promise<void>;
}) {
  const localProviders = providers.filter((p) => p.isLocal);
  const cliHostedProviders = providers.filter(
    (p) => !p.isLocal && p.id !== "azure-openai",
  );
  const azureOpenAIProvider = providers.find((p) => p.id === "azure-openai");

  return (
    <div className="max-w-[820px]">
      <SectionTitle
        title="LLM Providers"
        subtitle="Local providers keep tenant prompts on this device. Hosted providers send prompts to the selected service; CLI-backed providers use the vendor CLI, while Azure OpenAI stores one encrypted key locally."
      />

      <div className="mt-6 grid grid-cols-1 gap-3">
        {localProviders.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            activeProviderId={activeProviderId}
            activeModel={activeModelByProviderId?.[p.id]}
            onSetActiveProvider={onSetActiveProvider}
            onSetActiveModel={onSetActiveModel}
          />
        ))}
      </div>

      <div className="mt-10 mb-3 flex items-center gap-3">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Hosted via local CLI
        </span>
        <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
      </div>
      <p className="mb-4 max-w-[640px] text-[12px] text-[var(--color-text-muted)]">
        These providers are accessed by invoking the vendor's locally-installed
        CLI. Your existing subscription is used. OpenAdminOS never sees an API
        key.
      </p>
      <div className="grid grid-cols-1 gap-3">
        {cliHostedProviders.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            activeProviderId={activeProviderId}
            activeModel={activeModelByProviderId?.[p.id]}
            onSetActiveProvider={onSetActiveProvider}
            onSetActiveModel={onSetActiveModel}
          />
        ))}
      </div>

      {azureOpenAIProvider && (
        <>
          <div className="mt-10 mb-3 flex items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Hosted via Azure API key
            </span>
            <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
          </div>
          <p className="mb-4 max-w-[640px] text-[12px] text-[var(--color-text-muted)]">
            Azure OpenAI uses your Azure resource endpoint and deployment. The
            API key is encrypted with OS secure storage and is write-only in the
            renderer.
          </p>
          <div className="grid grid-cols-1 gap-3">
            <ProviderRow
              provider={azureOpenAIProvider}
              activeProviderId={activeProviderId}
              activeModel={activeModelByProviderId?.[azureOpenAIProvider.id]}
              onSetActiveProvider={onSetActiveProvider}
              onSetActiveModel={onSetActiveModel}
            />
            <AzureOpenAIConfigForm onSaved={onProviderConfigSaved} />
          </div>
        </>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  activeProviderId,
  activeModel,
  onSetActiveProvider,
  onSetActiveModel,
}: {
  provider: ProviderSummary;
  activeProviderId: ProviderId;
  activeModel: string | undefined;
  onSetActiveProvider: (id: ProviderId) => Promise<void>;
  onSetActiveModel: (id: ProviderId, model: string | null) => Promise<void>;
}) {
  const isActive = provider.id === activeProviderId;
  const implemented = isProviderImplemented(provider.id);
  const installedModels = provider.models ?? [];
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const effectiveModel = resolveProviderDefaultModel(
    provider,
    activeModel ? { [provider.id]: activeModel } : undefined,
  ).model;
  const providerReadyForTest =
    provider.status === "connected" ||
    (provider.id === "azure-openai" && provider.status === "available");
  const canTest =
    implemented &&
    providerReadyForTest &&
    (provider.id === "openai" ||
      provider.id === "ollama" ||
      provider.id === "azure-openai" ||
      provider.id === "apple-foundation");

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.openAdminOS?.testProvider(provider.id, effectiveModel);
      if (result) setTestResult(result);
    } catch (error) {
      setTestResult({
        providerId: provider.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className={implemented ? undefined : "opacity-60"}>
      <div className="flex items-start gap-4 p-5">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ring-1 ${
            provider.isLocal
              ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"
              : "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-[var(--color-info)]/25"
          }`}
        >
          {provider.isLocal ? <IconHardDrive size={20} /> : <IconCloud size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-[var(--color-text)]">
              {provider.name}
            </span>
            {!implemented ? (
              <Pill>
                <StatusDot tone="muted" /> Coming soon
              </Pill>
            ) : (
              <>
                {provider.status === "connected" && (
                  <Pill tone="success">
                    <StatusDot tone="success" /> Connected
                  </Pill>
                )}
                {provider.status === "available" && (
                  <Pill tone="warning">
                    <StatusDot tone="warning" /> Available
                  </Pill>
                )}
                {provider.status === "not-installed" && (
                  <Pill>
                    <StatusDot tone="muted" /> Not installed
                  </Pill>
                )}
                {provider.status === "error" && (
                  <Pill tone="danger">
                    <StatusDot tone="danger" /> Error
                  </Pill>
                )}
              </>
            )}
            {isActive && implemented && (
              <Pill tone="accent">
                <IconCheck size={10} /> Active
              </Pill>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
            {provider.description}
          </p>
          {provider.detail && (
            <div className="mt-2 font-mono text-[11px] text-[var(--color-text-muted)]">
              {provider.detail}
            </div>
          )}
          {provider.id === "openai" && implemented && (
            <div className="mt-3 grid gap-2 rounded-md bg-[var(--color-bg-raised)] p-3 text-[11px] ring-1 ring-[var(--color-border-soft)] sm:grid-cols-3">
              <ProviderFact label="Codex auth" value={provider.status === "connected" ? "Detected" : "Check required"} />
              <ProviderFact label="Default model" value={effectiveModel ?? "Provider default"} />
              <ProviderFact label="Models" value={`${installedModels.length} available`} />
            </div>
          )}
          {implemented && installedModels.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                <span>Models</span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {installedModels.length} {provider.isLocal ? "installed" : "available"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {installedModels.map((m) => {
                  const selected = m === effectiveModel;
                  const modelTitle = !isActive
                    ? `Use ${m} and set ${provider.name} active for runs`
                    : selected
                      ? "Currently active model · click to revert to provider default"
                      : `Use ${m} for runs against this provider`;
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        void (async () => {
                          if (!isActive) {
                            await onSetActiveProvider(provider.id);
                          }
                          await onSetActiveModel(
                            provider.id,
                            selected && isActive ? null : m,
                          );
                        })();
                      }}
                      title={modelTitle}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                        selected
                          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                          : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {selected && (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                      )}
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {testResult && (
            <div
              className={`mt-3 rounded-md px-3 py-2 text-[11.5px] leading-relaxed ring-1 ${
                testResult.ok
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/30"
                  : "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30"
              }`}
            >
              <div className="font-medium">
                {testResult.ok ? "Provider test passed." : "Provider test failed."}
              </div>
              <div className="mt-0.5 text-[11px] opacity-90">
                {testResult.message}
                {testResult.model && (
                  <>
                    {" "}
                    Model: <span className="font-mono">{testResult.model}</span>.
                  </>
                )}
                {typeof testResult.durationMs === "number" && (
                  <> Response time: {(testResult.durationMs / 1000).toFixed(1)}s.</>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {canTest && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void handleTest();
              }}
              disabled={testing}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
          )}
          {implemented &&
            (provider.status === "connected" || provider.status === "available") &&
            !isActive && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void onSetActiveProvider(provider.id);
              }}
            >
              Set active
            </Button>
          )}
          {implemented && provider.status === "not-installed" && providerInstallGuideUrl(provider.id) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const url = providerInstallGuideUrl(provider.id);
                if (url) void window.openAdminOS?.openExternal(url);
              }}
            >
              Install guide
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function AzureOpenAIConfigForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const [config, setConfig] = useState<AzureOpenAIProviderConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [deployment, setDeployment] = useState("");
  const [apiVersion, setApiVersion] = useState(
    DEFAULT_AZURE_OPENAI_API_VERSION,
  );
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyConfig = (next: AzureOpenAIProviderConfig) => {
    setConfig(next);
    setEndpoint(next.endpoint);
    setDeployment(next.deployment);
    setApiVersion(next.apiVersion || DEFAULT_AZURE_OPENAI_API_VERSION);
  };

  useEffect(() => {
    let cancelled = false;
    const api = window.openAdminOS;
    if (!api) {
      setLoading(false);
      setError("Azure OpenAI settings are unavailable outside the desktop app.");
      return () => {
        cancelled = true;
      };
    }

    api
      .getAzureOpenAIConfig()
      .then((next) => {
        if (!cancelled) applyConfig(next);
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

  const hasStoredKey = config?.hasKey ?? false;
  const showKeyInput = !hasStoredKey || replacingKey;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    const trimmedEndpoint = endpoint.trim();
    const trimmedDeployment = deployment.trim();
    const trimmedApiVersion =
      apiVersion.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
    const trimmedApiKey = apiKeyDraft.trim();

    if (!trimmedEndpoint) {
      setError("Endpoint URL is required.");
      setNotice(null);
      return;
    }
    try {
      new URL(trimmedEndpoint);
    } catch {
      setError("Endpoint URL must be a valid Azure OpenAI resource URL.");
      setNotice(null);
      return;
    }
    if (!trimmedDeployment) {
      setError("Deployment name is required.");
      setNotice(null);
      return;
    }
    if (!trimmedApiVersion) {
      setError("API version is required.");
      setNotice(null);
      return;
    }
    if (!hasStoredKey && !trimmedApiKey) {
      setError("Enter an Azure OpenAI API key before saving.");
      setNotice(null);
      return;
    }
    if (hasStoredKey && replacingKey && !trimmedApiKey) {
      setError("Enter a replacement key, or cancel replacement before saving.");
      setNotice(null);
      return;
    }

    const input: SetAzureOpenAIProviderConfigInput = {
      endpoint: trimmedEndpoint,
      deployment: trimmedDeployment,
      apiVersion: trimmedApiVersion,
    };
    if (showKeyInput) {
      input.apiKey = trimmedApiKey;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.openAdminOS?.setAzureOpenAIConfig(input);
      if (!next) {
        throw new Error("Azure OpenAI settings are unavailable outside the desktop app.");
      }
      applyConfig(next);
      setApiKeyDraft("");
      setReplacingKey(false);
      await onSaved();
      setNotice(
        "Azure OpenAI settings saved. Use Test on the provider row before sending tenant context.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div
          role="status"
          aria-live="polite"
          className="p-5 text-[12px] text-[var(--color-text-muted)]"
        >
          Loading Azure OpenAI settings.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={(event) => void handleSubmit(event)} className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <IconLock size={13} className="text-[var(--color-text-muted)]" />
              <h3 className="text-[13px] font-medium text-[var(--color-text)]">
                Azure OpenAI configuration
              </h3>
            </div>
            <p className="mt-1 max-w-[620px] text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              Your key is encrypted with the OS secure storage and never leaves
              this device except to call your Azure endpoint.
            </p>
          </div>
          <Pill tone={hasStoredKey ? "success" : "warning"}>
            <StatusDot tone={hasStoredKey ? "success" : "warning"} />
            {hasStoredKey ? "Key stored" : "Key required"}
          </Pill>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4">
          <AzureConfigField label="Endpoint URL" htmlFor="azure-openai-endpoint">
            <input
              id="azure-openai-endpoint"
              name="azure-openai-endpoint"
              type="url"
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value);
                setError(null);
                setNotice(null);
              }}
              placeholder="https://contoso.openai.azure.com"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
            />
          </AzureConfigField>
          <AzureConfigField label="Deployment name" htmlFor="azure-openai-deployment">
            <input
              id="azure-openai-deployment"
              name="azure-openai-deployment"
              value={deployment}
              onChange={(event) => {
                setDeployment(event.target.value);
                setError(null);
                setNotice(null);
              }}
              placeholder="gpt-4o-admin"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
            />
          </AzureConfigField>
          <AzureConfigField label="API version" htmlFor="azure-openai-api-version">
            <input
              id="azure-openai-api-version"
              name="azure-openai-api-version"
              value={apiVersion}
              onChange={(event) => {
                setApiVersion(event.target.value);
                setError(null);
                setNotice(null);
              }}
              placeholder={DEFAULT_AZURE_OPENAI_API_VERSION}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
            />
          </AzureConfigField>

          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  API key
                </div>
                <div className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  Stored keys are never displayed. Replace writes a new key over
                  the existing encrypted value.
                </div>
              </div>
              {hasStoredKey && !replacingKey && (
                <div className="flex items-center gap-2">
                  <Pill tone="success">
                    <IconCheck size={10} /> Key stored
                  </Pill>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setReplacingKey(true);
                      setApiKeyDraft("");
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Replace
                  </Button>
                </div>
              )}
            </div>
            {showKeyInput && (
              <div className="mt-3">
                <label
                  htmlFor="azure-openai-api-key"
                  className="sr-only"
                >
                  API key
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="azure-openai-api-key"
                    name="azure-openai-api-key"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(event) => {
                      setApiKeyDraft(event.target.value);
                      setError(null);
                      setNotice(null);
                    }}
                    placeholder={
                      hasStoredKey
                        ? "Paste a replacement key"
                        : "Paste Azure OpenAI API key"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
                  />
                  {hasStoredKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReplacingKey(false);
                        setApiKeyDraft("");
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      Cancel replace
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
          >
            {userFacingErrorReason(error) ??
              "Provider settings could not be updated. Review the provider connection, then try again."}
          </div>
        )}
        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="mt-4 rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/30"
          >
            {notice}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-4">
          <div className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
            Azure OpenAI is hosted. Tenant prompts are sent to the configured
            Azure endpoint when this provider is active.
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={saving}>
            {saving ? "Saving" : "Save Azure OpenAI"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AzureConfigField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_1fr] sm:items-center">
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function ProviderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-soft)]">
        {value}
      </div>
    </div>
  );
}

function providerInstallGuideUrl(providerId: ProviderId): string | undefined {
  switch (providerId) {
    case "ollama":
      return "https://ollama.com/download";
    case "apple-foundation":
      return "https://support.apple.com/121115";
    case "lm-studio":
      return "https://lmstudio.ai";
    case "anthropic":
      return "https://docs.anthropic.com/en/docs/claude-code/overview";
    case "openai":
      return "https://github.com/openai/codex";
    case "azure-openai":
      return "https://learn.microsoft.com/en-us/azure/ai-services/openai/";
    default:
      return undefined;
  }
}

function TenantsSection({
  tenants,
  activeTenantId,
  busy,
  error,
  onConnect,
  onSetActive,
  onDisconnect,
}: {
  tenants: TenantRecord[];
  activeTenantId?: string;
  busy: boolean;
  error: string | null;
  onConnect: () => Promise<void>;
  onSetActive: (id: string) => Promise<void>;
  onDisconnect: (id: string) => Promise<void>;
}) {
  return (
    <div className="max-w-[820px]">
      <SectionTitle
        title="Tenants"
        subtitle="Connect Microsoft 365 tenants. Sign-in opens Microsoft in your system browser. Disconnecting the last tenant leaves the app available for browsing and drafting."
      />

      <div className="mt-6 flex items-center gap-3">
        <Button
          variant="primary"
          leadingIcon={<IconPlus size={12} />}
          onClick={() => void onConnect()}
          disabled={busy}
        >
          {busy ? "Waiting for sign-in…" : "Connect tenant"}
        </Button>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          Consent is requested under "Microsoft Graph Command Line Tools".
        </span>
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
          {userFacingErrorReason(error) ??
            "The tenant connection could not be updated. Review the sign-in state, then try again."}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {tenants.length === 0 ? (
          <Card>
            <div className="p-5 text-[13px] text-[var(--color-text-muted)]">
              No tenants connected. Use the button above to sign in with
              your Microsoft 365 admin account.
            </div>
          </Card>
        ) : (
          tenants.map((tenant) => (
            <TenantRow
              key={tenant.id}
              tenant={tenant}
              isActive={tenant.id === activeTenantId}
              onSetActive={onSetActive}
              onDisconnect={onDisconnect}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TenantRow({
  tenant,
  isActive,
  onSetActive,
  onDisconnect,
}: {
  tenant: TenantRecord;
  isActive: boolean;
  onSetActive: (id: string) => Promise<void>;
  onDisconnect: (id: string) => Promise<void>;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const entraLicenseName =
    tenant.entraTier && tenant.entraTier !== "unknown"
      ? tenant.entraTier === "free"
        ? "Microsoft Entra ID Free"
        : `Microsoft Entra ID ${tenant.entraTier.toUpperCase()}`
      : null;
  // Synthesise the Entra tier as the first row of the license list.
  // Technically derived from service plans inside SKUs (not a SKU
  // itself) but an admin thinks of it as just another license they
  // have, so surfacing it identically removes the artificial split.
  const skuLicenses = tenant.relevantLicenses ?? [];
  const licenses = entraLicenseName
    ? [
        {
          skuPartNumber: `__entra_${tenant.entraTier}`,
          displayName: entraLicenseName,
        },
        ...skuLicenses,
      ]
    : skuLicenses;
  return (
    <>
    <Card>
      <div className="flex items-start gap-4 p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25">
          <IconCloud size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-[var(--color-text)]">
              {tenant.displayName}
            </span>
            {isActive && (
              <Pill tone="accent">
                <IconCheck size={10} /> Active
              </Pill>
            )}
          </div>
          <div className="mt-1 text-[12.5px] text-[var(--color-text-soft)]">
            {tenant.username}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            tenant-id: {tenant.id}
          </div>
          {licenses.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
              <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Licenses
              </div>
              <ul className="space-y-0.5 text-[12px] text-[var(--color-text-soft)]">
                {licenses.map((license) => (
                  <li key={license.skuPartNumber}>{license.displayName}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {!isActive && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onSetActive(tenant.id)}
            >
              Set active
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconClose size={11} />}
            onClick={() => {
              setDisconnectError(null);
              setConfirmDisconnect(true);
            }}
          >
            Disconnect
          </Button>
        </div>
      </div>
    </Card>
    <Modal
      open={confirmDisconnect}
      onClose={() => {
        if (!disconnecting) setConfirmDisconnect(false);
      }}
      size="md"
    >
      <ModalHeader
        title={`Disconnect ${tenant.displayName}`}
        subtitle="Remove the connection and its local tenant data"
        badge={<Pill tone="danger">Permanent local deletion</Pill>}
        onClose={() => {
          if (!disconnecting) setConfirmDisconnect(false);
        }}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          This removes the Microsoft sign-in connection and permanently deletes this
          tenant&apos;s local Graph cache, change history, chats, workspaces, run history,
          learning records, and queued deliveries from this device.
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          Microsoft 365 data in the tenant is not changed. Reconnecting later starts with
          an empty local cache.
        </p>
        {disconnectError && (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
          >
            {userFacingErrorReason(disconnectError) ??
              "The tenant could not be fully disconnected. Some local cleanup may already have completed. Restart OpenAdminOS, check that secure storage is available, then try again."}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            disabled={disconnecting}
            onClick={() => setConfirmDisconnect(false)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={disconnecting}
            onClick={() => {
              setDisconnecting(true);
              setDisconnectError(null);
              void onDisconnect(tenant.id)
                .then(() => setConfirmDisconnect(false))
                .catch((caught) =>
                  setDisconnectError(
                    caught instanceof Error ? caught.message : String(caught),
                  ),
                )
                .finally(() => setDisconnecting(false));
            }}
          >
            {disconnecting ? "Disconnecting" : "Disconnect and delete local data"}
          </Button>
        </div>
      </div>
    </Modal>
    </>
  );
}

function ChatSettingsSection() {
  const { state } = useAppState();
  const { requireTenant } = useSetupFlow();
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus | null>(null);
  const [localDataSummary, setLocalDataSummary] =
    useState<LocalDataSummary | null>(null);
  const [learningSettings, setLearningSettings] =
    useState<SelfTrainingSettings>({ enabled: false });
  const [investigationSettings, setInvestigationSettings] =
    useState<ChatInvestigationSettings>({ mode: "auto" });
  const [suggestions, setSuggestions] = useState<SelfTrainingSuggestion[]>([]);
  const [refreshingCache, setRefreshingCache] = useState(false);
  const [clearingLocalData, setClearingLocalData] =
    useState<"chat" | "graph" | null>(null);
  const [clearTarget, setClearTarget] = useState<"chat" | "graph" | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(360);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const resumedIntentRef = useRef<string | null>(null);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;

  const pendingSuggestions = suggestions.filter(
    (suggestion) =>
      suggestion.status === "pending" &&
      (!activeTenant || suggestion.tenantId === activeTenant.id),
  );
  const activeLearning = suggestions.filter(
    (suggestion) =>
      suggestion.status === "accepted" &&
      (!activeTenant || suggestion.tenantId === activeTenant.id),
  );
  const activeLearningAgents = Array.from(
    activeLearning.reduce((map, suggestion) => {
      map.set(suggestion.agentSlug, (map.get(suggestion.agentSlug) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  );
  const decidedSuggestions = suggestions.filter(
    (suggestion) =>
      suggestion.status !== "pending" &&
      (!activeTenant || suggestion.tenantId === activeTenant.id),
  );

  const loadChatSettings = async () => {
    const api = window.openAdminOS;
    if (!api) return;
    const [
      nextCache,
      nextLearning,
      nextInvestigation,
      nextSuggestions,
      nextLocalData,
    ] = await Promise.all([
      api.getGraphCacheStatus().catch(() => null),
      api.getSelfTrainingSettings(),
      api.getChatInvestigationSettings(),
      api.listSelfTrainingSuggestions(),
      api.getLocalDataSummary().catch(() => null),
    ]);
    setCacheStatus(nextCache);
    setLearningSettings(nextLearning);
    setInvestigationSettings(nextInvestigation);
    setSuggestions(nextSuggestions);
    setLocalDataSummary(nextLocalData);
    if (nextCache?.schedule?.intervalMinutes) {
      setScheduleInterval(nextCache.schedule.intervalMinutes);
    }
  };

  useEffect(() => {
    void loadChatSettings().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTenantId, state.runs.length]);

  const handleRefreshCache = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api || refreshingCache) return;
    if (
      !requireTenant(
        createPendingIntent({
          kind: "refresh-cache",
          returnTo: `${location.pathname}${location.search}`,
        }),
      )
    ) {
      return;
    }
    setRefreshingCache(true);
    setError(null);
    try {
      await api.refreshGraphCache();
      setCacheStatus(await api.getGraphCacheStatus());
      setLocalDataSummary(await api.getLocalDataSummary());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshingCache(false);
    }
  }, [location.pathname, location.search, refreshingCache, requireTenant]);

  useEffect(() => {
    const routeState = location.state as { resumePendingIntent?: PendingIntent } | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind !== "refresh-cache" ||
      resumedIntentRef.current === resumed.createdAt
    ) {
      return;
    }
    resumedIntentRef.current = resumed.createdAt;
    navigate(location.pathname + location.search, { replace: true, state: null });
    void handleRefreshCache();
  }, [handleRefreshCache, location.pathname, location.search, location.state, navigate]);

  const handleClearLocalData = async () => {
    const api = window.openAdminOS;
    if (!api || !clearTarget || clearingLocalData) return;
    setClearingLocalData(clearTarget);
    setError(null);
    try {
      if (clearTarget === "chat") {
        setLocalDataSummary(await api.clearIntuneChatHistory());
      } else {
        setLocalDataSummary(await api.clearGraphCache(activeTenant?.id));
        setCacheStatus(await api.getGraphCacheStatus(activeTenant?.id));
      }
      setClearTarget(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setClearingLocalData(null);
    }
  };

  const handleScheduleChange = async (enabled: boolean, intervalMinutes = scheduleInterval) => {
    const api = window.openAdminOS;
    if (!api || !activeTenant || scheduleBusy) return;
    setScheduleBusy(true);
    setError(null);
    try {
      await api.setGraphCacheRefreshSchedule({
        tenantId: activeTenant.id,
        enabled,
        intervalMinutes,
      });
      setCacheStatus(await api.getGraphCacheStatus(activeTenant.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleInvestigationModeChange = async (mode: ChatInvestigationMode) => {
    const api = window.openAdminOS;
    if (!api || mode === investigationSettings.mode) return;
    setError(null);
    try {
      setInvestigationSettings(await api.setChatInvestigationMode(mode));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleToggleLearning = async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setError(null);
    try {
      const next = await api.setSelfTrainingEnabled(!learningSettings.enabled);
      setLearningSettings(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleSuggestionDecision = async (
    suggestion: SelfTrainingSuggestion,
    decision: "accept" | "reject",
  ) => {
    const api = window.openAdminOS;
    if (!api) return;
    setError(null);
    try {
      if (decision === "accept") {
        await api.approveSelfTrainingSuggestion(suggestion.id);
      } else {
        await api.rejectSelfTrainingSuggestion(suggestion.id);
      }
      setSuggestions(await api.listSelfTrainingSuggestions());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleResetLearning = async (agentSlug: string) => {
    const api = window.openAdminOS;
    if (!api || !activeTenant) return;
    setError(null);
    try {
      await api.resetSelfTrainingSuggestions({
        tenantId: activeTenant.id,
        agentSlug,
      });
      setSuggestions(await api.listSelfTrainingSuggestions());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshedResources = cacheStatus?.resources.filter((resource) => resource.refreshedAt) ?? [];
  const latestRefresh = refreshedResources
    .map((resource) => resource.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const activeTenantCacheRows =
    localDataSummary?.activeTenantGraphRowCount ??
    cacheStatus?.resources.reduce((total, resource) => total + resource.rows, 0) ??
    0;
  const chatHistoryLabel = localDataSummary
    ? `${localDataSummary.chatConversationCount.toLocaleString()} conversations · ${localDataSummary.chatMessageCount.toLocaleString()} messages`
    : "Loading";
  const graphCacheLabel = activeTenant
    ? `${activeTenantCacheRows.toLocaleString()} rows for ${activeTenant.displayName}`
    : "No active tenant";
  const runHistoryLabel = localDataSummary?.runHistoryCount !== undefined
    ? `${localDataSummary.runHistoryCount.toLocaleString()} records`
    : `${state.runs.length.toLocaleString()} records`;
  const lastPruneLabel = localDataSummary?.lastRunHistoryPrune
    ? formatRunHistoryPruneResult(localDataSummary.lastRunHistoryPrune)
    : "No run-history prune result recorded.";

  return (
    <div className="max-w-[820px]">
      <div className="flex items-start justify-between gap-6">
        <SectionTitle
          title="Chat"
          subtitle="Chat stays simple. Cache refresh, scheduled updates, and local self-training approvals live here."
        />
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<IconChat size={13} />}
          onClick={() => navigate("/chat")}
        >
          Open chat
        </Button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
          {userFacingErrorReason(error) ??
            "Chat settings could not be updated. Review the current values, then try again."}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          id="chat-investigation-mode"
          description="Controls whether single-tenant Chat can run read-only tool calls before answering. Multi-tenant chat stays deterministic."
          control={
            <div
              role="group"
              aria-label="Chat investigation mode"
              className="grid min-w-[360px] grid-cols-3 gap-1 rounded-lg bg-[var(--color-bg)] p-1 ring-1 ring-[var(--color-border-soft)]"
            >
              {([
                {
                  value: "auto",
                  label: "Auto",
                  detail: "Hosted and capable local models investigate.",
                },
                {
                  value: "always-agentic",
                  label: "Investigative",
                  detail: "Always allow read-only tool calls.",
                },
                {
                  value: "always-deterministic",
                  label: "Deterministic",
                  detail: "Use keyword-planned cache retrieval.",
                },
              ] satisfies Array<{
                value: ChatInvestigationMode;
                label: string;
                detail: string;
              }>).map((option) => {
                const active = investigationSettings.mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => void handleInvestigationModeChange(option.value)}
                    className={`rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                      active
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                        : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    }`}
                    aria-pressed={active}
                  >
                    <span className="block text-[11.5px] font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">
                      {option.detail}
                    </span>
                  </button>
                );
              })}
            </div>
          }
        />

        <SettingRow
          id="tenant-cache"
          description={
            latestRefresh
              ? `Latest refresh ${formatDateTime(latestRefresh)}. Chat uses compact answer packs from these local cache rows.`
              : "No tenant cache yet. Chat will refresh the resources it needs before answering."
          }
          control={
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<IconRefresh size={12} />}
              disabled={refreshingCache}
              onClick={() => void handleRefreshCache()}
            >
              {refreshingCache ? "Refreshing" : "Refresh now"}
            </Button>
          }
        />

        <Card>
          <div className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  Cached resources
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                  Row counts and last refresh state for the active tenant.
                </div>
              </div>
              <Pill tone="default">{cacheStatus?.resources.length ?? 0} sources</Pill>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {(cacheStatus?.resources ?? []).map((resource) => (
                <div
                  key={resource.resource}
                  className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[12px] text-[var(--color-text)]">
                      {resource.label}
                    </span>
                    <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
                      {resource.rows}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[10.5px] text-[var(--color-text-muted)]">
                    {resource.lastError
                      ? resource.lastError
                      : resource.refreshedAt
                        ? formatDateTime(resource.refreshedAt)
                        : "Not refreshed"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  Local data
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                  Chat, cache, and learning records live in local SQLite. Run history lives in this profile's local state store.
                </div>
              </div>
              <Pill tone="success">
                <IconHardDrive size={10} /> On device
              </Pill>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <LocalDataMetric
                label="SQLite store"
                value={
                  localDataSummary
                    ? formatBytes(localDataSummary.sqliteBytes)
                    : "Loading"
                }
              />
              <LocalDataMetric label="Chat history" value={chatHistoryLabel} />
              <LocalDataMetric label="Active tenant cache" value={graphCacheLabel} />
              <LocalDataMetric label="Run history" value={runHistoryLabel} />
              <LocalDataMetric
                label="Self-training"
                value={
                  localDataSummary
                    ? `${localDataSummary.selfTrainingSuggestionCount.toLocaleString()} suggestions · ${localDataSummary.learningEventCount.toLocaleString()} events`
                    : "Loading"
                }
              />
            </div>
            <div className="mt-3 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
              {lastPruneLabel}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="danger"
                disabled={
                  clearingLocalData !== null ||
                  !localDataSummary ||
                  localDataSummary.chatConversationCount === 0
                }
                onClick={() => setClearTarget("chat")}
              >
                Clear chat history
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={
                  clearingLocalData !== null ||
                  !activeTenant ||
                  activeTenantCacheRows === 0
                }
                onClick={() => setClearTarget("graph")}
              >
                Clear active tenant cache
              </Button>
            </div>
            <div className="mt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
              Clearing data never disconnects tenants, removes provider settings, or changes agent run history.
            </div>
          </div>
        </Card>

        <SettingRow
          id="periodic-cache-refresh"
          description="Refreshes the active tenant cache through the local scheduler while the user is signed in."
          control={
            <div className="flex items-center gap-2">
              <label htmlFor="periodic-cache-refresh-interval" className="sr-only">
                Periodic cache refresh interval
              </label>
              <Select
                id="periodic-cache-refresh-interval"
                name="periodic-cache-refresh-interval"
                value={scheduleInterval}
                disabled={scheduleBusy || !activeTenant}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setScheduleInterval(next);
                  if (cacheStatus?.schedule?.enabled) {
                    void handleScheduleChange(true, next);
                  }
                }}
                className="h-7 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value={60}>Every hour</option>
                <option value={360}>Every 6 hours</option>
                <option value={720}>Every 12 hours</option>
                <option value={1440}>Every 24 hours</option>
              </Select>
              <Button
                size="sm"
                variant={cacheStatus?.schedule?.enabled ? "secondary" : "primary"}
                disabled={scheduleBusy || !activeTenant}
                onClick={() =>
                  void handleScheduleChange(!(cacheStatus?.schedule?.enabled ?? false))
                }
              >
                {scheduleBusy
                  ? "Saving"
                  : cacheStatus?.schedule?.enabled
                    ? "Disable"
                    : "Enable"}
              </Button>
            </div>
          }
        />
        {cacheStatus?.schedule?.nextRunAt && (
          <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            Next cache refresh {formatDateTime(cacheStatus.schedule.nextRunAt)}
          </div>
        )}
        {cacheStatus?.schedule?.lastError && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {cacheStatus.schedule.lastError}
          </div>
        )}

        <SettingRow
          id="local-self-training"
          description="Approved suggestions write local agent overlay files. They cannot add scopes, change mode, alter connector egress, or bypass confirmation."
          control={
            <Button
              size="sm"
              variant={learningSettings.enabled ? "primary" : "secondary"}
              leadingIcon={<IconShield size={12} />}
              onClick={() => void handleToggleLearning()}
            >
              {learningSettings.enabled ? "Enabled" : "Enable"}
            </Button>
          }
        />

        <Card>
          <div className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  Self-training suggestions
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                  Nothing becomes active until accepted here.
                </div>
              </div>
              <Pill tone={pendingSuggestions.length > 0 ? "warning" : "default"}>
                {pendingSuggestions.length} pending
              </Pill>
            </div>
            <div className="flex flex-col gap-2">
              {pendingSuggestions.length === 0 ? (
                <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                  No pending suggestions.
                </div>
              ) : (
                pendingSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]"
                  >
                    <div className="text-[12px] font-medium text-[var(--color-text)]">
                      {suggestion.agentSlug}
                    </div>
                    <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-soft)]">
                      {suggestion.text}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void handleSuggestionDecision(suggestion, "accept")}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleSuggestionDecision(suggestion, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {activeLearningAgents.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
                  Active overlays
                </div>
                <div className="flex flex-col gap-2">
                  {activeLearningAgents.map(([agentSlug, count]) => (
                    <div
                      key={agentSlug}
                      className="flex items-center justify-between gap-2 rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12px] text-[var(--color-text)]">
                          {agentSlug}
                        </div>
                        <div className="text-[10.5px] text-[var(--color-text-muted)]">
                          {count} approved {count === 1 ? "instruction" : "instructions"}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleResetLearning(agentSlug)}
                      >
                        Reset
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {decidedSuggestions.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
                  Recent decisions
                </div>
                <div className="flex flex-col gap-1.5">
                  {decidedSuggestions.slice(0, 5).map((suggestion) => (
                    <div
                      key={suggestion.id}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="truncate text-[var(--color-text-soft)]">
                        {suggestion.agentSlug}
                      </span>
                      <Pill tone={suggestion.status === "accepted" ? "success" : "default"}>
                        {suggestion.status}
                      </Pill>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
      <ClearLocalDataModal
        target={clearTarget}
        activeTenantName={activeTenant?.displayName}
        busy={clearTarget !== null && clearingLocalData === clearTarget}
        onClose={() => setClearTarget(null)}
        onConfirm={() => void handleClearLocalData()}
      />
    </div>
  );
}

function LocalDataMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10.5px] font-medium uppercase text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate text-[12px] text-[var(--color-text)]">
        {value}
      </div>
    </div>
  );
}

function ClearLocalDataModal({
  target,
  activeTenantName,
  busy,
  onClose,
  onConfirm,
}: {
  target: "chat" | "graph" | null;
  activeTenantName?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const title =
    target === "chat" ? "Clear chat history" : "Clear active tenant cache";
  const detail =
    target === "chat"
      ? "This removes all local Chat conversations, messages, and chat tool-call records. It does not clear Graph cache rows, disconnect tenants, or alter agent run history."
      : `This removes cached Graph rows and cache status for ${activeTenantName ?? "the active tenant"}. The next chat that needs tenant context will refresh the required resources again.`;

  return (
    <Modal open={target !== null} onClose={onClose} size="md">
      <ModalHeader
        title={title}
        subtitle="Local SQLite cleanup"
        badge={<Pill tone="danger">Local deletion</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          {detail}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Clearing" : "Clear"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function GatewaySection({
  tenants,
  activeTenantId,
}: {
  tenants: TenantRecord[];
  activeTenantId?: string;
}) {
  const fallbackTenantId = activeTenantId ?? tenants[0]?.id ?? "";
  const [gatewayStatus, setGatewayStatus] =
    useState<GatewayPublicStatus | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState(fallbackTenantId);
  const [portInput, setPortInput] = useState("");
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<
    | { kind: "regenerate" }
    | { kind: "revoke"; clientId: string; clientName: string }
    | { kind: "disable" }
    | null
  >(null);
  const gatewayAvailable = Boolean(
    window.openAdminOS?.getGatewayStatus &&
      window.openAdminOS.enableGateway &&
      window.openAdminOS.disableGateway &&
      window.openAdminOS.regenerateGatewayToken &&
      window.openAdminOS.revokeGatewayClient,
  );

  useEffect(() => {
    let cancelled = false;
    const api = window.openAdminOS;
    if (!api?.getGatewayStatus) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void api
      .getGatewayStatus()
      .then((status) => {
        if (cancelled) return;
        setGatewayStatus(status);
        setSelectedTenantId(status.boundTenantId ?? fallbackTenantId);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            gatewayActionError(
              "Gateway status could not be loaded",
              caught,
              "Restart OpenAdminOS, then open Gateway settings again.",
            ),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fallbackTenantId]);

  const boundTenant = gatewayStatus?.boundTenantId
    ? tenants.find((tenant) => tenant.id === gatewayStatus.boundTenantId)
    : undefined;
  const listeningPort = gatewayStatus
    ? (gatewayStatus.listeningPort ?? gatewayStatus.port)
    : undefined;
  const endpoint = listeningPort
    ? `http://127.0.0.1:${listeningPort}/`
    : undefined;

  const enableGateway = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = window.openAdminOS;
    if (!api?.enableGateway || busyAction) return;
    if (!selectedTenantId) {
      setError("Select a connected tenant before enabling the gateway.");
      return;
    }
    const trimmedPort = portInput.trim();
    const parsedPort = trimmedPort ? Number(trimmedPort) : undefined;
    if (
      parsedPort !== undefined &&
      (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)
    ) {
      setError("Port must be a whole number between 1 and 65535.");
      return;
    }
    setBusyAction("enable");
    setError(null);
    try {
      const result = await api.enableGateway({
        boundTenantId: selectedTenantId,
        ...(parsedPort !== undefined ? { port: parsedPort } : {}),
      });
      setGatewayStatus(result.status);
      setPairingToken(result.token);
    } catch (caught) {
      setError(
        gatewayActionError(
          "The gateway could not be enabled",
          caught,
          "Check that the port is available, then try again.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const regenerateToken = async () => {
    const api = window.openAdminOS;
    if (!api?.regenerateGatewayToken || busyAction) return;
    setBusyAction("regenerate");
    setError(null);
    try {
      const result = await api.regenerateGatewayToken();
      setGatewayStatus(result.status);
      setPairingToken(result.token);
    } catch (caught) {
      setError(
        gatewayActionError(
          "The pairing token could not be regenerated",
          caught,
          "The existing token remains active. Try again after checking the gateway status.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const revokeClient = async (clientId: string) => {
    const api = window.openAdminOS;
    if (!api?.revokeGatewayClient || busyAction) return;
    setBusyAction(`revoke:${clientId}`);
    setError(null);
    try {
      setGatewayStatus(await api.revokeGatewayClient(clientId));
    } catch (caught) {
      setError(
        gatewayActionError(
          "The client pairing could not be revoked",
          caught,
          "Check that the gateway is available, then try again.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const disableGateway = async () => {
    const api = window.openAdminOS;
    if (!api?.disableGateway || busyAction) return;
    setBusyAction("disable");
    setError(null);
    try {
      setGatewayStatus(await api.disableGateway());
      setPairingToken(null);
    } catch (caught) {
      setError(
        gatewayActionError(
          "The gateway could not be disabled",
          caught,
          "Check the listener status, then try again.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const copyEndpoint = async () => {
    if (!endpoint) return;
    try {
      await copyTextToClipboard(endpoint);
      setEndpointCopied(true);
      window.setTimeout(() => setEndpointCopied(false), 1500);
    } catch (caught) {
      setError(
        gatewayActionError(
          "The loopback URL could not be copied",
          caught,
          "Select the URL and copy it manually.",
        ),
      );
    }
  };

  const confirmGatewayAction = async () => {
    if (!pendingConfirmation || busyAction) return;
    if (pendingConfirmation.kind === "regenerate") {
      await regenerateToken();
    } else if (pendingConfirmation.kind === "revoke") {
      await revokeClient(pendingConfirmation.clientId);
    } else {
      await disableGateway();
    }
    setPendingConfirmation(null);
  };

  const confirmationCopy = gatewayConfirmationCopy(pendingConfirmation);

  return (
    <div className="max-w-[820px]">
      <SectionTitle
        title="Gateway"
        subtitle="Pair local MCP clients with one tenant-scoped OpenAdminOS session."
      />

      <div className="mt-6 flex flex-col gap-4">
        {!gatewayAvailable ? (
          <Card>
            <div className="p-5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Gateway controls are unavailable in this build. Open this section in
              the desktop app with gateway support enabled.
            </div>
          </Card>
        ) : loading ? (
          <Card>
            <div role="status" className="p-5 text-[12.5px] text-[var(--color-text-muted)]">
              Loading local gateway status…
            </div>
          </Card>
        ) : gatewayStatus === null ? (
          <Card>
            <div className="p-5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Gateway status is unavailable. Use the recovery below, then reload
              this section.
            </div>
          </Card>
        ) : !gatewayStatus?.enabled ? (
          <Card>
            <form onSubmit={(event) => void enableGateway(event)} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-[620px]">
                  <div className="text-[13px] font-medium text-[var(--color-text)]">
                    Local MCP gateway
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                    The gateway is a local, loopback-only MCP server. It lets
                    external AI clients read one bound tenant and propose changes
                    that you still confirm by hand.
                  </p>
                </div>
                <Pill>Off</Pill>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <div>
                  <label
                    htmlFor="gateway-tenant"
                    className="block text-[11px] font-medium text-[var(--color-text-soft)]"
                  >
                    Bound tenant
                  </label>
                  <Select
                    id="gateway-tenant"
                    name="gateway-tenant"
                    required
                    value={selectedTenantId}
                    onChange={(event) => setSelectedTenantId(event.target.value)}
                    disabled={busyAction !== null || tenants.length === 0}
                    className="mt-1.5 h-9 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[12px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {tenants.length === 0 ? (
                      <option value="">No connected tenant</option>
                    ) : (
                      tenants.map((tenant) => (
                        <option key={tenant.id} value={tenant.id}>
                          {tenant.displayName}
                        </option>
                      ))
                    )}
                  </Select>
                </div>
                <div>
                  <label
                    htmlFor="gateway-port"
                    className="block text-[11px] font-medium text-[var(--color-text-soft)]"
                  >
                    Port (optional)
                  </label>
                  <input
                    id="gateway-port"
                    name="gateway-port"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    step={1}
                    autoComplete="off"
                    value={portInput}
                    onChange={(event) => setPortInput(event.target.value)}
                    placeholder={String(gatewayStatus?.port ?? 47_891)}
                    disabled={busyAction !== null}
                    className="mt-1.5 h-9 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 font-mono text-[12px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="mt-4 border-l-2 border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
                Reads are scoped to the selected tenant. Every write is only a
                proposal that requires typed confirmation in this app. Nothing an
                external client sends can apply a change.
              </div>

              <div className="mt-5 flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busyAction !== null || !selectedTenantId}
                  leadingIcon={<IconLock size={12} />}
                >
                  {busyAction === "enable" ? "Enabling…" : "Enable gateway"}
                </Button>
              </div>
            </form>
          </Card>
        ) : (
          <>
            <Card>
              <div className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--color-text)]">
                      Local gateway
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                      The listener accepts paired clients on this device only.
                    </p>
                  </div>
                  <Pill tone={gatewayStatus.running ? "success" : "warning"}>
                    <StatusDot tone={gatewayStatus.running ? "success" : "warning"} />
                    {gatewayStatus.running ? "Running" : "Listener stopped"}
                  </Pill>
                </div>

                <dl className="mt-4 grid gap-3 rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)] sm:grid-cols-3">
                  <GatewayFact
                    label="Bound tenant"
                    value={
                      boundTenant?.displayName ??
                      gatewayStatus.boundTenantId ??
                      "No tenant"
                    }
                  />
                  <GatewayFact
                    label="Listener port"
                    value={listeningPort ? String(listeningPort) : "Not listening"}
                    mono
                  />
                  <GatewayFact
                    label="Pairing token"
                    value={gatewayStatus.hasToken ? "Configured" : "Not configured"}
                  />
                </dl>

                {endpoint && (
                  <div className="mt-4">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                      Loopback URL
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
                      <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-[var(--color-text)]">
                        {endpoint}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void copyEndpoint()}
                        aria-label="Copy loopback URL"
                      >
                        {endpointCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="mt-4 border-l-2 border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
                  Reads are scoped to {boundTenant?.displayName ?? "the bound tenant"}.
                  Every write is only a proposal that requires typed confirmation
                  in this app. Nothing an external client sends can apply a change.
                </div>
              </div>
            </Card>

            {pairingToken && (
              <Card>
                <div className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[13px] font-medium text-[var(--color-text)]">
                        Pairing token
                      </h3>
                      <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                        This token is shown once. Copy it now. You can regenerate a
                        replacement later.
                      </p>
                    </div>
                    <Pill tone="warning">Shown once</Pill>
                  </div>
                  <OutputJsonBlock
                    value={pairingToken}
                    copyLabel="Copy pairing token"
                    className="mt-4"
                  />
                </div>
              </Card>
            )}

            <Card>
              <div className="border-b border-[var(--color-border-soft)] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-[13px] font-medium text-[var(--color-text)]">
                      Connected clients
                    </h3>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                      {gatewayStatus.clients.length.toLocaleString()} paired client
                      {gatewayStatus.clients.length === 1 ? "" : "s"} for this local gateway.
                    </p>
                  </div>
                  <div className="max-w-[360px] text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busyAction !== null}
                      leadingIcon={<IconRefresh size={11} />}
                      onClick={() => setPendingConfirmation({ kind: "regenerate" })}
                    >
                      {busyAction === "regenerate" ? "Regenerating…" : "Regenerate token"}
                    </Button>
                    <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--color-warning)]">
                      Paired clients must re-pair after regeneration.
                    </p>
                  </div>
                </div>
              </div>

              {gatewayStatus.clients.length === 0 ? (
                <div className="px-5 py-6 text-[12px] text-[var(--color-text-muted)]">
                  No clients are paired with this gateway.
                </div>
              ) : (
                <ul aria-label="Connected gateway clients" className="divide-y divide-[var(--color-border-soft)]">
                  {gatewayStatus.clients.map((client) => (
                    <li
                      key={client.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5"
                    >
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-[var(--color-text)]">
                          {client.name}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                          Paired {formatDateTime(client.createdAt)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={busyAction !== null}
                        onClick={() =>
                          setPendingConfirmation({
                            kind: "revoke",
                            clientId: client.id,
                            clientName: client.name,
                          })
                        }
                        aria-label={`Revoke ${client.name}`}
                      >
                        {busyAction === `revoke:${client.id}` ? "Revoking…" : "Revoke"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-border-soft)] px-5 py-4">
                <p className="max-w-[560px] text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                  Disabling stops the loopback listener. Existing client records
                  remain available when the gateway is enabled again.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={busyAction !== null}
                  onClick={() => setPendingConfirmation({ kind: "disable" })}
                >
                  {busyAction === "disable" ? "Disabling…" : "Disable gateway"}
                </Button>
              </div>
            </Card>
          </>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
          >
            {error}
          </div>
        )}
      </div>

      <Modal
        open={pendingConfirmation !== null}
        onClose={() => {
          if (!busyAction) setPendingConfirmation(null);
        }}
        size="md"
      >
        <ModalHeader
          title={confirmationCopy.title}
          subtitle="This changes local gateway access."
          onClose={() => {
            if (!busyAction) setPendingConfirmation(null);
          }}
        />
        <div className="p-6">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            {confirmationCopy.detail}
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busyAction !== null}
              onClick={() => setPendingConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busyAction !== null}
              onClick={() => void confirmGatewayAction()}
            >
              {busyAction ? confirmationCopy.busyLabel : confirmationCopy.confirmLabel}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function GatewayFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate text-[12px] text-[var(--color-text)] ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function gatewayActionError(
  prefix: string,
  caught: unknown,
  recovery: string,
): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const reason = userFacingErrorReason(raw);
  return reason ? `${prefix}: ${reason} ${recovery}` : `${prefix}. ${recovery}`;
}

function gatewayConfirmationCopy(
  confirmation:
    | { kind: "regenerate" }
    | { kind: "revoke"; clientId: string; clientName: string }
    | { kind: "disable" }
    | null,
): { title: string; detail: string; confirmLabel: string; busyLabel: string } {
  if (confirmation?.kind === "regenerate") {
    return {
      title: "Regenerate pairing token?",
      detail:
        "The current token will stop working. Every paired client must pair again with the replacement token.",
      confirmLabel: "Regenerate pairing token",
      busyLabel: "Regenerating…",
    };
  }
  if (confirmation?.kind === "revoke") {
    return {
      title: `Revoke ${confirmation.clientName}?`,
      detail:
        "This client will lose gateway access immediately. It can connect again only after pairing with a valid token.",
      confirmLabel: "Revoke client",
      busyLabel: "Revoking…",
    };
  }
  return {
    title: "Disable gateway?",
    detail:
      "The loopback listener will stop. Existing client records remain available if the gateway is enabled again.",
    confirmLabel: "Disable gateway now",
    busyLabel: "Disabling…",
  };
}

function GeneralSection() {
  const { state, refresh } = useAppState();
  const [schedulerLaunch, setSchedulerLaunch] =
    useState<SchedulerLaunchSettings | null>(null);
  const [companionLaunch, setCompanionLaunch] =
    useState<CompanionLaunchSettings | null>(null);
  const [sandboxSettings, setSandboxSettings] =
    useState<SandboxSettings | null>(null);
  const [runHistoryRetention, setRunHistoryRetention] =
    useState<RunHistoryRetentionSettings | null>(null);
  const [runHistoryDraft, setRunHistoryDraft] =
    useState<RunHistoryRetentionDraft>(() =>
      runHistoryRetentionDraftFromSettings(null),
    );
  const [lastPruneResult, setLastPruneResult] =
    useState<RunHistoryPruneResult | null>(null);
  const [driftRetention, setDriftRetention] =
    useState<DriftRetentionSettings | null>(null);
  const [driftDraft, setDriftDraft] =
    useState<DriftRetentionDraft>(() => driftRetentionDraftFromSettings(null));
  const [lastDriftPruneResult, setLastDriftPruneResult] =
    useState<DriftHistoryPruneResult | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [runHistoryBusy, setRunHistoryBusy] =
    useState<"saving" | "pruning" | null>(null);
  const [driftBusy, setDriftBusy] =
    useState<"saving" | "pruning" | null>(null);
  const [auditExportFormat, setAuditExportFormat] =
    useState<AuditLogExportFormat>("json");
  const [auditExportBusy, setAuditExportBusy] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [runHistoryError, setRunHistoryError] = useState<string | null>(null);
  const [runHistoryNotice, setRunHistoryNotice] = useState<string | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [driftNotice, setDriftNotice] = useState<string | null>(null);
  const [auditExportNotice, setAuditExportNotice] = useState<string | null>(null);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const scheduledCount = state.installedAgents.filter(
    (agent) => agent.schedule?.enabled === true,
  ).length;

  useEffect(() => {
    let cancelled = false;
    const api = window.openAdminOS;
    if (!api) return;
    api
      .getSchedulerLaunchSettings()
      .then((settings) => {
        if (!cancelled) setSchedulerLaunch(settings);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSchedulerError(error instanceof Error ? error.message : String(error));
        }
      });
    api
      .getCompanionLaunchSettings()
      .then((settings) => {
        if (!cancelled) setCompanionLaunch(settings);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCompanionError(error instanceof Error ? error.message : String(error));
        }
      });
    api
      .getSandboxSettings()
      .then((settings) => {
        if (!cancelled) setSandboxSettings(settings);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSandboxError(error instanceof Error ? error.message : String(error));
        }
      });
    api
      .getRunHistoryRetentionSettings()
      .then((settings) => {
        if (!cancelled) {
          setRunHistoryRetention(settings);
          setRunHistoryDraft(runHistoryRetentionDraftFromSettings(settings));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunHistoryError(error instanceof Error ? error.message : String(error));
        }
      });
    api
      .getDriftRetentionSettings()
      .then((settings) => {
        if (!cancelled) {
          setDriftRetention(settings);
          setDriftDraft(driftRetentionDraftFromSettings(settings));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDriftError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSchedulerLaunch = async () => {
    if (!schedulerLaunch?.supported) return;
    setSchedulerBusy(true);
    setSchedulerError(null);
    try {
      const next = await window.openAdminOS?.setSchedulerLaunchEnabled(
        !schedulerLaunch.enabled,
      );
      if (next) setSchedulerLaunch(next);
    } catch (error) {
      setSchedulerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSchedulerBusy(false);
    }
  };

  const toggleCompanionLaunch = async () => {
    if (!companionLaunch?.supported) return;
    setCompanionBusy(true);
    setCompanionError(null);
    try {
      const next = await window.openAdminOS?.setCompanionLaunchEnabled(
        !companionLaunch.enabled,
      );
      if (next) setCompanionLaunch(next);
    } catch (error) {
      setCompanionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompanionBusy(false);
    }
  };

  const toggleSandboxedCode = async () => {
    setSandboxBusy(true);
    setSandboxError(null);
    try {
      const next = await window.openAdminOS?.setSandboxedCodeEnabled(
        !sandboxSettings?.enabled,
      );
      if (next) setSandboxSettings(next);
    } catch (error) {
      setSandboxError(error instanceof Error ? error.message : String(error));
    } finally {
      setSandboxBusy(false);
    }
  };

  const saveRunHistoryRetention = async () => {
    const api = window.openAdminOS;
    if (!api || runHistoryBusy) return;
    if (
      !runHistoryDraft.neverPrune &&
      !runHistoryDraft.keepLastRunsEnabled &&
      !runHistoryDraft.keepDaysEnabled
    ) {
      setRunHistoryError("Enable at least one retention rule, or choose never prune.");
      return;
    }
    setRunHistoryBusy("saving");
    setRunHistoryError(null);
    setRunHistoryNotice(null);
    try {
      const next = await api.setRunHistoryRetentionSettings({
        neverPrune: runHistoryDraft.neverPrune,
        keepLastRuns: runHistoryDraft.keepLastRunsEnabled
          ? runHistoryDraft.keepLastRuns
          : null,
        keepDays: runHistoryDraft.keepDaysEnabled
          ? runHistoryDraft.keepDays
          : null,
      });
      setRunHistoryRetention(next);
      setRunHistoryDraft(runHistoryRetentionDraftFromSettings(next));
      setRunHistoryNotice("Run-history retention saved.");
    } catch (error) {
      setRunHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunHistoryBusy(null);
    }
  };

  const pruneRunHistoryNow = async () => {
    const api = window.openAdminOS;
    if (!api || runHistoryBusy) return;
    setRunHistoryBusy("pruning");
    setRunHistoryError(null);
    setRunHistoryNotice(null);
    try {
      const result = await api.pruneRunHistoryNow();
      setLastPruneResult(result);
      setRunHistoryNotice(result.reason);
      await refresh();
    } catch (error) {
      setRunHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunHistoryBusy(null);
    }
  };

  const saveDriftRetention = async () => {
    const api = window.openAdminOS;
    if (!api || driftBusy) return;
    setDriftBusy("saving");
    setDriftError(null);
    setDriftNotice(null);
    try {
      const next = await api.setDriftRetentionSettings({
        neverPrune: driftDraft.neverPrune,
        keepDays: driftDraft.neverPrune ? null : driftDraft.keepDays,
      });
      setDriftRetention(next);
      setDriftDraft(driftRetentionDraftFromSettings(next));
      setDriftNotice("Change-history retention saved.");
    } catch (error) {
      setDriftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDriftBusy(null);
    }
  };

  const pruneDriftHistoryNow = async () => {
    const api = window.openAdminOS;
    if (!api || driftBusy) return;
    setDriftBusy("pruning");
    setDriftError(null);
    setDriftNotice(null);
    try {
      const result = await api.pruneDriftHistoryNow();
      setLastDriftPruneResult(result);
      setDriftNotice(result.reason);
    } catch (error) {
      setDriftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDriftBusy(null);
    }
  };

  const exportAuditLog = async () => {
    const api = window.openAdminOS;
    if (!api || auditExportBusy) return;
    setAuditExportBusy(true);
    setRunHistoryError(null);
    setRunHistoryNotice(null);
    setAuditExportNotice(null);
    try {
      const exported = await api.exportAuditLog({ format: auditExportFormat });
      const saved = await api.saveTextFile({
        suggestedName: exported.suggestedName,
        content: exported.content,
        filters:
          auditExportFormat === "json"
            ? [{ name: "JSON", extensions: ["json"] }]
            : [{ name: "CSV", extensions: ["csv"] }],
      });
      if (saved.canceled) {
        setAuditExportNotice("Audit log export cancelled.");
        return;
      }
      setAuditExportNotice(
        `Audit log saved locally. ${exported.eventCount.toLocaleString()} events. Final hash ${exported.hashChain.finalHash.slice(0, 12)}...`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunHistoryError(
        `Audit log export failed: ${message} Try again, choose another save location, or narrow the date range through the export API.`,
      );
    } finally {
      setAuditExportBusy(false);
    }
  };

  return (
    <div className="max-w-[720px]">
      <SectionTitle
        title="General"
        subtitle="Defaults that apply across the app."
      />
      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          id="menu-bar-companion"
          description={
            companionLaunch?.supported
              ? companionLaunch.status === "requires-approval"
                ? `${companionLaunch.detail} The companion uses the same local store, active tenant, provider, schedules, and Chat path as the full app.`
                : `${companionLaunch.detail} It opens as a compact macOS status item and routes setup, hosted-provider confirmation, and write review back to the full app.`
              : (companionLaunch?.detail ?? "The menu bar companion is available on macOS only.")
          }
          control={
            <button
              onClick={() => void toggleCompanionLaunch()}
              disabled={!companionLaunch?.supported || companionBusy}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                companionLaunch?.enabled
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25"
                  : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
              } ${!companionLaunch?.supported || companionBusy ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--color-surface-hover)]"}`}
              title={companionLaunch?.detail}
            >
              <IconShield size={10} />
              {companionBusy
                ? "Saving..."
                : companionLaunchLabel(companionLaunch)}
            </button>
          }
        />
        {companionError && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {companionError}
          </div>
        )}
        <SettingRow
          id="experimental-sandboxed-code"
          description={
            sandboxSettings?.enabled
              ? `${formatSandboxValue(sandboxSettings.diagnostics)}. Only code-backed preview agents use MXC; YAML agents keep using the manifest interpreter.`
              : "Off by default. Enables MXC only for built-in code-backed preview agents such as Intune Device Posture Auditor."
          }
          control={
            <button
              onClick={() => void toggleSandboxedCode()}
              disabled={sandboxBusy}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                sandboxSettings?.enabled
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25"
                  : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
              } ${sandboxBusy ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--color-surface-hover)]"}`}
              title={sandboxSettings?.diagnostics.detail}
            >
              <IconShield size={10} />
              {sandboxBusy
                ? "Saving..."
                : sandboxSettings?.enabled
                  ? sandboxSettings.diagnostics.status === "available"
                    ? "Enabled"
                    : "Enabled, unavailable"
                  : "Disabled"}
            </button>
          }
        />
        {sandboxError && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {sandboxError}
          </div>
        )}
        <SettingRow
          id="os-scheduler"
          description={
            schedulerLaunch?.supported
              ? schedulerLaunch.requiresTenant
                ? `Connect a Microsoft 365 tenant before enabling scheduled background runs. ${scheduledCount} active schedule${scheduledCount === 1 ? "" : "s"}.`
                : `${schedulerLaunch.detail} Due schedules run through the signed OpenAdminOS app and write results to local history. ${scheduledCount} active schedule${scheduledCount === 1 ? "" : "s"}.`
              : (schedulerLaunch?.detail ?? "Background launch support is unavailable on this platform.")
          }
          control={
            <button
              onClick={() => void toggleSchedulerLaunch()}
              disabled={!schedulerLaunch?.supported || schedulerLaunch.requiresTenant || schedulerBusy}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                schedulerLaunch?.enabled
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25"
                  : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
              } ${!schedulerLaunch?.supported || schedulerLaunch.requiresTenant || schedulerBusy ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--color-surface-hover)]"}`}
              title={schedulerLaunch?.detail}
            >
              <IconClock size={10} />
              {schedulerBusy
                ? "Saving…"
                : schedulerLaunch?.enabled
                  ? "OS scheduled"
                  : schedulerLaunch?.requiresTenant
                    ? "Tenant required"
                    : "Manual only"}
            </button>
          }
        />
        {schedulerError && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {schedulerError}
          </div>
        )}
        {schedulerLaunch?.supported && (
          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="grid grid-cols-2 gap-3 text-[11px] md:grid-cols-4">
              <ProviderFact label="Last wake" value={schedulerLaunch.lastWakeAt ? formatRelative(schedulerLaunch.lastWakeAt) : "not yet"} />
              <ProviderFact label="Last success" value={schedulerLaunch.lastSuccessAt ? formatRelative(schedulerLaunch.lastSuccessAt) : "not yet"} />
              <ProviderFact label="Next due" value={schedulerLaunch.nextDueAt ? `${schedulerLaunch.nextDueAgentName ?? "Agent"} · ${formatFuture(schedulerLaunch.nextDueAt)}` : "none"} />
              <ProviderFact label="Active" value={`${schedulerLaunch.activeScheduleCount ?? scheduledCount}`} />
            </div>
            {schedulerLaunch.lastError && (
              <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[11.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
                {schedulerLaunch.lastError}
              </div>
            )}
          </div>
        )}
        <SettingRow
          id="default-tenant-scope"
          description={
            activeTenant
              ? "Agents use this tenant unless overridden at run time. Change in Settings → Tenants."
              : "No tenant connected. Connect one from Settings → Tenants."
          }
          control={
            activeTenant ? (
              <Pill tone="success">{activeTenant.displayName}</Pill>
            ) : (
              <Pill tone="warning">None</Pill>
            )
          }
        />
        <SettingRow
          id="destructive-confirmation"
          description="Always on. Cannot be disabled. See the spec for why."
          control={
            <Pill tone="success">
              <IconLock size={10} /> Always on
            </Pill>
          }
        />
        <SettingRow
          id="theme"
          description="OpenAdminOS is dark-only today. A light theme is on the v1.x list."
          control={
            <Pill>
              <StatusDot tone="muted" /> Dark only
            </Pill>
          }
        />
        <SettingRow
          id="run-history-retention"
          description="Pruning removes old run records from local history. Workspace-linked or workspace-pinned runs, queued/running runs, and runs awaiting confirmation are kept. The job runs at startup and on the scheduler tick."
          control={
            <RunHistoryRetentionControls
              draft={runHistoryDraft}
              saved={runHistoryRetention}
              runCount={state.runs.length}
              busy={runHistoryBusy}
              lastResult={lastPruneResult}
              onChange={setRunHistoryDraft}
              onSave={() => void saveRunHistoryRetention()}
              onPruneNow={() => void pruneRunHistoryNow()}
            />
          }
        />
        <SettingRow
          id="change-history"
          description="Pruning removes old local drift snapshots and historical object versions. Current object state is never deleted. The job runs at startup and on the scheduler tick."
          control={
            <DriftRetentionControls
              draft={driftDraft}
              saved={driftRetention}
              busy={driftBusy}
              lastResult={lastDriftPruneResult}
              onChange={setDriftDraft}
              onSave={() => void saveDriftRetention()}
              onPruneNow={() => void pruneDriftHistoryNow()}
            />
          }
        />
        <SettingRow
          id="audit-log-export"
          description="Exports retained run history, write-confirmation events, connector delivery audit entries, and recorded hosted-provider consent acknowledgements. Old run records may already be absent because of retention."
          control={
            <AuditLogExportControls
              format={auditExportFormat}
              busy={auditExportBusy}
              onFormatChange={setAuditExportFormat}
              onExport={() => void exportAuditLog()}
            />
          }
        />
        {(runHistoryError || runHistoryNotice || driftError || driftNotice || auditExportNotice) && (
          <div
            role={runHistoryError || driftError ? "alert" : "status"}
            aria-live={runHistoryError || driftError ? "assertive" : "polite"}
            className={`rounded-lg px-3 py-2 text-[12px] ring-1 ${
              runHistoryError || driftError
                ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30"
                : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-[var(--color-border-soft)]"
            }`}
          >
            {runHistoryError ?? driftError ?? runHistoryNotice ?? driftNotice ?? auditExportNotice}
          </div>
        )}
      </div>
    </div>
  );
}

function RunHistoryRetentionControls({
  draft,
  saved,
  runCount,
  busy,
  lastResult,
  onChange,
  onSave,
  onPruneNow,
}: {
  draft: RunHistoryRetentionDraft;
  saved: RunHistoryRetentionSettings | null;
  runCount: number;
  busy: "saving" | "pruning" | null;
  lastResult: RunHistoryPruneResult | null;
  onChange: (draft: RunHistoryRetentionDraft) => void;
  onSave: () => void;
  onPruneNow: () => void;
}) {
  const controlsDisabled = busy !== null || draft.neverPrune;
  const valid =
    draft.neverPrune || draft.keepLastRunsEnabled || draft.keepDaysEnabled;

  return (
    <div className="w-[430px] max-w-[52vw] space-y-2 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <Pill tone={draft.neverPrune ? "warning" : "default"}>
          {draft.neverPrune ? "Never prune" : runHistoryRetentionSummary(saved)}
        </Pill>
        <span className="text-[var(--color-text-muted)]">
          {runCount.toLocaleString()} records
        </span>
      </div>

      <label
        htmlFor="run-history-never-prune"
        className="flex items-center gap-2 rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
      >
        <input
          id="run-history-never-prune"
          name="run-history-never-prune"
          type="checkbox"
          checked={draft.neverPrune}
          disabled={busy !== null}
          onChange={(event) =>
            onChange({ ...draft, neverPrune: event.currentTarget.checked })
          }
        />
        <span>Never prune</span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <div
          className={`rounded-md bg-[var(--color-bg-raised)] p-2 ring-1 ring-[var(--color-border-soft)] ${
            controlsDisabled ? "opacity-60" : ""
          }`}
        >
          <label
            htmlFor="run-history-keep-last-runs-enabled"
            className="flex items-center gap-2 text-[var(--color-text-soft)]"
          >
            <input
              id="run-history-keep-last-runs-enabled"
              name="run-history-keep-last-runs-enabled"
              type="checkbox"
              checked={draft.keepLastRunsEnabled}
              disabled={controlsDisabled}
              onChange={(event) =>
                onChange({
                  ...draft,
                  keepLastRunsEnabled: event.currentTarget.checked,
                })
              }
            />
            Keep newest
          </label>
          <label htmlFor="run-history-keep-last-runs" className="sr-only">
            Runs to keep
          </label>
          <input
            id="run-history-keep-last-runs"
            name="run-history-keep-last-runs"
            type="number"
            min={1}
            max={100000}
            inputMode="numeric"
            value={draft.keepLastRuns}
            disabled={controlsDisabled || !draft.keepLastRunsEnabled}
            onChange={(event) =>
              onChange({
                ...draft,
                keepLastRuns: boundedRetentionValue(
                  event.currentTarget.valueAsNumber,
                  draft.keepLastRuns,
                  1,
                  100_000,
                ),
              })
            }
            className="mt-2 h-7 w-full rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div
          className={`rounded-md bg-[var(--color-bg-raised)] p-2 ring-1 ring-[var(--color-border-soft)] ${
            controlsDisabled ? "opacity-60" : ""
          }`}
        >
          <label
            htmlFor="run-history-keep-days-enabled"
            className="flex items-center gap-2 text-[var(--color-text-soft)]"
          >
            <input
              id="run-history-keep-days-enabled"
              name="run-history-keep-days-enabled"
              type="checkbox"
              checked={draft.keepDaysEnabled}
              disabled={controlsDisabled}
              onChange={(event) =>
                onChange({
                  ...draft,
                  keepDaysEnabled: event.currentTarget.checked,
                })
              }
            />
            Keep newer than
          </label>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="run-history-keep-days" className="sr-only">
              Run age days to keep
            </label>
            <input
              id="run-history-keep-days"
              name="run-history-keep-days"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={draft.keepDays}
              disabled={controlsDisabled || !draft.keepDaysEnabled}
              onChange={(event) =>
                onChange({
                  ...draft,
                  keepDays: boundedRetentionValue(
                    event.currentTarget.valueAsNumber,
                    draft.keepDays,
                    1,
                    3_650,
                  ),
                })
              }
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            <span className="text-[var(--color-text-muted)]">days</span>
          </div>
        </div>
      </div>

      <div className="text-[10.5px] leading-4 text-[var(--color-text-muted)]">
        Deletes only records outside every enabled rule. Keeps workspace evidence,
        queued/running runs, and write confirmations.
      </div>

      {lastResult && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[10.5px] leading-4 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
        >
          {formatRunHistoryPruneResult(lastResult)}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null || !valid}
          onClick={onSave}
        >
          {busy === "saving" ? "Saving" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<IconRefresh size={12} />}
          disabled={busy !== null}
          onClick={onPruneNow}
        >
          {busy === "pruning" ? "Pruning" : "Prune now"}
        </Button>
      </div>
    </div>
  );
}

function DriftRetentionControls({
  draft,
  saved,
  busy,
  lastResult,
  onChange,
  onSave,
  onPruneNow,
}: {
  draft: DriftRetentionDraft;
  saved: DriftRetentionSettings | null;
  busy: "saving" | "pruning" | null;
  lastResult: DriftHistoryPruneResult | null;
  onChange: (draft: DriftRetentionDraft) => void;
  onSave: () => void;
  onPruneNow: () => void;
}) {
  const controlsDisabled = busy !== null || draft.neverPrune;
  const retentionCopy = draft.neverPrune
    ? "Configuration change history is kept locally until you change this setting. Current object state is never deleted."
    : `Configuration change history is kept locally for ${draft.keepDays.toLocaleString()} days. Current object state is never deleted.`;

  return (
    <div className="w-[430px] max-w-[52vw] space-y-2 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <Pill tone={draft.neverPrune ? "warning" : "default"}>
          {driftRetentionSummary(saved)}
        </Pill>
        <span className="text-[var(--color-text-muted)]">local snapshots</span>
      </div>

      <label
        htmlFor="drift-never-prune"
        className="flex items-center gap-2 rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
      >
        <input
          id="drift-never-prune"
          name="drift-never-prune"
          type="checkbox"
          checked={draft.neverPrune}
          disabled={busy !== null}
          onChange={(event) =>
            onChange({ ...draft, neverPrune: event.currentTarget.checked })
          }
        />
        <span>Never prune</span>
      </label>

      <div
        className={`rounded-md bg-[var(--color-bg-raised)] p-2 ring-1 ring-[var(--color-border-soft)] ${
          controlsDisabled ? "opacity-60" : ""
        }`}
      >
        <label
          htmlFor="drift-keep-days"
          className="block text-[var(--color-text-soft)]"
        >
          Retention days
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="drift-keep-days"
            name="drift-keep-days"
            type="number"
            min={30}
            max={730}
            inputMode="numeric"
            value={draft.keepDays}
            disabled={controlsDisabled}
            onChange={(event) =>
              onChange({
                ...draft,
                keepDays: boundedRetentionValue(
                  event.currentTarget.valueAsNumber,
                  draft.keepDays,
                  30,
                  730,
                ),
              })
            }
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-[var(--color-text-muted)]">days</span>
        </div>
      </div>

      <div className="text-[10.5px] leading-4 text-[var(--color-text-muted)]">
        {retentionCopy}
      </div>

      {lastResult && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[10.5px] leading-4 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
        >
          {formatDriftPruneResult(lastResult)}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label="Save change-history retention"
          disabled={busy !== null}
          onClick={onSave}
        >
          {busy === "saving" ? "Saving" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Prune change history now"
          leadingIcon={<IconRefresh size={12} />}
          disabled={busy !== null}
          onClick={onPruneNow}
        >
          {busy === "pruning" ? "Pruning" : "Prune now"}
        </Button>
      </div>
    </div>
  );
}

function AuditLogExportControls({
  format,
  busy,
  onFormatChange,
  onExport,
}: {
  format: AuditLogExportFormat;
  busy: boolean;
  onFormatChange: (format: AuditLogExportFormat) => void;
  onExport: () => void;
}) {
  return (
    <div className="w-[430px] max-w-[52vw] space-y-2 text-[11px]">
      <div
        role="group"
        aria-label="Audit log export format"
        className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--color-bg)] p-1 ring-1 ring-[var(--color-border-soft)]"
      >
        {(["json", "csv"] satisfies AuditLogExportFormat[]).map((option) => {
          const active = format === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              disabled={busy}
              onClick={() => onFormatChange(option)}
              className={`h-7 rounded-md text-[11.5px] font-medium uppercase tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                active
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              } ${busy ? "opacity-60" : ""}`}
            >
              {option}
            </button>
          );
        })}
      </div>
      <div className="rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[10.5px] leading-4 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
        Saved through the local file dialog. Nothing is uploaded. CSV includes the
        per-entry hash; JSON includes the full hash-chain header.
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<IconHash size={12} />}
          disabled={busy}
          onClick={onExport}
        >
          {busy ? "Exporting" : "Export audit log"}
        </Button>
      </div>
    </div>
  );
}

function PrivacySection({
  trust,
  registrySource,
  registryRefreshError,
  lastRegistryRefresh,
  registryInstallCountsEnabled,
  usageTelemetryEnabled,
  onSetRegistrySource,
  onSetRegistryInstallCountsEnabled,
  onSetUsageTelemetryEnabled,
}: {
  trust: TrustState;
  registrySource: string;
  registryRefreshError: string | null;
  lastRegistryRefresh: string | null;
  registryInstallCountsEnabled: boolean;
  usageTelemetryEnabled: boolean;
  onSetRegistrySource: (
    url: string,
    options?: { confirmExternalSource?: boolean },
  ) => Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }>;
  onSetRegistryInstallCountsEnabled: (enabled: boolean) => Promise<void>;
  onSetUsageTelemetryEnabled: (enabled: boolean) => Promise<void>;
}) {
  const platform = window.openAdminOS?.platform ?? "unknown";
  const [savingInstallCounts, setSavingInstallCounts] = useState(false);
  const [installCountsError, setInstallCountsError] = useState<string | null>(null);
  const [registryModalOpen, setRegistryModalOpen] = useState(false);
  const [telemetryPreview, setTelemetryPreview] = useState<{
    enabled: boolean;
    endpointConfigured: boolean;
    payload: UsageTelemetryPayload;
  } | null>(null);
  const [telemetryPreviewLoading, setTelemetryPreviewLoading] = useState(true);
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryTestSending, setTelemetryTestSending] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetryTestResult, setTelemetryTestResult] = useState<string | null>(null);
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatus | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(true);
  const [retrievalRefreshing, setRetrievalRefreshing] = useState(false);
  const [retrievalInstalling, setRetrievalInstalling] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const isOfficialRegistry = isOfficialRegistrySource(registrySource);
  const telemetryToggleAvailable = Boolean(
    window.openAdminOS?.setUsageTelemetryEnabled,
  );

  const loadTelemetryPreview = useCallback(async () => {
    const getPreview = window.openAdminOS?.getUsageTelemetryPreview;
    setTelemetryPreviewLoading(true);
    setTelemetryError(null);
    if (!getPreview) {
      setTelemetryPreview(null);
      setTelemetryError("The exact telemetry preview is unavailable in this build.");
      setTelemetryPreviewLoading(false);
      return;
    }

    try {
      setTelemetryPreview(await getPreview());
    } catch (error) {
      setTelemetryError(
        error instanceof Error
          ? error.message
          : "The exact telemetry preview could not be loaded.",
      );
    } finally {
      setTelemetryPreviewLoading(false);
    }
  }, []);

  const loadRetrievalStatus = useCallback(async () => {
    const getStatus = window.openAdminOS?.getRetrievalStatus;
    setRetrievalLoading(true);
    setRetrievalError(null);
    if (!getStatus) {
      setRetrievalStatus({
        available: false,
        reason: "Documentation retrieval is unavailable in this build.",
      });
      setRetrievalLoading(false);
      return;
    }

    try {
      setRetrievalStatus(await getStatus());
    } catch (error) {
      setRetrievalStatus(null);
      setRetrievalError(
        error instanceof Error
          ? error.message
          : "The documentation index status could not be checked.",
      );
    } finally {
      setRetrievalLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTelemetryPreview();
  }, [loadTelemetryPreview, usageTelemetryEnabled]);

  useEffect(() => {
    void loadRetrievalStatus();
  }, [loadRetrievalStatus]);

  const toggleUsageTelemetry = async () => {
    setTelemetrySaving(true);
    setTelemetryError(null);
    setTelemetryTestResult(null);
    try {
      await onSetUsageTelemetryEnabled(!usageTelemetryEnabled);
    } catch (error) {
      setTelemetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTelemetrySaving(false);
    }
  };

  const sendTelemetryTest = async () => {
    const sendTest = window.openAdminOS?.sendUsageTelemetryTest;
    if (!sendTest) {
      setTelemetryTestResult("Test pings are unavailable in this build.");
      return;
    }

    setTelemetryTestSending(true);
    setTelemetryError(null);
    setTelemetryTestResult(null);
    try {
      const result = await sendTest();
      setTelemetryTestResult(
        result.sent ? "Test ping sent." : "Test ping was not sent.",
      );
    } catch (error) {
      setTelemetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTelemetryTestSending(false);
    }
  };

  const refreshRetrievalStatus = async () => {
    const refreshIndex = window.openAdminOS?.refreshRetrievalIndex;
    if (!refreshIndex) {
      setRetrievalError("Documentation index refresh is unavailable in this build.");
      return;
    }

    setRetrievalRefreshing(true);
    setRetrievalError(null);
    try {
      setRetrievalStatus(await refreshIndex());
    } catch (error) {
      setRetrievalError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrievalRefreshing(false);
    }
  };

  const installRetrievalIndex = async (source: "download" | "folder" = "download") => {
    const install = window.openAdminOS?.installRetrievalIndex;
    if (!install || retrievalInstalling) return;
    setRetrievalInstalling(true);
    setRetrievalError(null);
    try {
      // No argument opens a folder picker in the host. An index copied
      // onto the machine works without any network access, which is the
      // only option some tenants allow.
      // "download" fetches the published release asset; "folder" opens a
      // picker in the host so an air-gapped machine can install a copy.
      setRetrievalStatus(await install(source === "download" ? { source } : {}));
    } catch (caught) {
      setRetrievalError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRetrievalInstalling(false);
    }
  };

  const toggleRegistryInstallCounts = async () => {
    setSavingInstallCounts(true);
    setInstallCountsError(null);
    try {
      await onSetRegistryInstallCountsEnabled(!registryInstallCountsEnabled);
    } catch (error) {
      setInstallCountsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingInstallCounts(false);
    }
  };

  return (
    <div className="max-w-[720px]">
      <SectionTitle
        title="Privacy"
        subtitle="OpenAdminOS is local-first by design. Here's the truth about where your data goes."
      />
      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          id="tenant-telemetry"
          description="Tenant data, prompts, run results, and error-reporting data are never collected. Optional usage telemetry and aggregate registry install counts are controlled separately below. Crash logs stay on this device."
          control={
            <Pill tone="success">
              <StatusDot tone="success" /> Not collected
            </Pill>
          }
        />
        <Card>
          <section aria-labelledby="usage-telemetry-title">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-soft)] px-5 py-4">
              <div className="min-w-0 max-w-[520px]">
                <h3
                  id="usage-telemetry-title"
                  className="text-[13px] font-medium text-[var(--color-text)]"
                >
                  Usage telemetry
                </h3>
                <p
                  id="usage-telemetry-description"
                  className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]"
                >
                  Tenant, agent, and run counts are converted to bucketed ranges on
                  this device. Tenant content, prompts, and results are never sent.
                  Nothing is sent unless this setting is on and this build has a
                  collector configured.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  {usageTelemetryEnabled ? "On" : "Off"}
                </span>
                <SettingsSwitch
                  checked={usageTelemetryEnabled}
                  disabled={!telemetryToggleAvailable || telemetrySaving}
                  label="Usage telemetry"
                  describedBy="usage-telemetry-description"
                  onClick={() => void toggleUsageTelemetry()}
                />
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-soft)]">
                  Exactly what a ping contains
                </h4>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  counts and versions only
                </span>
              </div>
              <OutputJsonBlock
                value={telemetryPreview?.payload ?? null}
                copyLabel="Copy telemetry payload"
                className="mt-2"
              />
              {telemetryPreviewLoading && (
                <p
                  role="status"
                  className="mt-2 text-[11px] text-[var(--color-text-muted)]"
                >
                  Loading exact payload…
                </p>
              )}
              {telemetryPreview && !telemetryPreview.endpointConfigured && (
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  This build has no telemetry collector configured, so nothing is
                  sent even when this is on.
                </p>
              )}
              {telemetryError && (
                <div
                  role="alert"
                  className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
                >
                  {telemetryError}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-[420px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  A test ping sends the preview once. It does not change this setting.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={
                    !usageTelemetryEnabled ||
                    !telemetryPreview?.endpointConfigured ||
                    telemetryTestSending
                  }
                  onClick={() => void sendTelemetryTest()}
                >
                  {telemetryTestSending ? "Sending…" : "Send a test ping"}
                </Button>
              </div>
              {telemetryTestResult && (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-2 text-right text-[11px] text-[var(--color-text-soft)]"
                >
                  {telemetryTestResult}
                </p>
              )}
            </div>
          </section>
        </Card>
        <SettingRow
          id="registry-install-counts"
          description="When enabled, installing a public registry agent sends only agent slug, app version, platform, and a yearly per-agent hash for aggregate counts. No tenant data, prompts, run results, or Graph data are sent."
          control={
            <button
              onClick={() => void toggleRegistryInstallCounts()}
              disabled={savingInstallCounts}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                registryInstallCountsEnabled
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25"
                  : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
              } ${savingInstallCounts ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--color-surface-hover)]"}`}
            >
              <StatusDot tone={registryInstallCountsEnabled ? "success" : "muted"} />
              {savingInstallCounts
                ? "Saving..."
                : registryInstallCountsEnabled
                  ? "Enabled"
                  : "Disabled"}
            </button>
          }
        />
        {installCountsError && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {installCountsError}
          </div>
        )}
        <SettingRow
          id="agent-registry-source"
          description={
            registryRefreshError
              ? `Using cache or bundled agents after the last refresh failed. Source: ${formatRegistrySource(registrySource)}.`
              : lastRegistryRefresh
                ? `Last refreshed ${formatRelative(lastRegistryRefresh)} from ${formatRegistrySource(registrySource)}.`
                : `No registry refresh recorded yet. Source: ${formatRegistrySource(registrySource)}.`
          }
          control={
            <div className="flex items-center gap-2">
              <Pill tone={isOfficialRegistry ? "success" : "warning"}>
                <StatusDot tone={isOfficialRegistry ? "success" : "warning"} />
                {isOfficialRegistry ? "Official" : "Custom"}
              </Pill>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setRegistryModalOpen(true)}
              >
                Change
              </Button>
            </div>
          }
        />
        {registryRefreshError && (
          <div className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/30">
            {registryRefreshError}
          </div>
        )}
        <Card>
          <section aria-labelledby="documentation-grounding-title" className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 max-w-[520px]">
                <h3
                  id="documentation-grounding-title"
                  className="text-[13px] font-medium text-[var(--color-text)]"
                >
                  Documentation grounding
                </h3>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  Retrieval grounds answers in local Microsoft documentation. It runs
                  on this device and never sends the question to a remote service when
                  a local provider is selected.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leadingIcon={<IconRefresh size={12} />}
                disabled={
                  retrievalLoading ||
                  retrievalRefreshing ||
                  !window.openAdminOS?.refreshRetrievalIndex
                }
                onClick={() => void refreshRetrievalStatus()}
              >
                {retrievalRefreshing
                  ? "Checking…"
                  : retrievalStatus?.available
                    ? "Refresh"
                    : "Check for index"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={
                  retrievalLoading ||
                  retrievalInstalling ||
                  !window.openAdminOS?.installRetrievalIndex
                }
                onClick={() => void installRetrievalIndex("download")}
              >
                {retrievalInstalling ? "Installing…" : "Download index"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={
                  retrievalLoading ||
                  retrievalInstalling ||
                  !window.openAdminOS?.installRetrievalIndex
                }
                onClick={() => void installRetrievalIndex("folder")}
              >
                Install from folder…
              </Button>
            </div>

            <div aria-live="polite" aria-busy={retrievalLoading || retrievalRefreshing}>
              {retrievalLoading ? (
                <div
                  role="status"
                  className="mt-4 rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
                >
                  Checking the local documentation index…
                </div>
              ) : retrievalStatus?.available ? (
                <div className="mt-4">
                  <Pill tone="success">
                    <StatusDot tone="success" /> Available
                  </Pill>
                  {retrievalStatus.updateAvailable ? (
                    <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
                      Version {retrievalStatus.updateAvailable} is available and
                      installs automatically in the background.
                    </p>
                  ) : null}
                  <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <RetrievalDetail
                      label="Version"
                      value={retrievalStatus.version ?? "Not recorded"}
                    />
                    <RetrievalDetail
                      label="Built"
                      value={
                        retrievalStatus.builtAt
                          ? formatRetrievalBuildDate(retrievalStatus.builtAt)
                          : "Not recorded"
                      }
                      dateTime={retrievalStatus.builtAt}
                    />
                    <RetrievalDetail
                      label="Chunks"
                      value={
                        retrievalStatus.chunkCount === undefined
                          ? "Not recorded"
                          : retrievalStatus.chunkCount.toLocaleString()
                      }
                    />
                    <RetrievalDetail
                      label="Embedding model"
                      value={retrievalStatus.embeddingModel ?? "Not recorded"}
                      mono
                    />
                  </dl>
                </div>
              ) : (
                <div className="mt-4 rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-text-soft)]">
                    <StatusDot tone="muted" /> Not documentation-grounded yet
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    {retrievalStatus?.reason ??
                      "No local documentation index is available yet."}
                  </p>
                </div>
              )}
            </div>
            {retrievalError && (
              <div
                role="alert"
                className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
              >
                {retrievalError}
              </div>
            )}
          </section>
        </Card>
        <SettingRow
          id="crash-reporting"
          description="No crash reports are sent. Errors stay local."
          control={
            <Pill tone="success">
              <StatusDot tone="success" /> Not collected
            </Pill>
          }
        />
        <SettingRow
          id="tenant-data-residency"
          description="Where the active provider sends prompts and tenant data."
          control={
            <Pill tone={trust.isLocal ? "success" : "warning"}>
              <IconHardDrive size={10} /> {trust.label}
            </Pill>
          }
        />
        <SettingRow
          id="graph-writes"
          description="Write-mode agents always call Microsoft Graph for real when a tenant is connected. There is no global toggle — every write run pauses for a typed-phrase confirmation against the live diff, which is the only place to authorize a change."
          control={
            <Pill tone="warning">
              <StatusDot tone="warning" /> Confirmed per run
            </Pill>
          }
        />
        <SettingRow
          id="update-channel"
          description={
            platform === "linux"
              ? "Stable-only. Linux updates are installed through the signed apt repository or by downloading the next package; the app does not replace unsigned Linux executables automatically."
              : platform === "windows"
                ? "Stable-only, never pre-releases. Microsoft Store builds update through the Store. Other signed builds check the release channel, download the update in the background, then ask before restarting. If you choose Later it is applied the next time you quit."
                : "Stable-only, never pre-releases. Signed builds check the release channel on launch and every four hours, download the update in the background, then ask before restarting. If you choose Later it is applied the next time you quit."
          }
          control={
            <Pill tone="success">
              <StatusDot tone="success" /> Stable
            </Pill>
          }
        />
      </div>

      <div className="mt-8 rounded-xl bg-[var(--color-success-soft)] p-5 ring-1 ring-[var(--color-success)]/25">
        <div className="flex items-center gap-2">
          <IconShield size={14} className="text-[var(--color-success)]" />
          <span className="text-[12px] font-medium text-[var(--color-success)]">
            {trust.label}
          </span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
          {trust.detail}
        </p>
      </div>
      <RegistrySourceModal
        open={registryModalOpen}
        currentSource={registrySource}
        onClose={() => setRegistryModalOpen(false)}
        onSave={onSetRegistrySource}
      />
    </div>
  );
}

function SettingsSwitch({
  checked,
  disabled,
  label,
  describedBy,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  describedBy?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-10 rounded-full ring-1 transition-colors duration-150 enabled:hover:ring-[var(--color-accent)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "bg-[var(--color-accent)] ring-[var(--color-accent)]"
          : "bg-[var(--color-bg-raised)] ring-[var(--color-border-strong)]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-1 top-1 h-4 w-4 rounded-full transition-transform duration-150 ${
          checked
            ? "translate-x-4 bg-[var(--color-on-accent)]"
            : "translate-x-0 bg-[var(--color-text-muted)]"
        }`}
      />
    </button>
  );
}

function RetrievalDetail({
  label,
  value,
  dateTime,
  mono = false,
}: {
  label: string;
  value: string;
  dateTime?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </dt>
      <dd
        className={`mt-1 break-words text-[11px] text-[var(--color-text-soft)] ${mono ? "font-mono" : ""}`}
      >
        {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
      </dd>
    </div>
  );
}

function RegistrySourceModal({
  open,
  currentSource,
  onClose,
  onSave,
}: {
  open: boolean;
  currentSource: string;
  onClose: () => void;
  onSave: (
    url: string,
    options?: { confirmExternalSource?: boolean },
  ) => Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }>;
}) {
  const [draft, setDraft] = useState(currentSource);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(currentSource);
    setConfirmed(false);
    setError(null);
    setNotice(null);
  }, [open]);

  const trimmedDraft = draft.trim();
  const customSource = trimmedDraft.length > 0 && !isOfficialRegistrySource(trimmedDraft);
  const changed =
    normalizeRegistrySourceForComparison(trimmedDraft) !==
    normalizeRegistrySourceForComparison(currentSource);
  const canSave = trimmedDraft.length > 0 && changed && (!customSource || confirmed) && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await onSave(trimmedDraft, {
        confirmExternalSource: customSource,
      });
      if (result.error) {
        setNotice(
          `Source saved, but the refresh did not complete: ${result.error}`,
        );
      } else if (result.fromCache) {
        setNotice("Source saved. OpenAdminOS is using the cached registry index.");
      } else {
        onClose();
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Agent registry source"
        subtitle="Choose where OpenAdminOS reads agent metadata and updates."
        onClose={onClose}
        badge={
          <Pill tone={customSource ? "warning" : "success"}>
            <StatusDot tone={customSource ? "warning" : "success"} />
            {customSource ? "Custom source" : "Official source"}
          </Pill>
        }
      />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5 p-6">
        <div>
          <label
            htmlFor="registry-source"
            className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
          >
            Registry URL
          </label>
          <input
            id="registry-source"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setConfirmed(false);
              setError(null);
              setNotice(null);
            }}
            spellCheck={false}
            className="mt-2 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
            placeholder={OFFICIAL_REGISTRY_SOURCE}
          />
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Point to the agent directory. The host app fetches `index.json` from this
            location after validation.
          </p>
        </div>

        <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex items-start gap-2">
            <IconShield size={14} className="mt-0.5 text-[var(--color-text-muted)]" />
            <div>
              <div className="text-[12px] font-medium text-[var(--color-text)]">
                What changes when this changes
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                Tenant data does not go to the registry. The source controls which
                agent manifests, versions, Graph scopes, and update metadata the app
                shows to the admin.
              </p>
            </div>
          </div>
        </div>

        {customSource && (
          <div className="rounded-lg bg-[var(--color-warning-soft)] p-3 ring-1 ring-[var(--color-warning)]/30">
            <div className="flex items-start gap-2">
              <IconWarning size={14} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              <div>
                <div className="text-[12px] font-medium text-[var(--color-warning)]">
                  Review this source before using it
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  Custom registries can advertise agents with different Graph scopes,
                  write actions, connector egress, and update requirements. Install
                  and update flows still run their normal trust review.
                </p>
              </div>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)] bg-[var(--color-bg-raised)] accent-[var(--color-accent)]"
              />
              <span>
                I trust this registry source and understand it changes the agent
                catalog OpenAdminOS will read from.
              </span>
            </label>
          </div>
        )}

        <div className="rounded-lg bg-[var(--color-surface)] p-3 text-[12px] leading-relaxed text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          Host validation requires HTTPS, rejects credentials, query strings,
          fragments, and `index.json` paths, and only allows private or localhost
          sources when the explicit dev registry override is enabled.
        </div>

        {error && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {userFacingErrorReason(error) ??
              "Registry settings could not be updated. Review the source, then try again."}
          </div>
        )}
        {notice && (
          <div className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/30">
            {notice}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(OFFICIAL_REGISTRY_SOURCE);
              setConfirmed(false);
              setError(null);
              setNotice(null);
            }}
          >
            <IconExternal size={13} />
            Use official
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              <IconRefresh size={13} />
              {saving ? "Saving..." : "Save source"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function AboutSection() {
  const { openSetup } = useSetupFlow();
  const { state } = useAppState();
  const openReportIssue = useReportIssue();
  const [diagnostics, setDiagnostics] = useState<ReleaseDiagnostics | null>(null);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const codexProvider = state.providers.find((provider) => provider.id === "openai");
  const ollamaProvider = state.providers.find((provider) => provider.id === "ollama");
  const activeModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const codexModel = resolveProviderDefaultModel(
    codexProvider,
    state.activeModelByProviderId,
  ).model;
  const ollamaModel = resolveProviderDefaultModel(
    ollamaProvider,
    state.activeModelByProviderId,
  ).model;

  useEffect(() => {
    window.openAdminOS
      ?.getReleaseDiagnostics()
      .then(setDiagnostics)
      .catch(() => setDiagnostics(null));
  }, []);

  return (
    <div className="max-w-[820px]">
      <SectionTitle title="About" subtitle="OpenAdminOS is open-source and community-driven." />
      <div className="mt-6 grid grid-cols-2 gap-3">
        <Stat label="Version" value={__APP_VERSION__} mono />
        <Stat label="License" value="MIT" />
        <Stat label="Repo" value="OpenAdminOS/OpenAdminOS" mono />
        <Stat label="Built by" value="OpenAdminOS" />
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={openSetup}
        >
          Connect tenant
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void window.openAdminOS?.openExternal(
              "https://github.com/OpenAdminOS/OpenAdminOS",
            );
          }}
        >
          View on GitHub
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void window.openAdminOS?.openExternal(
              "https://github.com/OpenAdminOS/OpenAdminOS/blob/main/CHANGELOG.md",
            );
          }}
        >
          What's new
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            openReportIssue({
              source: "settings-about",
              title: "OpenAdminOS issue",
              description:
                "I found an issue while using OpenAdminOS. Details are below.",
            })
          }
        >
          Create issue
        </Button>
      </div>

      <div className="mt-8">
        <SectionTitle
          title="0.2 readiness"
          subtitle="Local diagnostics for release checks and support. They only leave this device when included in a confirmed public issue."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <ReadinessRow
            label="Build"
            value={diagnostics?.packaged ? "Packaged app" : "Dev run"}
            tone={diagnostics?.packaged ? "success" : "warning"}
            detail={
              diagnostics?.signed
                ? "Signed/notarized build expected."
                : "Running through Electron dev tooling."
            }
          />
          <ReadinessRow
            label="Notifications"
            value={
              diagnostics?.notificationSupported
                ? diagnostics.notificationPermission === "granted"
                  ? "Available"
                  : `Permission ${diagnostics.notificationPermission}`
                : "Unavailable"
            }
            tone={diagnostics?.notificationSupported ? "success" : "danger"}
            detail="Scheduled runs use native OS notifications when allowed."
          />
          <ReadinessRow
            label="OS scheduler"
            value={
              diagnostics?.scheduler.enabled
                ? "Registered"
                : diagnostics?.scheduler.requiresTenant
                  ? "Tenant required"
                  : "Manual only"
            }
            tone={diagnostics?.scheduler.enabled ? "success" : "warning"}
            detail={diagnostics?.scheduler.detail ?? "Scheduler state unavailable."}
          />
          <ReadinessRow
            label="Menu bar"
            value={companionLaunchLabel(diagnostics?.companion)}
            tone={companionLaunchTone(diagnostics?.companion)}
            detail={diagnostics?.companion.detail ?? "Menu bar companion diagnostics unavailable."}
          />
          <ReadinessRow
            label="Agent sandbox"
            value={formatSandboxValue(diagnostics?.sandbox)}
            tone={sandboxTone(diagnostics?.sandbox)}
            detail={formatSandboxDetail(diagnostics?.sandbox)}
          />
          <ReadinessRow
            label="Active tenant"
            value={activeTenant?.displayName ?? "None"}
            tone={activeTenant ? "success" : "danger"}
            detail={activeTenant?.username ?? "Connect a tenant before running agents."}
          />
          <ReadinessRow
            label="Active LLM"
            value={
              activeProvider
                ? `${activeProvider.name}${activeModel ? ` · ${activeModel}` : ""}`
                : state.activeProviderId
            }
            tone={activeProvider?.status === "connected" ? "success" : "warning"}
            detail={state.trust.label}
          />
          <ReadinessRow
            label="OpenAI Codex"
            value={codexProvider?.status === "connected" ? "Detected" : "Not connected"}
            tone={codexProvider?.status === "connected" ? "success" : "warning"}
            detail={codexModel ?? codexProvider?.detail ?? "Codex CLI not detected."}
          />
          <ReadinessRow
            label="Ollama"
            value={ollamaProvider?.status === "connected" ? "Detected" : "Not connected"}
            tone={ollamaProvider?.status === "connected" ? "success" : "warning"}
            detail={ollamaModel ?? ollamaProvider?.detail ?? "Ollama is not running."}
          />
          <ReadinessRow
            label="Registry"
            value={state.registryRefreshError ? "Using cache" : "Ready"}
            tone={state.registryRefreshError ? "warning" : "success"}
            detail={
              state.lastRegistryRefresh
                ? `Last refreshed ${formatRelative(state.lastRegistryRefresh)} from ${formatRegistrySource(state.registrySource)}.`
                : `No registry refresh recorded yet. Source: ${formatRegistrySource(state.registrySource)}.`
            }
          />
          <ReadinessRow
            label="Registry install counts"
            value={state.registryInstallCountsEnabled ? "Enabled" : "Disabled"}
            tone={state.registryInstallCountsEnabled ? "success" : "warning"}
            detail="Sends agent slug, app version, platform, and a yearly per-agent hash for aggregate public registry stats."
          />
        </div>
      </div>
    </div>
  );
}

function ReadinessRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "success" | "warning" | "danger";
}) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {label}
        </div>
        <StatusDot tone={tone} />
      </div>
      <div className="mt-1 truncate text-[13.5px] font-medium text-[var(--color-text)]">
        {value}
      </div>
      <div className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
        {detail}
      </div>
    </div>
  );
}

function companionLaunchLabel(
  companion: CompanionLaunchSettings | null | undefined,
): string {
  if (!companion) return "Unknown";
  if (!companion.supported) return "macOS only";
  if (companion.status === "requires-approval") return "Approval needed";
  return companion.enabled ? "Launch at login" : "Manual";
}

function companionLaunchTone(
  companion: CompanionLaunchSettings | null | undefined,
): "success" | "warning" | "danger" {
  if (!companion?.supported) return "warning";
  if (companion.status === "requires-approval") return "warning";
  return companion.enabled ? "success" : "warning";
}

function formatSandboxValue(
  sandbox: ReleaseDiagnostics["sandbox"] | undefined,
): string {
  if (!sandbox) return "Unknown";
  if (sandbox.status === "disabled") return "Disabled";
  if (sandbox.status === "available") {
    return sandbox.containment ? `MXC ${sandbox.containment}` : "MXC available";
  }
  if (sandbox.status === "unavailable") return "Unavailable";
  return "Probe error";
}

function sandboxTone(
  sandbox: ReleaseDiagnostics["sandbox"] | undefined,
): "success" | "warning" | "danger" {
  if (!sandbox) return "warning";
  if (sandbox.status === "available") return "success";
  if (sandbox.status === "error") return "danger";
  return "warning";
}

function formatSandboxDetail(
  sandbox: ReleaseDiagnostics["sandbox"] | undefined,
): string {
  if (!sandbox) return "Sandbox diagnostics unavailable.";
  const parts = [sandbox.detail];
  if (sandbox.status === "disabled") {
    parts.push("YAML agents still use the manifest interpreter.");
  }
  if (sandbox.remediation) parts.push(sandbox.remediation);
  if (sandbox.warning) parts.push(sandbox.warning);
  return parts.join(" ");
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-text)]">
        {title}
      </h2>
      <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-[var(--color-text-soft)]">
        {subtitle}
      </p>
    </div>
  );
}

function SettingRow({
  id,
  label,
  description,
  control,
}: {
  id?: SettingsItemId;
  label?: string;
  description?: string;
  control: React.ReactNode;
}) {
  const catalogEntry = id ? SETTINGS_ITEMS[id] : undefined;
  const renderedLabel = catalogEntry?.title ?? label;
  const renderedDescription = description ?? catalogEntry?.description;
  return (
    <Card
      id={id ? `setting-${id}` : undefined}
      tabIndex={id ? -1 : undefined}
      className="setting-row scroll-mt-6 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <div className="flex items-center justify-between gap-6 p-4 px-5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {renderedLabel}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {renderedDescription}
          </div>
        </div>
        <div className="shrink-0">{control}</div>
      </div>
    </Card>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-[13.5px] text-[var(--color-text)] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function runHistoryRetentionDraftFromSettings(
  settings: RunHistoryRetentionSettings | null,
): RunHistoryRetentionDraft {
  return {
    neverPrune: settings?.neverPrune ?? false,
    keepLastRunsEnabled: settings?.keepLastRuns !== undefined,
    keepLastRuns:
      settings?.keepLastRuns ?? DEFAULT_RUN_HISTORY_RETENTION_KEEP_LAST_RUNS,
    keepDaysEnabled: settings?.keepDays !== undefined,
    keepDays: settings?.keepDays ?? DEFAULT_RUN_HISTORY_RETENTION_KEEP_DAYS,
  };
}

function driftRetentionDraftFromSettings(
  settings: DriftRetentionSettings | null,
): DriftRetentionDraft {
  return {
    neverPrune: settings?.neverPrune ?? false,
    keepDays: settings?.keepDays ?? DEFAULT_DRIFT_RETENTION_DAYS,
  };
}

function boundedRetentionValue(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function runHistoryRetentionSummary(
  settings: RunHistoryRetentionSettings | null,
): string {
  if (!settings) return "Loading";
  if (settings.neverPrune) return "Never prune";
  const rules: string[] = [];
  if (settings.keepLastRuns !== undefined) {
    rules.push(`${settings.keepLastRuns.toLocaleString()} runs`);
  }
  if (settings.keepDays !== undefined) {
    rules.push(`${settings.keepDays.toLocaleString()} days`);
  }
  return rules.length > 0 ? rules.join(" / ") : "No rule";
}

function driftRetentionSummary(settings: DriftRetentionSettings | null): string {
  if (!settings) return "Loading";
  if (settings.neverPrune) return "Never prune";
  return `${(settings.keepDays ?? DEFAULT_DRIFT_RETENTION_DAYS).toLocaleString()} days`;
}

function formatRunHistoryPruneResult(result: RunHistoryPruneResult): string {
  const protectedParts: string[] = [];
  if (result.protectedWorkspaceCount > 0) {
    protectedParts.push(
      `${result.protectedWorkspaceCount.toLocaleString()} workspace-linked`,
    );
  }
  if (result.protectedActiveCount > 0) {
    protectedParts.push(`${result.protectedActiveCount.toLocaleString()} active`);
  }
  if (result.protectedAwaitingConfirmationCount > 0) {
    protectedParts.push(
      `${result.protectedAwaitingConfirmationCount.toLocaleString()} awaiting confirmation`,
    );
  }
  const protectedText =
    protectedParts.length > 0 ? ` Kept ${protectedParts.join(", ")}.` : "";
  return `${result.reason} ${formatDateTime(result.prunedAt)}. ${result.afterCount.toLocaleString()} run records remain.${protectedText}`
    .replace(/\s+/g, " ")
    .trim();
}

function formatDriftPruneResult(result: DriftHistoryPruneResult): string {
  const removed = result.snapshotsDeleted + result.versionsDeleted;
  return `${result.reason} ${formatDateTime(result.prunedAt)}. ${removed.toLocaleString()} local history rows removed.`
    .replace(/\s+/g, " ")
    .trim();
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "-";
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const maximumFractionDigits = unitIndex === 0 ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`;
}

function isOfficialRegistrySource(source: string): boolean {
  return (
    normalizeRegistrySourceForComparison(source) ===
    normalizeRegistrySourceForComparison(OFFICIAL_REGISTRY_SOURCE)
  );
}

function normalizeRegistrySourceForComparison(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function formatRegistrySource(source: string): string {
  try {
    const url = new URL(source);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return source;
  }
}

function formatFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "-";
  if (ms <= 0) return "due";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.ceil(ms / (60 * 60_000))}h`;
  return new Date(iso).toLocaleDateString();
}

function formatRetrievalBuildDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
