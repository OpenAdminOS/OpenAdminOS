import { randomUUID } from 'node:crypto';
import type { AppState, ConnectorSummary, NovaActionPreview, RunRecord, StartRunOptions } from '@openadminos/agent-sdk';

export interface NovaActionHost {
  connectors(): Promise<ConnectorSummary[]>;
  send(input: { connectorId: string; config: Record<string, unknown>; method: string; args: Record<string, unknown>; tenantId: string; actionId: string; signal: AbortSignal }): Promise<unknown>;
  startRun(slug: string, options: StartRunOptions): Promise<RunRecord>;
}
export interface PreparedNovaAction {
  preview: NovaActionPreview;
  execute(signal: AbortSignal): Promise<{ text: string; route?: string }>;
}
const aliases: Record<string, string> = { whatsapp: 'whatsapp-web', email: 'outlook', exchange: 'outlook', outlook: 'outlook', teams: 'teams', slack: 'slack', discord: 'discord', signal: 'signal' };
/** Only explicit imperative requests create drafts. Evidence and model speech cannot authorize actions. */
export function novaActionIntent(text: string): { kind: 'send'; connectorId: string; self: boolean } | { kind: 'run'; name: string } | undefined {
  if (/^(?:can|could) you (?:send (?:email|messages)|run agents)[?.!\s]*$/i.test(text.trim())) return undefined;
  const q = text.trim().replace(/^(?:hey|hi)[,\s]+nova[,\s]*/i, '').replace(/^(?:please\s+|(?:can|could|would) you\s+)/i, '').replace(/[?.!]+$/, '').trim();
  if (/^send (?:an? )?email with (?:this|that|the) (?:list|result|answer|report)(?: to me)?$/i.test(q)) return { kind: "send", connectorId: "outlook", self: /to me$/i.test(q) };
  if (/^email (?:this|that|it|the (?:list|result|answer|report)) to me$/i.test(q)) return { kind: 'send', connectorId: 'outlook', self: true };
  const send = /^(?:send|share|message|post|email)\s+(?:(?:this|that|it|the (?:list|result|answer|report))\s+)?(?:(?:to|via|on|through|using|by)\s+)?(?:(?:me|my)\s+)?(?:on |via |to )?(whatsapp|email|exchange|outlook|teams|slack|discord|signal)$/i.exec(q);
  if (send) return { kind: 'send', connectorId: aliases[send[1].toLowerCase()]!, self: /\b(me|my)\b/i.test(q) };
  const run = /^(?:run|start|launch)\s+(?:the\s+)?(.+?)(?:\s+agent)?$/i.exec(q);
  if (run) return { kind: 'run', name: run[1].trim() };
  return undefined;
}
export async function prepareNovaAction(text: string, evidence: string | undefined, state: AppState, host: NovaActionHost): Promise<PreparedNovaAction | undefined> {
  const intent = novaActionIntent(text);
  if (!intent) return undefined;
  if (!state.activeTenantId) throw new Error('Select a tenant before using Nova actions.');
  const tenantId = state.activeTenantId;
  const id = randomUUID();
  if (intent.kind === 'run') {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidates = state.installedAgents.filter(a => normalize(a.name) === normalize(intent.name) || normalize(a.slug) === normalize(intent.name));
    if (candidates.length !== 1) throw new Error('Name one installed agent exactly. Open Agents to see the available names.');
    const agent = candidates[0]!;
    return { preview: { id, title: `Run ${agent.name}`, target: state.tenants.find(t => t.id === tenantId)?.displayName || 'Selected tenant', body: `Run ${agent.name} against the selected tenant. Write plans require their normal review. Existing saved result-delivery routes may send notifications when the run finishes.`, kind: 'run' }, execute: async signal => {
      signal.throwIfAborted();
      const run = await host.startRun(agent.slug, { tenantId, providerId: state.activeProviderId });
      return { text: `${agent.name} was queued. Follow its progress in Activity; any required approvals remain in the app.`, route: `/runs/${run.id}` };
    } };
  }
  if (!evidence?.trim()) throw new Error('Ask Nova for a result first, then ask to send it. There is no completed result to share in this session.');
  if (evidence.length > 50000) throw new Error('This result is too large for a message. Ask for a shorter report before sending.');
  const connector = (await host.connectors()).find(c => c.descriptor.id === intent.connectorId);
  if (!connector) throw new Error('This connector is unavailable. Open Connectors to configure a supported destination.');
  const config = structuredClone(connector.config);
  const str = (key: string) => typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  let method = 'sendMessage', target = '', args: Record<string, unknown> = { text: evidence };
  switch (intent.connectorId) {
    case 'whatsapp-web': args.to = intent.self ? 'self' : str('defaultRecipientType') === 'self' ? 'self' : str('defaultRecipient') || 'self'; target = args.to === 'self' ? 'My WhatsApp (linked account)' : str('defaultRecipientLabel') || String(args.to); break;
    case 'outlook': {
      const tenant = state.tenants.find(t => t.id === tenantId);
      const recipients = intent.self ? tenant?.username : str('defaultRecipients');
      const to = (recipients || '').split(/[;,\s]+/).filter(Boolean);
      if (!to.length) throw new Error('No email recipient is available. Set default recipients in the Outlook connector.');
      method = 'sendMail'; args = { text: evidence, to, subject: 'Nova result · OpenAdminOS' }; target = to.join(', '); break;
    }
    case 'teams':
      if (intent.self) throw new Error('Teams personal delivery needs an explicit chat destination. Configure a default chat and ask to send via Teams, then review its destination.');
      if (str('defaultTeamId') && str('defaultChannelId')) { method = 'postChannelMessage'; args = { markdown: evidence, teamId: str('defaultTeamId'), channelId: str('defaultChannelId') }; target = `${str('defaultTeamName') || str('defaultTeamId')} / ${str('defaultChannelName') || str('defaultChannelId')}`; }
      else if (str('defaultChatId')) { method = 'postChatMessage'; args = { markdown: evidence, chatId: str('defaultChatId') }; target = str('defaultChatName') || str('defaultChatId'); }
      break;
    case 'slack': args.channel = str('defaultChannel'); target = str('defaultChannel'); break;
    case 'signal': args.to = str('defaultRecipient'); target = str('defaultRecipient'); break;
    case 'discord': target = str('defaultTargetLabel') || 'Configured Discord webhook'; break;
  }
  if (!target) throw new Error(`Set a default destination for ${connector.descriptor.name} on the Connectors page, then ask again.`);
  return { preview: { id, kind: 'send', title: `Send via ${connector.descriptor.name}`, target, body: evidence }, execute: async signal => {
    signal.throwIfAborted();
    await host.send({ connectorId: intent.connectorId, config, method, args, tenantId, actionId: id, signal });
    return { text: intent.connectorId === 'outlook' ? 'Outlook accepted the email for sending. Delivery to the recipient is not yet confirmed.' : `${connector.descriptor.name} accepted the message to ${target}.` };
  } };
}
