import { isNovaIntroduction } from './nova-conversation.js';
import { conversationalText } from './nova-action-intent.js';

/** Live emits continuous fragments, not authoritative end-of-turn events. */
export function isNovaInputIncomplete(text: string): boolean {
  // Keep ordinary questions responsive, but don't submit an unfinished clause.
  const question = conversationalText(text);
  // Live can deliver the noun phrase before its verb, even while the visible
  // transcript later joins them. "Which Windows devices" is not settled yet.
  const questionPrefix = /^(?:which|what)\b/i.test(question) && !/\b(?:am|is|are|was|were|do|does|did|have|has|had|can|could|would|should|will|may|might|must|report|reports|run|runs|need|needs|support|supports)\b/i.test(question);
  return !isNovaIntroduction(text) && (questionPrefix || /\b(?:am|is|are|was|were|be|been|being|do|does|did|have|has|had|can|could|would|should|will|may|might|must|and|or|but|because|if|when|which|whose|with|without|of|to|for|from|on|in|at|by|the|a|an|my|your|our|not)\s*[,.…-]*$/i.test(question));
}

export function novaInputWaitMs(text: string, sinceTranscript: number, sinceVoice: number): number {
  const unfinished = isNovaInputIncomplete(text);
  return Math.max(0, (unfinished ? 2500 : 650) - sinceTranscript, (unfinished ? 2500 : 1000) - sinceVoice);
}
