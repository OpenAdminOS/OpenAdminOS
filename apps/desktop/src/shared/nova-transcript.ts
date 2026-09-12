import type { NovaConversationTurn } from "@openadminos/agent-sdk";

interface Fragment {
  key: string;
  sequence: number;
  role: NovaConversationTurn["role"];
  text: string;
  start?: number;
  end?: number;
}
interface Turn extends NovaConversationTurn { fragments: Fragment[] }

/** Keep original fragments: arrival order is not the Live session timeline. */
export class NovaTranscript {
  private fragments: Fragment[] = [];
  private sequence = 0;
  private consumed = new Set<string>();

  append(event: { type: string; delta: string; event_id?: string; start_ms?: number; end_ms?: number }) {
    if (!event.delta || !["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type)) return false;
    const sequence = ++this.sequence;
    const key = event.event_id || `arrival-${sequence}`;
    if (this.fragments.some(fragment => fragment.key === key)) return false;
    const timed = Number.isFinite(event.start_ms) && Number.isFinite(event.end_ms) && event.start_ms! >= 0 && event.end_ms! >= event.start_ms!;
    this.fragments.push({ key, sequence, role: event.type.includes("input_") ? "user" : "assistant", text: event.delta.slice(0, 12000),
      ...(timed ? { start: event.start_ms, end: event.end_ms } : {}) });
    let size = this.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0);
    while (this.fragments.length > 512 || size > 24000) {
      const removed = this.fragments.shift()!;
      size -= removed.text.length;
      this.consumed.delete(removed.key);
    }
    return true;
  }

  takeStopCommand(): boolean {
    const pending = this.capture(undefined, false);
    if (!pending) return false;
    const rest = novaStopCommand(pending.text);
    if (rest === undefined) return false;
    this.capture();
    if (rest) this.append({ type: "session.input_transcript.delta", delta: rest });
    return true;
  }

  capture(offsetMs?: number, consume = true): { text: string; history: NovaConversationTurn[] } | undefined {
    const cutoff = Number.isFinite(offsetMs) && offsetMs! >= 0 ? offsetMs : undefined;
    const fragments = this.fragments.filter(fragment => cutoff === undefined || fragment.start === undefined || fragment.start <= cutoff);
    fragments.sort((a, b) => a.start !== undefined && b.start !== undefined ? a.start - b.start || a.sequence - b.sequence : a.sequence - b.sequence);
    const turns: Turn[] = [];
    for (const fragment of fragments) {
      const previous = turns.at(-1);
      // Overlapping assistant acknowledgments do not split an ongoing user utterance.
      const lastUser = turns.slice().reverse().find(turn => turn.role === "user");
      const lastInput = lastUser?.fragments.at(-1);
      const overlapping = fragment.role === "user" && previous?.role === "assistant" && lastInput?.end !== undefined &&
        previous.fragments.every(output => output.start !== undefined && output.start < lastInput.end! && output.end !== undefined && fragment.start !== undefined && output.end > fragment.start);
      const target = previous?.role === fragment.role ? previous : overlapping ? lastUser : undefined;
      if (target) { target.text += fragment.text; target.fragments.push(fragment); }
      else turns.push({ role: fragment.role, text: fragment.text, fragments: [fragment] });
    }
    const current = turns.slice().reverse().find(turn => turn.role === "user");
    if (!current || current.fragments.every(fragment => this.consumed.has(fragment.key))) return undefined;
    const text = current.fragments.filter(fragment => !this.consumed.has(fragment.key)).map(fragment => fragment.text).join("").trim();
    // Earlier greetings and waiting chatter remain reference history, never the new request.
    if (consume) for (const fragment of fragments) if (fragment.role === "user") this.consumed.add(fragment.key);
    const history = turns.slice(0, turns.indexOf(current)).slice(-6).map(({ role, text }) => ({ role, text: text.slice(-600) }));
    return { text, history };
  }
}

/** Known conversational turns must not replace a running investigation. */
export function isNovaConversationOnly(text: string): boolean {
  const question = text.trim().replace(/[?.!]+$/, "").trim();
  return /^(?:still there|are you (?:still )?there|are you (?:still )?(?:working|checking)|any (?:update|news)|(?:can you |could you |please )?(?:tell me|say) (?:a|another) joke(?: while (?:we|i) wait)?|who are you(?: and what can you do)?|what can you do|(?:hey|hi|hello)(?: nova)?|thanks|thank you)$/i.test(question);
}

/** Each append is below 500 tokens even with non-ASCII text; prefer whole sentences. */
export function novaCommentaryChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  const encoder = new TextEncoder();
  while (remaining) {
    let end = 0, bytes = 0;
    for (const char of remaining) {
      const size = encoder.encode(char).length;
      if (bytes + size > 400) break;
      bytes += size; end += char.length;
    }
    if (end < remaining.length) {
      const prefix = remaining.slice(0, end);
      const sentence = [...prefix.matchAll(/[.!?]\s+/g)].at(-1);
      const boundary = sentence ? sentence.index! + 1 : prefix.lastIndexOf(" ");
      if (boundary > 0) end = boundary;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

/** Recognize an explicit command at the start of the unconsumed utterance. */
export function novaStopCommand(text: string): string | undefined {
  const match = /^(?:(?:hey\s+)?nova[,\s]+)?(?:please\s+)?(?:stop|cancel)(?:\s+(?:speaking|talking|the (?:answer|investigation)|that|this))?(?:[.!?,]+\s*|\s+(?=(?:can|could|now|tell|show|why|what|which|list)\b)|$)/i.exec(text.trim());
  return match ? text.trim().slice(match[0].length).trim() : undefined;
}
