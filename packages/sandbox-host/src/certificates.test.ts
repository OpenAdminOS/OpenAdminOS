import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { describe, it } from "node:test";

import { chooseCertificate } from "./certificates.js";
import { SandboxRefusal } from "./refusal.js";
import { tempDir, writeCertificate } from "./test-support.js";

const DAY = 86_400_000;

describe("chooseCertificate", () => {
  it("refuses an expired and a not yet valid certificate", () => {
    const { dir, cleanup } = tempDir();
    try {
      const now = Date.now();
      const expired = writeCertificate(dir, "expired", new Date(now - 30 * DAY), new Date(now - DAY));
      const future = writeCertificate(dir, "future", new Date(now + DAY), new Date(now + 30 * DAY));
      assert.throws(() => chooseCertificate([expired], new Date(now)), (error: unknown) => error instanceof SandboxRefusal && error.reason === "certificate-expired");
      assert.throws(() => chooseCertificate([future], new Date(now)), (error: unknown) => error instanceof SandboxRefusal && error.reason === "certificate-not-yet-valid");
    } finally {
      cleanup();
    }
  });

  it("warns under 30 days and picks the certificate that expires last", () => {
    const { dir, cleanup } = tempDir();
    try {
      const now = Date.now();
      const soon = writeCertificate(dir, "soon", new Date(now - DAY), new Date(now + 10 * DAY));
      const next = writeCertificate(dir, "next", new Date(now - DAY), new Date(now + 400 * DAY));
      const single = chooseCertificate([soon], new Date(now));
      assert.equal(single.warnings.length, 1);
      assert.match(single.warnings[0] ?? "", /expires in (9|10) days/);
      const both = chooseCertificate([soon, next], new Date(now));
      assert.ok(both.signer.notAfter.getTime() > now + 300 * DAY);
    } finally {
      cleanup();
    }
  });

  it("refuses a private key other users can read", () => {
    const { dir, cleanup } = tempDir();
    try {
      const now = Date.now();
      const certificate = writeCertificate(dir, "open", new Date(now - DAY), new Date(now + 100 * DAY));
      chmodSync(certificate.privateKeyPath, 0o640);
      assert.throws(() => chooseCertificate([certificate], new Date(now)), (error: unknown) => error instanceof SandboxRefusal && error.reason === "file-permissions");
    } finally {
      cleanup();
    }
  });
});
