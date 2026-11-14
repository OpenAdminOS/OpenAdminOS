import { readFileSync } from "node:fs";

import { ApplicationTokenError, createPemAssertionSigner, type AssertionSigner } from "@openadminos/runtime";

import type { SandboxCertificateConfig } from "./config.js";
import { assertPrivateFile, describe } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

/** A certificate this close to expiry is reported on every run. */
export const CERTIFICATE_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CertificateChoice {
  signer: AssertionSigner;
  /** Plain warnings, such as a certificate that expires soon. */
  warnings: string[];
}

/**
 * Reads the configured certificates again (files can change between runs)
 * and picks the valid one that expires last. With two certificates, one
 * can be replaced while the other keeps working.
 */
export function chooseCertificate(certificates: readonly SandboxCertificateConfig[], now: Date): CertificateChoice {
  const warnings: string[] = [];
  const valid: AssertionSigner[] = [];
  let firstProblem: SandboxRefusal | undefined;
  for (const certificate of certificates) {
    let signer: AssertionSigner;
    try {
      assertPrivateFile(certificate.privateKeyPath, "private key");
      signer = createPemAssertionSigner({
        certificatePem: readFileSync(certificate.certificatePath, "utf8"),
        privateKeyPem: readFileSync(certificate.privateKeyPath, "utf8"),
      });
    } catch (error) {
      const problem = error instanceof SandboxRefusal
        ? error
        : new SandboxRefusal(
          "certificate-unreadable",
          `The certificate ${certificate.certificatePath} with key ${certificate.privateKeyPath} cannot be used: ${error instanceof ApplicationTokenError ? error.message : describe(error)}`,
          { cause: error },
        );
      firstProblem ??= problem;
      if (certificates.length > 1) warnings.push(problem.message);
      continue;
    }
    const label = `The certificate ${certificate.certificatePath} (SHA-256 ${signer.thumbprintSha256.slice(0, 16)})`;
    if (signer.notBefore.getTime() > now.getTime()) {
      firstProblem ??= new SandboxRefusal("certificate-not-yet-valid", `${label} is not valid until ${signer.notBefore.toISOString()}. Check the clock of this machine, or use a certificate that is valid now.`);
      continue;
    }
    if (signer.notAfter.getTime() <= now.getTime()) {
      firstProblem ??= new SandboxRefusal("certificate-expired", `${label} expired on ${signer.notAfter.toISOString()}. Create a new certificate, upload it to the app registration and add it to the config.`);
      continue;
    }
    const daysLeft = Math.floor((signer.notAfter.getTime() - now.getTime()) / DAY_MS);
    if (daysLeft < CERTIFICATE_WARNING_DAYS) {
      warnings.push(`${label} expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}, on ${signer.notAfter.toISOString()}. Add its replacement as a second certificate now.`);
    }
    valid.push(signer);
  }
  const chosen = valid.sort((left, right) => right.notAfter.getTime() - left.notAfter.getTime())[0];
  if (!chosen) {
    throw firstProblem ?? new SandboxRefusal("certificate-unreadable", "No certificate is configured.");
  }
  return { signer: chosen, warnings };
}
