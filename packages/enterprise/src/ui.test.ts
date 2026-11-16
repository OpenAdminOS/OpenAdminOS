import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { EnterpriseHostError } from "./errors.js";
import { checkModuleText, checkScheduleTargets, checkUiActionAgainst, checkUiActionInput, checkUiBody, checkUiReply, currentTargetFor, ENTERPRISE_UI_LIMITS, normalizeForPhraseMatch } from "./ui.js";

function refused(action: () => unknown, code: "invalid-value" | "limit" = "invalid-value"): void {
  assert.throws(action, (error: unknown) => error instanceof EnterpriseHostError && error.code === code);
}

const body = (...elements: unknown[]) => ({ elements });

describe("declarative module UI", () => {
  it("takes each element type and returns a frozen copy", () => {
    const source = body(
      { type: "status", label: "Sandbox", value: "Paired", tone: "success" },
      { type: "text", text: "Schedules keep running while the laptop is off.\nThey are read-only." },
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
    refused(() => checkUiBody(body({ type: "notice", tone: "danger", title: "T", message: "M" })), "invalid-value");
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

  it("refuses the app's trust phrases, This computer and invisible formatting characters", () => {
    for (const text of ["Runs on This Computer", "Local-only, nothing to worry about", "No data leaves your network", "Tenant data stays on this device.", "Verified against the team chain"]) {
      refused(() => checkUiBody(body({ type: "text", text })));
    }
    for (const character of ["\u202e", "\u2066", "\u200b", "\ufeff"]) {
      refused(() => checkUiBody(body({ type: "status", label: `Sandbox${character}`, value: "Paired", tone: "success" })));
      refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", value: `x${character}` })));
    }
    refused(() => checkScheduleTargets({ action: "x", targets: [{ id: "laptop", label: "This computer" }] }));
  });

  it("asks before a danger button and names a registered action", () => {
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "Unpair", kind: "danger", action: "sandboxes.unpair" })));
    const actions = new Set(["sandboxes.pair"]);
    assert.equal(checkUiBody(body({ type: "button", id: "b", label: "Pair", kind: "primary", action: "sandboxes.pair" }), actions).elements.length, 1);
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "Sync", kind: "primary", action: "sandboxes.sync" }), actions));
    refused(() => checkScheduleTargets({ action: "sandboxes.schedule", targets: [] }, actions));
  });

  it("reports the current target per agent and refuses one that is not offered", () => {
    const targets = checkScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC" }], current: { "find-inactive-devices": "mini-pc", "os-update-posture": "this-computer" } });
    assert.equal(currentTargetFor(targets, "find-inactive-devices"), "mini-pc");
    assert.equal(currentTargetFor(targets, "os-update-posture"), "this-computer");
    assert.equal(currentTargetFor(targets, "compliance-overview"), "this-computer");
    assert.equal(currentTargetFor(undefined, "compliance-overview"), "this-computer");
    refused(() => checkScheduleTargets({ action: "x", targets: [], current: { "find-inactive-devices": "lab" } }));
  });

  it("checks an action input against the UI the window was given", () => {
    const section = checkUiBody(body(
      { type: "field", id: "address", label: "Address", kind: "code", maxLength: 10 },
      { type: "select", id: "organization", label: "Organization", options: [{ value: "org-1", label: "Contoso" }] },
      { type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" },
      { type: "button", id: "unpair", label: "Unpair", kind: "danger", action: "sandboxes.unpair", confirm: { title: "Unpair", message: "Unpair it?", typedPhrase: "UNPAIR" } },
    ));
    const targets = checkScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", agentIds: ["find-inactive-devices"] }, { id: "lab", label: "Lab", disabledReason: "Sync is stopped." }] });
    const ui = { body: (id: string) => (id === "sandboxes" ? section : undefined), scheduleTargets: targets };
    const button = (buttonId: string, values: Record<string, string>, confirmedPhrase?: string) =>
      checkUiActionInput({ kind: "button", sectionId: "sandboxes", buttonId, values, ...(confirmedPhrase ? { confirmedPhrase } : {}) });
    checkUiActionAgainst(button("pair", { address: "10.0.0.1:1", organization: "org-1" }), "sandboxes.pair", ui);
    refused(() => checkUiActionAgainst(button("pair", {}), "sandboxes.unpair", ui));
    refused(() => checkUiActionAgainst(button("gone", {}), "sandboxes.pair", ui));
    refused(() => checkUiActionAgainst(checkUiActionInput({ kind: "button", sectionId: "other", buttonId: "pair", values: {} }), "sandboxes.pair", ui));
    refused(() => checkUiActionAgainst(button("pair", { address: "10.0.0.1:7443" }), "sandboxes.pair", ui));
    refused(() => checkUiActionAgainst(button("pair", { organization: "org-9" }), "sandboxes.pair", ui));
    refused(() => checkUiActionAgainst(button("pair", { secret: "x" }), "sandboxes.pair", ui));
    refused(() => checkUiActionAgainst(button("unpair", {}), "sandboxes.unpair", ui));
    refused(() => checkUiActionAgainst(button("unpair", {}, "unpair"), "sandboxes.unpair", ui));
    checkUiActionAgainst(button("unpair", {}, "UNPAIR"), "sandboxes.unpair", ui);

    const schedule = (agentId: string, targetId: string) => checkUiActionInput({ kind: "schedule", agentId, targetId, intervalSeconds: 3600 });
    checkUiActionAgainst(schedule("find-inactive-devices", "mini-pc"), "sandboxes.schedule", ui);
    checkUiActionAgainst(schedule("find-inactive-devices", "this-computer"), "sandboxes.schedule", ui);
    refused(() => checkUiActionAgainst(schedule("os-update-posture", "mini-pc"), "sandboxes.schedule", ui));
    refused(() => checkUiActionAgainst(schedule("os-update-posture", "lab"), "sandboxes.schedule", ui));
    refused(() => checkUiActionAgainst(schedule("find-inactive-devices", "mini-pc"), "sandboxes.other", ui));
    refused(() => checkUiActionInput({ kind: "schedule", agentId: "a", targetId: "mini-pc", intervalSeconds: 32 * 86_400 }));
  });

  it("matches reserved phrases after normalizing, and refuses invisible characters outright", () => {
    for (const text of [
      "Runs on This\u00a0computer",
      "Runs on This  computer",
      "Runs on This\ncomputer",
      "Runs on THIS COMPUTER",
      "Ｌｏｃａｌ－ｏｎｌｙ",
    ]) {
      refused(() => checkUiBody(body({ type: "text", text })));
    }
    // Soft hyphen and word joiner are refused as characters, wherever they are.
    refused(() => checkUiBody(body({ type: "text", text: "This com\u00adputer" })));
    refused(() => checkUiBody(body({ type: "text", text: "Sandbox\u2060" })));
    assert.equal(normalizeForPhraseMatch("This\u00a0 \n computer"), "this computer");
    // A look-alike from another script is not caught here; the app marks module places as the module's.
    assert.equal(checkUiBody(body({ type: "text", text: "This c\u043emputer" })).elements.length, 1);
    refused(() => checkUiBody(body({ type: "button", id: "b", label: "Move", kind: "danger", action: "x", confirm: { title: "Move", message: "Move it?", typedPhrase: "THIS COMPUTER" } })));
    refused(() => checkModuleText("Nothing leaves this device", "label"));
  });

  it("refuses a current place that is not offered for that agent", () => {
    refused(() => checkScheduleTargets({ action: "x", targets: [{ id: "mini-pc", label: "Office mini PC", agentIds: ["os-update-posture"] }], current: { "find-inactive-devices": "mini-pc" } }));
    const targets = checkScheduleTargets({ action: "x", targets: [{ id: "mini-pc", label: "Office mini PC", agentIds: ["os-update-posture"] }], current: { "os-update-posture": "mini-pc" } });
    assert.equal(currentTargetFor(targets, "os-update-posture"), "mini-pc");
  });

  it("counts punctuation and symbol separators as spaces before matching", () => {
    for (const text of ["Runs on This-computer", "Runs on This.computer", "Local\u2011only", "No-data leaves the office", "Runs on this_computer", "this/computer"]) {
      refused(() => checkUiBody(body({ type: "text", text })));
    }
    // A word that merely contains a phrase's letters is not refused.
    assert.equal(checkUiBody(body({ type: "text", text: "Thisco mputer lab" })).elements.length, 1);
  });

  it("names an invisible character in a pasted value", () => {
    const section = checkUiBody(body(
      { type: "field", id: "address", label: "Address", kind: "code", maxLength: 64 },
      { type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" },
    ));
    const ui = { body: () => section, scheduleTargets: undefined };
    assert.throws(
      () => checkUiActionAgainst(checkUiActionInput({ kind: "button", sectionId: "sandboxes", buttonId: "pair", values: { address: "100.64.0.10\u200b:7443" } }), "sandboxes.pair", ui),
      (error: unknown) => error instanceof EnterpriseHostError && /U\+200B/.test(error.message),
    );
  });

  it("checks a prefilled field value as module text, and the added trust phrases", () => {
    assert.equal(checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", value: "" })).elements.length, 1);
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", value: "<b>x</b>" })));
    refused(() => checkUiBody(body({ type: "field", id: "a", label: "A", kind: "text", value: "Nothing leaves this device" })));
    for (const text of ["Kept on your device", "Data never leaves the office", "It stays on your device", "Nothing leaves this device unencrypted"]) {
      refused(() => checkUiBody(body({ type: "text", text })));
    }
  });
});
