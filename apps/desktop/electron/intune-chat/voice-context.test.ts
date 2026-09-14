import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  GraphCacheResourceStatus,
  IntuneChatMessage,
} from "@openadminos/agent-sdk";
import {
  voiceInventoryAnswer,
  voiceDeviceSummaryAnswer,
  voiceConversationContext,
  compactVoiceAnswerPack,
  assertVoicePromptBudget,
} from "./voice-context.js";
const status = (
  overrides: Partial<GraphCacheResourceStatus> = {},
): GraphCacheResourceStatus => ({
  resource: "managedDevices",
  label: "Intune",
  rows: 9,
  pages: 1,
  refreshedAt: "2026-09-12T09:00:00Z",
  scopeSet: [],
  ...overrides,
});
it("answers unfiltered inventory questions from exact resource totals without conflating Entra and Intune", () => {
  const answer = voiceInventoryAnswer("Do you see any of my devices?", [
    status(),
    status({ resource: "entraDevices", rows: 82 }),
  ]);
  assert.match(answer!, /9 Intune managed devices/);
  assert.match(answer!, /82 Entra device records/);
  assert.doesNotMatch(answer!, /91|missing|incomplete/);
  assert.match(
    voiceInventoryAnswer("How many Intune devices do I have?", [
      status({ rows: 0 }),
    ])!,
    /0 Intune/,
  );
  assert.equal(
    voiceInventoryAnswer("How many encrypted devices do I have?", [status()]),
    undefined,
  );
  assert.equal(
    voiceInventoryAnswer("How many devices are noncompliant?", [status()]),
    undefined,
  );
});
it("distinguishes partial, failed and missing snapshots from an empty tenant", () => {
  assert.match(
    voiceInventoryAnswer("How many managed devices?", [
      status({ pageLimitReached: true, tenantTotal: 90 }),
    ])!,
    /Graph reported 90.*partial/,
  );
  assert.match(
    voiceInventoryAnswer("How many managed devices?", [
      status({ pageLimitReached: true }),
    ])!,
    /at least 9/,
  );
  assert.match(
    voiceInventoryAnswer("How many managed devices?", [
      status({ lastError: "Forbidden" }),
    ])!,
    /latest refresh failed/,
  );
  assert.match(
    voiceInventoryAnswer("How many managed devices?", [])!,
    /does not mean there are none/,
  );
});
it("carries bounded completed history into follow-ups while keeping new questions independent", () => {
  const messages = [
    { role: "user", status: "completed", content: "Which users are guests?" },
    {
      role: "assistant",
      status: "completed",
      content: "Guest user evidence. ".repeat(1000),
    },
    { role: "assistant", status: "cancelled", content: "Discarded result" },
  ] as IntuneChatMessage[];
  const followup = voiceConversationContext(
    "Which of those are disabled?",
    messages,
  );
  assert.match(followup.history, /Which users are guests/);
  assert.doesNotMatch(followup.history, /Discarded/);
  assert.ok(Buffer.byteLength(followup.history) < 1200);
  assert.match(followup.planningQuestion, /users.*\nFollow-up:/);
  assert.equal(
    voiceConversationContext("List devices", messages).planningQuestion,
    "List devices",
  );
});
it("caps large Unicode evidence without losing totals or claiming omitted buckets are absent", () => {
  const pack = JSON.stringify({
    question: "OS versions?",
    resources: [
      {
        cachedRows: 5000,
        tenantTotal: 5000,
        sampleRows: Array(20).fill({ name: "😀".repeat(1000) }),
        breakdowns: {
          osVersion: Object.fromEntries(
            Array.from({ length: 1000 }, (_, i) => [String(i), 5]),
          ),
        },
      },
    ],
  });
  const compact = compactVoiceAnswerPack(pack, 3000);
  const parsed = JSON.parse(compact);
  assert.ok(Buffer.byteLength(compact) <= 3000);
  assert.equal(parsed.resources[0].tenantTotal, 5000);
  assert.equal(parsed.resources[0].omittedBreakdownBuckets, 980);
  assert.equal(parsed.omittedFindings, true);
  assert.throws(
    () => assertVoicePromptBudget("system", "😀".repeat(4000)),
    /narrower question/,
  );
  assert.throws(
    () =>
      compactVoiceAnswerPack(
        JSON.stringify({ question: "x".repeat(20000) }),
        1000,
      ),
    /fewer resources/,
  );
});

it("summarizes encryption and OS versions without treating unknown values as false", () => {
  const aggregate = () => ({
    total: 100,
    breakdowns: {
      isEncrypted: { "1": 80, "0": 5, unknown: 15 },
      osVersion: { "10.0": 75, "15.0": 25 },
    },
  });
  const encrypted = voiceDeviceSummaryAnswer(
    "Are my devices encrypted?",
    [status({ rows: 100 })],
    aggregate,
  );
  assert.match(
    encrypted!,
    /80 report encryption enabled, 5 report not encrypted, and 15 have no reported/,
  );
  const versions = voiceDeviceSummaryAnswer(
    "What OS versions do I have?",
    [status({ rows: 100 })],
    aggregate,
  );
  assert.match(versions!, /10.0: 75; 15.0: 25/);
  assert.equal(
    voiceDeviceSummaryAnswer(
      "How many Windows devices are encrypted?",
      [status()],
      aggregate,
    ),
    undefined,
  );
  assert.match(
    voiceDeviceSummaryAnswer(
      "Are my devices encrypted?",
      [status({ pageLimitReached: true })],
      aggregate,
    )!,
    /^Detail coverage is partial/,
  );
});

it('retains the device question for why they follow-ups', () => {
  const result = voiceConversationContext('Can you tell me why they are non-compliant?', [], false, [
    { role: 'user', text: 'Which devices are non-compliant?' }, { role: 'assistant', text: 'Device A and Device B.' },
  ]);
  assert.match(result.history, /Device A and Device B/);
  assert.match(result.planningQuestion, /Which devices are non-compliant/);
});

it('answers app counts directly without conflating catalog entries and discovered software', () => {
  const data = [status({resource:'mobileApps',rows:4}), status({resource:'detectedApps',rows:35})];
  const answer = voiceInventoryAnswer('How many apps do I have?', data)!;
  assert.match(answer, /4 Intune app catalog entries/);
  assert.match(answer, /35 detected app inventory entries/);
  assert.doesNotMatch(answer, /39 /);
  assert.doesNotMatch(voiceInventoryAnswer('How many Intune apps do I have?', data)!, /detected/);
  assert.equal(voiceInventoryAnswer('How many apps do I have on Windows?',data), undefined);
  assert.match(voiceInventoryAnswer('How many apps do I have?',[])!, /could not retrieve/);
});
