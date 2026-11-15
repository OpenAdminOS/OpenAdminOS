import { useEffect, useId, useMemo, useState } from "react";

import type {
  EnterpriseUiBodyView,
  EnterpriseUiElementView,
  EnterpriseUiNoticeView,
  EnterpriseUiReplyView,
  EnterpriseUiToneView,
} from "@openadminos/agent-sdk";

import { Modal, ModalHeader } from "./Modal";
import { Badge, Button, StatusDot } from "./ui";

/**
 * Draws a team features module's declarative UI with the app's own
 * components. The main process checked the elements; this draws only the
 * closed set, as plain text, with no links. No module code runs here.
 */

export const ENTERPRISE_UI_COPY = {
  failedTitle: "The team feature did not complete",
  failedRecovery: "Try again. If it keeps failing, the app log names the cause.",
  unavailable: "Team features are not available in this window. Restart OpenAdminOS, then try again.",
  unreadable: "The team features module answered in a form this app does not draw.",
  cancel: "Cancel",
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

export function EnterpriseNotice({ notice }: { notice: EnterpriseUiNoticeView }) {
  const urgent = notice.tone === "warning" || notice.tone === "danger";
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
  const reason = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "").trim() || ENTERPRISE_UI_COPY.unreadable;
  return { type: "notice", tone: "danger", title: ENTERPRISE_UI_COPY.failedTitle, message: reason, recovery: ENTERPRISE_UI_COPY.failedRecovery };
}

function isNotice(value: unknown): value is EnterpriseUiNoticeView {
  const notice = value as Partial<EnterpriseUiNoticeView> | null;
  return typeof notice === "object" && notice !== null && notice.type === "notice" && typeof notice.title === "string" && typeof notice.message === "string";
}

/** The reply as the main process checked it; anything else is drawn as the unreadable notice. */
export function readReply(value: unknown): EnterpriseUiReplyView {
  const reply = value as Partial<EnterpriseUiReplyView> | null;
  if (typeof reply !== "object" || reply === null) return { notice: failureNotice(new Error(ENTERPRISE_UI_COPY.unreadable)) };
  const body = reply.body && Array.isArray(reply.body.elements) ? reply.body : undefined;
  const notice = isNotice(reply.notice) ? reply.notice : undefined;
  if (!body && !notice) return { notice: failureNotice(new Error(ENTERPRISE_UI_COPY.unreadable)) };
  return { ...(body ? { body } : {}), ...(notice ? { notice } : {}) };
}

/** Calls a module UI action through the preload bridge; every failure becomes a notice. */
export async function invokeUiAction(action: string, input: unknown): Promise<EnterpriseUiReplyView> {
  const bridge = window.openAdminOS;
  if (!bridge?.invokeEnterprise) return { notice: failureNotice(new Error(ENTERPRISE_UI_COPY.unavailable)) };
  try {
    return readReply(await bridge.invokeEnterprise(action, input));
  } catch (error) {
    return { notice: failureNotice(error) };
  }
}

function initialValues(body: EnterpriseUiBodyView): Record<string, string> {
  const values: Record<string, string> = {};
  for (const element of body.elements) {
    if (element.type === "field") values[element.id] = element.value ?? "";
    if (element.type === "select") values[element.id] = element.value ?? element.options[0]?.value ?? "";
  }
  return values;
}

/** One module section body: its elements, the values of its fields and selects, and its buttons. */
export function EnterpriseUiBody({ sectionId, body }: { sectionId: string; body: EnterpriseUiBodyView }) {
  const [current, setCurrent] = useState(body);
  const [values, setValues] = useState(() => initialValues(body));
  const [notice, setNotice] = useState<EnterpriseUiNoticeView | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Button | undefined>();

  // A body the module pushed replaces the one drawn, with its values.
  const pushed = useMemo(() => JSON.stringify(body), [body]);
  useEffect(() => {
    setCurrent(body);
    setValues(initialValues(body));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushed]);

  const run = async (button: Button) => {
    setConfirming(undefined);
    setBusy(true);
    setNotice(undefined);
    const ids = new Set(current.elements.flatMap((element) => (element.type === "field" || element.type === "select" ? [element.id] : [])));
    const reply = await invokeUiAction(button.action, {
      kind: "button",
      sectionId,
      buttonId: button.id,
      values: Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id))),
    });
    if (reply.body) {
      setCurrent(reply.body);
      setValues(initialValues(reply.body));
    }
    setNotice(reply.notice);
    setBusy(false);
  };

  return (
    <div className="space-y-3" aria-busy={busy}>
      {notice ? <EnterpriseNotice notice={notice} /> : null}
      {current.elements.map((element, index) => (
        <EnterpriseUiElement
          key={`${element.type}-${"id" in element ? element.id : index}`}
          element={element}
          sectionId={sectionId}
          value={"id" in element ? values[element.id] ?? "" : ""}
          busy={busy}
          onValue={(id, value) => setValues((previous) => ({ ...previous, [id]: value }))}
          onButton={(button) => (button.confirm ? setConfirming(button) : void run(button))}
        />
      ))}
      {confirming?.confirm ? (
        <ConfirmDialog button={confirming} onCancel={() => setConfirming(undefined)} onConfirm={() => void run(confirming)} />
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
  busy: boolean;
  onValue: (id: string, value: string) => void;
  onButton: (button: Button) => void;
}) {
  const inputId = useId();
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
            disabled={busy}
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
            disabled={busy}
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
          <Button size="sm" variant={BUTTON_VARIANTS[element.kind] ?? "secondary"} disabled={busy} onClick={() => onButton(element)}>
            {element.label}
          </Button>
        </div>
      );
    case "list":
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

/** Confirms a button; with a typed phrase the button acts only once the phrase is typed exactly. */
function ConfirmDialog({ button, onCancel, onConfirm }: { button: Button; onCancel: () => void; onConfirm: () => void }) {
  const confirm = button.confirm!;
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ready = confirm.typedPhrase === undefined || typed === confirm.typedPhrase;
  return (
    <Modal open onClose={onCancel} size="md">
      <ModalHeader title={confirm.title} onClose={onCancel} />
      <div className="space-y-4 p-6">
        <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text-soft)]">{confirm.message}</p>
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
          <Button variant={BUTTON_VARIANTS[button.kind] ?? "secondary"} disabled={!ready} onClick={onConfirm}>
            {button.label}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
