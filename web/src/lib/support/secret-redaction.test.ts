import assert from "node:assert/strict";
import test from "node:test";

import { redactSupportPublicText } from "./secret-redaction";

const openAiKey = `sk-proj-${"a".repeat(48)}`;
const githubToken = `github_pat_${"A".repeat(28)}_${"b".repeat(28)}`;
const googleKey = `AIza${"c".repeat(35)}`;
const jwt = `eyJ${"d".repeat(12)}.${"e".repeat(12)}.${"f".repeat(12)}`;
const base64Blob = "A".repeat(52);

test("redacts known support issue secret shapes", () => {
  const text = [
    `OpenAI ${openAiKey}`,
    `GitHub ${githubToken}`,
    "AWS AKIAIOSFODNN7EXAMPLE",
    `Google ${googleKey}`,
    `Authorization: Bearer ${jwt}`,
    `payload ${base64Blob}`,
    'client_secret="tenant-client-secret-value"',
    "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
  ].join("\n");

  const redacted = redactSupportPublicText(text);

  assert(!redacted.includes(openAiKey));
  assert(!redacted.includes(githubToken));
  assert(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert(!redacted.includes(googleKey));
  assert(!redacted.includes(jwt));
  assert(!redacted.includes(base64Blob));
  assert(!redacted.includes("tenant-client-secret-value"));
  assert(!redacted.includes("abc123"));
  assert(redacted.includes("[redacted-secret]"));
  assert(redacted.includes("[redacted-private-key]"));
});

test("redacts public identity and local path markers", () => {
  const redacted = redactSupportPublicText(
    "admin@contoso.com 4b9f7a0c-6a44-4f4d-a308-4bb67c93c222 contoso.onmicrosoft.com https://contoso.example/path /Users/ugur/.codex/auth.json C:\\Users\\ugur\\secret.txt",
  );

  assert.equal(
    redacted,
    "[email] [guid] [tenant-domain] [url] [local-path] [local-path]",
  );
});

test("keeps short diagnostic hashes while redacting serialized JSON safely", () => {
  const serialized = JSON.stringify({
    detailHash: "dcc246092640dfd5",
    userText: `client_secret=${openAiKey}`,
  });
  const redacted = redactSupportPublicText(serialized);

  assert.doesNotThrow(() => JSON.parse(redacted));
  assert(redacted.includes("dcc246092640dfd5"));
  assert(!redacted.includes(openAiKey));
  assert(redacted.includes("[redacted-secret]"));
});
