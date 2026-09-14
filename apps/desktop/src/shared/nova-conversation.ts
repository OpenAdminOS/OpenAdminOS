import { conversationalText } from './nova-action-intent.js';

/** Static product abilities, not a claim that a particular connector or permission is ready. */
export const NOVA_INTRODUCTION = "I'm Nova, the voice assistant in OpenAdminOS. We can chat, and I can help you explore devices, apps, compliance, and policies in your connected tenant. I can explain findings, prepare reports, and prepare messages through configured connectors or installed agent runs for you to review. Sending messages and starting agents require your confirmation in the app. What would you like help with?";

/** Every clause must be conversational: never swallow an appended tenant question or action. */
export function isNovaIntroduction(text: string): boolean {
  const clauses = conversationalText(text).toLowerCase()
    .replace(/[,;.!?]+/g, ' and ').replace(/\s+/g, ' ').trim()
    .split(/\s+(?:and|also|then)\s+/).map(c => c.trim().replace(/^(?:and|also|then)\s+/, '').replace(/\s+(?:and|also|then)$/, '')).filter(Boolean);
  if (!clauses.length || clauses.length > 8) return false;
  const introduction = (clause: string) => {
    const q = clause.replace(/^(?:(?:can|could|would) you (?:please )?(?:tell me |explain )|please )/, '').replace(/ please$/, '');
    return /^(?:who (?:are you|you are)|what(?: is|'s) your name|introduce yourself|tell me (?:about yourself|who you are|what you can do)|what (?:can|do) you do(?: for (?:me|us))?|what can you (?:help|assist) (?:me|us) with|how can you (?:help|assist)(?: (?:me|us))?(?: (?:today|here))?|what (?:are your capabilities|you can do|can i ask you|can i use you for)|what (?:can you help with|do you help with)|can you help me)$/.test(q);
  };
  const greeting = /^(?:(?:hey|hello|hi)(?: nova)?|how are you(?: doing)?|good (?:morning|afternoon|evening)(?: nova)?|thanks|thank you)$/;
  return clauses.some(introduction) && clauses.every(c => introduction(c) || greeting.test(c));
}
