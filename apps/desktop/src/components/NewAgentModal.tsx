import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { ManifestPreview } from "./ManifestPreview";
import { IconSparkle, IconWarning } from "./icons";
import { useAppState } from "../state";
import type { AgentDraft, AgentManifestPreview } from "../shared/openAdminOS";

/**
 * Natural-language → Agent Template flow. The user types a plain-English
 * description; the active LLM provider drafts a YAML manifest; the user
 * sees a full Manifest Preview (same surface they'd see post-install)
 * with the raw YAML next to it; on Save, the agent is persisted to the
 * user-agents directory and we navigate to its detail page.
 *
 * The state machine has three modes:
 *   - prompt    — empty / typing / submitting
 *   - draft     — a draft is ready (may be valid OR have validation errors)
 *   - saving    — Save is in flight
 *
 * Errors are shown inline at the bottom of whichever pane is active so
 * the user never loses the prompt or the draft after a failure.
 */
export function NewAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { state, draftAgentManifest, saveAgentDraft, installAgent } = useAppState();

  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset whenever the modal opens. Abandoned drafts should not survive
  // a close/reopen — fresh start every time.
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setDraft(null);
    setDrafting(false);
    setSaving(false);
    setError(null);
    // Defer focus until the modal animation is done.
    const id = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const llmReady = activeProvider?.status === "connected";
  const llmGuidance =
    activeProvider?.id === "ollama"
      ? "Start Ollama with `ollama serve` from a terminal, then reopen this dialog."
      : `Open Settings → LLM Providers to verify ${activeProvider?.name ?? "your provider"}'s connection.`;

  const previewForRenderer: AgentManifestPreview | null = useMemo(() => {
    if (!draft?.manifest) return null;
    return {
      kind: "agent-template",
      manifest: draft.manifest,
      sourceText: draft.yamlSource,
    };
  }, [draft]);

  const handleDraft = async () => {
    setError(null);
    setDrafting(true);
    setDraft(null);
    try {
      const result = await draftAgentManifest(prompt);
      setDraft(result);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setDrafting(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      await saveAgentDraft(draft.yamlSource);
      const slug = draft.manifest?.descriptor.id;
      if (slug) {
        // The button reads "Save & install" — actually install it so
        // the user lands on a detail page that knows about the agent.
        await installAgent(slug);
        onClose();
        navigate(`/agents/${slug}`);
        return;
      }
      onClose();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <ModalHeader
        title="New agent"
        subtitle={
          draft
            ? "Review what the LLM drafted. You can go back to refine the prompt, or open the raw YAML to make manual tweaks before saving."
            : "Describe what the agent should do. The active LLM provider drafts a YAML manifest you can review before saving."
        }
        onClose={onClose}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {!draft && (
          <PromptPane
            ref={textareaRef}
            prompt={prompt}
            onPromptChange={setPrompt}
            drafting={drafting}
            llmReady={llmReady}
            providerName={activeProvider?.name ?? "your LLM provider"}
            guidance={llmGuidance}
            onDraft={handleDraft}
            error={error}
          />
        )}

        {draft && (
          <DraftPane
            draft={draft}
            previewForRenderer={previewForRenderer}
            saving={saving}
            error={error}
            onBack={() => {
              setDraft(null);
              setError(null);
            }}
            onSave={handleSave}
            onClose={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

interface PromptPaneProps {
  prompt: string;
  onPromptChange: (next: string) => void;
  drafting: boolean;
  llmReady: boolean;
  providerName: string;
  guidance: string;
  onDraft: () => void;
  error: string | null;
}

const PromptPane = forwardRef<HTMLTextAreaElement, PromptPaneProps>(
  (
    { prompt, onPromptChange, drafting, llmReady, providerName, guidance, onDraft, error },
    ref,
  ) => (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-4 rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex items-center gap-2 text-[11.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <IconSparkle size={12} className="text-[var(--color-accent)]" /> What you can ask for
          </div>
          <ul className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            <li>· Read-only agents that call any Microsoft Graph GET endpoint — users, devices, groups, sign-in logs, compliance policies, audit logs, reports, and more.</li>
            <li>· Transforms over the results: group / count / sort / bucket-by-age.</li>
            <li>· An LLM step that writes the headline summary (required — every agent must invoke the model at least once).</li>
            <li>· Settings the user can override at install time (integer / string / boolean).</li>
          </ul>
          <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">
            The drafter looks up real Graph endpoints for your prompt and refuses to invent paths. Write operations are still limited to device retire — broader write support is coming.
          </p>
        </div>

        <label
          htmlFor="new-agent-prompt"
          className="block text-[12.5px] font-medium text-[var(--color-text)]"
        >
          Describe the agent
        </label>
        <textarea
          id="new-agent-prompt"
          ref={ref}
          rows={6}
          placeholder="e.g. Find devices that haven't synced in 60+ days, bucket them by operating system, and write a short summary."
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          disabled={drafting}
          className="mt-2 w-full resize-y rounded-lg bg-[var(--color-surface)] p-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50 disabled:opacity-60"
        />

        {!llmReady && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 ring-1 ring-[var(--color-warning)]/30">
            <IconWarning size={12} className="mt-0.5 text-[var(--color-warning)]" />
            <div className="text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
              <span className="font-medium text-[var(--color-text)]">
                {providerName} isn't reachable.
              </span>{" "}
              {guidance}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border-soft)] px-6 py-3">
        <Button
          type="button"
          variant="primary"
          leadingIcon={<IconSparkle size={12} />}
          disabled={
            !llmReady || drafting || prompt.trim().length === 0
          }
          onClick={onDraft}
        >
          {drafting ? "Drafting…" : "Draft with LLM"}
        </Button>
      </div>
    </>
  ),
);
PromptPane.displayName = "PromptPane";

function DraftPane({
  draft,
  previewForRenderer,
  saving,
  error,
  onBack,
  onSave,
  onClose: _onClose,
}: {
  draft: AgentDraft;
  previewForRenderer: AgentManifestPreview | null;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const valid = draft.validationErrors.length === 0 && previewForRenderer !== null;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {!valid && (
          <div className="mb-4 rounded-lg bg-[var(--color-danger-soft)] p-4 ring-1 ring-[var(--color-danger)]/30">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-danger)]">
              <IconWarning size={12} /> The draft didn't pass schema validation
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
              {draft.validationErrors.map((msg, idx) => (
                <li key={idx}>{msg}</li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
              Go back and refine the prompt — usually adding a sentence
              about the category, scope, or expected output is enough.
            </p>
          </div>
        )}

        {valid && previewForRenderer && (
          <ManifestPreview
            preview={previewForRenderer}
            showDescriptor
            defaultPipelineOpen
          />
        )}

        {!valid && (
          <details className="mt-4 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <summary className="cursor-pointer text-[11.5px] font-medium text-[var(--color-text)]">
              View raw YAML output
            </summary>
            <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)]">
              {draft.yamlSource}
            </pre>
          </details>
        )}

        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--color-border-soft)] px-6 py-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          Back to prompt
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={!valid || saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save & install"}
          </Button>
        </div>
      </div>
    </>
  );
}
