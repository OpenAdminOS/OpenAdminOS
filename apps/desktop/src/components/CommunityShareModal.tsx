import { useMemo, useState, type ReactNode } from "react";

import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { IconCheck, IconClose, IconExternal, IconRefresh, IconShare, IconWarning } from "./icons";
import { useAppState } from "../state";
import type {
  AgentCategory,
  AgentCommunitySubmissionCheck,
  AgentCommunitySubmissionMetadata,
  AgentCommunitySubmissionReview,
  AgentManifestPreview,
} from "../shared/openAdminOS";

const categories: AgentCategory[] = [
  "devices",
  "apps",
  "policies",
  "compliance",
  "updates",
];

export function CommunityShareModal({
  open,
  onClose,
  preview,
  slug,
}: {
  open: boolean;
  onClose: () => void;
  preview: AgentManifestPreview;
  slug: string;
}) {
  const {
    prepareAgentCommunitySubmission,
    submitAgentCommunitySubmission,
  } = useAppState();
  const manifest = preview.manifest;
  const [metadata, setMetadata] = useState<AgentCommunitySubmissionMetadata>(() => ({
    name: manifest.descriptor.name,
    description: manifest.descriptor.description,
    category: manifest.descriptor.category,
    maintainerName: manifest.descriptor.author.name,
    supportUrl: manifest.descriptor.author.handle
      ? `@${manifest.descriptor.author.handle}`
      : manifest.descriptor.author.url ?? "",
    licenseConfirmed: false,
    privacyNotes:
      manifest.descriptor.mode === "write" && manifest.descriptor.connectors && manifest.descriptor.connectors.length > 0
        ? "This agent reads Microsoft Graph data, prepares Graph write actions behind typed confirmation, and declares connector egress. No tenant data, prompts, run history, provider settings, tokens, or secrets are included in the submission."
        : manifest.descriptor.mode === "write"
          ? "This agent reads Microsoft Graph data and prepares Graph write actions behind typed confirmation. No tenant data, prompts, run history, provider settings, tokens, or secrets are included in the submission."
          : manifest.descriptor.connectors && manifest.descriptor.connectors.length > 0
        ? "This agent reads Microsoft Graph data and declares connector egress. No tenant data, prompts, run history, provider settings, tokens, or secrets are included in the submission."
        : "This agent reads Microsoft Graph data only. No tenant data, prompts, run history, provider settings, tokens, or secrets are included in the submission.",
    changelog: "Initial community submission.",
  }));
  const [review, setReview] = useState<AgentCommunitySubmissionReview | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);

  const failureCount = review?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warningCount = review?.checks.filter((check) => check.status === "warn").length ?? 0;
  const passCount = review?.checks.filter((check) => check.status === "pass").length ?? 0;
  const canSubmit = Boolean(review?.ok && !issueUrl);

  const packagePreview = useMemo(() => {
    if (!review) return null;
    return [
      ["manifest.yaml", `${review.package.manifestYaml.length.toLocaleString()} bytes`],
      ["README.md", `${review.package.readmeMarkdown.length.toLocaleString()} bytes`],
      ["metadata.json", `${review.package.metadataJson.length.toLocaleString()} bytes`],
    ];
  }, [review]);

  const updateMetadata = <K extends keyof AgentCommunitySubmissionMetadata>(
    key: K,
    value: AgentCommunitySubmissionMetadata[K],
  ) => {
    setMetadata((current) => ({ ...current, [key]: value }));
    setReview(null);
    setIssueUrl(null);
    setError(null);
  };

  const runQa = async () => {
    setRunning(true);
    setError(null);
    setIssueUrl(null);
    try {
      const result = await prepareAgentCommunitySubmission(
        preview.sourceText,
        metadata,
        slug,
      );
      setReview(result);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setRunning(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitAgentCommunitySubmission(
        preview.sourceText,
        metadata,
        slug,
      );
      setIssueUrl(result.issueUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <ModalHeader
        title="Share with community"
        subtitle="Prepare a public GitHub issue for maintainer review. Agent Hub only updates after maintainers approve and merge a registry change."
        onClose={onClose}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] overflow-hidden">
        <div className="overflow-y-auto border-r border-[var(--color-border-soft)] p-5">
          <div className="space-y-4">
            <TextField
              label="Agent name"
              value={metadata.name}
              onChange={(value) => updateMetadata("name", value)}
            />
            <TextArea
              label="Description"
              rows={4}
              value={metadata.description}
              onChange={(value) => updateMetadata("description", value)}
            />
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                Category
              </span>
              <select
                value={metadata.category}
                onChange={(event) =>
                  updateMetadata("category", event.target.value as AgentCategory)
                }
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="Maintainer"
              value={metadata.maintainerName}
              onChange={(value) => updateMetadata("maintainerName", value)}
            />
            <TextField
              label="GitHub handle or support URL"
              value={metadata.supportUrl}
              onChange={(value) => updateMetadata("supportUrl", value)}
              placeholder="@handle or https://..."
            />
            <TextArea
              label="Privacy and egress notes"
              rows={4}
              value={metadata.privacyNotes}
              onChange={(value) => updateMetadata("privacyNotes", value)}
            />
            <TextArea
              label="Changelog"
              rows={3}
              value={metadata.changelog}
              onChange={(value) => updateMetadata("changelog", value)}
            />
            <label className="flex items-start gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-text-soft)]">
              <input
                type="checkbox"
                checked={metadata.licenseConfirmed}
                onChange={(event) =>
                  updateMetadata("licenseConfirmed", event.target.checked)
                }
                className="mt-0.5"
              />
              <span>
                I can submit this agent under the OpenAdminOS MIT license and understand
                that the created GitHub issue is public.
              </span>
            </label>
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="border-b border-[var(--color-border-soft)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[13px] font-semibold text-[var(--color-text)]">
                  QA gate
                </div>
                <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                  Blocking failures must be fixed before OpenAdminOS creates the public
                  review issue.
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<IconRefresh size={12} />}
                onClick={runQa}
                disabled={running || submitting}
              >
                {running ? "Running..." : "Run QA"}
              </Button>
            </div>
            {review && (
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <Badge tone="success">{passCount} passed</Badge>
                <Badge tone={warningCount > 0 ? "warning" : "muted"}>
                  {warningCount} review flags
                </Badge>
                <Badge tone={failureCount > 0 ? "danger" : "muted"}>
                  {failureCount} failed
                </Badge>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {!review ? (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-[12px] text-[var(--color-text-muted)]">
                Run QA to generate the submission package and review checks.
              </div>
            ) : (
              <div className="space-y-3">
                {review.checks.map((check) => (
                  <QaRow key={check.id} check={check} />
                ))}
                {packagePreview && (
                  <div className="mt-5 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4">
                    <div className="text-[12px] font-semibold text-[var(--color-text)]">
                      Package preview
                    </div>
                    <div className="mt-2 space-y-1">
                      {packagePreview.map(([name, size]) => (
                        <div
                          key={name}
                          className="flex items-center justify-between text-[12px]"
                        >
                          <span className="font-mono text-[var(--color-text)]">
                            {name}
                          </span>
                          <span className="text-[var(--color-text-muted)]">{size}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                      Tenant data, prompts, run history, provider settings, tokens, and
                      secrets are excluded.
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                {error}
              </div>
            )}

            {issueUrl && (
              <div className="mt-4 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)]">
                Submitted for maintainer review.{" "}
                <button
                  onClick={() => void window.openAdminOS?.openExternal(issueUrl)}
                  className="inline-flex items-center gap-1 underline"
                >
                  Open issue <IconExternal size={11} />
                </button>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border-soft)] px-5 py-4">
            <div className="max-w-[420px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              This creates a public GitHub issue. Maintainers decide whether it becomes an
              Agent Hub entry.
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Close
              </Button>
              <Button
                variant="primary"
                leadingIcon={<IconShare size={12} />}
                onClick={submit}
                disabled={!canSubmit || submitting}
              >
                {submitting ? "Submitting..." : "Create issue"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function QaRow({ check }: { check: AgentCommunitySubmissionCheck }) {
  const isFail = check.status === "fail";
  const isWarn = check.status === "warn";
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            isFail
              ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
              : isWarn
                ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                : "bg-[var(--color-success-soft)] text-[var(--color-success)]"
          }`}
        >
          {isFail ? (
            <IconClose size={12} />
          ) : isWarn ? (
            <IconWarning size={12} />
          ) : (
            <IconCheck size={12} />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[var(--color-text)]">
            {check.label}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {check.detail}
          </div>
          {check.status === "fail" && check.fix && (
            <div className="mt-2 rounded-md bg-[var(--color-bg)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--color-text-soft)]">
              Fix: {check.fix}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </span>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted";
  children: ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-[var(--color-success)]/30 bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : tone === "warning"
        ? "border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
        : tone === "danger"
          ? "border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <span className={`rounded-full border px-2 py-1 ${toneClass}`}>
      {children}
    </span>
  );
}
