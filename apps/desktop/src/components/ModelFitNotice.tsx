import { useId } from "react";
import { Button } from "./Button";
import { MODEL_FIT_COPY } from "../copy/model-fit";
import { PROVIDER_TOOL_NAMES } from "../copy/providers";
import { providerDataLocation } from "../copy/trust";
import { modelDisplayName } from "../setup/model-choice";
import type { ModelFitChoice, ModelFitChoices } from "../shared/model-fit";
import type { ModelFitIssue } from "../shared/openAdminOS";

/** What the admin knows a model as: "OpenAdmin 8B" for the OpenAdmin model, the name otherwise. */
export function modelFitModelName(issue: Pick<ModelFitIssue, "model" | "providerId">, providerName?: string): string {
  return modelDisplayName(issue.model) ?? providerName ?? PROVIDER_TOOL_NAMES[issue.providerId] ?? issue.providerId;
}

/**
 * The model fit notice (mockup 36, sections A, E and F): why the local
 * model cannot do this request, and the configured alternatives. Every
 * choice is its own button and none is focused or highlighted, so nothing
 * is preselected; a hosted one opens the accept step before anything is
 * sent.
 */
export function ModelFitNotice({
  issue,
  choices,
  surface,
  onChoose,
  onSplit,
  onKeep,
  onOpenProviders,
  returnModel,
}: {
  /** The active model Chat stays on; defaults to the model that failed. */
  returnModel?: string;
  issue: ModelFitIssue;
  choices: ModelFitChoices;
  surface: "chat" | "run";
  onChoose: (choice: ModelFitChoice) => void;
  onSplit?: () => void;
  /** Keep the local model. Absent on the run page, which has nothing to keep. */
  onKeep?: () => void;
  onOpenProviders?: () => void;
}) {
  const titleId = useId();
  const model = modelFitModelName(issue);
  const answered = issue.reason === "repeated-failure";
  const rows = [...choices.hosted, ...choices.local];
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-model-fit=""
      // Focus returns here when the accept step closes with Back or Escape.
      tabIndex={-1}
      className="mb-3 rounded-[10px] bg-[var(--color-surface)] px-[18px] py-4 text-sm ring-1 ring-[var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
    >
      <h2 id={titleId} className="text-base font-medium text-[var(--color-text)]">
        {MODEL_FIT_COPY.title(issue, model, surface)}
      </h2>
      {/* Announced when the notice replaces the error, so a screen reader hears why and that choices follow. */}
      <span role="status" className="sr-only">{`${MODEL_FIT_COPY.title(issue, model, surface)}. ${MODEL_FIT_COPY.why(issue, model, surface)}`}</span>
      <p className="mt-1 text-[var(--color-text-soft)]">{MODEL_FIT_COPY.why(issue, model, surface)}</p>
      {answered ? null : <p className="mt-1 text-xs text-[var(--color-text-muted)]">{MODEL_FIT_COPY.nothingSent}</p>}
      {rows.length > 0 ? (
        <>
          <div className="mb-1.5 mt-3.5 text-xs text-[var(--color-text-muted)]">{MODEL_FIT_COPY.groupLabel(issue, surface)}</div>
          <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg ring-1 ring-[var(--color-border)]">
            {rows.map((choice) => {
              const tool = PROVIDER_TOOL_NAMES[choice.providerId] ?? choice.providerName;
              return (
                <li key={`${choice.providerId}:${choice.model ?? ""}`} className="flex flex-wrap items-center gap-3 bg-[var(--color-bg)] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[var(--color-text)]">{choice.isLocal ? choice.model : tool}</div>
                    {choice.isLocal ? (
                      <>
                        <div className="text-xs text-[var(--color-success)]">{MODEL_FIT_COPY.localWhere(choice.providerName)}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">{MODEL_FIT_COPY.localNote(surface)}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-xs text-[var(--color-warning)]">{providerDataLocation({ id: choice.providerId, name: choice.providerName })}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">{MODEL_FIT_COPY.costNote(choice.providerId, tool, surface)}</div>
                      </>
                    )}
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => onChoose(choice)}>
                    {choice.isLocal ? MODEL_FIT_COPY.useLocal(choice.model ?? choice.providerName) : MODEL_FIT_COPY.runWith(tool)}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {choices.hosted.length === 0 ? (
        <p className="mt-3.5 flex flex-wrap items-center gap-x-2 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-[var(--color-text-soft)]">
          <span>{choices.hostedBlockedByPolicy ? MODEL_FIT_COPY.policy : MODEL_FIT_COPY.noneSetUp}</span>
          {!choices.hostedBlockedByPolicy && onOpenProviders ? (
            <button
              type="button"
              onClick={onOpenProviders}
              className="rounded-sm underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {MODEL_FIT_COPY.openProviders}
            </button>
          ) : null}
        </p>
      ) : null}
      {onSplit || onKeep ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onSplit && !answered ? <Button size="sm" variant="secondary" onClick={onSplit}>{MODEL_FIT_COPY.split}</Button> : null}
          {onKeep ? <Button size="sm" variant="ghost" onClick={onKeep}>{answered ? MODEL_FIT_COPY.keepAnswer : MODEL_FIT_COPY.keep(returnModel ?? model)}</Button> : null}
        </div>
      ) : null}
    </section>
  );
}
