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
    // Tool-call shape must be identical across every track. r4 shipped two
    // shapes ({function,type} from the older tracks, {function,id,type} from
    // the newer ones); the model learned a hybrid and llama.cpp rejected it
    // with "Failed to parse tool call arguments as JSON" on 51 of 60
    // trajectory tasks. Normalise to the shape the 150-scoring run used.
    const msg = { ...m };
    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls = msg.tool_calls.map((tc) => ({
        type: "function",
        function: {
          name: tc.function?.name,
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        },
      }));
    }
    if (msg.tool_call_id) delete msg.tool_call_id;
    const thinking = msg.thinking;
    delete msg.thinking;
    // gpt-oss identity lines would teach the small model to claim it is a 20B.
    if (typeof msg.content === "string" && /gpt-oss|OpenAdmin, an open-source/.test(msg.content)) {
      msg.content = msg.content.replace(
        /You are OpenAdmin[^.]*\./,
        IDENTITY,
      ).replace(/OpenAI's open-weight gpt-oss-20b/g, "Mistral AI's open-weight Ministral 3 8B")
       .replace(/gpt-oss-20b/g, "Ministral 3 8B")
       // The 20B identity contrasts itself with ChatGPT/Copilot in most
       // examples; at that density the contrast bleeds into unrelated
       // refusals ("I am not ChatGPT" mid-wipe-refusal on the smoke test).
       // State what the model IS; drop the negative contrast.
       .replace(/\s*I am not ChatGPT and not Copilot[;,.]?/g, "")
       .replace(/OpenAI's/g, "Mistral AI's");
    }
    // Selective preambles (8b-r10), after measuring both extremes:
    //   - preambles everywhere (r8): model narrates process at the user;
    //     failed the human smoke test on tone
    //   - preambles nowhere (r9): abstention fell 15 -> 8 because the model
    //     stopped reading the system prompt's exact-reply instruction; the
    //     visible deliberation had been teaching instruction-following
    // Keep deliberation only where it decides behaviour: evidence checks,
    // abstention, and write-safety. Drop it where it became narration.
    const KEEP_THINKING = /does not (cover|mention)|can't find that|isn't in the excerpts|NOT IN DOCS|apply that change|blast radius|excerpt (covers|describes)|evidence/i;
    if (msg.role === "assistant" && thinking) {
      const deliberative = KEEP_THINKING.test(thinking) || KEEP_THINKING.test(msg.content || "");
      if (deliberative && thinking.length <= MAX_PREAMBLE && msg.content) {
        msg.content = `${thinking}

${msg.content}`;
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
