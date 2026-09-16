import { conversationalText } from './nova-action-intent.js';

/** Static product abilities, not a claim that a particular connector or permission is ready. */
export const NOVA_INTRODUCTION = "I'm Nova, the voice assistant in OpenAdminOS. We can chat, and I can help you explore devices, apps, compliance, and policies in your connected tenant. I can explain findings, prepare reports, and prepare messages through configured connectors or installed agent runs for you to review. Sending messages and starting agents require your confirmation in the app. What would you like help with?";

/** A brief spoken greeting can arrive before the user's remaining words. */
export function isNovaAudienceGreeting(text: string): boolean {
  return /^(?:(?:(?:oh|of course)[,.\s]+)?(?:hello|hi|hey|welcome)[,\s]+(?:everyone|everybody|all|folks)[\s,.!?]*)+$/i.test(text.trim());
}

/** A longer completed introduction also counts as having greeted the audience. */
export function hasNovaAudienceGreeting(text: string): boolean {
  return /\b(?:hello|hi|hey|welcome)[,\s]+(?:everyone|everybody|all|folks)\b/i.test(text);
}

/** Pure stage context and spoken greetings do not request an app action. */
export function novaAudienceReply(text: string): string | undefined {
  const clauses = conversationalText(text).replace(/^[.\s]+/, '').split(/[.!?]+|\s+and\s+/i)
    .map(c => conversationalText(c).replace(/^and\s+/i, '').trim()).filter(Boolean);
  if (!clauses.length) return undefined;
  let greet = false;
  for (const clause of clauses) {
    const q = clause.replace(/^(?:I (?:want|would like) you to |(?:can|could|would) you |please )/i, '').replace(/,? please$/i, '');
    if (/^(?:say (?:hello|hi)(?: to)?|greet|welcome) (?:them|everyone|everybody|(?:the |our |this )?audience|(?:the )?(?:people|folks)(?: here| in the audience)?)$/i.test(q)) { greet = true; continue; }
    if (/^(?:we(?: are|'re)|I(?: am|'m)) (?:right now |now )?(?:on (?:the |a )?stage(?: (?:in front of|with) (?:an? |the |our )?audience)?|in front of (?:an? |the |our )?audience)$/i.test(q)) continue;
    return undefined; // Never swallow a compound tenant question or command.
  }
  return greet ? "Hello everyone. I'm Nova, the voice assistant in OpenAdminOS. It's good to be here with you. What would you like to explore together?" : '';
}

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
