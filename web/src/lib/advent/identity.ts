import { randomInt } from "node:crypto";

const RESERVED_HANDLES = new Set([
  "about", "administrator", "admin", "advent", "api", "help", "microsoft",
  "mod", "moderator", "official", "open-admin-os", "open-adminos", "openadmin",
  "openadminos", "privacy", "root", "rules", "security", "staff", "support",
  "system", "team", "ugurlabs",
]);

export function validHandle(handle: string) {
  return /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(handle) && !RESERVED_HANDLES.has(handle);
}

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function parseReferral(value: string) {
  const code = value.trim().toUpperCase();
  return code.length === 8 && [...code].every((character) => REF_ALPHABET.includes(character))
    ? code
    : "";
}

export function newReferralCode() {
  return Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join("");
}
