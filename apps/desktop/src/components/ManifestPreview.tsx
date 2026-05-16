import { useState } from "react";
import { Card } from "./Card";
import { Pill } from "./Pill";
import {
  IconBolt,
  IconChevronDown,
  IconCloud,
  IconLock,
  IconShield,
  IconSparkle,
  IconWarning,
} from "./icons";
import type {
  AgentManifestPreview,
  AgentTemplate,
  GraphStep,
  LlmStep,
  TemplateStep,
  TransformStep,
  WriteStep,
} from "../shared/openAgents";

/**
 * Renders an agent's manifest as readable cards so users can audit what an
 * agent does before installing or running it. Two render paths:
 *   - `agent-template` — declarative YAML pipeline (`<TemplateBody>`)
 *   - `code-based`     — TypeScript module with metadata only
 *                        (`<CodeBasedBody>`)
 *
 * Both flavours include a "View raw" affordance at the bottom for users who
 * want to read the exact source the runtime sees.
 */
export function ManifestPreview({ preview }: { preview: AgentManifestPreview }) {
  if (preview.kind === "agent-template") {
    return <TemplateBody preview={preview} />;
  }
  return <CodeBasedBody preview={preview} />;
}

function TemplateBody({
  preview,
}: {
  preview: Extract<AgentManifestPreview, { kind: "agent-template" }>;
}) {
  const { manifest, sourceText, registryPath } = preview;
  const scopes = collectScopesFromManifest(manifest);
  return (
    <div className="flex flex-col gap-6">
      <ScopesCard scopes={scopes} />
      <PipelineCard steps={manifest.skills} />
      <SettingsCard manifest={manifest} />
      <ResultCard manifest={manifest} />
      <RawSourceCard
        sourceText={sourceText}
        registryPath={registryPath}
        languageHint="yaml"
        title="Raw manifest"
        helperText="This is the exact YAML the runtime loaded. The pipeline above is derived from it — there is no hidden code path."
      />
    </div>
  );
}

function CodeBasedBody({
  preview,
}: {
  preview: Extract<AgentManifestPreview, { kind: "code-based" }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="p-6">
          <SectionLabel>This is a code-based agent</SectionLabel>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-text-soft)]">
            Capabilities are declared in <code className="font-mono text-[12px]">manifest.json</code>{" "}
            (shown below). The actual logic lives in a TypeScript module that
            we can't pretty-print here. The runtime still enforces the
            declared scopes and graph operations at runtime — the agent
            cannot call anything outside what it declares.
          </p>
          <p className="mt-3 text-[12.5px] text-[var(--color-text-muted)]">
            Source location: <code className="font-mono">{preview.sourceLocation}</code>
          </p>
        </div>
      </Card>
      <ScopesCard scopes={preview.metadata.scopes} />
      {preview.sourceText && (
        <RawSourceCard
          sourceText={preview.sourceText}
          registryPath={preview.registryPath}
          languageHint="json"
          title="manifest.json"
          helperText="Registry metadata only. The implementation lives in TypeScript source under the same directory."
        />
      )}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────

function ScopesCard({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return (
    <Card>
      <div className="p-6">
        <SectionLabel>Required Graph scopes</SectionLabel>
        <div className="mt-3 flex flex-col gap-2">
          {scopes.map((scope) => (
            <div
              key={scope}
              className="flex items-center gap-2.5 rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
            >
              <IconLock size={13} className="text-[var(--color-text-muted)]" />
              <span className="font-mono text-[12px] text-[var(--color-text)]">
                {scope}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 text-[12px] text-[var(--color-text-muted)]">
          Approved at tenant sign-in. You can revoke these from the
          tenant's Enterprise applications view in the Microsoft Entra
          admin center at any time.
        </div>
      </div>
    </Card>
  );
}

function PipelineCard({ steps }: { steps: TemplateStep[] }) {
  return (
    <Card>
      <div className="p-6">
        <SectionLabel>Pipeline</SectionLabel>
        <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          The agent runs these steps in order. Each step's output is named
          after its id and is available to later steps.
        </div>
        <ol className="mt-5 flex flex-col gap-3">
          {steps.map((step, index) => (
            <li key={step.id}>
              <StepRow step={step} index={index} />
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

function StepRow({ step, index }: { step: TemplateStep; index: number }) {
  const tone = formatTone(step.format);
  return (
    <div className="min-w-0 rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] font-mono text-[11px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-[var(--color-text)]">
              {step.label}
            </span>
            <Pill tone={tone}>
              <FormatIcon format={step.format} /> {formatLabel(step.format)}
            </Pill>
            <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
              id: {step.id}
            </span>
          </div>
          {step.detail && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              {step.detail}
            </p>
          )}
          <div className="mt-3">
            <StepDetail step={step} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StepDetail({ step }: { step: TemplateStep }) {
  switch (step.format) {
    case "graph":
      return <GraphDetail step={step} />;
    case "transform":
      return <TransformDetail step={step} />;
    case "llm":
      return <LlmDetail step={step} />;
    case "write":
      return <WriteDetail step={step} />;
    default:
      return null;
  }
}

function WriteDetail({ step }: { step: WriteStep }) {
  const { kind, source, confirmationPhrase, actionTemplate, scopes } = step.settings;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]">
        <span className="rounded bg-[var(--color-danger-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-danger)]">
          {kind}
        </span>
        <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
          source: {source}
        </span>
      </div>
      <div className="rounded-md bg-[var(--color-danger-soft)] px-3 py-2 ring-1 ring-[var(--color-danger)]/30">
        <div className="flex items-start gap-2">
          <IconWarning size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div className="min-w-0">
            <div className="text-[11.5px] font-medium text-[var(--color-text)]">
              Typed confirmation required
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-soft)]">
              The runtime pauses here and will not call Microsoft Graph until
              the user types the rendered phrase verbatim.
            </div>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]">
              {confirmationPhrase}
            </pre>
          </div>
        </div>
      </div>
      <div className="rounded-md bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
        <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
          Action template (rendered once per source item)
        </div>
        <div className="mt-2 flex flex-col gap-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)]">
          <div>
            <span className="text-[var(--color-text-muted)]">label:</span>{" "}
            {actionTemplate.label}
          </div>
          {actionTemplate.description && (
            <div>
              <span className="text-[var(--color-text-muted)]">description:</span>{" "}
              {actionTemplate.description}
            </div>
          )}
          <div>
            <span className="text-[var(--color-text-muted)]">severity:</span>{" "}
            {actionTemplate.severity ?? "destructive"}
          </div>
          {actionTemplate.metadata && (
            <pre className="mt-1 overflow-x-auto rounded bg-[var(--color-bg-raised)] p-2 text-[10.5px] ring-1 ring-[var(--color-border-soft)]">
              {`metadata:\n${Object.entries(actionTemplate.metadata)
                .map(([key, value]) => `  ${key}: ${String(value)}`)
                .join("\n")}`}
            </pre>
          )}
        </div>
      </div>
      {scopes && scopes.length > 0 && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          Uses scope{scopes.length === 1 ? "" : "s"}:{" "}
          {scopes.map((scope, idx) => (
            <span key={scope}>
              {idx > 0 ? ", " : ""}
              <span className="font-mono text-[var(--color-text-soft)]">{scope}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function GraphDetail({ step }: { step: GraphStep }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11.5px]">
        <span className="shrink-0 rounded bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-success)]">
          {step.settings.method}
        </span>
        <span className="min-w-0 truncate text-[var(--color-text)]">{step.settings.path}</span>
      </div>
      {step.settings.select && step.settings.select.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
            $select
          </span>
          {step.settings.select.map((field) => (
            <span
              key={field}
              className="rounded-md bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
            >
              {field}
            </span>
          ))}
        </div>
      )}
      {step.settings.scopes && step.settings.scopes.length > 0 && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          Uses scope{step.settings.scopes.length === 1 ? "" : "s"}:{" "}
          {step.settings.scopes.map((scope, idx) => (
            <span key={scope}>
              {idx > 0 ? ", " : ""}
              <span className="font-mono text-[var(--color-text-soft)]">{scope}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TransformDetail({ step }: { step: TransformStep }) {
  const settings = step.settings as Record<string, unknown>;
  const kind = typeof settings.kind === "string" ? settings.kind : "(unknown)";
  const summaryFields = Object.entries(settings).filter(
    ([key]) => key !== "kind" && key !== "source",
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]">
        <span className="rounded bg-[var(--color-info-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-info)]">
          {kind}
        </span>
        {typeof settings.source === "string" && (
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
            source: {settings.source}
          </span>
        )}
      </div>
      {summaryFields.length > 0 && (
        <pre className="overflow-x-auto rounded-md bg-[var(--color-surface)] p-3 font-mono text-[10.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          {summaryFields
            .map(([key, value]) => `${key}: ${stringify(value)}`)
            .join("\n")}
        </pre>
      )}
    </div>
  );
}

function LlmDetail({ step }: { step: LlmStep }) {
  const [promptOpen, setPromptOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]">
        {step.when === "ctx.llm.available" && (
          <Pill tone="default">
            <IconShield size={9} /> Gated on LLM availability
          </Pill>
        )}
        {typeof step.settings.temperature === "number" && (
          <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
            temperature: {step.settings.temperature}
          </span>
        )}
        {typeof step.settings.maxTokens === "number" && (
          <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
            maxTokens: {step.settings.maxTokens}
          </span>
        )}
      </div>
      <button
        onClick={() => setPromptOpen((open) => !open)}
        className="inline-flex w-fit items-center gap-1.5 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
      >
        <IconChevronDown
          size={11}
          style={{
            transform: promptOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.15s ease",
          }}
        />
        {promptOpen ? "Hide prompt" : "Show prompt template"}
      </button>
      {promptOpen && (
        <div className="flex flex-col gap-3 rounded-md bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
          {step.settings.system && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                System
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)]">
                {step.settings.system}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Prompt
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)]">
              {step.settings.prompt}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsCard({ manifest }: { manifest: AgentTemplate }) {
  const settings = manifest.definition.settings ?? [];
  if (settings.length === 0) return null;
  return (
    <Card>
      <div className="p-6">
        <SectionLabel>Configurable settings</SectionLabel>
        <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          These can be overridden at install time. Defaults shown here are
          what the agent will use unless you change them.
        </div>
        <div className="mt-4 flex flex-col gap-2.5">
          {settings.map((setting) => (
            <div
              key={setting.id}
              className="flex items-center justify-between gap-4 rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {setting.label}
                </div>
                {setting.description && (
                  <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                    {setting.description}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Pill>{setting.type}</Pill>
                {setting.default !== undefined && (
                  <span className="rounded-md bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
                    default: {stringify(setting.default)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ResultCard({ manifest }: { manifest: AgentTemplate }) {
  const result = manifest.definition.result;
  if (!result) return null;
  return (
    <Card>
      <div className="p-6">
        <SectionLabel>What the run produces</SectionLabel>
        <div className="mt-3">
          <div className="text-[11.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
            Summary template
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-[var(--color-bg-raised)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {result.summary}
          </pre>
        </div>
        {result.data && (
          <div className="mt-4">
            <div className="text-[11.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Result data shape
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-[var(--color-bg-raised)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {stringify(result.data, 2)}
            </pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function RawSourceCard({
  sourceText,
  registryPath,
  languageHint,
  title,
  helperText,
}: {
  sourceText: string;
  registryPath?: string;
  languageHint: string;
  title: string;
  helperText: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="p-6">
        <button
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center gap-2 text-left"
        >
          <IconChevronDown
            size={12}
            className="text-[var(--color-text-muted)]"
            style={{
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
          <SectionLabel>{title}</SectionLabel>
          <span className="ml-auto rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
            .{languageHint}
          </span>
        </button>
        {registryPath && (
          <div className="mt-2 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {registryPath}
          </div>
        )}
        {open && (
          <>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              {helperText}
            </p>
            <pre className="mt-3 max-h-[480px] overflow-auto rounded-lg bg-[var(--color-bg-raised)] p-4 font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {sourceText}
            </pre>
          </>
        )}
      </div>
    </Card>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </span>
  );
}

function FormatIcon({ format }: { format: TemplateStep["format"] }) {
  switch (format) {
    case "graph":
      return <IconCloud size={9} />;
    case "transform":
      return <IconBolt size={9} />;
    case "llm":
      return <IconSparkle size={9} />;
    case "write":
      return <IconWarning size={9} />;
    default:
      return null;
  }
}

function formatLabel(format: TemplateStep["format"]): string {
  switch (format) {
    case "graph":
      return "Graph";
    case "transform":
      return "Transform";
    case "llm":
      return "LLM";
    case "write":
      return "Write";
    default:
      return format;
  }
}

function formatTone(
  format: TemplateStep["format"],
): "success" | "warning" | "accent" | "default" | "danger" {
  switch (format) {
    case "graph":
      return "success";
    case "transform":
      return "default";
    case "llm":
      return "accent";
    case "write":
      return "danger";
    default:
      return "default";
  }
}

function collectScopesFromManifest(manifest: AgentTemplate): string[] {
  const scopes = new Set<string>();
  for (const step of manifest.skills) {
    if (step.format === "graph") {
      for (const scope of step.settings.scopes ?? []) {
        scopes.add(scope);
      }
    } else if (step.format === "write") {
      for (const scope of step.settings.scopes ?? []) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
}

function stringify(value: unknown, indent = 0): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}
