import { useNavigate } from "react-router";
import type { Agent } from "../types";
import { Card } from "./Card";
import { Pill } from "./Pill";
import { Button } from "./Button";
import {
  IconPlay,
  IconShield,
  IconBolt,
  IconBadgeCheck,
} from "./icons";

function timeSince(iso?: string): string {
  if (!iso) return "Never run";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `Ran ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Ran ${h}h ago`;
  const d = Math.floor(h / 24);
  return `Ran ${d}d ago`;
}

const categoryAccent: Record<Agent["category"], string> = {
  devices: "from-[#e8a87c]/16 to-[#e8a87c]/4",
  apps: "from-[#a3bfd9]/16 to-[#a3bfd9]/4",
  policies: "from-[#9cc88f]/16 to-[#9cc88f]/4",
  compliance: "from-[#c4a5d9]/16 to-[#c4a5d9]/4",
  updates: "from-[#e5c678]/16 to-[#e5c678]/4",
};

export function AgentCard({
  agent,
  onRun,
}: {
  agent: Agent;
  onRun?: (agent: Agent) => void;
}) {
  const navigate = useNavigate();

  return (
    <Card interactive onClick={() => navigate(`/agents/${agent.slug}`)}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${
              categoryAccent[agent.category]
            } ring-1 ring-[var(--color-border)]`}
          >
            {agent.mode === "write" ? (
              <IconBolt size={18} className="text-[var(--color-warning)]" />
            ) : (
              <IconShield size={18} className="text-[var(--color-text-soft)]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[14px] font-medium text-[var(--color-text)]">
                {agent.name}
              </h3>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span>{agent.author.name}</span>
              {agent.author.verified && (
                <IconBadgeCheck size={11} className="text-[var(--color-accent)]" />
              )}
              <span className="opacity-50">·</span>
              <span className="font-mono">{agent.version}</span>
            </div>
          </div>
        </div>

        <p className="line-clamp-2 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
          {agent.description}
        </p>

        <div className="flex items-center gap-2">
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read-only"}
          </Pill>
          <Pill>
            {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
          </Pill>
          {"updateAvailable" in agent && agent.updateAvailable && (
            <Pill tone="accent">
              Update → v{agent.updateAvailable.version}
            </Pill>
          )}
          {agent.compatibility?.supported === false && (
            <Pill tone="warning">
              Needs OpenAdminOS {agent.compatibility.minAppVersion}
            </Pill>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-3">
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {timeSince(agent.lastRunAt)}
          </span>
          <Button
            size="sm"
            variant={agent.compatibility?.supported === false ? "secondary" : "primary"}
            leadingIcon={<IconPlay size={11} />}
            disabled={agent.compatibility?.supported === false}
            title={
              agent.compatibility?.supported === false
                ? `Update OpenAdminOS to ${agent.compatibility.minAppVersion} before running this agent.`
                : undefined
            }
            onClick={(e) => {
              e.stopPropagation();
              if (agent.compatibility?.supported === false) return;
              onRun?.(agent);
            }}
          >
            {agent.compatibility?.supported === false ? "Update app" : "Run"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
