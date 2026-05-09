import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Avatar } from "../components/Avatar";
import { ShareMenu } from "../components/ShareMenu";
import {
  IconArrowLeft,
  IconBadgeCheck,
  IconBolt,
  IconLock,
  IconPlay,
  IconShield,
} from "../components/icons";
import { installedAgents } from "../data/agents";
import { LiveRunModal } from "./LiveRun";

export default function AgentDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const agent = installedAgents.find((a) => a.slug === slug);
  const [running, setRunning] = useState(false);

  if (!agent) {
    return (
      <PageBody>
        <div className="text-center text-[var(--color-text-muted)]">
          Agent not found.{" "}
          <button
            className="text-[var(--color-accent)] underline"
            onClick={() => navigate("/")}
          >
            Back to agents
          </button>
        </div>
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <button
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <IconArrowLeft size={12} /> Agents
          </button>
        }
        title={agent.name}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Avatar name={agent.author.name} size={16} />
            <span>{agent.author.name}</span>
            {agent.author.verified && (
              <IconBadgeCheck size={12} className="text-[var(--color-accent)]" />
            )}
            <span className="opacity-50">·</span>
            <span className="font-mono">{agent.version}</span>
            <span className="opacity-50">·</span>
            <span className="capitalize">{agent.category}</span>
          </span>
        }
        actions={
          <>
            <ShareMenu contextLabel="agent" />
            <Button variant="secondary">Configure</Button>
            <Button
              variant="primary"
              leadingIcon={<IconPlay size={12} />}
              onClick={() => setRunning(true)}
            >
              Run agent
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-6">
            <Card>
              <div className="p-6">
                <SectionLabel>About</SectionLabel>
                <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-text-soft)]">
                  {agent.description}
                </p>
                <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-text-soft)]">
                  This agent runs against your active tenant scope and
                  produces a structured report. The result is saved to your
                  local run history and never transmitted off-device when a
                  local LLM provider is selected.
                </p>
              </div>
            </Card>

            <Card>
              <div className="p-6">
                <SectionLabel>Required Graph scopes</SectionLabel>
                <div className="mt-3 flex flex-col gap-2">
                  {agent.scopes.map((scope) => (
                    <div
                      key={scope}
                      className="flex items-center gap-2.5 rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
                    >
                      <IconLock
                        size={13}
                        className="text-[var(--color-text-muted)]"
                      />
                      <span className="font-mono text-[12px] text-[var(--color-text)]">
                        {scope}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 text-[12px] text-[var(--color-text-muted)]">
                  Granted at install time. You can revoke them from your
                  tenant's enterprise apps view at any time.
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-6">
                <SectionLabel>Recent runs</SectionLabel>
                <div className="mt-3 divide-y divide-[var(--color-border-soft)]">
                  {[
                    {
                      when: "2 hours ago",
                      result: "47 inactive devices found",
                      tenant: "UgurLabs",
                      duration: "8.2s",
                    },
                    {
                      when: "Yesterday",
                      result: "44 inactive devices found",
                      tenant: "UgurLabs",
                      duration: "7.8s",
                    },
                    {
                      when: "3 days ago",
                      result: "41 inactive devices found",
                      tenant: "UgurLabs",
                      duration: "8.0s",
                    },
                  ].map((run, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                    >
                      <div>
                        <div className="text-[13px] text-[var(--color-text)]">
                          {run.result}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                          {run.when} · {run.tenant} · {run.duration}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Sidebar column */}
          <div className="flex flex-col gap-6">
            <Card>
              <div className="p-5">
                <SectionLabel>Mode</SectionLabel>
                <div className="mt-3 flex items-center gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
                  {agent.mode === "write" ? (
                    <IconBolt
                      size={18}
                      className="text-[var(--color-warning)]"
                    />
                  ) : (
                    <IconShield
                      size={18}
                      className="text-[var(--color-text-soft)]"
                    />
                  )}
                  <div>
                    <div className="text-[13px] font-medium text-[var(--color-text)]">
                      {agent.mode === "write" ? "Write" : "Read-only"}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {agent.mode === "write"
                        ? "Pauses for diff confirmation before any change."
                        : "Cannot mutate tenant state."}
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-5">
                <SectionLabel>Model</SectionLabel>
                <div className="mt-3">
                  <div className="text-[13px] font-medium text-[var(--color-text)]">
                    {agent.preferredModel ?? "Default"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    Inherited from active provider · Ollama
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Pill tone="success">Local</Pill>
                  <Pill>$0.00 / run</Pill>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </PageBody>
      <LiveRunModal
        agent={running ? agent : null}
        onClose={() => setRunning(false)}
      />
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}
