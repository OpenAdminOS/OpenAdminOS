import { Link } from "react-router";
import { IconWarning } from "./icons";
import { Button } from "./Button";
import { useReportIssue } from "./ReportIssueModal";
import type { RunRecord } from "../shared/openAdminOS";
import { isOllamaKeptContextFailure, isOllamaReasoningWithoutAnswerMessage, ollamaFailureOwnText as ownText } from "../shared/ollama-failure";
import { errorIsGraphSignInRejection, graphAccessDenialFromStoredText, storedGraphAccessDenial, type ContextTooSmallFailure } from "@openadminos/agent-sdk";

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
 * The sizes and the reload steps from the runtime's LM Studio context
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
const EXCLUSIVE = [isOllamaReasoningWithoutAnswerMessage, isOllamaKeptContextFailure, isLmStudioContextTooSmall, isContextLimitLookup];

/**
 * A Microsoft sign-in error as MSAL reports it: the message starts with an
 * AADSTS code, or with an OAuth error such as interaction_required followed by
 * one, also after the app's write-plan wrappers. An AADSTS code quoted further
 * into a provider's error is not a tenant sign-in.
 */
const MICROSOFT_SIGN_IN_ERROR = /^(?:The (?:plan|proposal) could not be checked[^.]*\. |Nothing was applied: )?(?:AADSTS\d+|(?:interaction_required|invalid_grant|consent_required): AADSTS\d+)/;


const SUGGESTIONS: Suggestion[] = [
  {
    match: (e) => /ollama/i.test(e) && /(not reachable|connect|refused|econnrefused)/i.test(e) && !isContextLimitLookup(e),
    title: "Ollama isn't running",
    body: "Start it from a terminal with `ollama serve`, confirm it's reachable at http://127.0.0.1:11434, then re-run.",
  },
  {
    match: isOllamaKeptContextFailure,
    title: "Ollama failed with a kept context size",
    body: "Re-run the same request. OpenAdminOS dropped the kept size, so Ollama can start from its default context size. If it fails again, close other apps to free memory or pick a smaller model in Settings → LLM Providers.",
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
    match: isOllamaReasoningWithoutAnswerMessage,
    title: "Model reasoned without answering",
    body: "The model spent its output on reasoning and wrote no answer, so there is no report. Raise the step's maxTokens, narrow the agent's scope, or pick a model that answers without reasoning in Settings → LLM Providers, then re-run.",
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
    // Only a Graph 401 ("Graph rejected the access token (HTTP 401)") or a
    // Microsoft sign-in error (an AADSTS code) is a tenant sign-in failure; a
    // model server or vendor API that answers 401, 403 Unauthorized or
    // "expired token" is not.
    match: (e) =>
      (errorIsGraphSignInRejection(e) || MICROSOFT_SIGN_IN_ERROR.test(e)) &&
      !isContextLimitLookup(e),
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

/** Recovery for a request that did not fit the model, read from the typed reason. */
function contextTooSmallSuggestion(failure: ContextTooSmallFailure): Suggestion {
  const tokens = (value: number) => value.toLocaleString("en-US");
  const model = failure.model ?? "The selected model";
  return {
    match: () => true,
    title: "Prompt larger than the model's context",
    body:
      `This run needs about ${tokens(failure.neededTokens)} tokens of context and ${model} accepts ${tokens(failure.limitTokens)}, ` +
      (failure.sentToProvider
        ? "so the model refused the request or stopped before finishing its answer. "
        : "so OpenAdminOS stopped before sending anything. ") +
      "Pick a local model with a larger context window in Settings → LLM Providers, " +
      "switch to a hosted provider (the prompt then leaves this device), or run the agent against a narrower scope, then re-run.",
  };
}

export function RunFailureRemediation({
  run,
  hasReasoningModelFitOffer = false,
}: {
  run: RunRecord;
  hasReasoningModelFitOffer?: boolean;
}) {
  const openReportIssue = useReportIssue();
  if (run.status !== "failed" || !run.error) return null;
  if (run.origin === "sophos-change" || run.origin === "splashtop-change") {
    const sophos = run.origin === "sophos-change";
    const vendor = sophos ? "Sophos Central" : "Splashtop";
    const consoleUrl = sophos ? "https://central.sophos.com/" : "https://my.splashtop.com/";
    return (
      <section className="border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4">
        <h3 className="flex items-center gap-2 text-base font-medium text-[var(--color-danger)]">
          <IconWarning size={14} />
          {vendor} change stopped
        </h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{run.error}</p>
        {run.summary && <p className="mt-2 text-sm text-[var(--color-text-soft)]">{run.summary}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          <Link className="underline" to={`/connections?connect=${sophos ? "sophos" : "splashtop"}`}>
            Prepare the change again
          </Link>
          <Button size="sm" variant="secondary" onClick={() => void window.openAdminOS?.openExternal(consoleUrl)}>
            {sophos ? "Check the endpoint in Sophos Central" : "Check the computer in Splashtop"}
          </Button>
        </div>
      </section>
    );
  }
  // A typed reason is exact, so it comes first and replaces the guesses.
  const typed = run.failureReason?.code === "context-too-small" ? run.failureReason : undefined;
  // Each exclusive playbook has one cause and one recovery. An HTTP status
  // or a number in its text (for example 403) does not add another playbook.
  const own = ownText(run.error);
  // A cause the runtime classified from its typed error decides, whatever
  // wrapper the app put in front of the message.
  const exclusive = run.failureCause === "reasoning-without-answer"
    ? isOllamaReasoningWithoutAnswerMessage
    : typed
      ? (typed.ollamaKeptContext === true ? isOllamaKeptContextFailure : undefined)
      : EXCLUSIVE.find((match) => match(own));
  const matched = exclusive
    ? SUGGESTIONS.filter((suggestion) => suggestion.match === exclusive)
    : typed
      ? [contextTooSmallSuggestion(typed)]
      : SUGGESTIONS.filter((suggestion) => suggestion.match(own));
  // Only a Graph error gets Graph recovery advice. Runs stored by earlier
  // versions can carry an accessDenial for a 403 from a model server, a
  // vendor API, or an MCP server, for example a "403 MiB" in what Ollama
  // said; that stored value is ignored. A failure classified from its typed
  // error is never read from its text; a run stored by an earlier version is
  // read from its message, as Graph code wrote it before denials were stored.
  // A typed context reason is never a Graph denial.
  const accessDenial = typed || exclusive
    ? undefined
    : storedGraphAccessDenial(run.accessDenial, run.error)
      ?? (run.graphDenialChecked ? undefined : graphAccessDenialFromStoredText(run.error));
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
                    {hasReasoningModelFitOffer && suggestion.match === isOllamaReasoningWithoutAnswerMessage
                      ? "The model spent its output on reasoning and wrote no answer, so there is no report. Raise the step's maxTokens, narrow the agent's scope, or run it with another model below."
                      : typeof suggestion.body === "function" ? suggestion.body(run.error!) : suggestion.body}
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
