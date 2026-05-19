import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconArrowRight,
  IconBadgeCheck,
  IconCheck,
  IconCloud,
  IconCopy,
  IconExternal,
  IconHardDrive,
  IconLogo,
  IconPlay,
  IconShield,
  IconWarning,
} from "../components/icons";
import { Avatar } from "../components/Avatar";
import { TitleBarInset } from "../components/AppShell";
import { useAppState } from "../state";
import type {
  ProviderId,
  ProviderSummary,
  RegistryAgentSummary,
  TenantRecord,
} from "../shared/openAgents";
import { isProviderImplemented } from "../shared/providers";

const steps = ["Welcome", "Pick LLM", "Connect tenant", "First agent"] as const;
type Step = (typeof steps)[number];

export default function Onboarding() {
  const navigate = useNavigate();
  const {
    state,
    registryAgents,
    installAgent,
    setActiveProvider,
    startRun,
    connectTenant,
    refresh,
  } = useAppState();
  const [step, setStep] = useState<Step>("Welcome");
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    state.activeProviderId,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProvider(state.activeProviderId);
  }, [state.activeProviderId]);

  useEffect(() => {
    if (selectedAgentId) return;
    const first = registryAgents[0];
    if (first) {
      setSelectedAgentId(first.registryId);
    }
  }, [registryAgents, selectedAgentId]);

  // Re-probe provider status while the user might be installing or
  // starting Ollama in another window. Only the two steps that surface
  // provider state need this — Welcome and Connect tenant don't.
  useEffect(() => {
    if (step !== "Pick LLM" && step !== "First agent") return;
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [step, refresh]);

  const handlePickLlmContinue = async () => {
    setError(null);
    if (selectedProvider !== state.activeProviderId) {
      try {
        setWorking(true);
        await setActiveProvider(selectedProvider);
      } catch (caughtError) {
        setError(toMessage(caughtError));
        return;
      } finally {
        setWorking(false);
      }
    }
    setStep("Connect tenant");
  };

  const handleConnectTenant = async () => {
    setError(null);
    setWorking(true);
    try {
      await connectTenant();
      setStep("First agent");
    } catch (caughtError) {
      setError(toMessage(caughtError));
    } finally {
      setWorking(false);
    }
  };

  const handleInstallAndFinish = async () => {
    setError(null);
    const registryAgent = registryAgents.find(
      (agent) => agent.registryId === selectedAgentId,
    );

    if (!registryAgent) {
      setError("Pick an agent to install before continuing.");
      return;
    }

    setWorking(true);
    try {
      const alreadyInstalled = state.installedAgents.some(
        (installed) =>
          installed.registryId === registryAgent.registryId ||
          installed.id === registryAgent.id ||
          installed.slug === registryAgent.slug,
      );

      if (!alreadyInstalled) {
        await installAgent(registryAgent.registryId);
      }

      const run = await startRun(registryAgent.slug);
      navigate(`/runs/${run.id}`);
    } catch (caughtError) {
      setError(toMessage(caughtError));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <TitleBarInset />
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] px-10 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            <IconLogo size={16} />
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-[var(--color-text)]">
            Open Agents
          </span>
          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
            v0.1.5
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {steps.map((s, i) => {
            const idx = steps.indexOf(step);
            const done = i < idx;
            const current = i === idx;
            return (
              <div key={s} className="flex items-center gap-1.5">
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium transition-colors ${
                    done
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : current
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                        : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {done ? <IconCheck size={11} /> : i + 1}
                </div>
                <span
                  className={`text-[12px] ${
                    current
                      ? "text-[var(--color-text)]"
                      : "text-[var(--color-text-muted)]"
                  }`}
                >
                  {s}
                </span>
                {i < steps.length - 1 && (
                  <span className="mx-2 h-px w-8 bg-[var(--color-border-soft)]" />
                )}
              </div>
            );
          })}
        </div>
        <span aria-hidden className="w-[7px]" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-10 animate-fade-in">
        <div className="mx-auto max-w-[820px]">
          {error && (
            <div className="mb-4 rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
              {error}
            </div>
          )}

          {step === "Welcome" && (
            <Welcome onContinue={() => setStep("Pick LLM")} />
          )}
          {step === "Pick LLM" && (
            <PickLLM
              providers={state.providers}
              selected={selectedProvider}
              onSelect={setSelectedProvider}
              onBack={() => setStep("Welcome")}
              onContinue={() => void handlePickLlmContinue()}
              onRecheck={() => void refresh()}
              working={working}
            />
          )}
          {step === "Connect tenant" && (
            <ConnectTenant
              activeTenant={
                state.activeTenantId
                  ? state.tenants.find((t) => t.id === state.activeTenantId)
                  : undefined
              }
              onConnect={() => void handleConnectTenant()}
              onContinueWithActive={() => setStep("First agent")}
              onBack={() => setStep("Pick LLM")}
              working={working}
            />
          )}
          {step === "First agent" && (
            <PickAgent
              agents={registryAgents}
              selectedId={selectedAgentId}
              activeProvider={state.providers.find(
                (p) => p.id === state.activeProviderId,
              )}
              onRecheck={() => void refresh()}
              onSelect={setSelectedAgentId}
              onBack={() => setStep("Connect tenant")}
              onContinue={() => void handleInstallAndFinish()}
              onSkip={() => navigate("/")}
              working={working}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function Welcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center">
      <div className="mb-10 flex flex-col items-center text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/25 shadow-[0_0_60px_-12px_var(--color-accent-soft)]">
          <IconLogo size={36} />
        </div>
        <h1 className="text-[32px] font-semibold tracking-tight text-[var(--color-text)]">
          Welcome to Open Agents.
        </h1>
        <p className="mt-3 max-w-[520px] text-[14.5px] leading-relaxed text-[var(--color-text-soft)]">
          Open-source, local-first agents for Microsoft 365 admins.
        </p>
      </div>

      <div className="grid w-full max-w-[820px] grid-cols-1 gap-3 sm:grid-cols-3">
        <FeatureCard
          icon={<IconHardDrive size={16} className="text-[var(--color-success)]" />}
          title="Local-first"
          body="Tenant data and prompts stay on this device with a local LLM."
        />
        <FeatureCard
          icon={<IconShield size={16} className="text-[var(--color-accent)]" />}
          title="Trust by design"
          body="Write agents always pause for typed diff confirmation. No exceptions."
        />
        <FeatureCard
          icon={<IconCloud size={16} className="text-[var(--color-info)]" />}
          title="No API keys"
          body="Local Ollama today. Hosted providers piggyback on your installed CLI."
        />
      </div>

      <div className="mt-12 flex flex-col items-center gap-3">
        <Button
          size="lg"
          variant="primary"
          trailingIcon={<IconArrowRight size={14} />}
          onClick={onContinue}
        >
          Get started
        </Button>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          Takes about a minute. You'll sign in to Microsoft once.
        </span>
      </div>
    </div>
  );
}

function PickLLM({
  providers,
  selected,
  onSelect,
  onBack,
  onContinue,
  onRecheck,
  working,
}: {
  providers: ProviderSummary[];
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
  onBack: () => void;
  onContinue: () => void;
  onRecheck: () => void;
  working: boolean;
}) {
  const selectedProvider = providers.find((p) => p.id === selected);
  const ready =
    selectedProvider !== undefined &&
    isProviderImplemented(selectedProvider.id) &&
    selectedProvider.status === "connected";

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          Pick an LLM provider
        </h2>
        <p className="mt-1.5 max-w-[600px] text-[13.5px] leading-relaxed text-[var(--color-text-soft)]">
          Local Ollama is the only provider available today. LM Studio and
          hosted providers (Anthropic, OpenAI, Azure OpenAI) land in v0.2.
          Local providers keep tenant data on this device; hosted providers
          will piggyback on your installed CLI's authentication so we never
          store API keys.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {providers.map((p) => {
          const active = p.id === selected;
          const implemented = isProviderImplemented(p.id);
          return (
            <Card
              key={p.id}
              interactive={implemented}
              onClick={implemented ? () => onSelect(p.id) : undefined}
              className={
                !implemented
                  ? "opacity-60 cursor-not-allowed"
                  : active
                    ? "ring-2 ring-[var(--color-accent)]/55 bg-[var(--color-surface-hover)]"
                    : ""
              }
            >
              <div className="flex items-center gap-4 p-5">
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ring-1 ${
                    p.isLocal
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"
                      : "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-[var(--color-info)]/25"
                  }`}
                >
                  {p.isLocal ? <IconHardDrive size={20} /> : <IconCloud size={20} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-[var(--color-text)]">
                      {p.name}
                    </span>
                    {p.isLocal ? (
                      <Pill tone="success">
                        <StatusDot tone="success" /> Local
                      </Pill>
                    ) : (
                      <Pill>
                        <StatusDot tone="info" /> CLI piggyback
                      </Pill>
                    )}
                    {!implemented ? (
                      <Pill>
                        <StatusDot tone="muted" /> Coming in 0.2
                      </Pill>
                    ) : (
                      <>
                        {p.status === "connected" && (
                          <Pill tone="success">
                            <IconCheck size={9} /> Detected
                          </Pill>
                        )}
                        {p.status === "available" && <Pill tone="warning">Available</Pill>}
                        {p.status === "not-installed" && <Pill>Not installed</Pill>}
                        {p.status === "error" && <Pill tone="danger">Error</Pill>}
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                    {p.description}
                  </p>
                </div>
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${
                    active && implemented
                      ? "bg-[var(--color-accent)] ring-[var(--color-accent)]"
                      : "ring-[var(--color-border-strong)]"
                  }`}
                >
                  {active && implemented && (
                    <IconCheck size={12} className="text-[#1a120c]" />
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {!ready && selectedProvider && (
        <div className="mt-4">
          <ProviderNotReadyCard provider={selectedProvider} onRecheck={onRecheck} />
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          trailingIcon={<IconArrowRight size={14} />}
          onClick={onContinue}
          disabled={working || !ready}
        >
          {working ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

function ConnectTenant({
  activeTenant,
  onConnect,
  onContinueWithActive,
  onBack,
  working,
}: {
  activeTenant: TenantRecord | undefined;
  onConnect: () => void;
  onContinueWithActive: () => void;
  onBack: () => void;
  working: boolean;
}) {
  return (
    <div>
      <div className="mb-7">
        <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          Connect a Microsoft 365 tenant
        </h2>
        <p className="mt-1.5 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--color-text-soft)]">
          Sign in once with your admin account. Open Agents will open
          Microsoft's login page in your system browser and read managed
          devices, policies, and compliance state from Graph against the
          tenants you allow.
        </p>
      </div>

      {activeTenant ? (
        <Card className="ring-2 ring-[var(--color-accent)]/30">
          <div className="flex items-start gap-4 p-5">
            <Avatar name={activeTenant.displayName} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14.5px] font-medium text-[var(--color-text)]">
                  {activeTenant.displayName}
                </span>
                <Pill tone="success">
                  <StatusDot tone="success" /> Active
                </Pill>
              </div>
              <div className="mt-1 text-[12.5px] text-[var(--color-text-soft)]">
                {activeTenant.username}
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-[var(--color-text-muted)]">
                tenant-id: {activeTenant.id}
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col p-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25">
              <IconCloud size={20} />
            </div>
            <div className="mt-3 text-[14.5px] font-medium text-[var(--color-text)]">
              Sign in with your Microsoft 365 admin account
            </div>
            <p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Open Agents reads device, policy, and compliance state from
              Microsoft Graph. The consent screen says "Microsoft Graph
              Command Line Tools". You can disconnect at any time from
              Settings → Tenants.
            </p>
            <div className="mt-5">
              <Button
                variant="primary"
                leadingIcon={<IconShield size={12} />}
                onClick={onConnect}
                disabled={working}
              >
                {working ? "Waiting for sign-in…" : "Sign in to Microsoft"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={working}>
          Back
        </Button>
        {activeTenant && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={onConnect}
              disabled={working}
            >
              {working ? "Waiting…" : "Connect another"}
            </Button>
            <Button
              variant="primary"
              trailingIcon={<IconArrowRight size={14} />}
              onClick={onContinueWithActive}
              disabled={working}
            >
              Continue with this tenant
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function PickAgent({
  agents,
  selectedId,
  activeProvider,
  onSelect,
  onBack,
  onContinue,
  onSkip,
  onRecheck,
  working,
}: {
  agents: RegistryAgentSummary[];
  selectedId: string;
  activeProvider: ProviderSummary | undefined;
  onSelect: (id: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onRecheck: () => void;
  working: boolean;
}) {
  const featured = useMemo(() => agents.slice(0, 3), [agents]);
  const providerReady =
    activeProvider !== undefined &&
    isProviderImplemented(activeProvider.id) &&
    activeProvider.status === "connected";

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          Install your first agent
        </h2>
        <p className="mt-1.5 max-w-[600px] text-[13.5px] leading-relaxed text-[var(--color-text-soft)]">
          Pick a read-only agent to start. You can install more from the Agent
          Hub anytime.
        </p>
      </div>

      {!providerReady && activeProvider && (
        <div className="mb-5">
          <ProviderNotReadyCard provider={activeProvider} onRecheck={onRecheck} />
        </div>
      )}

      {featured.length === 0 ? (
        <Card>
          <div className="p-6 text-[13px] text-[var(--color-text-muted)]">
            No built-in agents are available yet. Add an agent under the root
            agents directory.
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {featured.map((a) => {
            const active = a.registryId === selectedId;
            return (
              <Card
                key={a.registryId}
                interactive
                onClick={() => onSelect(a.registryId)}
                className={
                  active
                    ? "ring-2 ring-[var(--color-accent)]/55 bg-[var(--color-surface-hover)]"
                    : ""
                }
              >
                <div className="flex items-start gap-4 p-5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border)]">
                    <IconShield size={18} className="text-[var(--color-text-soft)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-[var(--color-text)]">
                        {a.name}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                        {a.author.name}
                        {a.author.verified && (
                          <IconBadgeCheck
                            size={11}
                            className="text-[var(--color-accent)]"
                          />
                        )}
                      </span>
                      <Pill tone={a.mode === "write" ? "warning" : "default"}>
                        {a.mode === "write" ? "Write" : "Read-only"}
                      </Pill>
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                      {a.description}
                    </p>
                  </div>
                  <div
                    className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${
                      active
                        ? "bg-[var(--color-accent)] ring-[var(--color-accent)]"
                        : "ring-[var(--color-border-strong)]"
                    }`}
                  >
                    {active && <IconCheck size={12} className="text-[#1a120c]" />}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onSkip} disabled={working}>
            Skip for now
          </Button>
          <Button
            variant="primary"
            size="lg"
            leadingIcon={<IconPlay size={12} />}
            onClick={onContinue}
            disabled={working || featured.length === 0 || !providerReady}
          >
            {working ? "Installing…" : "Install and run"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--color-surface)] p-5 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
        {icon}
      </div>
      <div className="mt-3 text-[13.5px] font-medium text-[var(--color-text)]">
        {title}
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
        {body}
      </div>
    </div>
  );
}

function ProviderNotReadyCard({
  provider,
  onRecheck,
}: {
  provider: ProviderSummary;
  onRecheck: () => void;
}) {
  const [rechecking, setRechecking] = useState(false);

  const isOllama = provider.id === "ollama";

  const onRecheckClick = async () => {
    setRechecking(true);
    try {
      onRecheck();
      // Give the host a moment to re-probe before re-enabling — the
      // real status update flows through the app-state subscription,
      // this just stops button-mashing.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      setRechecking(false);
    }
  };

  if (!isOllama) {
    return (
      <div className="rounded-xl bg-[var(--color-warning-soft)] p-5 ring-1 ring-[var(--color-warning)]/30">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/35">
            <IconWarning size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-[var(--color-text)]">
              {provider.name} isn't reachable.
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Install or start the provider, then recheck.
            </p>
            <div className="mt-3">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void onRecheckClick()}
                disabled={rechecking}
              >
                {rechecking ? "Rechecking…" : "Recheck"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <OllamaInstallGuide rechecking={rechecking} onRecheck={onRecheckClick} />;
}

function OllamaInstallGuide({
  rechecking,
  onRecheck,
}: {
  rechecking: boolean;
  onRecheck: () => void | Promise<void>;
}) {
  const platform = window.openAgents?.platform ?? "unknown";
  const openExternal = (url: string) =>
    void window.openAgents?.openExternal(url);

  return (
    <div className="overflow-hidden rounded-xl bg-[var(--color-warning-soft)] ring-1 ring-[var(--color-warning)]/30">
      <div className="flex items-start gap-3 border-b border-[var(--color-warning)]/20 bg-[var(--color-warning-soft)] px-5 py-4">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/35">
          <IconWarning size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-[var(--color-text)]">
            Ollama isn't running on this device.
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            Ollama is a free, open-source app that runs LLMs locally. Open
            Agents needs it so your tenant data and prompts never leave this
            machine. Three short steps:
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 bg-[var(--color-bg)]/40 px-5 py-5">
        <InstallStep number={1} title="Install Ollama">
          {platform === "macos" && (
            <MacInstallStep openExternal={openExternal} />
          )}
          {platform === "windows" && (
            <WindowsInstallStep openExternal={openExternal} />
          )}
          {platform === "linux" && <LinuxInstallStep />}
          {platform === "unknown" && (
            <UnknownPlatformInstallStep openExternal={openExternal} />
          )}
        </InstallStep>

        <InstallStep number={2} title="Start Ollama">
          {platform === "macos" && (
            <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              The macOS app launches Ollama automatically and keeps it running
              in the menu bar. You'll see a small llama icon at the top of
              your screen.
            </p>
          )}
          {platform === "windows" && (
            <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              The Windows installer launches Ollama and adds it to your system
              tray. It also starts automatically on login.
            </p>
          )}
          {(platform === "linux" || platform === "unknown") && (
            <>
              <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                Run this in a terminal to start Ollama in the background:
              </p>
              <CommandRow command="ollama serve" />
            </>
          )}
        </InstallStep>

        <InstallStep number={3} title="Come back here and click Recheck">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            Open Agents will detect Ollama as soon as it's running. No
            restart needed.
          </p>
          <div className="mt-3">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void onRecheck()}
              disabled={rechecking}
            >
              {rechecking ? "Rechecking…" : "Recheck"}
            </Button>
          </div>
        </InstallStep>
      </div>
    </div>
  );
}

function InstallStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning-soft)] text-[11px] font-medium text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/40">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-[var(--color-text)]">
          {title}
        </div>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  );
}

function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <span className="font-mono text-[12px] text-[var(--color-text)]">
        {command}
      </span>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      >
        {copied ? (
          <>
            <IconCheck size={10} /> Copied
          </>
        ) : (
          <>
            <IconCopy size={10} /> Copy
          </>
        )}
      </button>
    </div>
  );
}

function MacInstallStep({
  openExternal,
}: {
  openExternal: (url: string) => void;
}) {
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        Download the macOS app and drag it into Applications. Or, if you use
        Homebrew, install from the terminal.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          trailingIcon={<IconExternal size={11} />}
          onClick={() => openExternal("https://ollama.com/download/mac")}
        >
          Download for macOS
        </Button>
      </div>
      <div className="mt-3">
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          Or with Homebrew:
        </span>
        <CommandRow command="brew install ollama" />
      </div>
    </>
  );
}

function WindowsInstallStep({
  openExternal,
}: {
  openExternal: (url: string) => void;
}) {
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        Download the Windows installer and run it. The installer puts Ollama
        in your system tray and starts it automatically.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          trailingIcon={<IconExternal size={11} />}
          onClick={() => openExternal("https://ollama.com/download/windows")}
        >
          Download for Windows
        </Button>
      </div>
    </>
  );
}

function LinuxInstallStep() {
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        Run the official install script in a terminal. It detects your distro
        and installs the right package.
      </p>
      <CommandRow command="curl -fsSL https://ollama.com/install.sh | sh" />
    </>
  );
}

function UnknownPlatformInstallStep({
  openExternal,
}: {
  openExternal: (url: string) => void;
}) {
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        We couldn't detect your OS. Open the Ollama download page and pick
        the build for your system.
      </p>
      <div className="mt-3">
        <Button
          size="sm"
          variant="primary"
          trailingIcon={<IconExternal size={11} />}
          onClick={() => openExternal("https://ollama.com/download")}
        >
          Ollama downloads
        </Button>
      </div>
    </>
  );
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Onboarding failed.";
}
