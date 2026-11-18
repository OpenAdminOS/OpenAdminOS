/**
 * A final answer that only promises work ("I'll check that now.") ends
 * the turn with nothing done: no work continues after a final answer.
 * Chat, Agent Team and Nova ask the model once or twice to do the work or
 * say what blocks it, instead of showing the promise as the answer.
 */

/** Repair turns per answer. */
export const MAX_PROMISE_NUDGES = 2;

const PROMISE_VERBS =
  "(?:check|look|see|take\\s+a\\s+(?:quick\\s+)?look|query|search|investigate|find|retrieve|pull|run|get|verify|fetch|review|dig|gather|analy[sz]e|examine|confirm|inspect|scan|research|figure|work)";

/**
 * Work announced for later, in forward-looking words only: "let me check",
 * "I'll look into it", "I'm going to verify", "one moment". A present
 * progressive ("I am getting a 403 response") is not one: it often reports
 * what was found.
 */
const PROMISE = new RegExp(
  [
    `\\b(?:let me|allow me to)\\s+(?:now\\s+|quickly\\s+|first\\s+|just\\s+)?(?:go\\s+(?:and\\s+)?)?${PROMISE_VERBS}\\b`,
    `\\bi(?:'ll|’ll| will| am going to|'m going to|’m going to| shall)\\s+(?:now\\s+|quickly\\s+|first\\s+|just\\s+|go\\s+(?:and\\s+)?)*${PROMISE_VERBS}\\b`,
    "^(?:one|just a|wait a)\\s+(?:moment|second|sec|minute)\\b",
    "\\bgive me\\s+(?:a\\s+)?(?:moment|second|sec|minute|few)\\b",
    "\\b(?:hold on|stand by|bear with me|working on it|checking now|looking now)\\b",
  ].join("|"),
  "i",
);

/** "Checking now", "Checking the devices now", "I'm checking that now": the whole clause announces the check. */
const CHECKING_NOW = /^(?:i(?:'m|’m| am)\s+)?(?:just\s+|still\s+)?(?:checking|looking)\b[^.!?]*?\bnow$/i;

/**
 * Work under way said with nothing after it: "I'm checking", "I'm on it",
 * "working on it", "I'm looking into that now". Next to a promise ("One
 * moment, I'm checking.") the answer is still a progress message. A
 * progressive with an object or a result ("I'm getting a 403 response",
 * "I'm pulling the device list") reports something and is substance.
 */
const BARE_PROGRESS = /^(?:i(?:'m|’m| am)\s+)?(?:now\s+|currently\s+|just\s+|still\s+)?(?:on it|(?:checking|looking|querying|searching|investigating|retrieving|verifying|fetching|reviewing|digging|researching|working)(?:\s+(?:on|into|at)?\s*(?:it|that|this))?)(?:\s+(?:now|for you|right now))?$/i;

/** A promise that depends on the admin, or an offer, is not unkept work. */
const CONDITIONAL =
  /\b(?:if (?:you|needed|that helps|it helps|useful|wanted|required)|should i|do you want|would you like|let me know|i can\b|i could\b|when you|whenever you|once you|if you ask|on request|just ask|tell me)\b/i;

/** Longest answer that can still be a progress message; anything longer reports something. */
export const PROMISE_ANSWER_MAX_LENGTH = 160;

/** Inline quotes are text the answer talks about, not work it announces. */
function withoutInlineQuotes(answer: string): string {
  return answer
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}

/** Acknowledgements that carry no result: "Sure.", "Okay, ", "Got it." */
const FILLER =
  /^(?:(?:sure|ok(?:ay)?|yes|yeah|alright|all right|of course|certainly|absolutely|got it|understood|right|no problem|thanks|thank you|good question|great question|on it|and|then|first|now|so)\b[\s,.!:;…-]*)*$/i;

function isFiller(text: string): boolean {
  return FILLER.test(text.trim());
}

/**
 * The clauses of an answer: split at sentence ends, at , ; : and dashes,
 * and at the conjunctions that join a second statement ("and", "but",
 * "so"), so a result next to a promise stands on its own. "because",
 * "since", "as" and "now that" split only before a statement ("since the
 * review is complete"), not before a time ("since Monday"). "go and check"
 * stays one clause.
 */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+|\s*[,;:—–]\s*|(?<!\bgo)\s+(?:and|but|so|while|although|though|yet|however|whereas)\s+|\s+(?:because|since|as|now that)\s+(?=(?:the|all|every|each|no|none|it|its|this|that|these|those|they|there|we|our|your|i|you|[0-9])\b)/i)
    .map((clause) => clause.replace(/[.!?…]+$/, "").trim())
    .filter(Boolean);
}

/**
 * True only for a short progress message: at least one clause announces
 * work in forward-looking words ("I'll check that now.", "Let me see."),
 * and every other clause acknowledges the question ("Sure.") or says work
 * is under way with nothing after it ("I'm checking").
 * Any other clause is substance: a result, an offer, a list or a code
 * block finishes the answer, also when it mentions a later step. Numbers
 * inside the announced work ("I'll check the Windows 11 devices.") do not
 * make it a result. Conservative on purpose: a missed promise costs an
 * unhelpful answer the admin can ask again; a false one withdraws a
 * correct answer.
 */
export function looksLikeUnkeptPromise(answer: string): boolean {
  const raw = answer.trim();
  if (!raw || raw.length > PROMISE_ANSWER_MAX_LENGTH) return false;
  if (raw.includes("```") || /^\s*(?:[-*•]|\d+[.)])\s+/m.test(raw)) return false;
  if (CONDITIONAL.test(raw)) return false;
  let promised = false;
  for (const clause of clauses(withoutInlineQuotes(raw))) {
    if (isFiller(clause)) continue;
    if (CHECKING_NOW.test(clause)) {
      promised = true;
      continue;
    }
    // A promise counts only with nothing but an acknowledgement before it.
    const match = PROMISE.exec(clause);
    if (match && isFiller(clause.slice(0, match.index))) {
      promised = true;
      continue;
    }
    // Work under way with nothing after it is neutral; any other clause is substance.
    if (BARE_PROGRESS.test(clause)) continue;
    return false;
  }
  return promised;
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

/**
 * Bounds each model call on its own, so a repair turn gets the same time
 * as the first answer instead of sharing it. With `MAX_PROMISE_NUDGES`
 * the whole answer is bounded by three times `timeoutMs`. `outer` stops
 * every attempt, for example when the organization is being disconnected.
 */
export function eachAttemptWithin(
  complete: (prompt: string, signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
  timeoutMessage: string,
  outer?: AbortSignal,
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Settle as timed out first: a call that answers its abort must not win the race.
        reject(new Error(timeoutMessage));
        controller.abort(new Error(timeoutMessage));
      }, timeoutMs);
    });
    const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
    try {
      return await Promise.race([complete(prompt, signal), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}
