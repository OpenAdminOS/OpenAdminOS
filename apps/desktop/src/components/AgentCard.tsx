import type { AgentDisplay } from "../shared/agent-display";
import { formatAgentDisplayName } from "../shared/agent-display";
import { Badge, IconButton } from "./ui";
import {
  IconBadgeCheck,
  IconBolt,
  IconPlay,
  IconShield,
} from "./icons";

export function AgentIdentity({ agent }: { agent: AgentDisplay }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)]">
        {agent.mode === "write" ? <IconBolt size={15} /> : <IconShield size={15} />}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-[var(--color-text)]">
            {formatAgentDisplayName(agent)}
          </span>
          {agent.compatibility?.supported === false ? (
            <Badge tone="warning">Incompatible</Badge>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <span className="truncate">{agent.author.name}</span>
          {agent.author.verified ? (
            <IconBadgeCheck
              aria-label="Verified publisher"
              size={12}
              className="shrink-0 text-[var(--color-info)]"
            />
          ) : null}
        </span>
      </span>
    </div>
  );
}

/** Compact compatibility row for callers outside the consolidated library. */
export function AgentCard({
  agent,
  onOpen,
  onRun,
}: {
  agent: AgentDisplay;
  onOpen?: (agent: AgentDisplay) => void;
  onRun?: (agent: AgentDisplay) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-border-soft)] px-3 py-2.5 last:border-b-0">
      <button
        type="button"
        className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        onClick={() => onOpen?.(agent)}
      >
        <AgentIdentity agent={agent} />
      </button>
      <Badge tone={agent.mode === "write" ? "warning" : "neutral"}>
        {agent.mode === "write" ? "Write" : "Read"}
      </Badge>
      <IconButton
        label={`Run ${formatAgentDisplayName(agent)}`}
        icon={<IconPlay size={13} />}
        disabled={agent.compatibility?.supported === false}
        onClick={() => onRun?.(agent)}
        size="sm"
      />
    </div>
  );
}
