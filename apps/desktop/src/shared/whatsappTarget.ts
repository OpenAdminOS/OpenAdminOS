export function extractWhatsAppRecipientInput(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const jid = text.match(/[a-zA-Z0-9_.:-]+@(s\.whatsapp\.net|g\.us)/i)?.[0];
  if (jid) return jid;
  const waid = text.match(/waid=(\d+)/i)?.[1];
  if (waid) return `+${waid}`;
  const waLink = text.match(/(?:wa\.me\/|phone=)(\+?\d[\d\s().-]*)/i)?.[1];
  if (waLink) return waLink.trim();
  const tel = text.match(/TEL[^:\n]*:([+\d][^\n]*)/i)?.[1];
  if (tel) return tel.trim();
  return text;
}
