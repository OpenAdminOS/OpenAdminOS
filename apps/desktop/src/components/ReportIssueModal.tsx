import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { IconDownload, IconExternal, IconWarning } from "./icons";
import type {
  SupportBundleInput,
  SupportIssueSubmissionResult,
} from "../shared/openAdminOS";

type ReportIssuePrefill = Partial<SupportBundleInput>;

interface ReportIssueForm {
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  source: SupportBundleInput["source"];
  runId?: string;
  agentSlug?: string;
}

const defaultForm: ReportIssueForm = {
  title: "",
  description: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  source: "sidebar",
};

const ReportIssueContext = createContext<(prefill?: ReportIssuePrefill) => void>(
  () => undefined,
);

export function useReportIssue() {
  return useContext(ReportIssueContext);
}

export function ReportIssueProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<ReportIssuePrefill | undefined>();

  const openReportIssue = useCallback((nextPrefill?: ReportIssuePrefill) => {
    setPrefill(nextPrefill);
    setOpen(true);
  }, []);

  return (
    <ReportIssueContext.Provider value={openReportIssue}>
      {children}
      <ReportIssueModal
        open={open}
        prefill={prefill}
        onClose={() => setOpen(false)}
      />
    </ReportIssueContext.Provider>
  );
}

function ReportIssueModal({
  open,
  prefill,
  onClose,
}: {
  open: boolean;
  prefill?: ReportIssuePrefill;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ReportIssueForm>(defaultForm);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issueResult, setIssueResult] = useState<SupportIssueSubmissionResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      title: prefill?.title ?? "",
      description: prefill?.description ?? "",
      stepsToReproduce: prefill?.stepsToReproduce ?? "",
      expectedBehavior: prefill?.expectedBehavior ?? "",
      actualBehavior: prefill?.actualBehavior ?? "",
      source: prefill?.source ?? "sidebar",
      runId: prefill?.runId,
      agentSlug: prefill?.agentSlug,
    });
    setIncludeDiagnostics(true);
    setPublicConfirmed(false);
    setBusy(false);
    setError(null);
    setNotice(null);
    setIssueResult(null);
  }, [open, prefill]);

  const hasRequiredFields = useMemo(
    () => form.title.trim().length > 0 && form.description.trim().length > 0,
    [form.description, form.title],
  );
  const canSubmit = hasRequiredFields && publicConfirmed;

  const update = (key: keyof ReportIssueForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    if (!busy) onClose();
  };

  const submitIssue = async () => {
    const api = window.openAdminOS;
    if (!api) {
      setError("Desktop bridge unavailable. Use the Electron app to submit an issue.");
      return;
    }
    if (!canSubmit) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setIssueResult(null);

    try {
      const result = await api.submitSupportIssue({
        ...toSupportBundleInput(form),
        confirmPublic: true,
        includeDiagnostics,
      });
      setIssueResult(result);
      setNotice(`Public GitHub issue #${result.issueNumber} created.`);
      await api.openExternal(result.issueUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const exportDiagnostics = async () => {
    const api = window.openAdminOS;
    if (!api) {
      setError("Desktop bridge unavailable. Use the Electron app to export diagnostics.");
      return;
    }
    if (!hasRequiredFields) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await api.exportSupportBundle(toSupportBundleInput(form));
      if (result.canceled) {
        setNotice("Diagnostics export cancelled.");
        return;
      }
      setNotice("Diagnostics file exported locally. Review it before sharing.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} size="lg">
      <ModalHeader
        title="Report issue"
        subtitle="Submit a public GitHub issue after explicit confirmation."
        onClose={handleClose}
      />
      <div className="min-h-0 overflow-y-auto p-6">
        <div className="rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-3 text-[12px] leading-relaxed text-[var(--color-warning)]">
          <div className="flex items-start gap-2">
            <IconWarning size={14} className="mt-0.5 shrink-0" />
            <p>
              This creates a public GitHub issue. Do not paste tenant names,
              UPNs, device names, group names, API keys, tokens, prompts,
              Graph output, or run reports.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4">
          <TextField
            label="Title"
            value={form.title}
            maxLength={160}
            placeholder="Short failure summary"
            onChange={(value) => update("title", value)}
          />
          <TextArea
            label="What happened"
            rows={5}
            value={form.description}
            maxLength={2_000}
            placeholder="Describe the failure in plain language. Keep tenant data out."
            onChange={(value) => update("description", value)}
          />
          <TextArea
            label="Steps to reproduce"
            rows={4}
            value={form.stepsToReproduce}
            maxLength={2_000}
            placeholder={"1. Open...\n2. Click...\n3. See..."}
            onChange={(value) => update("stepsToReproduce", value)}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <TextArea
              label="Expected"
              rows={4}
              value={form.expectedBehavior}
              maxLength={1_200}
              onChange={(value) => update("expectedBehavior", value)}
            />
            <TextArea
              label="Actual"
              rows={4}
              value={form.actualBehavior}
              maxLength={1_200}
              onChange={(value) => update("actualBehavior", value)}
            />
          </div>
        </div>

        <label className="mt-5 flex items-start gap-3 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-text-soft)]">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Include the sanitized diagnostics summary in the public issue. It
            excludes tenant identifiers, prompts, Graph response bodies, run
            results, raw logs, secrets, screenshots, and local databases.
          </span>
        </label>

        <label className="mt-3 flex items-start gap-3 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3 text-[12px] text-[var(--color-danger)]">
          <input
            type="checkbox"
            checked={publicConfirmed}
            onChange={(event) => setPublicConfirmed(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand this creates a public GitHub issue in
            OpenAdminOS/OpenAdminOS.
          </span>
        </label>

        {notice && (
          <div className="mt-4 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-success)]">
            {notice}{" "}
            {issueResult && (
              <button
                onClick={() => void window.openAdminOS?.openExternal(issueResult.issueUrl)}
                className="inline-flex items-center gap-1 underline"
              >
                Open issue <IconExternal size={11} />
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border-soft)] px-6 py-4">
        <div className="max-w-[420px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          OpenAdminOS sends this report to its server endpoint. The server
          creates the GitHub issue with a repo-scoped token.
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void exportDiagnostics()}
            disabled={!hasRequiredFields || busy}
            leadingIcon={<IconDownload size={13} />}
          >
            Export diagnostics JSON
          </Button>
          <Button
            variant="primary"
            onClick={() => void submitIssue()}
            disabled={!canSubmit || busy}
            leadingIcon={<IconExternal size={13} />}
          >
            {busy ? "Submitting..." : "Submit public issue"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function toSupportBundleInput(form: ReportIssueForm): SupportBundleInput {
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    stepsToReproduce: optionalTrimmed(form.stepsToReproduce),
    expectedBehavior: optionalTrimmed(form.expectedBehavior),
    actualBehavior: optionalTrimmed(form.actualBehavior),
    source: form.source,
    runId: form.runId,
    agentSlug: form.agentSlug,
  };
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function TextField({
  label,
  value,
  maxLength,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          {label}
        </span>
        <span className="font-mono text-[10px] text-[var(--color-text-faint)]">
          {value.length}/{maxLength}
        </span>
      </div>
      <input
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  rows,
  maxLength,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  maxLength: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          {label}
        </span>
        <span className="font-mono text-[10px] text-[var(--color-text-faint)]">
          {value.length}/{maxLength}
        </span>
      </div>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
