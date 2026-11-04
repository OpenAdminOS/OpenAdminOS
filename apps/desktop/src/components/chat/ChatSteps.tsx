import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { IntuneChatDocumentationSource, IntuneChatMessage, IntuneChatSource, IntuneChatStep, IntuneChatStepOrigin } from "../../shared/openAdminOS";
import {
  STEP_ORIGIN_TONE,
  formatIndexVersion,
  formatStepDuration,
  mainLearnPage,
  numberCitations,
  orderCitationRuns,
  originCounts,
  sourceHost,
  sourcesHeadingDetail,
  splitAnswerBlocks,
  summarizeSteps,
  tenantNotUsed,
  usedTenantEvidence,
  type EgressEntry,
  type SourceCard,
} from "../../shared/chat-steps";
import { CitationContext, MarkdownPreview } from "../MarkdownPreview";
import { IconCheck, IconChevronRight, IconClose, IconCloud, IconExternal, IconHardDrive, IconLayers, IconWarning } from "../icons";
import { Tooltip } from "../ui/Tooltip";

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
                  <code className="[overflow-wrap:anywhere] rounded-[5px] bg-[var(--color-code-bg)] px-1.5 py-px font-mono text-xs text-[var(--color-text)]">{step.sent}</code>
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

/** One icon per origin in the folded line: on device, Microsoft Graph, an MCP host, the model provider. */
const ORIGIN_ICON: Record<IntuneChatStepOrigin, (props: { size?: number }) => ReactNode> = {
  device: IconHardDrive,
  graph: IconLayers,
  "third-party": IconExternal,
  model: IconCloud,
};

function OriginCounts({ steps }: { steps: readonly IntuneChatStep[] }) {
  const counts = originCounts(steps);
  return (
    <>
      <span aria-hidden="true" className="inline-flex items-center gap-2">
        {counts.map(({ origin, label, count }) => {
          const Icon = ORIGIN_ICON[origin];
          return (
            <span key={origin} title={`${count} ${count === 1 ? "step" : "steps"}: ${label}`} className={`inline-flex items-center gap-0.5 ${STEP_ORIGIN_TONE[origin].text}`}>
              <Icon size={12} />
              <span className="font-mono text-xs">{count}</span>
            </span>
          );
        })}
      </span>
      <span className="sr-only">{counts.map(({ label, count }) => `${count} on ${label}`).join(", ")}.</span>
    </>
  );
}

/** Exactly what left the device for an answer, per destination. */
function EgressDetail({ entries }: { entries: readonly EgressEntry[] }) {
  return (
    <div className="mb-4 rounded-lg px-3 py-2.5 text-sm ring-1 ring-inset ring-[var(--color-border-soft)]">
      <p className="mb-2 text-[var(--color-text-muted)]">What left this device for this answer, and where it went.</p>
      <ul className="list-none space-y-2.5 p-0">
        {entries.map((entry) => (
          <li key={entry.where}>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className={`rounded-full px-2 py-px text-xs ${STEP_ORIGIN_TONE[entry.origin].text} ${STEP_ORIGIN_TONE[entry.origin].soft}`}>{entry.where}</span>
              <span className="text-[var(--color-text-soft)]">received {entry.what.join(" and ")}</span>
            </div>
            <ul className="mt-1 list-none space-y-1 p-0 pl-1">
              {entry.items.map((item) => (
                <li key={item} className="text-[var(--color-text-muted)]">
                  {entry.origin === "third-party" ? (
                    <code className="[overflow-wrap:anywhere] rounded-[5px] bg-[var(--color-code-bg)] px-1.5 py-px font-mono text-xs text-[var(--color-text)]">{item}</code>
                  ) : item}
                </li>
              ))}
            </ul>
            {entry.origin === "third-party" ? <p className="mt-1 pl-1 text-xs text-[var(--color-text-muted)]">Nothing else was sent to {entry.where}.</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The folded line after an answer: origin icons with counts, the step
 * count and time, the sources, and what left the device. The steps part
 * expands to the full timeline and, below it, the tenant sources and tool
 * calls; "Sent" expands to exactly what left the device. An older answer
 * with no steps shows the details only.
 */
export function StepSummary({ message, details }: { message: IntuneChatMessage; details?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [sentOpen, setSentOpen] = useState(false);
  const timelineId = useId();
  const egressId = useId();
  const steps = message.steps ?? [];
  if (steps.length === 0) {
    if (!details) return null;
    return (
      <>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={timelineId}
          onClick={() => setOpen((value) => !value)}
          className="mb-3 flex items-center gap-1 rounded-md text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          <IconChevronRight size={13} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          How the answer was made
        </button>
        <div id={timelineId} hidden={!open}>{open ? details : null}</div>
      </>
    );
  }
  const summary = summarizeSteps(message);
  const notUsed = tenantNotUsed(message);
  const sources = [
    ...(summary.sources === "no sources" && notUsed ? [] : [summary.sources.charAt(0).toUpperCase() + summary.sources.slice(1)]),
    ...(notUsed ? ["Tenant not used"] : []),
  ];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset ring-[var(--color-border-soft)]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={timelineId}
          onClick={() => setOpen((value) => !value)}
          className="-mx-1 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 text-left transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          <IconChevronRight size={13} className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <OriginCounts steps={steps} />
          <span className="font-medium text-[var(--color-text)]">{summary.count} {summary.count === 1 ? "step" : "steps"}</span>
          <span className="text-[var(--color-text-muted)]">· {formatStepDuration(summary.totalMs)}{sources.map((part) => ` · ${part}`).join("")}</span>
        </button>
        {summary.sent.length === 0 ? (
          <span className="text-[var(--color-text-muted)]">{summary.egress}</span>
        ) : (
          <button
            type="button"
            aria-expanded={sentOpen}
            aria-controls={egressId}
            onClick={() => setSentOpen((value) => !value)}
            className="-mx-1 min-h-7 rounded-md px-1 text-left text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          >
            <span className="font-medium text-[var(--color-warning)] underline decoration-dotted underline-offset-2">Sent</span>
            {summary.egress.slice("Sent".length)}
          </button>
        )}
      </div>
      <div id={egressId} hidden={!sentOpen}>{sentOpen ? <EgressDetail entries={summary.sent} /> : null}</div>
      <div id={timelineId} hidden={!open}>
        {open ? (
          <>
            <StepTimeline steps={steps} />
            {details}
          </>
        ) : null}
      </div>
    </>
  );
}

const rowId = (messageId: string, display: number) => `source-${messageId}-${display}`;
const REVEAL_EVENT = "openadminos:chat-source-reveal";

/** Shown first in a source list; the rest sit under "Show N more". */
const VISIBLE_SOURCES = 3;

function SourcePopover({ source }: { source: IntuneChatDocumentationSource }) {
  return (
    <span className="block text-left">
      <span className="block font-medium">{source.title}</span>
      <span className="block opacity-75">{sourceHost(source)}</span>
      {source.excerpt ? <span className="mt-1.5 block opacity-90">{source.excerpt}</span> : null}
    </span>
  );
}

function CitationChip({ messageId, source, display }: { messageId: string; source: IntuneChatDocumentationSource; display: number }) {
  return (
    <Tooltip content={<SourcePopover source={source} />} panelClassName="max-w-80">
      <button
        type="button"
        aria-label={`Source ${display}: ${source.title}`}
        onClick={() => window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { messageId, display } }))}
        className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-[var(--color-active)] px-1 align-[1px] font-sans text-xs font-semibold leading-none text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border)] transition-colors hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      >
        {display}
      </button>
    </Tooltip>
  );
}

/**
 * The answer, split into documentation and tenant blocks labelled from the
 * trace when it has both. Citations that match a source become chips
 * numbered 1..N in the order they first appear; others stay text.
 */
export function AnswerBody({ message, content }: { message: IntuneChatMessage; content: string }) {
  const sources = message.documentationSources ?? [];
  const ordered = orderCitationRuns(content, sources);
  const blocks = splitAnswerBlocks(ordered, { documentationSources: sources, tenantEvidence: usedTenantEvidence(message) });
  const numbering = numberCitations(ordered, sources);
  const cardByDisplay = new Map(numbering.cited.map((card) => [card.display, card]));
  const renderCitation = (citation: number) => {
    const display = numbering.displayFor(citation);
    const card = display === undefined ? undefined : cardByDisplay.get(display);
    return card && display !== undefined ? <CitationChip messageId={message.id} source={card} display={display} /> : undefined;
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
            <MarkdownPreview source={block.text} numberedSections={false} tableTools copySteps className="chat-answer text-[var(--color-text)]" />
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

function SourceRow({ messageId, card, display, highlighted }: { messageId: string; card: SourceCard; display?: number; highlighted: boolean }) {
  const where = card.kind === "mcp"
    ? sourceHost(card)
    : `${card.file ?? "local docs index"}${card.indexVersion ? ` · index from ${formatIndexVersion(card.indexVersion)}` : ""}`;
  return (
    <li
      id={display === undefined ? undefined : rowId(messageId, display)}
      tabIndex={display === undefined ? undefined : -1}
      className={`flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${highlighted ? "bg-[var(--color-warning-soft)] ring-1 ring-inset ring-[var(--color-warning)]" : ""}`}
    >
      {display !== undefined ? (
        <span aria-hidden="true" className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-[var(--color-active)] px-1 text-xs font-semibold text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border)]">
          {display}
        </span>
      ) : null}
      {display !== undefined ? <span className="sr-only">Source {display}: </span> : null}
      {card.url ? (
        <a href={card.url} target="_blank" rel="noopener noreferrer" title={card.title} className="min-w-0 truncate rounded text-sm font-medium text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
          {card.title}
        </a>
      ) : (
        <span title={card.title} className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">{card.title}</span>
      )}
      <span className="ml-auto shrink-0 truncate pl-2 text-xs text-[var(--color-text-muted)] max-w-[45%]">{where}</span>
    </li>
  );
}

/**
 * The sources of an answer as a compact list: one line each with its
 * number, title and host, the first three shown and the rest under "Show
 * N more". The heading names the third-party hosts once, as not verified.
 * Sources the answer was given but does not cite sit under a collapsed
 * "Also consulted". A citation chip reveals, scrolls to and briefly
 * highlights its row. When tenant tools ran, the tenant resources follow.
 */
export function SourceList({ message, content }: { message: IntuneChatMessage; content: string }) {
  const sources = message.documentationSources ?? [];
  const ordered = orderCitationRuns(content, sources);
  const numbering = numberCitations(ordered, sources);
  const cited = numbering.cited;
  // When nothing is cited, the MCP results the answer was given are shown as consulted.
  const consulted = cited.length > 0 ? numbering.consulted : numbering.consulted.filter((card) => card.kind === "mcp");
  const [showAll, setShowAll] = useState(false);
  const [consultedOpen, setConsultedOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const listId = useId();
  const consultedId = useId();
  const highlightTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId: string; display: number }>).detail;
      if (detail?.messageId !== message.id) return;
      if (detail.display > VISIBLE_SOURCES) setShowAll(true);
      setPendingFocus(detail.display);
      setHighlighted(detail.display);
      window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setHighlighted(null), 1600);
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener(REVEAL_EVENT, onReveal);
      window.clearTimeout(highlightTimer.current);
    };
  }, [message.id]);

  useEffect(() => {
    if (pendingFocus === null) return;
    const row = document.getElementById(rowId(message.id, pendingFocus));
    if (row) {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      row.focus({ preventScroll: true });
    }
    setPendingFocus(null);
  }, [pendingFocus, message.id, showAll]);

  const tenant: IntuneChatSource[] = usedTenantEvidence(message) && cited.length > 0
    ? (message.sources ?? []).filter((source) => source.rows > 0 && !source.error).slice(0, 3)
    : [];
  const shown = cited.length > 0 ? cited : consulted;
  if (shown.length === 0) return null;
  const heading = cited.length > 0 ? "Sources" : "Consulted";
  // Uncited third-party rows sit under this heading too, so their hosts are named as well.
  const detail = sourcesHeadingDetail(cited.length > 0 ? [...shown, ...consulted] : shown);
  const hidden = shown.length - VISIBLE_SOURCES;
  const learnPage = mainLearnPage(numbering);
  return (
    <section aria-label={heading} className="mb-4 mt-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-normal text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text-soft)]">{heading}</span>
          {detail ? <> · {detail}</> : null}
        </h3>
        {learnPage ? (
          <a
            href={learnPage.url}
            target="_blank"
            rel="noopener noreferrer"
            title={learnPage.title}
            className="ml-auto inline-flex items-center gap-1 rounded text-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          >
            Open in Learn
            <IconExternal size={12} />
            <span className="sr-only">: {learnPage.title}</span>
          </a>
        ) : null}
      </div>
      <ol id={listId} className="-mx-1.5 list-none p-0">
        {shown.map((card, index) => (index < VISIBLE_SOURCES || showAll ? (
          <SourceRow
            key={card.citation}
            messageId={message.id}
            card={card}
            {...(cited.length > 0 ? { display: (card as SourceCard & { display: number }).display } : {})}
            highlighted={cited.length > 0 && highlighted === (card as SourceCard & { display: number }).display}
          />
        ) : null))}
      </ol>
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={() => setShowAll((value) => !value)}
          className="mt-0.5 rounded text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          {showAll ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
      {cited.length > 0 && consulted.length > 0 ? (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={consultedOpen}
            aria-controls={consultedId}
            onClick={() => setConsultedOpen((value) => !value)}
            className="flex items-center gap-1 rounded text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          >
            <IconChevronRight size={12} className={`transition-transform duration-150 ${consultedOpen ? "rotate-90" : ""}`} />
            Also consulted ({consulted.length})
          </button>
          <ul id={consultedId} hidden={!consultedOpen} aria-label="Also consulted" className="-mx-1.5 mt-0.5 list-none p-0">
            {consultedOpen ? consulted.map((card) => <SourceRow key={card.citation} messageId={message.id} card={card} highlighted={false} />) : null}
          </ul>
        </div>
      ) : null}
      {tenant.length > 0 ? (
        <ul aria-label="Tenant data" className="mt-2 list-none space-y-0.5 p-0 text-sm">
          {tenant.map((source) => (
            <li key={`${source.resource}-${source.source}`} className="flex min-w-0 items-center gap-2 text-[var(--color-text-muted)]">
              <span className="text-xs text-[var(--color-info)]">Tenant</span>
              <span className="truncate font-medium text-[var(--color-text)]">{source.label}</span>
              <span className="ml-auto shrink-0 text-xs">
                {source.source === "live" ? "Graph" : "Cache"} · {source.rows.toLocaleString()} rows{formatTime(source.refreshedAt) ? ` · ${formatTime(source.refreshedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The follow-up under an answer, one quiet chip next to the composer
 * ghost text. When a docs answer's follow-up would read tenant data, the
 * chip says so. Picking it fills the composer; nothing is sent.
 */
export function FollowUpChip({ followUp, usesTenant, disabled, onPick }: { followUp: string; usesTenant: boolean; disabled: boolean; onPick: (text: string) => void }) {
  return (
    <div className="-mt-5 mb-[30px] flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(followUp)}
        title="Fills the message box. Nothing is sent."
        className="inline-flex min-h-[30px] max-w-full items-center gap-2 rounded-full px-3 py-1 text-left text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60"
      >
        <span className="min-w-0">{followUp}</span>
        {usesTenant ? <span className="sr-only">, </span> : null}
        {usesTenant ? (
          <span className="shrink-0 rounded-full bg-[var(--color-info-soft)] px-1.5 py-px text-xs text-[var(--color-info)] ring-1 ring-inset ring-[var(--color-info)]/30">Uses tenant data</span>
        ) : null}
      </button>
    </div>
  );
}
