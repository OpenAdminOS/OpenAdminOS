import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWhatsAppQrStatus,
  readWhatsAppMessageId,
  resolveWhatsAppRecipient,
} from "./runtime.js";

describe("WhatsApp Web runtime helpers", () => {
  it("creates renderer QR status without exposing the raw QR string", () => {
    const issuedAt = new Date("2026-06-07T08:00:00.000Z");
    const status = createWhatsAppQrStatus({
      qrDataUrl: "data:image/png;base64,abc",
      issuedAt,
      refreshMs: 5_000,
    });

    assert.equal(status.state, "qr");
    assert.equal(status.qrDataUrl, "data:image/png;base64,abc");
    assert.equal(status.qrIssuedAt, "2026-06-07T08:00:00.000Z");
    assert.equal(status.qrRefreshesAt, "2026-06-07T08:00:05.000Z");
    assert.equal("qr" in status, false);
  });

  it("resolves self to the linked account JID without exposing the phone number", () => {
    const target = resolveWhatsAppRecipient("self", {
      user: { id: "491234567890:12@s.whatsapp.net" },
    });

    assert.equal(target.toJid, "491234567890@s.whatsapp.net");
    assert.equal(target.display, "My WhatsApp");
    assert.equal(target.targetType, "self");
  });

  it("keeps group JIDs as group targets", () => {
    const target = resolveWhatsAppRecipient("999999999999@g.us", {});

    assert.equal(target.toJid, "999999999999@g.us");
    assert.equal(target.display, "WhatsApp group");
    assert.equal(target.targetType, "group");
  });

  it("normalizes pasted phone numbers into WhatsApp user JIDs", () => {
    const target = resolveWhatsAppRecipient("+1 (555) 123-4567", {});

    assert.equal(target.toJid, "15551234567@s.whatsapp.net");
    assert.equal(target.display, "WhatsApp recipient");
    assert.equal(target.targetType, "manual");
  });

  it("requires a country-code-like recipient", () => {
    assert.throws(
      () => resolveWhatsAppRecipient("123", {}),
      /must include a country code/,
    );
  });

  it("requires WhatsApp to return a remote message id", () => {
    assert.equal(readWhatsAppMessageId({ key: { id: "ABC123" } }), "ABC123");
    assert.throws(
      () => readWhatsAppMessageId({ key: {} }),
      /without a message id/,
    );
  });
});
