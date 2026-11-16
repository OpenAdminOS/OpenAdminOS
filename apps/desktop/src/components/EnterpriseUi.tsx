import { Component, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from "react";

import type {
  EnterpriseUiBodyView,
  EnterpriseUiElementView,
  EnterpriseUiNoticeView,
  EnterpriseUiReplyView,
  EnterpriseUiToneView,
} from "@openadminos/agent-sdk";
import { checkUiReply } from "@openadminos/enterprise/ui";

import { Modal, ModalHeader } from "./Modal";
import { Badge, Button, StatusDot } from "./ui";

/**
 * Draws a team features module's declarative UI with the app's own
 * components. The main process checked the elements and keeps the current
 * body; this draws only the closed set, as plain text, with no links, and
 * checks every reply again with the same check. No module code runs here.
 */

export const ENTERPRISE_UI_COPY = {
  provenance: "Provided by the team features module",
  confirmScope: "This confirms a team features action. It does not approve a change to your tenant; those are still confirmed in Runs.",
  failedTitle: "The team feature did not complete",
  failedRecovery: "Try again. If it keeps failing, the app log names the cause.",
  unavailable: "Team features are not available in this window. Restart OpenAdminOS, then try again.",
  unreadable: "The team features module answered in a form this app does not draw.",
  drawFailedTitle: "This team features section could not be drawn",
  drawFailedMessage: "The app could not draw what the team features module sent.",
  drawFailedRecovery: "Restart OpenAdminOS. If it stays, update the team features module.",
  emptyBody: "Nothing to show yet.",
  emptyList: "No entries.",
  cancel: "Cancel",
  working: "Working",
  typeToConfirm: (phrase: string) => `Type ${phrase} to confirm`,
} as const;

type Button = Extract<EnterpriseUiElementView, { type: "button" }>;

const NOTICE_TONES: Record<EnterpriseUiToneView, string> = {
  neutral: "bg-[var(--color-hover)] text-[var(--color-text-soft)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
};

const BUTTON_VARIANTS = { primary: "primary", secondary: "secondary", danger: "danger" } as const;

/**
 * A notice. `live` is for the answer to an action the admin just took: a
 * warning or danger one is then announced as an alert. A notice that is
 * part of a body is a status.
 */
export function EnterpriseNotice({ notice, live = false }: { notice: EnterpriseUiNoticeView; live?: boolean }) {
  const urgent = live && (notice.tone === "warning" || notice.tone === "danger");
  return (
    <div role={urgent ? "alert" : "status"} data-tone={notice.tone} className={`rounded-[10px] px-3 py-2.5 text-sm ${NOTICE_TONES[notice.tone] ?? NOTICE_TONES.neutral}`}>
      <p className="font-medium">{notice.title}</p>
      <p className="mt-0.5 whitespace-pre-line text-[var(--color-text-soft)]">{notice.message}</p>
      {notice.recovery ? <p className="mt-1 text-[var(--color-text-soft)]">{notice.recovery}</p> : null}
    </div>
  );
}

/** A notice for a failed call: the reason it gave, and the step that fixes it. */
export function failureNotice(error: unknown): EnterpriseUiNoticeView {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors from the main process with the channel name.
  const reason = raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, "").trim() || ENTERPRISE_UI_COPY.unreadable;
  return { type: "notice", tone: "danger", title: ENTERPRISE_UI_COPY.failedTitle, message: reason, recovery: ENTERPRISE_UI_COPY.failedRecovery };
}

/** The reply checked with the same check the main process runs; anything else is the unreadable notice. */
export function readReply(value: unknown): EnterpriseUiReplyView {
  try {
    return checkUiReply(value) as EnterpriseUiReplyView;
  } catch {
    return { notice: failureNotice(new Error(ENTERPRISE_UI_COPY.unreadable)) };
  }
}

/** Calls a module UI action through the preload bridge; every failure becomes a notice. */
export async function invokeUiAction(action: string, input: unknown): Promise<EnterpriseUiReplyView> {
  const bridge = window.openAdminOS;
  if (!bridge?.invokeEnterpriseUi) return { notice: failureNotice(new Error(ENTERPRISE_UI_COPY.unavailable)) };
  try {
    return readReply(await bridge.invokeEnterpriseUi(action, input));
  } catch (error) {
    return { notice: failureNotice(error) };
  }
}

/** Shows a designed notice instead of a broken section when module UI cannot be drawn. */
export class ModuleUiBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[enterprise] a team features section could not be drawn", { error: error.message, stack: info.componentStack });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <EnterpriseNotice
        notice={{ type: "notice", tone: "danger", title: ENTERPRISE_UI_COPY.drawFailedTitle, message: ENTERPRISE_UI_COPY.drawFailedMessage, recovery: ENTERPRISE_UI_COPY.drawFailedRecovery }}
      />
    );
  }
}

type Inputs = Extract<EnterpriseUiElementView, { type: "field" } | { type: "select" }>;

function inputsOf(body: EnterpriseUiBodyView): Inputs[] {
  return body.elements.filter((element): element is Inputs => element.type === "field" || element.type === "select");
}

function initialValue(element: Inputs): string {
  return element.type === "field" ? element.value ?? "" : element.value ?? element.options[0]?.value ?? "";
}

/** Keeps a value the admin changed when the field or select is still there and the value still fits it. */
function mergeValues(body: EnterpriseUiBodyView, previous: Record<string, string>, dirty: ReadonlySet<string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const element of inputsOf(body)) {
    const kept = previous[element.id];
    const fits =
      kept !== undefined &&
      dirty.has(element.id) &&
      (element.type === "field" ? kept.length <= (element.maxLength ?? 200) : element.options.some((option) => option.value === kept));
    values[element.id] = fits ? kept : initialValue(element);
  }
  return values;
}

/**
 * One module section body, as the host holds it at `revision`. The body is
 * drawn from the host only: a reply body reaches it through the host. A
 * newer revision closes an open confirmation and keeps the values the
 * admin typed where they still fit.
 */
export function EnterpriseUiBody({ sectionId, body, revision = 0 }: { sectionId: string; body: EnterpriseUiBodyView; revision?: number }) {
  const [values, setValues] = useState(() => mergeValues(body, {}, new Set()));
  const dirty = useRef(new Set<string>());
  const [notice, setNotice] = useState<EnterpriseUiNoticeView | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<Button | undefined>();

  // The body changes with its revision; a host without revisions is keyed by the body itself.
  const key = revision > 0 ? String(revision) : JSON.stringify(body);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setConfirming(undefined);
    setValues((previous) => mergeValues(body, previous, dirty.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const run = async (button: Button, confirmedPhrase?: string) => {
    setConfirming(undefined);
    setBusy(button.id);
    setNotice(undefined);
    const ids = new Set(inputsOf(body).map((element) => element.id));
    const reply = await invokeUiAction(button.action, {
      kind: "button",
      sectionId,
      buttonId: button.id,
      values: Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id))),
      ...(confirmedPhrase !== undefined ? { confirmedPhrase } : {}),
    });
    if (reply.body) dirty.current.clear();
    setNotice(reply.notice);
    setBusy(undefined);
  };

  return (
    <div className="space-y-3" aria-busy={busy !== undefined}>
      {notice ? <EnterpriseNotice notice={notice} live /> : null}
      {body.elements.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">{ENTERPRISE_UI_COPY.emptyBody}</p> : null}
      {body.elements.map((element, index) => (
        <EnterpriseUiElement
          key={`${element.type}-${"id" in element ? element.id : index}`}
          element={element}
          sectionId={sectionId}
          value={"id" in element ? values[element.id] ?? "" : ""}
          busy={busy}
          onValue={(id, value) => {
            dirty.current.add(id);
            setValues((previous) => ({ ...previous, [id]: value }));
          }}
          onButton={(button) => (button.confirm ? setConfirming(button) : void run(button))}
        />
      ))}
      {confirming?.confirm ? (
        <ConfirmDialog button={confirming} onCancel={() => setConfirming(undefined)} onConfirm={(phrase) => void run(confirming, phrase)} />
      ) : null}
    </div>
  );
}

function EnterpriseUiElement({
  element,
  sectionId,
  value,
  busy,
  onValue,
  onButton,
}: {
  element: EnterpriseUiElementView;
  sectionId: string;
  value: string;
  busy: string | undefined;
  onValue: (id: string, value: string) => void;
  onButton: (button: Button) => void;
}) {
  const inputId = useId();
  const disabled = busy !== undefined;
  switch (element.type) {
    case "status":
      return (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--color-text-soft)]">{element.label}</span>
          <Badge tone={element.tone}>
            <StatusDot tone={element.tone} /> {element.value}
          </Badge>
        </div>
      );
    case "text":
      return <p className="whitespace-pre-line text-sm text-[var(--color-text-soft)]">{element.text}</p>;
    case "notice":
      return <EnterpriseNotice notice={element} />;
    case "field":
      return (
        <div className="grid gap-1">
          <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">{element.label}</label>
          <input
            id={inputId}
            name={`${sectionId}-${element.id}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={value}
            maxLength={element.maxLength}
            placeholder={element.placeholder}
            disabled={disabled}
            onChange={(event) => onValue(element.id, event.target.value)}
            className={`h-9 rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] ${element.kind === "code" ? "font-mono" : ""}`}
          />
        </div>
      );
    case "select":
      return (
        <div className="grid gap-1">
          <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">{element.label}</label>
          <select
            id={inputId}
            name={`${sectionId}-${element.id}`}
            value={value}
            disabled={disabled}
            onChange={(event) => onValue(element.id, event.target.value)}
            className="h-9 rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          >
            {element.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      );
    case "button":
      return (
        <div>
          <Button size="sm" variant={BUTTON_VARIANTS[element.kind] ?? "secondary"} disabled={disabled} onClick={() => onButton(element)}>
            {busy === element.id ? ENTERPRISE_UI_COPY.working : element.label}
          </Button>
        </div>
      );
    case "list":
      if (element.rows.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">{ENTERPRISE_UI_COPY.emptyList}</p>;
      return (
        <ul className="divide-y divide-[var(--color-border-soft)] rounded-[10px] ring-1 ring-[var(--color-border-soft)]">
          {element.rows.map((row, index) => (
            <li key={`${row.label}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate text-[var(--color-text)]" title={row.label}>{row.label}</span>
              {row.status ? (
                <Badge tone={row.status.tone}>
                  <StatusDot tone={row.status.tone} /> {row.status.value}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      );
    default:
      // Not part of the closed set: nothing is drawn.
      return null;
  }
}

/**
 * Confirms a module button. It names its source and says it does not
 * approve a tenant change, so it is never mistaken for the write diff
 * confirmation; it shows no counts and no diff. With a typed phrase the
 * button acts only once the phrase is typed exactly.
 */
function ConfirmDialog({ button, onCancel, onConfirm }: { button: Button; onCancel: () => void; onConfirm: (phrase?: string) => void }) {
  const confirm = button.confirm!;
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ready = confirm.typedPhrase === undefined || typed === confirm.typedPhrase;
  return (
    <Modal open onClose={onCancel} size="md">
      <ModalHeader title={confirm.title} subtitle={ENTERPRISE_UI_COPY.provenance} onClose={onCancel} />
      <div className="space-y-4 p-6">
        <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text-soft)]">{confirm.message}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{ENTERPRISE_UI_COPY.confirmScope}</p>
        {confirm.typedPhrase ? (
          <div className="grid gap-1">
            <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">{ENTERPRISE_UI_COPY.typeToConfirm(confirm.typedPhrase)}</label>
            <input
              id={inputId}
              data-autofocus
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="h-9 rounded-md bg-[var(--color-surface)] px-3 font-mono text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>{ENTERPRISE_UI_COPY.cancel}</Button>
          <Button variant={BUTTON_VARIANTS[button.kind] ?? "secondary"} disabled={!ready} onClick={() => onConfirm(confirm.typedPhrase === undefined ? undefined : typed)}>
            {button.label}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
