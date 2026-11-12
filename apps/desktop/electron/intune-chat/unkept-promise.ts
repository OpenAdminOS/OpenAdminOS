/**
 * A final answer that only promises work ("I'll check that now.") ends
 * the turn with nothing done: no work continues after a final answer.
 * Chat, Agent Team and Nova ask the model once or twice to do the work or
 * say what blocks it, instead of showing the promise as the answer.
 */

/** Repair turns per answer. */
export const MAX_PROMISE_NUDGES = 2;

const PROMISE_VERBS =
  "(?:check|look|query|search|investigate|find|retrieve|pull|run|get|verify|fetch|review|dig|gather|analy[sz]e|examine|confirm|inspect|scan|research|figure|work)";

/** Work announced for later in this turn: "let me check", "I'll look into it", "I am querying". */
const PROMISE = new RegExp(
  [
    `\\b(?:let me|let's|allow me to)\\s+(?:now\\s+|quickly\\s+|first\\s+|just\\s+)?(?:go\\s+(?:and\\s+)?)?${PROMISE_VERBS}\\b`,
    `\\bi(?:'ll|’ll| will| am going to|'m going to|’m going to| shall)\\s+(?:now\\s+|quickly\\s+|first\\s+|just\\s+|go\\s+(?:and\\s+)?)*${PROMISE_VERBS}\\b`,
    `\\bi(?:'m|’m| am)\\s+(?:now\\s+|currently\\s+|just\\s+)?(?:checking|looking|querying|searching|investigating|finding|retrieving|pulling|running|getting|verifying|fetching|reviewing|digging|gathering|analy[sz]ing|examining|confirming|inspecting|scanning|researching|working)\\b`,
    "^(?:one|just a|wait a)\\s+(?:moment|second|sec|minute)\\b",
    "\\bgive me\\s+(?:a\\s+)?(?:moment|second|sec|minute|few)\\b",
    "\\b(?:hold on|stand by|bear with me|working on it|checking now|looking now)\\b",
  ].join("|"),
  "i",
);

/** A promise that depends on the admin, or an offer, is not unkept work. */
const CONDITIONAL =
  /\b(?:if (?:you|needed|that helps|it helps|useful|wanted|required)|should i|do you want|would you like|let me know|i can\b|i could\b|when you|whenever you|once you|if you ask|on request|just ask|tell me)\b/i;

function withoutQuotedText(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * True when the answer announces work it has not done and says nothing
 * else of substance. An answer that reports results and mentions a later
 * step, or offers to do more, is a finished answer.
 */
export function looksLikeUnkeptPromise(answer: string): boolean {
  const text = withoutQuotedText(answer).trim();
  if (!text) return false;
  let promised = false;
  const rest: string[] = [];
  for (const sentence of sentences(text)) {
    // A sentence that carries a number or runs long reports something.
    if (PROMISE.test(sentence) && !CONDITIONAL.test(sentence) && !/\d/.test(sentence) && sentence.length <= 200) promised = true;
    else rest.push(sentence);
  }
  if (!promised) return false;
  const remainder = rest.join(" ").trim();
  // Substance besides the promise: results, numbers or a list.
  if (remainder.length >= 160) return false;
  if (/\d/.test(remainder)) return false;
  if (/^\s*(?:[-*•]|\d+[.)])\s+/m.test(answer)) return false;
  return true;
}

/** The repair turn for a single-call model, such as an Agent Team answer. */
export const PROMISE_REPAIR_PROMPT =
  "Your previous reply was a progress message, not an answer. No work continues after you reply. Answer the question now from the evidence supplied above. If the evidence is not enough, say what is missing.";

/**
 * Completes once and, while the answer only promises work, asks again with
 * the repair turn, at most `MAX_PROMISE_NUDGES` times. The last answer is
 * kept: a model that keeps promising still gets its words shown.
 */
export async function completeWithPromiseNudge(
  complete: (prompt: string) => Promise<string>,
  prompt: string,
  maxNudges = MAX_PROMISE_NUDGES,
): Promise<string> {
  let answer = await complete(prompt);
  for (let nudge = 0; nudge < maxNudges && looksLikeUnkeptPromise(answer); nudge += 1) {
    answer = await complete(`${prompt}\n\nYour previous reply:\n${answer}\n\n${PROMISE_REPAIR_PROMPT}`);
  }
  return answer;
}
