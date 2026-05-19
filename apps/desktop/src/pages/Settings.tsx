import { useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconCheck,
  IconClose,
  IconCloud,
  IconHardDrive,
  IconLock,
  IconPlus,
  IconShield,
} from "../components/icons";
import type {
  ProviderId,
  ProviderSummary,
  TenantRecord,
  TrustState,
} from "../shared/openAgents";
import { isProviderImplemented } from "../shared/providers";
import { useAppState } from "../state";

const sections = [
  { id: "providers", label: "LLM Providers" },
  { id: "tenants", label: "Tenants" },
  { id: "general", label: "General" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof sections)[number]["id"];

export default function Settings() {
  const [section, setSection] = useState<SectionId>("providers");
  const {
    state,
    setActiveProvider,
    setActiveModel,
    connectTenant,
    setActiveTenant,
    disconnectTenant,
  } = useAppState();
  const [tenantBusy, setTenantBusy] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);

  const handleConnectTenant = async () => {
    setTenantBusy(true);
    setTenantError(null);
    try {
      await connectTenant();
    } catch (error) {
      setTenantError(error instanceof Error ? error.message : String(error));
    } finally {
      setTenantBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Configure how Open Agents talks to LLMs and your tenant." />
      <div className="flex h-full min-h-0 flex-1">
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-[var(--color-border-soft)] px-3 py-6">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`rounded-lg px-3 py-1.5 text-left text-[13px] font-medium transition-colors ${
                s.id === section
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                  : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <PageBody>
          {section === "providers" && (
            <ProvidersSection
              providers={state.providers}
              activeProviderId={state.activeProviderId}
              activeModelByProviderId={state.activeModelByProviderId}
              onSetActiveProvider={setActiveProvider}
              onSetActiveModel={setActiveModel}
            />
          )}
          {section === "tenants" && (
            <TenantsSection
              tenants={state.tenants}
              activeTenantId={state.activeTenantId}
              busy={tenantBusy}
              error={tenantError}
              onConnect={handleConnectTenant}
              onSetActive={setActiveTenant}
              onDisconnect={disconnectTenant}
            />
          )}
          {section === "general" && <GeneralSection />}
          {section === "privacy" && <PrivacySection trust={state.trust} />}
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
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModelByProviderId: Partial<Record<ProviderId, string>> | undefined;
  onSetActiveProvider: (id: ProviderId) => Promise<void>;
  onSetActiveModel: (id: ProviderId, model: string | null) => Promise<void>;
}) {
  return (
    <div className="max-w-[820px]">
      <SectionTitle
        title="LLM Providers"
        subtitle="Open Agents never stores API keys. For hosted providers, we piggyback on your installed CLI's authentication so usage runs against your existing subscription."
      />

      <div className="mt-6 grid grid-cols-1 gap-3">
        {providers
          .filter((p) => p.isLocal)
          .map((p) => (
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
        CLI. Your existing subscription is used. Open Agents never sees an API
        key.
      </p>
      <div className="grid grid-cols-1 gap-3">
        {providers
          .filter((p) => !p.isLocal)
          .map((p) => (
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
  const effectiveModel =
    activeModel && installedModels.includes(activeModel)
      ? activeModel
      : provider.defaultModel ?? installedModels[0];
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
                <StatusDot tone="muted" /> Coming in 0.2
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
          {implemented && installedModels.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                <span>Models</span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {installedModels.length} installed
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {installedModels.map((m) => {
                  const selected = m === effectiveModel;
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        void onSetActiveModel(provider.id, selected ? null : m);
                      }}
                      title={
                        selected
                          ? "Currently active model · click to revert to provider default"
                          : `Use ${m} for runs against this provider`
                      }
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
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
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
                if (url) void window.openAgents?.openExternal(url);
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

function providerInstallGuideUrl(providerId: ProviderId): string | undefined {
  switch (providerId) {
    case "ollama":
      return "https://ollama.com/download";
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
        subtitle="Connect Microsoft 365 tenants. Sign-in opens your system browser to Microsoft's login page. Agents read Graph data from the active tenant; disconnecting the last tenant returns you to onboarding."
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
          {error}
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
  return (
    <Card>
      <div className="flex items-start gap-4 p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25">
          <IconCloud size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
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
            onClick={() => void onDisconnect(tenant.id)}
          >
            Disconnect
          </Button>
        </div>
      </div>
    </Card>
  );
}

function GeneralSection() {
  const { state } = useAppState();
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  return (
    <div className="max-w-[720px]">
      <SectionTitle
        title="General"
        subtitle="Defaults that apply across the app."
      />
      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          label="Default tenant scope"
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
          label="Confirm typed phrase for destructive writes"
          description="Always on. Cannot be disabled. See the spec for why."
          control={
            <Pill tone="success">
              <IconLock size={10} /> Always on
            </Pill>
          }
        />
        <SettingRow
          label="Theme"
          description="Open Agents is dark-only today. A light theme is on the v1.x list."
          control={
            <Pill>
              <StatusDot tone="muted" /> Dark only
            </Pill>
          }
        />
        <SettingRow
          label="Run history retention"
          description="Run records live in this profile's local store. Automatic pruning lands in v0.2."
          control={
            <Pill>
              <StatusDot tone="muted" /> Coming in 0.2
            </Pill>
          }
        />
      </div>
    </div>
  );
}

function PrivacySection({ trust }: { trust: TrustState }) {
  return (
    <div className="max-w-[720px]">
      <SectionTitle
        title="Privacy"
        subtitle="Open Agents is local-first by design. Here's the truth about where your data goes."
      />
      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          label="Telemetry"
          description="No telemetry is collected. No app usage data leaves this device. There is no opt-in switch — if we ever build one, it will require explicit consent."
          control={
            <Pill tone="success">
              <StatusDot tone="success" /> Not collected
            </Pill>
          }
        />
        <SettingRow
          label="Crash reporting"
          description="No crash reports are sent. Errors stay local. An opt-in option for sending sanitized stack traces lands in v0.2."
          control={
            <Pill tone="success">
              <StatusDot tone="success" /> Not collected
            </Pill>
          }
        />
        <SettingRow
          label="Tenant data residency"
          description="Where the active provider sends prompts and tenant data."
          control={
            <Pill tone={trust.isLocal ? "success" : "warning"}>
              <IconHardDrive size={10} /> {trust.label}
            </Pill>
          }
        />
        <SettingRow
          label="Graph writes"
          description="Write-mode agents always call Microsoft Graph for real when a tenant is connected. There is no global toggle — every write run pauses for a typed-phrase confirmation against the live diff, which is the only place to authorize a change."
          control={
            <Pill tone="warning">
              <StatusDot tone="warning" /> Confirmed per run
            </Pill>
          }
        />
        <SettingRow
          label="Update channel"
          description="Stable-only for now. The auto-updater checks signed GitHub releases on launch and every four hours. No silent updates — you'll see a banner with a Restart button when an update is ready."
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
    </div>
  );
}

function AboutSection() {
  const navigate = useNavigate();
  return (
    <div className="max-w-[640px]">
      <SectionTitle title="About" subtitle="Open Agents is open-source and community-driven." />
      <div className="mt-6 grid grid-cols-2 gap-3">
        <Stat label="Version" value="0.1.5" mono />
        <Stat label="License" value="MIT" />
        <Stat label="Repo" value="ugurkocde/OpenAgents" mono />
        <Stat label="Built by" value="Ugurlabs" />
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate("/onboarding")}
        >
          Run setup again
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void window.openAgents?.openExternal(
              "https://github.com/ugurkocde/OpenAgents",
            );
          }}
        >
          View on GitHub
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void window.openAgents?.openExternal(
              "https://github.com/ugurkocde/OpenAgents/blob/main/CHANGELOG.md",
            );
          }}
        >
          What's new
        </Button>
      </div>
    </div>
  );
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
  label,
  description,
  control,
}: {
  label: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-6 p-4 px-5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {label}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {description}
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
