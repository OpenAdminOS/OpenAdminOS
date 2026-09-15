import assert from "node:assert/strict";
import { it } from "node:test";
import { NovaTranscript, isNovaConversationOnly, novaCommentaryChunks } from "../src/shared/nova-transcript.js";

it("isolates the reported questions from greetings, waiting chatter and jokes", () => {
  const transcript = new NovaTranscript();
  let time = 0;
  const say = (role: "input" | "output", delta: string) => {
    transcript.append({ type: `session.${role}_transcript.delta`, delta, start_ms: time, end_ms: time + 900 });
    time += 1000;
  };
  say("input", "Hello girl"); say("output", "Hi! What would you like to know?");
  say("input", "Who are you and what can you do"); say("output", "I'm Nova, the voice of OpenAdminOS.");
  say("input", "How many devices do I have in my tenant");
  const firstOffset = time;
  say("output", "Let me check that.");
  say("input", "Still there"); say("output", "Yeah, I'm on it.");
  say("input", "Can you tell me a joke while we wait"); say("output", "A joke.");
  // Later speech can arrive before the delegation timer dispatches the first question.
  const first = transcript.capture(firstOffset)!;
  assert.equal(first.text, "How many devices do I have in my tenant");
  assert.ok(first.history.some(turn => turn.role === "assistant"));
  assert.equal(transcript.capture(firstOffset), undefined, "duplicate handoff must not rerun work");
  assert.equal(isNovaConversationOnly(transcript.capture(time)!.text), true);
  say("input", "All right, how many devices do I have");
  assert.equal(transcript.capture(time)!.text, "All right, how many devices do I have");
  assert.equal(isNovaConversationOnly("Tell me a joke and count my devices"), false);
});

it("orders delayed fragments by session time and preserves an overlapping acknowledgment", () => {
  const transcript = new NovaTranscript();
  transcript.append({ type: "session.input_transcript.delta", event_id: "second", delta: " devices?", start_ms: 2100, end_ms: 2500 });
  transcript.append({ type: "session.output_transcript.delta", delta: "Okay", start_ms: 1800, end_ms: 2200 });
  transcript.append({ type: "session.input_transcript.delta", event_id: "first", delta: "How many", start_ms: 1000, end_ms: 2000 });
  transcript.append({ type: "session.input_transcript.delta", event_id: "second", delta: " devices?", start_ms: 2100, end_ms: 2500 });
  assert.equal(transcript.capture(2600)!.text, "How many devices?");
  transcript.append({ type: "session.output_transcript.delta", delta: "There are nine.", start_ms: 2700, end_ms: 3500 });
  transcript.append({ type: "session.input_transcript.delta", delta: "Which of those are encrypted?", start_ms: 4000, end_ms: 5000 });
  const next = transcript.capture(5100)!;
  assert.equal(next.text, "Which of those are encrypted?");
  assert.ok(next.history.some(turn => turn.text.includes("How many devices")));
});

it("does not merge a new question into an earlier turn when Nova began responding early", () => {
  const transcript = new NovaTranscript();
  transcript.append({ type: "session.input_transcript.delta", delta: "Who are you?", start_ms: 1000, end_ms: 2000 });
  transcript.append({ type: "session.output_transcript.delta", delta: "I'm Nova.", start_ms: 1800, end_ms: 3000 });
  transcript.append({ type: "session.input_transcript.delta", delta: "How many devices?", start_ms: 3500, end_ms: 4500 });
  assert.equal(transcript.capture(4600)!.text, "How many devices?");
});

it("keeps short commentary intact and bounds Unicode appends without cutting characters", () => {
  const count = "The tenant has 9 Intune devices and 12 Entra device records.";
  assert.deepEqual(novaCommentaryChunks(count), [count]);
  const chunks = novaCommentaryChunks("漢字😀".repeat(300));
  assert.equal(chunks.join(""), "漢字😀".repeat(300));
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 400));
});

it("does not reattach a consumed question when no spoken answer separates requests", () => {
  const transcript = new NovaTranscript();
  transcript.append({ type: "session.input_transcript.delta", delta: "Research macOS" });
  assert.equal(transcript.capture()?.text, "Research macOS");
  transcript.append({ type: "session.input_transcript.delta", delta: "How many devices?" });
  assert.equal(transcript.capture()?.text, "How many devices?");
});

it("includes the boundary word observed in a real Live device-count delegation", () => {
  const transcript = new NovaTranscript();
  for (const [delta, start_ms] of [[" How many", 8000], [" devices", 8400], [" do", 8600], [" I", 8800], [" have in", 9000], [" my", 9200], [" tenant", 9600]] as const)
    transcript.append({ type: "session.input_transcript.delta", delta, start_ms, end_ms: start_ms + 200 });
  assert.equal(transcript.capture(9600)?.text, "How many devices do I have in my tenant");
});

it('consumes a spoken stop without losing the next question or matching quoted stop', () => {
  const transcript = new NovaTranscript();
  transcript.append({ type: 'session.input_transcript.delta', delta: 'Stop. Can you tell me why they are non-compliant?' });
  assert.equal(transcript.takeStopCommand(), true);
  assert.equal(transcript.capture()?.text, 'Can you tell me why they are non-compliant?');
  transcript.append({ type: 'session.input_transcript.delta', delta: "Do not stop" });
  assert.equal(transcript.takeStopCommand(), false);
});

it('binds a delayed handoff to its original utterance without consuming a newer question', () => {
  const t = new NovaTranscript();
  t.append({type:'session.input_transcript.delta',delta:'What can you do'});
  const anchor=t.capture(undefined,false)!.anchor;
  t.append({type:'session.input_transcript.delta',delta:' and what can you help me with'});
  t.append({type:'session.output_transcript.delta',delta:'I can help you explore your tenant.'});
  t.append({type:'session.input_transcript.delta',delta:'How many devices do I have?'});
  assert.equal(t.capture(undefined,true,anchor)!.text,'What can you do and what can you help me with');
  assert.equal(t.capture(undefined,true,anchor),undefined);
  assert.equal(t.capture()!.text,'How many devices do I have?');
});
