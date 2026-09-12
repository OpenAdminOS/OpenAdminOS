import { setTimeout as delay } from 'node:timers/promises';
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
export { novaActionIntent } from '../src/shared/nova-action-intent.js';
import { novaActionIntent } from '../src/shared/nova-action-intent.js';
export function novaConnectorSetupIssue(connector: ConnectorSummary): string | undefined {
  if (connector.status === 'connected' || connector.status === undefined) return undefined;
  const name = connector.descriptor.name;
  if (connector.status === 'needs-scope') return `${name} needs permission. Open Connectors and re-test ${name} to complete consent, then ask Nova again.`;
  if (connector.status === 'error') return `${name} reported a connection error. Open Connectors and re-test it before preparing a message.`;
  const steps: Record<string, string> = {
    'whatsapp-web': 'link WhatsApp with its QR code',
    outlook: 'connect your tenant, set email recipients and test Outlook',
    teams: 'choose a team and channel and test Teams',
    slack: 'add the Slack bot token, set its destination and test Slack',
    discord: 'add the Discord webhook and test Discord',
    signal: 'configure the Signal account, recipient and local bridge or signal-cli, then test Signal',
  };
  return `${name} ${connector.status === 'unknown' ? 'has not been tested' : 'needs setup'}. Open Connectors, ${steps[connector.descriptor.id] || 'complete setup and test the connection'}, then ask Nova again.`;
}

/** Preserve every character, including surrogate pairs; prefer newline boundaries. */
export function novaMessageParts(text: string, connectorId: string): string[] {
  // Conservative UTF-8 budgets leave room for part labels and Teams HTML expansion.
  const budget = ({ discord: 1800, slack: 35000, teams: 4000 } as Record<string, number>)[connectorId];
  if (!budget) return [text];
  const parts: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest) > budget) {
    let end = 0, bytes = 0;
    for (const char of rest) {
      const size = Buffer.byteLength(char);
      if (bytes + size > budget) break;
      bytes += size; end += char.length;
    }
    const newline = rest.lastIndexOf('\n', end - 1);
    if (newline > end / 2) end = newline + 1;
    parts.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) parts.push(rest);
  return parts;
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
  const connector = (await host.connectors()).find(c => c.descriptor.id === intent.connectorId);
  if (!connector) throw new Error('This connector is unavailable. Open Connectors to configure a supported destination.');
  const setupIssue = novaConnectorSetupIssue(connector);
  if (setupIssue) throw new Error(setupIssue);
  if (!evidence?.trim()) throw new Error('What should I send? There is no completed result to share yet. Ask for a report and a destination together, for example: send me an email with the list of non-compliant devices.');
  if (evidence.length > 50000) throw new Error('This result is too large for a message. Ask for a shorter report before sending.');
  const config = structuredClone(connector.config);
  const str = (key: string) => typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  let method = 'sendMessage', target = '', args: Record<string, unknown> = { text: evidence };
  switch (intent.connectorId) {
    case 'whatsapp-web': args.to = intent.self ? 'self' : str('defaultRecipientType') === 'self' ? 'self' : str('defaultRecipient') || 'self'; target = args.to === 'self' ? 'My WhatsApp (linked account)' : str('defaultRecipientLabel') || (str('defaultRecipientType') === 'group' ? 'Configured WhatsApp group' : 'Configured WhatsApp recipient'); break;
    case 'outlook': {
      const tenant = state.tenants.find(t => t.id === tenantId);
      const recipients = intent.self ? tenant?.username : str('defaultRecipients');
      const to = (recipients || '').split(/[;,\s]+/).filter(Boolean);
      if (!to.length) throw new Error('No email recipient is available. Set default recipients in the Outlook connector.');
      method = 'sendMail'; args = { markdown: evidence, to, subject: 'Nova result · OpenAdminOS' }; target = to.join(', '); break;
    }
    case 'teams':
      if (intent.self) throw new Error(`Your Teams connector is configured for shared destinations, not a verified private chat with you.${str('defaultTeamId') && str('defaultChannelId') ? ` I can prepare a post to ${str('defaultTeamName') || 'the configured team'} / ${str('defaultChannelName') || 'the configured channel'}. Say send this via Teams to review that shared destination.` : ' Open Connectors to choose a Teams destination.'}`);
      if (str('defaultTeamId') && str('defaultChannelId')) { method = 'postChannelMessage'; args = { markdown: evidence, teamId: str('defaultTeamId'), channelId: str('defaultChannelId') }; target = `${str('defaultTeamName') || str('defaultTeamId')} / ${str('defaultChannelName') || str('defaultChannelId')}`; }
      else if (str('defaultChatId')) { method = 'postChatMessage'; args = { markdown: evidence, chatId: str('defaultChatId') }; target = str('defaultChatName') || str('defaultChatId'); }
      break;
    case 'slack': args.channel = str('defaultChannel'); target = str('defaultChannelLabel') ? `${str('defaultChannelLabel')} (${str('defaultChannel')})` : str('defaultChannel'); if (!args.channel) target = ''; break;
    case 'signal': args.to = str('defaultRecipient'); target = str('defaultRecipientLabel') ? `${str('defaultRecipientLabel')} (${str('defaultRecipient')})` : str('defaultRecipient'); if (!args.to) target = ''; break;
    case 'discord': target = `${str('defaultTargetLabel') || 'Configured Discord webhook'}${str('defaultThreadId') ? ` / thread ${str('defaultThreadId')}` : ''}`; break;
  }
  if (!target) throw new Error(`Set a default destination for ${connector.descriptor.name} on the Connectors page, then ask again.`);
  if (intent.self && ['slack', 'discord', 'signal'].includes(intent.connectorId))
    throw new Error(`${connector.descriptor.name} does not have a verified personal destination for you. Its configured destination is ${target}. Say send this via ${connector.descriptor.name} to review that destination; I will not treat it as a private message to you.`);
  const parts = novaMessageParts(evidence, intent.connectorId);
  const deliveryNote = parts.length > 1 ? `This report will be sent as ${parts.length} numbered messages, in order. Review the full content below. If a send fails, remaining messages stop without automatic retries.` : undefined;
  return { preview: { id, kind: 'send', title: `Send via ${connector.descriptor.name}`, target, body: evidence, ...(deliveryNote ? { deliveryNote } : {}) }, execute: async signal => {
    let accepted = 0;
    try {
      for (const [index, part] of parts.entries()) {
        signal.throwIfAborted();
        if (index) await delay(1100, undefined, { signal });
        const body = parts.length > 1 ? `(${index + 1}/${parts.length})\n${part}` : part;
        await host.send({ connectorId: intent.connectorId, config, method,
          args: { ...args, [method === 'sendMail' || method.startsWith('post') ? 'markdown' : 'text']: body }, tenantId,
          actionId: parts.length > 1 ? `${id}:${index}` : id, signal });
        accepted++;
      }
    } catch (error) {
      throw new Error(`${accepted} of ${parts.length} messages confirmed accepted by ${connector.descriptor.name}. Remaining messages were stopped. The failed request may still have been accepted; check the destination before retrying. ${error instanceof Error ? error.message : 'Connector unavailable.'}`);
    }
    return { text: intent.connectorId === 'outlook' ? 'Outlook accepted the email for sending. Delivery to the recipient is not yet confirmed.' : `${connector.descriptor.name} accepted ${parts.length === 1 ? 'the message' : `all ${parts.length} messages`} to ${target}. Recipient delivery is not yet confirmed.` };
  } };
}
