import { IconWarning } from "./icons";
import { Button } from "./Button";
import { useReportIssue } from "./ReportIssueModal";
import type { RunRecord } from "../shared/openAdminOS";
import { graphAccessDenialFromError } from "@openadminos/agent-sdk";

interface Suggestion {
  match: (error: string) => boolean;
  title: string;
  /** Fixed advice, or advice read from the error when it carries the specifics. */
  body: string | ((error: string) => string);
}

/**
 * A failed lookup of the model's context limit has its own playbook only.
 * The runtime names the lookup URL followed by a final ".", by ": " or by " answered ", so an
 * endpoint prefix such as `/api/showroom` or `/api/show.v1` in front of `/api/chat` is not read as the lookup.
 */
const isContextLimitLookup = (e: string) => /ollama/i.test(e) && /context limit|\/api\/show(?=\.$|:\s| answered )/i.test(e);

/**
 * LM Studio's context error from the runtime. It quotes LM Studio and token
 * counts, so no other playbook and no Graph denial is read from its text.
 */
const LM_STUDIO_CONTEXT_PREFIX = "LM Studio context length too small:";
const isLmStudioContextTooSmall = (e: string) => e.includes(LM_STUDIO_CONTEXT_PREFIX);

/**
 * The sizes and the reload command from the runtime's LM Studio context
 * error, without LM Studio's own text. The run header truncates the error,
 * so the playbook repeats what the admin needs to act on.
 */
function lmStudioContextAdvice(error: string): string {
  const start = error.indexOf(LM_STUDIO_CONTEXT_PREFIX) + LM_STUDIO_CONTEXT_PREFIX.length;
  const end = error.indexOf(" LM Studio said:", start);
  const advice = error.slice(start, end === -1 ? undefined : end).trim();
  return advice.length > 0
    ? advice
    : "LM Studio sets a model's context length when the model is loaded, and this request did not fit. In LM Studio, raise Context Length in the model's load settings and reload the model, then re-run.";
}

/** Errors with one cause and one recovery: only their own playbook is shown. */
const EXCLUSIVE = [isContextLimitLookup, isLmStudioContextTooSmall];

const SUGGESTIONS: Suggestion[] = [
  {
    match: (e) => /ollama/i.test(e) && /(not reachable|connect|refused|econnrefused)/i.test(e) && !isContextLimitLookup(e),
    title: "Ollama isn't running",
    body: "Start it from a terminal with `ollama serve`, confirm it's reachable at http://127.0.0.1:11434, then re-run.",
  },
  {
    match: (e) => /ollama/i.test(e) && /context size/i.test(e),
    title: "Ollama context too small",
    body: "The request did not fit in the context Ollama loaded for this model. OpenAdminOS raises that context up to the model's limit when the model allows it, and the error names the limit that stopped it. Narrow the question or the agent's scope, close other apps to free memory, or pick a model with a larger context window in Settings → LLM Providers, then re-run.",
  },
  {
    match: isContextLimitLookup,
    title: "Ollama did not report the model's context limit",
    body: "The request did not fit in the context Ollama loaded, and Ollama did not answer when OpenAdminOS asked for the model's limit before raising it. Check that Ollama is responsive with `ollama ps`, restart it if it is stuck, then re-run.",
  },
  {
    match: isLmStudioContextTooSmall,
    title: "LM Studio context too small",
    body: lmStudioContextAdvice,
  },
  {
    match: (e) =>
      !isContextLimitLookup(e) &&
      (/Ollama model "[^"]+" is not pulled\. Run `ollama pull [^`]+`\./.test(e) ||
        /No Ollama model available\. Pull a model with `ollama pull <model>`\./.test(e)),
    title: "Model not pulled",
    body: "Run `ollama pull <model>` for the model you selected in Settings → LLM Providers, then try again.",
  },
  {
    match: (e) => /ollama/i.test(e) && /timed out|timeout|aborted/i.test(e) && !isContextLimitLookup(e),
    title: "Ollama generation timed out",
    body: "The local model did not finish in time. OpenAdminOS now waits up to 3 minutes by default; restart the app to pick up that change. For very large local models, set `OPENAGENTS_OLLAMA_TIMEOUT_MS` higher or pick a smaller model.",
  },
  {
    match: (e) => /stopped sending output for/i.test(e),
    title: "Provider stopped responding",
    body: "The provider CLI sent no output for longer than its silence limit, so it was stopped. This usually means a dropped connection, an expired sign-in, or a stuck CLI. Test the provider in Settings → LLM Providers, then re-run. If the model works without output for longer, set `OPENADMINOS_CLAUDE_CODE_IDLE_TIMEOUT_MS` or `OPENADMINOS_CODEX_IDLE_TIMEOUT_MS` higher, in milliseconds, and restart the app.",
  },
  {
    match: (e) => /the limit for one request/i.test(e),
    title: "Provider time limit reached",
    body: "The provider was still producing output when it reached the limit for one request. Narrow the agent's scope or pick a faster model, then re-run. To allow longer requests, set `OPENADMINOS_CLAUDE_CODE_TIMEOUT_MS` or `OPENADMINOS_CODEX_TIMEOUT_MS` higher, in milliseconds, and restart the app.",
  },
  {
    match: (e) => /timed out|timeout|aborted/i.test(e) && !isContextLimitLookup(e),
    title: "Request timed out",
    body: "The LLM or Microsoft Graph took longer than expected. Try a smaller model, narrow the agent's scope, or check your network.",
  },
  {
    match: (e) => /401|unauthor|expired token|interaction_required/i.test(e) && !isContextLimitLookup(e),
    title: "Tenant token expired",
    body: "Disconnect and reconnect the tenant from Connections. MSAL caches a refresh token but Graph can revoke it independently.",
  },
  {
    match: (e) => /tenant.*not connected|no tenant|no organization with microsoft 365/i.test(e),
    title: "No organization with Microsoft 365",
    body: "Choose an organization in the organization switcher, or connect a Microsoft 365 tenant in Connections, before running agents.",
  },
  {
    match: (e) => /yaml|manifest|schema|invalid/i.test(e) && !isContextLimitLookup(e),
    title: "Manifest validation failed",
    body: "The agent's manifest didn't validate against the schema. If you authored it, re-open the New Agent flow and re-draft; if it's a registry agent, check for a newer version.",
  },
];

export function RunFailureRemediation({ run }: { run: RunRecord }) {
  const openReportIssue = useReportIssue();
  if (run.status !== "failed" || !run.error) return null;
  // A failed lookup of the Ollama model's context limit and an LM Studio
  // context error each have one cause and one recovery; an HTTP status or a
  // number in their text (for example 403) is not a Graph denial.
  const exclusive = EXCLUSIVE.find((match) => match(run.error!));
  const matched = exclusive
    ? SUGGESTIONS.filter((suggestion) => suggestion.match === exclusive)
    : SUGGESTIONS.filter((suggestion) => suggestion.match(run.error!));
  const accessDenial = exclusive ? undefined : run.accessDenial ?? graphAccessDenialFromError(run.error);
  if (accessDenial) {
    matched.unshift({ match: () => true, title: accessDenial.title, body: `${accessDenial.message} ${accessDenial.recovery}` });
  }

  return (
    <section className="border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)]">
      <div className="border-b border-[var(--color-danger)]/30 px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm font-medium text-[var(--color-danger)]">
          <IconWarning size={14} />
          <span>Run failed</span>
          <span className="opacity-50">·</span>
          <span className="text-sm">{truncate(run.error, 120)}</span>
        </div>
      </div>
      <div className="p-4">
        {matched.length === 0 ? (
          <div>
            <div className="text-base font-medium text-[var(--color-text)]">
              No matching playbook
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-text-soft)]">
              Inspect the Logs tab locally. If this is reproducible, use Report
              this failure to submit a public GitHub issue after reviewing what
              is safe to make public.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">
              Likely causes
            </div>
            <div className="divide-y divide-[var(--color-danger)]/20 border-y border-[var(--color-danger)]/20">
              {matched.map((suggestion) => (
                <div key={suggestion.title} className="py-3">
                  <div className="text-base font-medium text-[var(--color-text)]">
                    {suggestion.title}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-soft)]">
                    {typeof suggestion.body === "function" ? suggestion.body(run.error!) : suggestion.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end border-t border-[var(--color-border-soft)] pt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              openReportIssue({
                source: "run-failure",
                title: "Run failed",
                description:
                  "An agent run failed during execution. I can reproduce it with the steps below.",
                expectedBehavior:
                  "The run should complete or show recovery guidance I can act on.",
                actualBehavior: "The run ended in the failed state.",
                runId: run.id,
                agentSlug: run.agentSlug,
              })
            }
          >
            Report this failure
          </Button>
        </div>
      </div>
    </section>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
