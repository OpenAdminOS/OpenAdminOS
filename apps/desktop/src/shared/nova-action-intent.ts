export type NovaActionIntent =
  | { kind: 'send'; connectorId: string; self: boolean; question?: string }
  | { kind: 'run'; name: string };

const channels = 'whatsapp|email|exchange|outlook|teams|slack|discord|signal';
const aliases: Record<string, string> = { whatsapp: 'whatsapp-web', email: 'outlook', exchange: 'outlook', outlook: 'outlook', teams: 'teams', slack: 'slack', discord: 'discord', signal: 'signal' };
const reference = /^(?:it|(?:this|that|the)(?: (?:list|result|answer|report|summary))?|an? (?:message|email))$/i;

function conversationalText(text: string) {
  const filler = /^(?:(?:alright|all right|okay|ok|so|well|then)\b[\s,.:;!-]*)+/i;
  return text.trim().replace(filler, '').replace(/^(?:hey|hi)[,\s]+nova[,\s]*/i, '').replace(filler, '').trim();
}

function requestText(text: string) {
  return conversationalText(text).replace(/^(?:please\s+|(?:can|could|would) you\s+|are you able to\s+)+/i, '')
    .replace(/\bMicrosoft Teams\b/ig, 'Teams').replace(/\bWhatsApp Web\b/ig, 'WhatsApp').replace(/\be-mail\b/ig, 'email')
    .replace(/\bExchange Online\b/ig, 'Exchange').replace(/\bOutlook email\b/ig, 'email')
    .replace(/^send an? email to me\b/i, 'send me an email').replace(/[?.!]+$/, '').trim();
}

/** Parse user requests only. A parsed action prepares a preview, never authorizes a send. */
export function novaActionIntent(text: string): NovaActionIntent | undefined {
  const q = requestText(text);
  const delivery = (channel: string, content = '', self = /^(?:send|share|message|post|email)\s+me\b|\b(?:to|via|on|through|using|by)\s+(?:me|my)\b/i.test(q)): NovaActionIntent => {
    const topic = content.trim();
    let question: string | undefined;
    if (topic && !reference.test(topic)) {
      const fleet = /^(?:a |the )?list of (non[ -]?compliant|unencrypted) devices$/i.exec(topic);
      question = fleet ? `List devices that are ${/^non/i.test(fleet[1]) ? 'non-compliant' : 'not encrypted'}` : `Show ${topic}`;
    }
    return { kind: 'send', connectorId: aliases[channel.toLowerCase()]!, self, ...(question ? { question } : {}) };
  };
  // "Send me an email with the list ..." and "send me a Teams message".
  const message = new RegExp(`^(?:send|post|share)\\s+(?:me\\s+)?(?:an?\\s+)?(${channels})(?:\\s+message)?(?:\\s+(?:with|containing|about)\\s+(.+))?$`, 'i').exec(q);
  if (message) {
    if (/^(?:can|could) you (?:send (?:email|messages))[?.!\s]*$/i.test(conversationalText(text))) return undefined;
    return delivery(message[1], message[2]);
  }
  // Result references and named new reports, followed by an explicit connector.
  const send = new RegExp(`^(?:send|share|message|post|email)\\s+(?:me\\s+)?(?:(.+?)\\s+)?(?:to|via|on|through|using|by)\\s+(?:(?:me|my)\\s+)?(?:on |via |to )?(${channels})$`, 'i').exec(q);
  if (send) {
    const content = (send[1] || '').replace(/\s+to me$/i, '');
    // Do not silently replace a named recipient with the configured default.
    if (/\bto\s+/i.test(content)) return undefined;
    return delivery(send[2], content);
  }
  const email = /^email (?:me\s+)?(.+?)(?: to me)?$/i.exec(q);
  if (email) return /\bto\s+/i.test(email[1]) ? undefined : delivery('email', email[1]);
  // Existing short form: "send this WhatsApp" or "send WhatsApp".
  const short = new RegExp(`^(?:send|share|message|post)\\s+(?:(it|this|that|the (?:list|result|answer|report))\\s+)?(${channels})$`, 'i').exec(q);
  if (short) return delivery(short[2], short[1]);
  const run = /^(?:run|start|launch)\s+(?:the\s+)?(.+?)(?:\s+agent)?$/i.exec(q);
  if (run) return { kind: 'run', name: run[1].trim() };
  return undefined;
}

/** Capability questions must be answered from app configuration, not read-only Chat. */
export function novaConnectorQuestion(text: string): boolean {
  const q = conversationalText(text);
  const capability = /^(?:can|could|would) you\b|^are you able to\b|^(?:what|which) (?:connectors|channels)\b|^(?:why|how)\b.*\b(?:you|nova)\b/i.test(q) ||
    new RegExp(`^(?:${channels})\\b.*\\bwhy\\b.*\\byou\\b`, 'i').test(q);
  return capability &&
    new RegExp(`\\b(?:${channels}|messages|connectors|channels)\\b`, 'i').test(text) &&
    /\b(?:send|share|post|message|use|available|connected)\b/i.test(text);
}
