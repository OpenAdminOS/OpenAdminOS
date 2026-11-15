// Checks the declarative UI a module gives the host: a closed set of
// element types, bounded counts and lengths, plain text only. Every check
// returns a deep frozen copy, so the caller keeps no reference into the
// module's objects.

import { EnterpriseHostError } from "./errors.js";
import type {
  EnterpriseScheduleTarget,
  EnterpriseScheduleTargets,
  EnterpriseUiActionInput,
  EnterpriseUiBody,
  EnterpriseUiConfirm,
  EnterpriseUiElement,
  EnterpriseUiNotice,
  EnterpriseUiReply,
  EnterpriseUiTone,
} from "./interface.js";

export const ENTERPRISE_UI_LIMITS = Object.freeze({
  maxElements: 40,
  maxLabelLength: 80,
  maxValueLength: 120,
  maxTextLength: 1000,
  maxMessageLength: 500,
  maxOptions: 50,
  maxListRows: 50,
  maxFieldLength: 2000,
  defaultFieldLength: 200,
  maxValues: 40,
  maxScheduleTargets: 8,
  maxAgentIds: 100,
  maxPhraseLength: 80,
});

const L = ENTERPRISE_UI_LIMITS;
/** Element ids, the same rule as IPC names and section ids, one part. */
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const ACTION = /^[a-z][a-z0-9-]{0,47}(?:\.[a-z][a-z0-9-]{0,47}){0,3}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Typed phrases are upper case words and digits, such as RETIRE 47 DEVICES. */
const PHRASE = /^[A-Z0-9]+(?: [A-Z0-9]+)*$/;
const TONES: ReadonlySet<string> = new Set(["neutral", "success", "warning", "danger"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/** A tag or a comment: module text is plain text. */
const MARKUP = /<\s*[a-z!/?]/i;

function invalid(message: string): never {
  throw new EnterpriseHostError("invalid-value", message);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`The ${what} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid(`The ${what} must be a plain object.`);
  return value as Record<string, unknown>;
}

function only(fields: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) invalid(`The ${what} has a field ${JSON.stringify(key.slice(0, 40))} that is not part of it.`);
  }
}

/** Plain text of 1 to `max` characters; line breaks only where `multiline`. */
function text(value: unknown, max: number, what: string, multiline = false): string {
  if (typeof value !== "string") invalid(`The ${what} must be text.`);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) invalid(`The ${what} must be 1 to ${max} characters.`);
  if (CONTROL.test(trimmed) || (!multiline && /[\n\r]/.test(trimmed))) invalid(`The ${what} has a control character or a line break.`);
  if (MARKUP.test(trimmed)) invalid(`The ${what} looks like markup; module text is plain text.`);
  return trimmed;
}

function optionalText(value: unknown, max: number, what: string): string | undefined {
  return value === undefined ? undefined : text(value, max, what);
}

function tone(value: unknown, what: string): EnterpriseUiTone {
  if (typeof value !== "string" || !TONES.has(value)) invalid(`The ${what} tone must be neutral, success, warning or danger.`);
  return value as EnterpriseUiTone;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(`The ${what} id must be lower case letters, digits and hyphens, up to 48 characters.`);
  return value;
}

export function checkUiAction(value: unknown, what = "action"): string {
  if (typeof value !== "string" || !ACTION.test(value)) invalid(`The ${what} must be lower case letters, digits and hyphens, up to four dot separated parts.`);
  return value;
}

export function checkUiNotice(value: unknown): EnterpriseUiNotice {
  const fields = object(value, "notice");
  only(fields, ["type", "tone", "title", "message", "recovery"], "notice");
  if (fields.type !== "notice") invalid("A notice has the type notice.");
  const recovery = optionalText(fields.recovery, L.maxMessageLength, "notice recovery");
  return Object.freeze({
    type: "notice",
    tone: tone(fields.tone, "notice"),
    title: text(fields.title, L.maxLabelLength, "notice title"),
    message: text(fields.message, L.maxMessageLength, "notice message", true),
    ...(recovery ? { recovery } : {}),
  });
}

function checkElement(value: unknown, ids: Set<string>): EnterpriseUiElement {
  const fields = object(value, "element");
  const unique = (elementId: string) => {
    if (ids.has(elementId)) invalid(`The element id ${elementId} is used twice in one body.`);
    ids.add(elementId);
    return elementId;
  };
  switch (fields.type) {
    case "status":
      only(fields, ["type", "label", "value", "tone"], "status");
      return Object.freeze({
        type: "status",
        label: text(fields.label, L.maxLabelLength, "status label"),
        value: text(fields.value, L.maxValueLength, "status value"),
        tone: tone(fields.tone, "status"),
      });
    case "text":
      only(fields, ["type", "text"], "text");
      return Object.freeze({ type: "text", text: text(fields.text, L.maxTextLength, "text", true) });
    case "notice":
      return checkUiNotice(fields);
    case "field": {
      only(fields, ["type", "id", "label", "kind", "placeholder", "maxLength", "value"], "field");
      if (fields.kind !== "text" && fields.kind !== "code") invalid("A field kind is text or code.");
      const maxLength = fields.maxLength === undefined ? L.defaultFieldLength : fields.maxLength;
      if (typeof maxLength !== "number" || !Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > L.maxFieldLength) {
        invalid(`A field maxLength is a whole number from 1 to ${L.maxFieldLength}.`);
      }
      const placeholder = optionalText(fields.placeholder, L.maxValueLength, "field placeholder");
      let fieldValue: string | undefined;
      if (fields.value !== undefined) {
        if (typeof fields.value !== "string" || fields.value.length > maxLength || CONTROL.test(fields.value)) invalid("A field value is text within its maxLength.");
        fieldValue = fields.value;
      }
      return Object.freeze({
        type: "field",
        id: unique(id(fields.id, "field")),
        label: text(fields.label, L.maxLabelLength, "field label"),
        kind: fields.kind,
        maxLength,
        ...(placeholder ? { placeholder } : {}),
        ...(fieldValue !== undefined ? { value: fieldValue } : {}),
      });
    }
    case "select": {
      only(fields, ["type", "id", "label", "options", "value"], "select");
      if (!Array.isArray(fields.options) || fields.options.length < 1 || fields.options.length > L.maxOptions) invalid(`A select has 1 to ${L.maxOptions} options.`);
      const values = new Set<string>();
      const options = fields.options.map((option: unknown) => {
        const entry = object(option, "select option");
        only(entry, ["value", "label"], "select option");
        const optionValue = text(entry.value, L.maxValueLength, "select option value");
        if (values.has(optionValue)) invalid("A select lists each option value once.");
        values.add(optionValue);
        return Object.freeze({ value: optionValue, label: text(entry.label, L.maxLabelLength, "select option label") });
      });
      if (fields.value !== undefined && (typeof fields.value !== "string" || !values.has(fields.value))) invalid("A select value is one of its options.");
      return Object.freeze({
        type: "select",
        id: unique(id(fields.id, "select")),
        label: text(fields.label, L.maxLabelLength, "select label"),
        options: Object.freeze(options),
        ...(typeof fields.value === "string" ? { value: fields.value } : {}),
      });
    }
    case "button": {
      only(fields, ["type", "id", "label", "kind", "action", "confirm"], "button");
      if (fields.kind !== "primary" && fields.kind !== "secondary" && fields.kind !== "danger") invalid("A button kind is primary, secondary or danger.");
      let confirm: EnterpriseUiConfirm | undefined;
      if (fields.confirm !== undefined) {
        const entry = object(fields.confirm, "button confirm");
        only(entry, ["title", "message", "typedPhrase"], "button confirm");
        let typedPhrase: string | undefined;
        if (entry.typedPhrase !== undefined) {
          if (typeof entry.typedPhrase !== "string" || entry.typedPhrase.length > L.maxPhraseLength || !PHRASE.test(entry.typedPhrase)) {
            invalid(`A typed phrase is upper case words and digits, up to ${L.maxPhraseLength} characters.`);
          }
          typedPhrase = entry.typedPhrase;
        }
        confirm = Object.freeze({
          title: text(entry.title, L.maxLabelLength, "confirm title"),
          message: text(entry.message, L.maxMessageLength, "confirm message", true),
          ...(typedPhrase ? { typedPhrase } : {}),
        });
      }
      return Object.freeze({
        type: "button",
        id: unique(id(fields.id, "button")),
        label: text(fields.label, L.maxLabelLength, "button label"),
        kind: fields.kind,
        action: checkUiAction(fields.action, "button action"),
        ...(confirm ? { confirm } : {}),
      });
    }
    case "list": {
      only(fields, ["type", "rows"], "list");
      if (!Array.isArray(fields.rows) || fields.rows.length > L.maxListRows) invalid(`A list has at most ${L.maxListRows} rows.`);
      const rows = fields.rows.map((row: unknown) => {
        const entry = object(row, "list row");
        only(entry, ["label", "status"], "list row");
        let status: { value: string; tone: EnterpriseUiTone } | undefined;
        if (entry.status !== undefined) {
          const rowStatus = object(entry.status, "list row status");
          only(rowStatus, ["value", "tone"], "list row status");
          status = Object.freeze({ value: text(rowStatus.value, L.maxValueLength, "list row status"), tone: tone(rowStatus.tone, "list row status") });
        }
        return Object.freeze({ label: text(entry.label, L.maxValueLength, "list row label"), ...(status ? { status } : {}) });
      });
      return Object.freeze({ type: "list", rows: Object.freeze(rows) });
    }
    default:
      return invalid(`${JSON.stringify(String(fields.type).slice(0, 40))} is not an element type. Use status, text, notice, field, select, button or list.`);
  }
}

export function checkUiBody(value: unknown): EnterpriseUiBody {
  const fields = object(value, "body");
  only(fields, ["elements"], "body");
  if (!Array.isArray(fields.elements)) invalid("A body has a list of elements.");
  if (fields.elements.length > L.maxElements) {
    throw new EnterpriseHostError("limit", `A body has at most ${L.maxElements} elements.`);
  }
  const ids = new Set<string>();
  return Object.freeze({ elements: Object.freeze(fields.elements.map((element: unknown) => checkElement(element, ids))) });
}

export function checkUiReply(value: unknown): EnterpriseUiReply {
  const fields = object(value, "reply");
  only(fields, ["body", "notice"], "reply");
  if (fields.body === undefined && fields.notice === undefined) invalid("A reply has a body, a notice or both.");
  return Object.freeze({
    ...(fields.body !== undefined ? { body: checkUiBody(fields.body) } : {}),
    ...(fields.notice !== undefined ? { notice: checkUiNotice(fields.notice) } : {}),
  });
}

/** The input the window sends with a button or a schedule choice. */
export function checkUiActionInput(value: unknown): EnterpriseUiActionInput {
  const fields = object(value, "action input");
  if (fields.kind === "button") {
    only(fields, ["kind", "sectionId", "buttonId", "values"], "action input");
    const values = object(fields.values ?? {}, "values");
    const entries = Object.entries(values);
    if (entries.length > L.maxValues) invalid(`An action carries at most ${L.maxValues} values.`);
    const copy: Record<string, string> = {};
    for (const [key, entry] of entries) {
      if (!ID.test(key) || typeof entry !== "string" || entry.length > L.maxFieldLength) invalid("Each value is text of an element id within the field limit.");
      Object.defineProperty(copy, key, { value: entry, enumerable: true });
    }
    return Object.freeze({
      kind: "button",
      sectionId: checkUiAction(fields.sectionId, "section id"),
      buttonId: id(fields.buttonId, "button"),
      values: Object.freeze(copy),
    });
  }
  if (fields.kind === "schedule") {
    only(fields, ["kind", "agentId", "targetId", "intervalSeconds"], "action input");
    if (typeof fields.agentId !== "string" || !AGENT_ID.test(fields.agentId)) invalid("The agent id is not an agent id.");
    const interval = fields.intervalSeconds;
    if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 60) invalid("intervalSeconds is a whole number of at least 60.");
    return Object.freeze({ kind: "schedule", agentId: fields.agentId, targetId: id(fields.targetId, "schedule target"), intervalSeconds: interval });
  }
  return invalid("An action input is a button or a schedule choice.");
}

export function checkScheduleTargets(value: unknown): EnterpriseScheduleTargets {
  const fields = object(value, "schedule targets");
  only(fields, ["action", "targets"], "schedule targets");
  if (!Array.isArray(fields.targets) || fields.targets.length > L.maxScheduleTargets) invalid(`At most ${L.maxScheduleTargets} schedule targets.`);
  const ids = new Set<string>();
  const targets = fields.targets.map((target: unknown): EnterpriseScheduleTarget => {
    const entry = object(target, "schedule target");
    only(entry, ["id", "label", "detail", "disabledReason", "agentIds"], "schedule target");
    const targetId = id(entry.id, "schedule target");
    if (targetId === "this-computer" || ids.has(targetId)) invalid(`The schedule target id ${targetId} is taken.`);
    ids.add(targetId);
    let agentIds: readonly string[] | undefined;
    if (entry.agentIds !== undefined) {
      if (!Array.isArray(entry.agentIds) || entry.agentIds.length > L.maxAgentIds || !entry.agentIds.every((agent) => typeof agent === "string" && AGENT_ID.test(agent))) {
        invalid(`agentIds is a list of at most ${L.maxAgentIds} agent ids.`);
      }
      agentIds = Object.freeze([...(entry.agentIds as string[])]);
    }
    const detail = optionalText(entry.detail, L.maxMessageLength, "schedule target detail");
    const disabledReason = optionalText(entry.disabledReason, L.maxMessageLength, "schedule target disabled reason");
    return Object.freeze({
      id: targetId,
      label: text(entry.label, L.maxLabelLength, "schedule target label"),
      ...(detail ? { detail } : {}),
      ...(disabledReason ? { disabledReason } : {}),
      ...(agentIds ? { agentIds } : {}),
    });
  });
  return Object.freeze({ action: checkUiAction(fields.action, "schedule targets action"), targets: Object.freeze(targets) });
}
