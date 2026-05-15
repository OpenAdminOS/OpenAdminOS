import { useState } from "react";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconCheck,
  IconCloud,
  IconHardDrive,
  IconLock,
  IconShield,
} from "../components/icons";
import type { ProviderId, ProviderSummary, TrustState } from "../shared/openAgents";
import { useAppState } from "../state";

const sections = [
  { id: "providers", label: "LLM Providers" },
  { id: "general", label: "General" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof sections)[number]["id"];

export default function Settings() {
  const [section, setSection] = useState<SectionId>("providers");
  const { state, setActiveProvider } = useAppState();

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
              onSetActiveProvider={setActiveProvider}
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
  onSetActiveProvider,
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  onSetActiveProvider: (id: ProviderId) => Promise<void>;
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
              onSetActiveProvider={onSetActiveProvider}
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
              onSetActiveProvider={onSetActiveProvider}
            />
          ))}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  activeProviderId,
  onSetActiveProvider,
}: {
  provider: ProviderSummary;
  activeProviderId: ProviderId;
  onSetActiveProvider: (id: ProviderId) => Promise<void>;
}) {
  const isActive = provider.id === activeProviderId;
  return (
    <Card>
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
            {isActive && (
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
          {provider.models && provider.models.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {provider.models.slice(0, 4).map((m) => (
                <Pill key={m}>
                  <span className="font-mono text-[10.5px]">{m}</span>
                </Pill>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {(provider.status === "connected" || provider.status === "available") &&
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
          {provider.status === "not-installed" && (
            <Button variant="ghost" size="sm">
              Install guide
            </Button>
          )}
          {provider.status === "connected" && (
            <Button variant="ghost" size="sm">
              Configure
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function GeneralSection() {
  return (
    <div className="max-w-[720px]">
      <SectionTitle
        title="General"
        subtitle="Defaults that apply across the app."
      />
      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          label="Theme"
          description="Light theme arrives in v1.1. Dark only for now."
          control={<Pill>Dark</Pill>}
        />
        <SettingRow
          label="Default tenant scope"
          description="The tenant agents use unless overridden at run time."
          control={<Pill>Not connected</Pill>}
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
          label="Run history retention"
          description="Old runs are kept locally. Choose how long."
          control={<Pill>90 days</Pill>}
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
          description="Anonymous app usage data. Off by default. We have no plan to turn it on without explicit consent."
          control={<Pill>Off</Pill>}
        />
        <SettingRow
          label="Crash reporting"
          description="If enabled, sends only stack traces and OS info. No tenant content. Off by default."
          control={<Pill>Off</Pill>}
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
          label="Update channel"
          description="Stable releases pushed via signed installer. No silent updates."
          control={<Pill>Stable</Pill>}
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
  return (
    <div className="max-w-[640px]">
      <SectionTitle title="About" subtitle="Open Agents is open-source and community-driven." />
      <div className="mt-6 grid grid-cols-2 gap-3">
        <Stat label="Version" value="0.1.0" mono />
        <Stat label="License" value="MIT" />
        <Stat label="Repo" value="ugurlabs/openagents" mono />
        <Stat label="Built by" value="Ugurlabs" />
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
