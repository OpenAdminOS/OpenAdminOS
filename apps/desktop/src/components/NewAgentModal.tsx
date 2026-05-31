import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { ManifestPreview } from "./ManifestPreview";
import { CommunityShareModal } from "./CommunityShareModal";
import { IconCheck, IconExternal, IconShare, IconSparkle, IconWarning } from "./icons";
import { useAppState } from "../state";
import type {
  AgentDraft,
  AgentDraftPreflightResult,
  AgentManifestPreview,
  AgentTemplate,
} from "../shared/openAdminOS";

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
  initialYamlSource,
  editingSlug,
}: {
  open: boolean;
  onClose: () => void;
  initialYamlSource?: string;
  editingSlug?: string;
}) {
  const navigate = useNavigate();
  const {
    state,
    draftAgentManifest,
    validateAgentDraft,
    preflightAgentDraft,
    saveAgentDraft,
    updateUserAgentDraft,
    installAgent,
  } = useAppState();

  const [prompt, setPrompt] = useState("");
  const [targetArea, setTargetArea] = useState("Intune");
  const [intent, setIntent] = useState("Investigate");
  const [outputShape, setOutputShape] = useState("Executive summary");
  const [scheduleIntent, setScheduleIntent] = useState("Manual only");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [yamlSource, setYamlSource] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [preflight, setPreflight] = useState<AgentDraftPreflightResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset whenever the modal opens. Abandoned drafts should not survive
  // a close/reopen — fresh start every time.
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setTargetArea("Intune");
    setIntent("Investigate");
    setOutputShape("Executive summary");
    setScheduleIntent("Manual only");
    setDraft(null);
    setYamlSource(initialYamlSource ?? "");
    setDrafting(false);
    setValidating(false);
    setPreflighting(false);
    setPreflight(null);
    setSaving(false);
    setSavedSlug(null);
    setShareOpen(false);
    setError(null);
    // Defer focus until the modal animation is done.
    const id = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [initialYamlSource, open]);

  useEffect(() => {
    if (!open || !initialYamlSource) return;
    let cancelled = false;
    setValidating(true);
    void validateAgentDraft(initialYamlSource, editingSlug)
      .then((result) => {
        if (cancelled) return;
        setDraft(result);
        setYamlSource(result.yamlSource);
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
        }
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingSlug, initialYamlSource, open, validateAgentDraft]);

  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const llmReady = activeProvider?.status === "connected";
  const llmGuidance =
    activeProvider?.id === "ollama"
      ? "Start Ollama with `ollama serve`, or switch providers in Settings."
      : `Open Settings → LLM Providers to verify ${activeProvider?.name ?? "your provider"}'s connection.`;

  const previewForRenderer: AgentManifestPreview | null = useMemo(() => {
    if (!draft?.manifest) return null;
    return {
      kind: "agent-template",
      manifest: draft.manifest,
      sourceText: draft.yamlSource,
    };
  }, [draft]);

  const composedPrompt = useMemo(() => {
    const lines = [
      `Target area: ${targetArea}.`,
      `Intent: ${intent}.`,
      `Expected output: ${outputShape}.`,
      `Schedule: ${scheduleIntent}.`,
      "",
      prompt.trim(),
    ];
    return lines.filter((line, index) => index < 5 || line.length > 0).join("\n");
  }, [intent, outputShape, prompt, scheduleIntent, targetArea]);

  const handleDraft = async () => {
    setError(null);
    setDrafting(true);
    setDraft(null);
    setYamlSource("");
    setPreflight(null);
    try {
      const result = await draftAgentManifest(composedPrompt);
      setDraft(result);
      setYamlSource(result.yamlSource);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setDrafting(false);
    }
  };

  const handleValidate = async () => {
    setError(null);
    setValidating(true);
    try {
      const result = await validateAgentDraft(yamlSource, editingSlug);
      setDraft(result);
      setYamlSource(result.yamlSource);
      setPreflight(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setValidating(false);
    }
  };

  const handlePreflight = async () => {
    setError(null);
    setPreflighting(true);
    try {
      const result = await preflightAgentDraft(yamlSource, editingSlug);
      setPreflight(result);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setPreflighting(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      if (editingSlug) {
        await updateUserAgentDraft(editingSlug, yamlSource);
        onClose();
        navigate(`/agents/${editingSlug}`);
        return;
      }

      await saveAgentDraft(yamlSource);
      const slug = draft.manifest?.descriptor.id;
      if (slug) {
        // The button reads "Save & install" — actually install it so
        // the user lands on a detail page that knows about the agent.
        await installAgent(slug);
        setSavedSlug(slug);
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
        title="Build your own Agent"
        subtitle={
          savedSlug
            ? "The local agent is installed. You can open it now or prepare a community submission."
            : draft
            ? "Review the generated manifest, adjust the YAML if needed, test it, then validate before saving."
            : "Describe the agent. The active LLM provider drafts a YAML manifest you can inspect before it is installed."
        }
        onClose={onClose}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {savedSlug && previewForRenderer && (
          <SavedPane
            slug={savedSlug}
            name={previewForRenderer.manifest.descriptor.name}
            onOpenAgent={() => {
              onClose();
              navigate(`/agents/${savedSlug}`);
            }}
            onShare={() => setShareOpen(true)}
            onClose={onClose}
          />
        )}

        {!savedSlug && !draft && !initialYamlSource && (
          <PromptPane
            ref={textareaRef}
            prompt={prompt}
            onPromptChange={setPrompt}
            targetArea={targetArea}
            onTargetAreaChange={setTargetArea}
            intent={intent}
            onIntentChange={setIntent}
            outputShape={outputShape}
            onOutputShapeChange={setOutputShape}
            scheduleIntent={scheduleIntent}
            onScheduleIntentChange={setScheduleIntent}
            drafting={drafting}
            llmReady={llmReady}
            providerName={activeProvider?.name ?? "your LLM provider"}
            guidance={llmGuidance}
            onOpenSettings={() => {
              onClose();
              navigate("/settings");
            }}
            onDraft={handleDraft}
            error={error}
          />
        )}

        {!savedSlug && !draft && initialYamlSource && (
          <div className="flex-1 px-6 py-5 text-[13px] text-[var(--color-text-muted)]">
            Loading local agent…
          </div>
        )}

        {!savedSlug && draft && (
          <DraftPane
            draft={draft}
            yamlSource={yamlSource}
            onYamlSourceChange={setYamlSource}
            previewForRenderer={previewForRenderer}
            validating={validating}
            preflighting={preflighting}
            preflight={preflight}
            saving={saving}
            error={error}
            editing={Boolean(editingSlug)}
            onBack={() => {
              if (editingSlug) {
                onClose();
                return;
              }
              setDraft(null);
              setYamlSource("");
              setPreflight(null);
              setError(null);
            }}
            onValidate={handleValidate}
            onPreflight={handlePreflight}
            onSave={handleSave}
            onClose={onClose}
          />
        )}
      </div>
      {savedSlug && previewForRenderer && (
        <CommunityShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          preview={previewForRenderer}
          slug={savedSlug}
        />
      )}
    </Modal>
  );
}

function SavedPane({
  slug,
  name,
  onOpenAgent,
  onShare,
  onClose,
}: {
  slug: string;
  name: string;
  onOpenAgent: () => void;
  onShare: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/30">
        <IconCheck size={18} />
      </div>
      <div className="mt-4 text-[15px] font-semibold text-[var(--color-text)]">
        {name} is installed
      </div>
      <div className="mt-2 max-w-[460px] text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
        The agent is local to this device. Sharing creates a public GitHub issue for
        maintainer review; it does not publish the agent into Agent Hub.
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button
          variant="primary"
          leadingIcon={<IconExternal size={12} />}
          onClick={onOpenAgent}
        >
          Open agent
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<IconShare size={12} />}
          onClick={onShare}
        >
          Share with community
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="mt-4 font-mono text-[11px] text-[var(--color-text-muted)]">
        {slug}
      </div>
    </div>
  );
}

function CapabilityPreview({
  manifest,
  yamlSource,
  onYamlSourceChange,
}: {
  manifest: AgentTemplate;
  yamlSource: string;
  onYamlSourceChange: (next: string) => void;
}) {
  const graphSteps = manifest.skills.filter((skill) => skill.format === "graph");
  const writeSteps = manifest.skills.filter((skill) => skill.format === "write");
  const llmSteps = manifest.skills.filter((skill) => skill.format === "llm");
  const connectorSteps = manifest.skills.filter((skill) => skill.format === "connector");
  const settings = manifest.definition.settings ?? [];
  const triggers = manifest.definition.triggers ?? [];
  const scheduled = triggers.some((trigger) => trigger.kind === "scheduled");
  const scopes = Array.from(
    new Set(
      [...graphSteps, ...writeSteps].flatMap((skill) =>
        Array.isArray(skill.settings.scopes) ? skill.settings.scopes : [],
      ),
    ),
  );

  const confirmationTier =
    writeSteps.length > 0
      ? "Typed write confirmation"
      : connectorSteps.length > 0
        ? "Connector preview"
        : "No write confirmation";

  return (
    <div className="mb-4 rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[12.5px] font-medium text-[var(--color-text)]">
            Capability review
          </div>
          <div className="text-[11.5px] text-[var(--color-text-muted)]">
            Check this before installing the local agent.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
            Version
            <input
              value={readDescriptorVersion(yamlSource)}
              onChange={(event) =>
                onYamlSourceChange(
                  replaceDescriptorVersion(yamlSource, event.currentTarget.value),
                )
              }
              className="h-7 w-[92px] rounded-md bg-[var(--color-surface)] px-2 font-mono text-[11.5px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-[var(--color-accent)]/50"
            />
          </label>
          <span className="rounded-full bg-[var(--color-surface)] px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {manifest.descriptor.mode}
          </span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <CapabilityCell
          label="Graph"
          value={`${graphSteps.length} step${graphSteps.length === 1 ? "" : "s"}`}
          detail={graphSteps.map((step) => step.id).join(", ") || "None"}
        />
        <CapabilityCell
          label="Scopes"
          value={`${scopes.length} required`}
          detail={scopes.slice(0, 3).join(", ") || "None"}
        />
        <CapabilityCell
          label="LLM"
          value={`${llmSteps.length} step${llmSteps.length === 1 ? "" : "s"}`}
          detail={manifest.descriptor.preferredModel ?? "Uses active model"}
        />
        <CapabilityCell
          label="Approval"
          value={confirmationTier}
          detail={
            writeSteps.length > 0
              ? "Every write pauses before Graph changes"
              : "Read-only unless connector steps are shown"
          }
        />
        <CapabilityCell
          label="Settings"
          value={`${settings.length} field${settings.length === 1 ? "" : "s"}`}
          detail={settings.map((setting) => setting.id).join(", ") || "None"}
        />
        <CapabilityCell
          label="Connectors"
          value={`${connectorSteps.length} step${connectorSteps.length === 1 ? "" : "s"}`}
          detail={
            manifest.descriptor.connectors
              ?.map((connector) => `${connector.id}${connector.required ? " required" : " optional"}`)
              .join(", ") || "None"
          }
        />
        <CapabilityCell
          label="Schedule"
          value={scheduled ? "Eligible" : "Manual"}
          detail={
            scheduled
              ? "Declares a scheduled trigger"
              : "Can still be scheduled per install"
          }
        />
        <CapabilityCell
          label="Residency"
          value="Uses active provider"
          detail="Local/hosted residency is selected at run time"
        />
      </div>
    </div>
  );
}

function replaceDescriptorVersion(yamlSource: string, version: string): string {
  const lines = yamlSource.split(/\r?\n/);
  let inDescriptor = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^descriptor:\s*$/.test(line)) {
      inDescriptor = true;
      continue;
    }
    if (inDescriptor && /^[a-zA-Z]/.test(line)) break;
    if (inDescriptor && /^  version:\s*/.test(line)) {
      lines[i] = `  version: ${version}`;
      return lines.join("\n");
    }
  }
  return yamlSource;
}

function readDescriptorVersion(yamlSource: string): string {
  const lines = yamlSource.split(/\r?\n/);
  let inDescriptor = false;
  for (const line of lines) {
    if (/^descriptor:\s*$/.test(line)) {
      inDescriptor = true;
      continue;
    }
    if (inDescriptor && /^[a-zA-Z]/.test(line)) break;
    const match = inDescriptor ? line.match(/^  version:\s*(.+?)\s*$/) : null;
    if (match) return match[1] ?? "";
  }
  return "";
}

function CapabilityCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate text-[12.5px] font-medium text-[var(--color-text)]">
        {value}
      </div>
      <div className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-[var(--color-text-muted)]">
        {detail}
      </div>
    </div>
  );
}

function PreflightResult({ result }: { result: AgentDraftPreflightResult }) {
  const hasWarnings = result.checks.some((check) => check.status === "warn");
  const title = result.ok
    ? hasWarnings
      ? "Draft preflight passed with warnings"
      : "Draft preflight passed"
    : "Draft preflight needs attention";
  return (
    <div
      className={`mb-4 rounded-lg p-4 ring-1 ${
        result.ok
          ? "bg-[var(--color-success-soft)] ring-[var(--color-success)]/25"
          : "bg-[var(--color-danger-soft)] ring-[var(--color-danger)]/30"
      }`}
    >
      <div
        className={`text-[12.5px] font-medium ${
          result.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"
        }`}
      >
        {title}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {result.checks.map((check) => (
          <div
            key={check.id}
            className="rounded-md bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-[var(--color-text)]">
                {check.label}
              </div>
              <span className={`text-[10.5px] uppercase tracking-wider ${preflightTone(check.status)}`}>
                {check.status}
              </span>
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              {check.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function preflightTone(status: AgentDraftPreflightResult["checks"][number]["status"]) {
  if (status === "pass") return "text-[var(--color-success)]";
  if (status === "warn") return "text-[var(--color-warning)]";
  return "text-[var(--color-danger)]";
}

interface PromptPaneProps {
  prompt: string;
  onPromptChange: (next: string) => void;
  targetArea: string;
  onTargetAreaChange: (next: string) => void;
  intent: string;
  onIntentChange: (next: string) => void;
  outputShape: string;
  onOutputShapeChange: (next: string) => void;
  scheduleIntent: string;
  onScheduleIntentChange: (next: string) => void;
  drafting: boolean;
  llmReady: boolean;
  providerName: string;
  guidance: string;
  onOpenSettings: () => void;
  onDraft: () => void;
  error: string | null;
}

const PromptPane = forwardRef<HTMLTextAreaElement, PromptPaneProps>(
  (
    {
      prompt,
      onPromptChange,
      targetArea,
      onTargetAreaChange,
      intent,
      onIntentChange,
      outputShape,
      onOutputShapeChange,
      scheduleIntent,
      onScheduleIntentChange,
      drafting,
      llmReady,
      providerName,
      guidance,
      onOpenSettings,
      onDraft,
      error,
    },
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
            The drafter looks up real Graph endpoints for your prompt and refuses to invent paths. Write operations use the same typed confirmation gate as published agents.
          </p>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <BuilderSelect
            label="Target area"
            value={targetArea}
            onChange={onTargetAreaChange}
            options={["Intune", "Entra", "Users and groups", "Apps", "Security", "Licensing"]}
            disabled={drafting}
          />
          <BuilderSelect
            label="Action"
            value={intent}
            onChange={onIntentChange}
            options={[
              "Investigate",
              "Report posture",
              "Triage items",
              "Prepare write plan",
              "Send report",
            ]}
            disabled={drafting}
          />
          <BuilderSelect
            label="Output"
            value={outputShape}
            onChange={onOutputShapeChange}
            options={[
              "Executive summary",
              "Prioritized list",
              "Per-item rationale",
              "Table-friendly findings",
            ]}
            disabled={drafting}
          />
          <BuilderSelect
            label="Schedule"
            value={scheduleIntent}
            onChange={onScheduleIntentChange}
            options={[
              "Manual only",
              "Daily",
              "Weekly",
            ]}
            disabled={drafting}
          />
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
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onOpenSettings}
              className="shrink-0"
            >
              Settings
            </Button>
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
          {drafting ? "Drafting and repairing…" : "Draft agent"}
        </Button>
      </div>
    </>
  ),
);
PromptPane.displayName = "PromptPane";

function BuilderSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 h-9 w-full rounded-md bg-[var(--color-surface)] px-2 text-[12.5px] normal-case tracking-normal text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-[var(--color-accent)]/50 disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function DraftPane({
  draft,
  yamlSource,
  onYamlSourceChange,
  previewForRenderer,
  validating,
  preflighting,
  preflight,
  saving,
  error,
  editing,
  onBack,
  onValidate,
  onPreflight,
  onSave,
  onClose: _onClose,
}: {
  draft: AgentDraft;
  yamlSource: string;
  onYamlSourceChange: (next: string) => void;
  previewForRenderer: AgentManifestPreview | null;
  validating: boolean;
  preflighting: boolean;
  preflight: AgentDraftPreflightResult | null;
  saving: boolean;
  error: string | null;
  editing: boolean;
  onBack: () => void;
  onValidate: () => void;
  onPreflight: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const valid = draft.validationErrors.length === 0 && previewForRenderer !== null;
  const yamlDirty = yamlSource.trim() !== draft.yamlSource.trim();
  const preflightBlocking = !preflight?.ok;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {valid && draft.manifest && (
          <CapabilityPreview
            manifest={draft.manifest}
            yamlSource={yamlSource}
            onYamlSourceChange={onYamlSourceChange}
          />
        )}

        {preflight && <PreflightResult result={preflight} />}

        {!valid && (
          <div className="mb-4 rounded-lg bg-[var(--color-danger-soft)] p-4 ring-1 ring-[var(--color-danger)]/30">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-danger)]">
              <IconWarning size={12} /> The draft needs changes before it can be saved
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
              {draft.validationErrors.map((msg, idx) => (
                <li key={idx}>{msg}</li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
              Edit the YAML below and validate again, or go back and refine
              the prompt.
            </p>
          </div>
        )}

        <div
          className={
            valid
              ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.72fr)]"
              : "grid gap-4"
          }
        >
          {valid && previewForRenderer && (
            <div className="min-w-0">
              <ManifestPreview
                preview={previewForRenderer}
                showDescriptor
                defaultPipelineOpen
                showRawSource={false}
              />
            </div>
          )}

          <div className="min-w-0 rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-[12.5px] font-medium text-[var(--color-text)]">
                  Manifest YAML
                </div>
                <div className="text-[11.5px] text-[var(--color-text-muted)]">
                  Local draft only. Validate before saving.
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={validating || saving || yamlSource.trim().length === 0}
                onClick={onValidate}
              >
                {validating ? "Validating…" : "Validate"}
              </Button>
            </div>
            <textarea
              value={yamlSource}
              onChange={(event) => onYamlSourceChange(event.currentTarget.value)}
              spellCheck={false}
              className="h-[520px] w-full resize-y rounded-md bg-[var(--color-surface)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-[var(--color-accent)]/50"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--color-border-soft)] px-6 py-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          {editing ? "Cancel edit" : "Back to prompt"}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!valid || yamlDirty || validating || preflighting || saving}
            onClick={onPreflight}
          >
            {preflighting ? "Testing…" : "Test draft"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!valid || yamlDirty || preflightBlocking || validating || saving}
            onClick={onSave}
          >
            {saving
              ? "Saving…"
              : yamlDirty
                ? "Validate before saving"
                : preflightBlocking
                  ? "Test before saving"
                  : editing
                    ? "Save changes"
                    : "Save & install"}
          </Button>
        </div>
      </div>
    </>
  );
}
