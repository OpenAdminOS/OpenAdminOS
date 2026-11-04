import { useId, useState } from "react";

import type { IntuneChatDocumentationSource, IntuneChatMessage, IntuneChatSource, IntuneChatStep } from "../../shared/openAdminOS";
import {
  STEP_ORIGIN_TONE,
  formatIndexVersion,
  formatStepDuration,
  sourcesForCards,
  splitAnswerBlocks,
  summarizeSteps,
  usedTenantEvidence,
} from "../../shared/chat-steps";
import { CitationContext, MarkdownPreview } from "../MarkdownPreview";
import { IconCheck, IconChevronRight, IconClose, IconWarning } from "../icons";

function StepNode({ step }: { step: IntuneChatStep }) {
  const tone = step.status === "failed"
    ? { text: "text-[var(--color-danger)]", soft: "bg-[var(--color-danger-soft)]" }
    : step.status === "blocked" ? STEP_ORIGIN_TONE["third-party"] : STEP_ORIGIN_TONE[step.origin];
  return (
    <span
      aria-hidden="true"
      className={`relative z-[1] mt-px grid h-[21px] w-[21px] place-items-center rounded-full ring-1 ring-inset ring-current/40 ${tone.text} ${tone.soft} ${step.status === "active" ? "motion-safe:animate-pulse" : ""}`}
    >
      {step.status === "completed" ? <IconCheck size={11} /> : step.status === "failed" ? <IconClose size={11} /> : step.status === "blocked" ? <IconWarning size={11} /> : <span className="h-[5px] w-[5px] rounded-full bg-current" />}
    </span>
  );
}

const STATUS_LABEL: Record<IntuneChatStep["status"], string> = { active: "running", completed: "done", failed: "failed", blocked: "blocked" };

/** The steps of one answer, each with its origin tag. Live while the answer runs. */
export function StepTimeline({ steps, id }: { steps: readonly IntuneChatStep[]; id?: string }) {
  return (
    <ol id={id} aria-label="Steps" className="relative mb-4 list-none p-0">
      {steps.map((step, index) => {
        const tone = STEP_ORIGIN_TONE[step.origin];
        return (
          <li
            key={step.id}
            aria-current={step.status === "active" ? "step" : undefined}
            className="relative grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-3 py-[7px]"
          >
            {index < steps.length - 1 ? <span aria-hidden="true" className="absolute bottom-[-8px] left-[10px] top-[24px] w-px bg-[var(--color-border)]" /> : null}
            <StepNode step={step} />
            <div className="min-w-0">
              <div className="text-base font-medium text-[var(--color-text)]">
                {step.title}
                <span className="sr-only">, {STATUS_LABEL[step.status]}</span>
                {step.durationMs !== undefined && step.status !== "active" ? (
                  <span className="ml-1.5 font-mono text-xs font-normal text-[var(--color-text-muted)]">{formatStepDuration(step.durationMs)}</span>
                ) : null}
              </div>
              {step.detail ? <div className="break-words text-sm text-[var(--color-text-muted)]">{step.detail}</div> : null}
              {step.kind === "mcp" && step.sent && step.status !== "blocked" ? (
                <div className="mt-1 flex flex-wrap items-baseline gap-1.5 text-sm text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-warning)]">Sent</span>
                  <code className="break-all rounded-[5px] bg-[var(--color-code-bg)] px-1.5 py-px font-mono text-xs text-[var(--color-text)]">{step.sent}</code>
                  <span>Nothing else was sent to {step.originLabel}.</span>
                </div>
              ) : null}
            </div>
            <span className={`mt-px self-start whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone.text} ${tone.soft}`}>{step.originLabel}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The first row before the host sends a step, so the answer area of a run
 * is never empty. It reads the same as the host's first step.
 */
export function StepSkeleton() {
  const tone = STEP_ORIGIN_TONE.device;
  return (
    <ol aria-label="Steps" className="relative mb-4 list-none p-0">
      <li aria-current="step" className="relative grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-3 py-[7px]">
        <span aria-hidden="true" className={`relative z-[1] mt-px grid h-[21px] w-[21px] place-items-center rounded-full ring-1 ring-inset ring-current/40 motion-safe:animate-pulse ${tone.text} ${tone.soft}`}>
          <span className="h-[5px] w-[5px] rounded-full bg-current" />
        </span>
        <div className="min-w-0">
          <div className="text-base font-medium text-[var(--color-text)]">
            Reading the question
            <span className="sr-only">, running</span>
          </div>
          <div aria-hidden="true" className="run-skeleton mt-1.5 h-2.5 w-44 max-w-full" />
        </div>
        <span className={`mt-px self-start whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone.text} ${tone.soft}`}>On device</span>
      </li>
    </ol>
  );
}

/** The folded line after an answer. It expands to the full timeline. */
export function StepSummary({ message }: { message: IntuneChatMessage }) {
  const [open, setOpen] = useState(false);
  const timelineId = useId();
  const steps = message.steps ?? [];
  if (steps.length === 0) return null;
  const summary = summarizeSteps(message);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={timelineId}
        onClick={() => setOpen((value) => !value)}
        className="mb-3 flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2 text-left ring-1 ring-inset ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      >
        <IconChevronRight size={13} className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <span aria-hidden="true" className="inline-flex gap-[3px]">
          {steps.map((step) => <i key={step.id} className={`h-2 w-2 rounded-full ${STEP_ORIGIN_TONE[step.origin].dot}`} />)}
        </span>
        <span className="text-sm font-medium text-[var(--color-text)]">{summary.count} {summary.count === 1 ? "step" : "steps"}</span>
        <span className="text-sm text-[var(--color-text-muted)]">{formatStepDuration(summary.totalMs)} · {summary.sources}</span>
        <span className="text-xs text-[var(--color-text-muted)] sm:ml-auto">{summary.egress}</span>
      </button>
      <div id={timelineId} hidden={!open}>
        {open ? <StepTimeline steps={steps} /> : null}
      </div>
    </>
  );
}

function sourceTone(source: IntuneChatDocumentationSource) {
  return source.kind === "mcp" ? STEP_ORIGIN_TONE["third-party"] : STEP_ORIGIN_TONE.device;
}

const cardId = (messageId: string, citation: number) => `source-${messageId}-${citation}`;

function CitationChip({ messageId, source }: { messageId: string; source: IntuneChatDocumentationSource }) {
  const tone = sourceTone(source);
  return (
    <button
      type="button"
      title={source.title}
      aria-label={`Source ${source.citation}: ${source.title}`}
      onClick={() => {
        const card = document.getElementById(cardId(messageId, source.citation));
        card?.scrollIntoView({ block: "nearest" });
        card?.focus();
      }}
      className={`mx-px rounded-[5px] px-1.5 py-px align-[2px] font-sans text-[11px] font-medium leading-none ${tone.text} ${tone.soft} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]`}
    >
      {source.citation}
    </button>
  );
}

/**
 * The answer, split into documentation and tenant blocks labelled from the
 * trace. Citations that match a source become chips; others stay text.
 */
export function AnswerBody({ message, content }: { message: IntuneChatMessage; content: string }) {
  const sources = message.documentationSources ?? [];
  const blocks = splitAnswerBlocks(content, { documentationSources: sources, tenantEvidence: usedTenantEvidence(message) });
  const renderCitation = (citation: number) => {
    const source = sources.find((entry) => entry.citation === citation);
    return source ? <CitationChip messageId={message.id} source={source} /> : undefined;
  };
  return (
    <CitationContext.Provider value={renderCitation}>
      {blocks.map((block, index) => {
        const tone = block.kind === "tenant" ? STEP_ORIGIN_TONE.graph : /Docs index$/.test(block.label ?? "") ? STEP_ORIGIN_TONE.device : STEP_ORIGIN_TONE["third-party"];
        return (
          <section key={index} aria-label={block.label} className={blocks.length > 1 ? "mb-4" : undefined}>
            {block.label ? (
              <div className={`mb-1 flex items-center gap-1.5 font-sans text-xs uppercase tracking-[0.04em] ${tone.text}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                {block.label}
              </div>
            ) : null}
            <MarkdownPreview source={block.text} numberedSections={false} tableTools className="chat-answer text-[var(--color-text)]" />
          </section>
        );
      })}
    </CitationContext.Provider>
  );
}

function formatTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Source cards for the cited documentation and, when tenant tools ran, the tenant resources. */
export function SourceCards({ message, content }: { message: IntuneChatMessage; content: string }) {
  const { cited, sources: docs } = sourcesForCards(content, message.documentationSources ?? []);
  const tenant: IntuneChatSource[] = usedTenantEvidence(message) && docs.length > 0
    ? (message.sources ?? []).filter((source) => source.rows > 0 && !source.error).slice(0, 3)
    : [];
  if (docs.length === 0) return null;
  return (
    <section aria-label={cited ? "Sources" : "Consulted"} className="mb-4 mt-2">
      <h3 className="mb-2 text-sm font-normal text-[var(--color-text-muted)]">{cited ? "Sources" : "Consulted"}</h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
        {docs.map((source) => {
          const tone = sourceTone(source);
          return (
            <div
              key={source.citation}
              id={cardId(message.id, source.citation)}
              tabIndex={-1}
              className={`rounded-lg border-t-2 px-3 py-2.5 ring-1 ring-inset ring-[var(--color-border-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${source.kind === "mcp" ? "border-[var(--color-warning)]" : "border-[var(--color-success)]"}`}
            >
              <div className={`font-mono text-[11px] ${tone.text}`}>{cited ? `${source.citation} · ` : ""}{source.kind === "mcp" ? source.serverName ?? "MCP server" : "Docs index"}</div>
              <div className="my-0.5 text-sm font-medium leading-snug text-[var(--color-text)]">
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">{source.title}</a>
                ) : source.title}
              </div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">
                {source.kind === "mcp"
                  ? `${source.host ?? "third-party host"} · third-party content`
                  : `On device · ${source.file ?? ""}${source.indexVersion ? ` · index from ${formatIndexVersion(source.indexVersion)}` : ""}`}
              </div>
            </div>
          );
        })}
        {tenant.map((source) => (
          <div key={`${source.resource}-${source.source}`} className="rounded-lg border-t-2 border-[var(--color-info)] px-3 py-2.5 ring-1 ring-inset ring-[var(--color-border-soft)]">
            <div className="font-mono text-[11px] text-[var(--color-info)]">Tenant</div>
            <div className="my-0.5 text-sm font-medium leading-snug text-[var(--color-text)]">{source.label}</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {source.source === "live" ? "Graph" : "Cache"} · {source.rows.toLocaleString()} rows{formatTime(source.refreshedAt) ? ` · ${formatTime(source.refreshedAt)}` : ""}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Follow-up chips under an answer. Picking one fills the composer; nothing is sent. */
export function FollowUpChips({ followUps, disabled, onPick }: { followUps: readonly string[]; disabled: boolean; onPick: (text: string) => void }) {
  if (followUps.length === 0) return null;
  return (
    <div role="group" aria-label="Follow-up questions" className="-mt-5 mb-[30px] flex flex-wrap gap-1.5">
      {followUps.map((text) => (
        <button
          key={text}
          type="button"
          disabled={disabled}
          onClick={() => onPick(text)}
          className="min-h-[30px] max-w-full rounded-full px-3 py-1 text-left text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
