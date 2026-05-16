import { useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import type {
  AgentSummary,
  AgentTemplate,
  TemplateSetting,
} from "../shared/openAgents";

/**
 * Renders the install-time settings form for one agent. Inputs are driven
 * by the manifest's `definition.settings[]` — the same array shown in the
 * Manifest Preview's "Configurable settings" card, but interactive. The
 * declared `type` picks the input widget; the YAML `default` is the
 * placeholder; the persisted override (if any) is the initial value.
 *
 * Save validates client-side, then defers to `updateAgentSettings`, which
 * re-validates on the host and persists. The form is dirty-aware so users
 * who haven't changed anything aren't forced through a save round-trip.
 */
export function ConfigureAgentModal({
  open,
  onClose,
  agent,
  manifest,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  agent: AgentSummary;
  manifest: AgentTemplate;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const declared = useMemo(
    () => manifest.definition.settings ?? [],
    [manifest.definition.settings],
  );
  const persisted = agent.settings ?? {};

  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    seedFormValues(declared, persisted),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(seedFormValues(declared, persisted));
    setError(null);
    setSubmitting(false);
    // We deliberately reset every time the modal opens — if the user
    // edited then closed without saving, reopening should not preserve
    // the abandoned edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = useMemo(
    () => isDirty(declared, persisted, values),
    [declared, persisted, values],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    let coerced: Record<string, unknown>;
    try {
      coerced = coerceFormValues(declared, values);
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : String(validationError),
      );
      return;
    }

    setSubmitting(true);
    try {
      await onSave(coerced);
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title={`Configure ${agent.name}`}
        subtitle="Overrides are saved per install and merged on top of the manifest defaults at run time."
        onClose={onClose}
      />
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {declared.length === 0 ? (
            <div className="text-[13px] text-[var(--color-text-muted)]">
              This agent does not declare any configurable settings.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {declared.map((setting) => (
                <SettingField
                  key={setting.id}
                  setting={setting}
                  value={values[setting.id]}
                  onChange={(next) =>
                    setValues((current) => ({ ...current, [setting.id]: next }))
                  }
                />
              ))}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[12.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
              {error}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border-soft)] px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || submitting || declared.length === 0}
          >
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: TemplateSetting;
  value: string | boolean | undefined;
  onChange: (next: string | boolean) => void;
}) {
  const inputId = `setting-${setting.id}`;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-[12.5px] font-medium text-[var(--color-text)]"
      >
        {setting.label}
        {setting.required && (
          <span className="ml-1 text-[var(--color-danger)]">*</span>
        )}
      </label>
      {setting.description && (
        <div className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          {setting.description}
        </div>
      )}
      {setting.type === "boolean" ? (
        <label
          htmlFor={inputId}
          className="inline-flex items-center gap-2 text-[12.5px] text-[var(--color-text-soft)]"
        >
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.currentTarget.checked)}
            className="h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] accent-[var(--color-accent)]"
          />
          {value === true ? "Enabled" : "Disabled"}
        </label>
      ) : (
        <input
          id={inputId}
          type={setting.type === "integer" ? "number" : "text"}
          step={setting.type === "integer" ? 1 : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={
            setting.default !== undefined ? `default: ${String(setting.default)}` : undefined
          }
          className="h-9 rounded-md bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
        />
      )}
      {setting.hint && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {setting.hint}
        </div>
      )}
    </div>
  );
}

function seedFormValues(
  declared: TemplateSetting[],
  persisted: Record<string, unknown>,
): Record<string, string | boolean> {
  const seed: Record<string, string | boolean> = {};
  for (const setting of declared) {
    const persistedValue = persisted[setting.id];
    const source = persistedValue !== undefined ? persistedValue : setting.default;

    if (setting.type === "boolean") {
      seed[setting.id] = source === true;
    } else if (source === undefined || source === null) {
      seed[setting.id] = "";
    } else {
      seed[setting.id] = String(source);
    }
  }
  return seed;
}

function coerceFormValues(
  declared: TemplateSetting[],
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const setting of declared) {
    const raw = values[setting.id];

    switch (setting.type) {
      case "integer": {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text === "") {
          if (setting.required) {
            throw new Error(`"${setting.label}" is required.`);
          }
          continue;
        }
        const num = Number(text);
        if (!Number.isFinite(num) || !Number.isInteger(num)) {
          throw new Error(`"${setting.label}" must be a whole number.`);
        }
        out[setting.id] = num;
        break;
      }
      case "string": {
        const text = typeof raw === "string" ? raw : "";
        if (text === "" && !setting.required) continue;
        if (text === "" && setting.required) {
          throw new Error(`"${setting.label}" is required.`);
        }
        out[setting.id] = text;
        break;
      }
      case "boolean": {
        out[setting.id] = raw === true;
        break;
      }
      default: {
        if (raw !== "" && raw !== undefined) {
          out[setting.id] = raw;
        }
      }
    }
  }
  return out;
}

function isDirty(
  declared: TemplateSetting[],
  persisted: Record<string, unknown>,
  values: Record<string, string | boolean>,
): boolean {
  try {
    const coerced = coerceFormValues(declared, values);
    for (const setting of declared) {
      const a = coerced[setting.id];
      const b =
        persisted[setting.id] !== undefined
          ? persisted[setting.id]
          : setting.default;
      if (a !== b) return true;
    }
    return false;
  } catch {
    // If coercion would throw, the form has at least one invalid edit —
    // treat that as dirty so the Save button surfaces the error.
    return true;
  }
}
