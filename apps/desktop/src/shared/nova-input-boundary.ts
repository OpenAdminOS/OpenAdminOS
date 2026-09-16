import { isNovaIntroduction } from './nova-conversation.js';

/** Live emits continuous fragments, not authoritative end-of-turn events. */
export function novaInputWaitMs(text: string, sinceTranscript: number, sinceVoice: number): number {
  // Keep ordinary questions responsive, but don't submit an unfinished clause.
  const unfinished = !isNovaIntroduction(text) && /\b(?:am|is|are|was|were|be|been|being|do|does|did|have|has|had|can|could|would|should|will|may|might|must|and|or|but|because|if|when|which|whose|with|without|of|to|for|from|on|in|at|by|the|a|an|my|your|our|not)\s*[,.…-]*$/i.test(text.trim());
  return Math.max(0, (unfinished ? 2500 : 650) - sinceTranscript, (unfinished ? 2500 : 1000) - sinceVoice);
}
