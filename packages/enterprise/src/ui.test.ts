import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { EnterpriseHostError } from "./errors.js";
import { checkScheduleTargets, checkUiActionInput, checkUiBody, checkUiReply, ENTERPRISE_UI_LIMITS } from "./ui.js";

function refused(action: () => unknown, code: "invalid-value" | "limit" = "invalid-value"): void {
  assert.throws(action, (error: unknown) => error instanceof EnterpriseHostError && error.code === code);
}

const body = (...elements: unknown[]) => ({ elements });

describe("declarative module UI", () => {
  it("takes each element type and returns a frozen copy", () => {
    const source = body(
      { type: "status", label: "Sandbox", value: "Paired", tone: "success" },
      { type: "text", text: "Schedules keep running while this computer is off.\nThey are read-only." },
      { type: "notice", tone: "warning", title: "Sync stopped", message: "A row is missing.", recovery: "Pair again." },
      { type: "field", id: "address", label: "Address", kind: "code", placeholder: "100.64.0.10:7443", maxLength: 64, value: "" },
      { type: "select", id: "organization", label: "Organization", options: [{ value: "org-1", label: "Contoso" }], value: "org-1" },
      { type: "button", id: "pair", label: "Pair", kind: "danger", action: "sandboxes.pair", confirm: { title: "Pair", message: "Pair this sandbox?", typedPhrase: "PAIR 1 SANDBOX" } },
      { type: "list", rows: [{ label: "find-inactive-devices", status: { value: "Assigned", tone: "neutral" } }, { label: "compliance-overview" }] },
    );
    const checked = checkUiBody(source);
    assert.equal(checked.elements.length, 7);
    assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.elements) && checked.elements.every((element) => Object.isFrozen(element)));
    assert.notEqual(checked.elements[0], source.elements[0]);
    const field = checked.elements[3] as { maxLength: number };
    assert.equal(field.maxLength, 64);
    // A field without maxLength gets the default.
    assert.equal((checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text" })).elements[0] as { maxLength: number }).maxLength, ENTERPRISE_UI_LIMITS.defaultFieldLength);
  });

  it("refuses an unknown element type, unknown fields and anything outside the bounds", () => {
    refused(() => checkUiBody(body({ type: "iframe", src: "x" })));
    refused(() => checkUiBody(body({ type: "html", html: "<b>x</b>" })));
    refused(() => checkUiBody(body({ type: "text", text: "x", onClick: "x" })));
    refused(() => checkUiBody(body({ type: "text", text: "<script>alert(1)</script>" })));
    refused(() => checkUiBody(body({ type: "text", text: "x".repeat(ENTERPRISE_UI_LIMITS.maxTextLength + 1) })));
    refused(() => checkUiBody(body({ type: "text", text: "  " })));
    refused(() => checkUiBody(body({ type: "status", label: "A\nB", value: "x", tone: "success" })));
    refused(() => checkUiBody(body({ type: "status", label: "A", value: "x", tone: "info" })));
    refused(() => checkUiBody(body({ type: "notice", tone: "danger", title: "T" })));
    refused(() => checkUiBody(body({ type: "field", id: "Bad Id", label: "A", kind: "text" })));
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "secret" })));
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", maxLength: ENTERPRISE_UI_LIMITS.maxFieldLength + 1 })));
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", maxLength: 3, value: "four" })));
    refused(() => checkUiBody(body({ type: "select", id: "s", label: "S", options: [] })));
    refused(() => checkUiBody(body({ type: "select", id: "s", label: "S", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })));
    refused(() => checkUiBody(body({ type: "select", id: "s", label: "S", options: [{ value: "a", label: "A" }], value: "b" })));
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "B", kind: "link", action: "x" })));
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "B", kind: "primary", action: "Not An Action" })));
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "B", kind: "danger", action: "x", confirm: { title: "T", message: "M", typedPhrase: "lower case" } })));
    refused(() => checkUiBody(body({ type: "list", rows: Array.from({ length: ENTERPRISE_UI_LIMITS.maxListRows + 1 }, () => ({ label: "x" })) })));
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text" }, { type: "select", id: "a", label: "B", options: [{ value: "x", label: "X" }] })));
    refused(() => checkUiBody(body(...Array.from({ length: ENTERPRISE_UI_LIMITS.maxElements + 1 }, () => ({ type: "text", text: "x" })))), "limit");
    refused(() => checkUiBody({ elements: "x" }));
    refused(() => checkUiBody(Object.create({ elements: [] })));
  });

  it("checks replies, action input and schedule targets", () => {
    const reply = checkUiReply({ notice: { type: "notice", tone: "success", title: "Paired", message: "The sandbox is paired." } });
    assert.equal(reply.notice?.title, "Paired");
    refused(() => checkUiReply({}));
    refused(() => checkUiReply({ notice: { type: "notice", tone: "success", title: "x", message: "y" }, script: "x" }));

    assert.deepEqual(checkUiActionInput({ kind: "button", sectionId: "sandboxes", buttonId: "pair", values: { address: "10.0.0.1:7443" } }), {
      kind: "button",
      sectionId: "sandboxes",
      buttonId: "pair",
      values: { address: "10.0.0.1:7443" },
    });
    refused(() => checkUiActionInput({ kind: "button", sectionId: "s", buttonId: "b", values: { address: 7 } }));
    refused(() => checkUiActionInput({ kind: "button", sectionId: "s", buttonId: "b", values: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`v${i}`, "x"])) }));
    assert.equal(checkUiActionInput({ kind: "schedule", agentId: "find-inactive-devices", targetId: "mini-pc", intervalSeconds: 3600 }).kind, "schedule");
    refused(() => checkUiActionInput({ kind: "schedule", agentId: "find-inactive-devices", targetId: "mini-pc", intervalSeconds: 1.5 }));
    refused(() => checkUiActionInput({ kind: "eval" }));

    const targets = checkScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", detail: "Local model", agentIds: ["find-inactive-devices"] }, { id: "lab", label: "Lab", disabledReason: "Sync is stopped." }] });
    assert.equal(targets.targets.length, 2);
    refused(() => checkScheduleTargets({ action: "x", targets: [{ id: "this-computer", label: "This computer" }] }));
    refused(() => checkScheduleTargets({ action: "x", targets: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }));
    refused(() => checkScheduleTargets({ action: "x", targets: Array.from({ length: ENTERPRISE_UI_LIMITS.maxScheduleTargets + 1 }, (_, i) => ({ id: `t${i}`, label: "T" })) }));
  });
});
