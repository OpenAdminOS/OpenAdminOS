import { Card } from "./Card";
import { IconWarning } from "./icons";
import type { RunRecord } from "../shared/openAgents";

interface Suggestion {
  match: (error: string) => boolean;
  title: string;
  body: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    match: (e) => /ollama/i.test(e) && /(not reachable|connect|refused|econnrefused)/i.test(e),
    title: "Ollama isn't running",
    body: "Start it from a terminal with `ollama serve`, confirm it's reachable at http://127.0.0.1:11434, then re-run.",
  },
  {
    match: (e) => /ollama/i.test(e) && /(not pulled|pull|model)/i.test(e),
    title: "Model not pulled",
    body: "Run `ollama pull <model>` for the model you selected in Settings → LLM Providers, then try again.",
  },
  {
    match: (e) => /timed out|timeout|aborted/i.test(e),
    title: "Request timed out",
    body: "The LLM or Microsoft Graph took longer than expected. Try a smaller model, narrow the agent's scope, or check your network.",
  },
  {
    match: (e) => /401|unauthor|expired token|interaction_required/i.test(e),
    title: "Tenant token expired",
    body: "Disconnect and reconnect the tenant from Settings → Tenants. MSAL caches a refresh token but Graph can revoke it independently.",
  },
  {
    match: (e) => /403|forbidden|insufficient|scope|consent/i.test(e),
    title: "Scope or consent issue",
    body: "The signed-in account does not have the Graph scope this agent requires. Re-consent with an admin account, or pick an agent with a narrower scope set.",
  },
  {
    match: (e) => /tenant.*not connected|no tenant/i.test(e),
    title: "No tenant available",
    body: "Open Settings → Tenants and connect a Microsoft 365 tenant, or accept synthetic mode for an empty-inventory dry run.",
  },
  {
    match: (e) => /yaml|manifest|schema|invalid/i.test(e),
    title: "Manifest validation failed",
    body: "The agent's manifest didn't validate against the schema. If you authored it, re-open the New Agent flow and re-draft; if it's a registry agent, check for a newer version.",
  },
];

export function RunFailureRemediation({ run }: { run: RunRecord }) {
  if (run.status !== "failed" || !run.error) return null;
  const matched = SUGGESTIONS.filter((suggestion) => suggestion.match(run.error!));

  return (
    <Card className="mb-6 ring-[var(--color-danger)]/35">
      <div className="border-b border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] px-6 py-3">
        <div className="flex items-center gap-2.5 text-[12.5px] font-medium text-[var(--color-danger)]">
          <IconWarning size={14} />
          <span>Run failed</span>
          <span className="opacity-50">·</span>
          <span className="font-mono text-[11.5px]">{truncate(run.error, 120)}</span>
        </div>
      </div>
      <div className="p-6">
        {matched.length === 0 ? (
          <div>
            <div className="text-[13px] font-medium text-[var(--color-text)]">
              No matching playbook
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Inspect the Logs tab for the stack trace. If this is reproducible, file
              an issue at <span className="font-mono">github.com/ugurkocde/OpenAgents/issues</span> with
              the run id, agent slug, and error message.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Likely causes
            </div>
            {matched.map((suggestion) => (
              <div
                key={suggestion.title}
                className="rounded-md bg-[var(--color-bg-raised)] p-3.5 ring-1 ring-[var(--color-border-soft)]"
              >
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {suggestion.title}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  {suggestion.body}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
