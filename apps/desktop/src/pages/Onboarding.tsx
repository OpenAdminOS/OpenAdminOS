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
  IconHardDrive,
  IconLogo,
  IconPlay,
  IconShield,
} from "../components/icons";
import { TitleBarInset } from "../components/AppShell";
import { useAppState } from "../state";
import type {
  ProviderId,
  ProviderSummary,
  RegistryAgentSummary,
} from "../shared/openAgents";

const steps = ["Welcome", "Pick LLM", "First agent"] as const;
type Step = (typeof steps)[number];

export default function Onboarding() {
  const navigate = useNavigate();
  const { state, registryAgents, installAgent, setActiveProvider, startRun } =
    useAppState();
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
    setStep("First agent");
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
            v0.1.0
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
        <button
          onClick={() => navigate("/")}
          className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Skip
        </button>
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
              working={working}
            />
          )}
          {step === "First agent" && (
            <PickAgent
              agents={registryAgents}
              selectedId={selectedAgentId}
              onSelect={setSelectedAgentId}
              onBack={() => setStep("Pick LLM")}
              onContinue={() => void handleInstallAndFinish()}
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
    <div>
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/20">
          <IconLogo size={28} />
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight text-[var(--color-text)]">
          Welcome to Open Agents.
        </h1>
        <p className="mt-3 max-w-[560px] text-[14px] leading-relaxed text-[var(--color-text-soft)]">
          A privacy-first local hub for Microsoft 365 admins. Build agents,
          share them with your colleagues, run them against your tenant — all on
          your machine.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FeatureCard
          icon={<IconHardDrive size={16} className="text-[var(--color-success)]" />}
          title="Local-first"
          body="Your tenant data and prompts never leave this device when a local LLM is selected."
        />
        <FeatureCard
          icon={<IconShield size={16} className="text-[var(--color-accent)]" />}
          title="Trust by design"
          body="Write agents always pause for diff confirmation. No 'remember my choice'."
        />
        <FeatureCard
          icon={<IconCloud size={16} className="text-[var(--color-info)]" />}
          title="No API keys"
          body="Use your installed Claude Code or Codex CLI. We never store keys."
        />
      </div>

      <div className="mt-10 flex justify-center">
        <Button
          size="lg"
          variant="primary"
          trailingIcon={<IconArrowRight size={14} />}
          onClick={onContinue}
        >
          Get started
        </Button>
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
  working,
}: {
  providers: ProviderSummary[];
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
  onBack: () => void;
  onContinue: () => void;
  working: boolean;
}) {
  return (
    <div>
      <div className="mb-7">
        <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          Pick an LLM provider
        </h2>
        <p className="mt-1.5 max-w-[600px] text-[13.5px] leading-relaxed text-[var(--color-text-soft)]">
          Local providers (Ollama, LM Studio) keep tenant data on this device.
          Hosted providers run on your existing Claude Code or Codex
          subscription — no API keys stored.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {providers.map((p) => {
          const active = p.id === selected;
          return (
            <Card
              key={p.id}
              interactive
              onClick={() => onSelect(p.id)}
              className={
                active
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
                    {p.status === "connected" && (
                      <Pill tone="success">
                        <IconCheck size={9} /> Detected
                      </Pill>
                    )}
                    {p.status === "available" && <Pill tone="warning">Available</Pill>}
                    {p.status === "not-installed" && <Pill>Not installed</Pill>}
                    {p.status === "error" && <Pill tone="danger">Error</Pill>}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                    {p.description}
                  </p>
                </div>
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${
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

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          trailingIcon={<IconArrowRight size={14} />}
          onClick={onContinue}
          disabled={working}
        >
          {working ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

function PickAgent({
  agents,
  selectedId,
  onSelect,
  onBack,
  onContinue,
  working,
}: {
  agents: RegistryAgentSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  onContinue: () => void;
  working: boolean;
}) {
  const featured = useMemo(() => agents.slice(0, 3), [agents]);

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
        <Button
          variant="primary"
          size="lg"
          leadingIcon={<IconPlay size={12} />}
          onClick={onContinue}
          disabled={working || featured.length === 0}
        >
          {working ? "Installing…" : "Install and run"}
        </Button>
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

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Onboarding failed.";
}
