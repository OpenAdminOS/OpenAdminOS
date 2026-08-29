#!/usr/bin/env node
// Re-render the SFT tracks for a Mistral-format base (Ministral 3 8B).
//
// The facts, tool calls and answers carry over unchanged; only the wire format
// differs. Two deliberate transforms, per Codex's review:
//   - harmony analysis channels have no Mistral equivalent, and Ministral is
//     not a reasoning model, so long traces become a short plain-text preamble
//     (kept only where the arithmetic is load-bearing) or are dropped.
//   - identity examples are rewritten to name the small model honestly.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFT = join(HERE, "../data/sft");
const IDENTITY =
  "You are OpenAdmin Mini, an open-source model for Microsoft 365 administration, " +
  "fine-tuned from Ministral 3 8B by the OpenAdminOS community.";
const MAX_PREAMBLE = 240; // keep reasoning only when it is short and load-bearing

const src = process.argv[2] || "train-r7.jsonl";
const out = process.argv[3] || "train-mini-r1.jsonl";

let kept = 0, dropped = 0, preambles = 0;
const lines = [];
for (const line of readFileSync(join(SFT, src), "utf8").split("\n").filter(Boolean)) {
  const ex = JSON.parse(line);
  const msgs = [];
  for (const m of ex.messages) {
    const msg = { ...m };
    const thinking = msg.thinking;
    delete msg.thinking;
    // gpt-oss identity lines would teach the small model to claim it is a 20B.
    if (typeof msg.content === "string" && /gpt-oss|OpenAdmin, an open-source/.test(msg.content)) {
      msg.content = msg.content.replace(
        /You are OpenAdmin[^.]*\./,
        IDENTITY,
      ).replace(/gpt-oss-20b/g, "Ministral 3 8B");
    }
    if (msg.role === "assistant" && thinking) {
      // Short, mechanically-computed traces survive as a visible preamble;
      // long ones are dropped rather than teaching a non-reasoning model to
      // emit rambling monologue it cannot sustain.
      if (thinking.length <= MAX_PREAMBLE && msg.content) {
        msg.content = `${thinking}\n\n${msg.content}`;
        preambles++;
      }
    }
    msgs.push(msg);
  }
  if (!msgs.some((m) => m.role === "assistant")) { dropped++; continue; }
  lines.push(JSON.stringify({ ...ex, messages: msgs }));
  kept++;
}
writeFileSync(join(SFT, out), lines.join("\n") + "\n");
console.log(`${out}: ${kept} examples (${preambles} with reasoning preamble, ${dropped} dropped)`);
