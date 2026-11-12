import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { AppState, ConnectorSummary, EffectiveNovaProfile, ManagedPolicyStatus, NovaActionPreview, NovaCapabilityName, NovaFollowUp, NovaNote, NovaNoteSource, NovaProfile, NovaProfilePatch, ProviderId, RunRecord, StartRunOptions } from '@openadminos/agent-sdk';
import { organizationForTenant, resolveProviderDefaultModel } from '@openadminos/agent-sdk';
import { applyNovaProfilePatch, novaCapabilityAllowed, novaCapabilityOffMessage, novaConnectorSendAllowed, novaShortcutPromptIssue } from './nova-profile.js';
import { novaNoteText } from './nova-memory.js';
import { novaFollowUpQuestion } from './nova-followups.js';
import type { NovaProfileProposal, NovaProposableCapability } from '../src/shared/nova-command.js';

/** Nova's settings with the IT policy, as `NovaActionHost.profile` reads them. */
export interface NovaSettings { profile: NovaProfile | undefined; effective: EffectiveNovaProfile; policy: ManagedPolicyStatus | undefined }

export interface NovaActionHost {
  classifyCommand?(text: string, context: import("../src/shared/nova-command.js").NovaCommandContext, options: Pick<import("./nova.js").NovaChatOptions, "scope" | "signal">): Promise<string>;
  connectors(): Promise<ConnectorSummary[]>;
  send(input: { connectorId: string; config: Record<string, unknown>; method: string; args: Record<string, unknown>; tenantId: string; actionId: string; signal: AbortSignal }): Promise<unknown>;
  startRun(slug: string, options: StartRunOptions): Promise<RunRecord>;
  /** The tenant of the active organization now, read when an action runs. */
  activeTenantId(): Promise<string | undefined>;
  /**
   * Run an approved action under its tenant's lease: refused once the
   * organization is being disconnected, drained by Disconnect, and the
   * signal fires when it starts closing, so a multi-part send stops.
   */
  tenantLease?<T>(tenantId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Nova's settings now, with the IT policy applied. Read again for every
   * action, at preparation and at the click, so a switch turned off in
   * between stops it. A failed read refuses the action.
   */
  profile(): Promise<NovaSettings>;
  /**
   * Saves a settings change the admin confirmed on a Nova card. The IT
   * policy is applied again. `assertUnchanged` runs inside the same
   * serialized write with the settings as stored, and throws when they
   * changed since the card was prepared.
   */
  applyProfileProposal?(patch: NovaProfilePatch, assertUnchanged: (effective: EffectiveNovaProfile) => void): Promise<void>;
  /** Nova's notes of one organization. Absent: Nova keeps no notes in this app session. */
  notes?: {
    /** Confirmed and edited notes for the prompt, newest first. */
    promptNotes(tenantId: string): Promise<string[]>;
    /** Stores a note for review; it reaches no prompt until confirmed. */
    propose(input: { tenantId: string; text: string; source: NovaNoteSource; sessionId?: string; conversationId?: string; turnId?: string }): Promise<NovaNote>;
    confirm(id: string): Promise<NovaNote>;
    forget(id: string): Promise<void>;
    /** Forgets a note only while it is still proposed: a note confirmed or edited in Settings meanwhile stays. */
    discardProposed(id: string): Promise<void>;
  };
  /** One-time follow-up questions. Absent: Nova sets none in this app session. */
  followUps?: {
    /** Throws the designed refusal when a follow-up with this delay is over a limit. */
    check(delayMinutes: number): Promise<void>;
    create(input: { tenantId: string; question: string; providerId: ProviderId; model?: string; delayMinutes: number }): Promise<NovaFollowUp>;
  };
  /** Records the consent to send audio and shared context to OpenAI for one voice session. Never throws. */
  recordVoiceConsent?(input: { tenantId: string; sessionId: string; acknowledgedAt: string; voiceModel: string; reasoningProviderId: ProviderId; reasoningModel?: string; includesProfile: boolean; includesMemory: boolean }): void;
}

/** Said when Nova's settings cannot be read: Nova then does not act. */
export const NOVA_SETTINGS_UNREADABLE =
  'Nova could not read its settings, so nothing was sent, started or opened. Open Settings, Nova, check it loads, then ask again.';

/** Nova's settings for one action. Throws the designed refusal when they cannot be read. */
export async function readNovaSettings(host: Pick<NovaActionHost, 'profile'>): Promise<NovaSettings> {
  try {
    const settings = await host.profile();
    if (!settings?.effective) throw new Error('No settings returned.');
    return settings;
  } catch {
    throw new Error(NOVA_SETTINGS_UNREADABLE);
  }
}

/** Refuses with the designed message when an ability is turned off now. */
export async function requireNovaCapability(host: Pick<NovaActionHost, 'profile'>, name: NovaCapabilityName): Promise<void> {
  const { profile, policy } = await readNovaSettings(host);
  if (!novaCapabilityAllowed(profile, policy, name)) throw new Error(novaCapabilityOffMessage(policy, name));
}

async function requireConnectorSend(host: Pick<NovaActionHost, 'profile'>, connectorId: string, connectorName: string): Promise<void> {
  const { profile, policy } = await readNovaSettings(host);
  if (!novaConnectorSendAllowed(profile, policy, connectorId)) throw new Error(novaCapabilityOffMessage(policy, 'connectorSends', connectorName));
}

/** Run an approved action under its tenant's lease, with both signals. */
function leased<T>(host: NovaActionHost, tenantId: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return host.tenantLease
    ? host.tenantLease(tenantId, (leaseSignal) => work(AbortSignal.any([signal, leaseSignal])))
    : work(signal);
}

/** Said when the organization changed between the preview and the confirmation. */
export const NOVA_ORGANIZATION_CHANGED =
  'The active organization changed after Nova prepared this. Nothing was run or sent. Ask Nova again in the organization you want to use.';

/** An action runs only while the organization it was prepared in is still active. */
async function assertStillActive(host: NovaActionHost, tenantId: string): Promise<void> {
  if ((await host.activeTenantId()) !== tenantId) {
    throw new Error(NOVA_ORGANIZATION_CHANGED);
  }
}
export interface PreparedNovaAction {
  preview: NovaActionPreview;
  execute(signal: AbortSignal): Promise<{ text: string; route?: string }>;
  /** Undoes what preparing stored, when the admin cancels the card. */
  cancel?(): Promise<void>;
}
export { novaActionIntent } from '../src/shared/nova-action-intent.js';
import { novaActionIntent, type NovaActionIntent } from '../src/shared/nova-action-intent.js';
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

export async function prepareNovaAction(text: string | NovaActionIntent, evidence: string | undefined, state: AppState, host: NovaActionHost): Promise<PreparedNovaAction | undefined> {
  const intent = typeof text === 'string' ? novaActionIntent(text) : text;
  if (!intent) return undefined;
  if (!state.activeTenantId) throw new Error('Select a tenant before using Nova actions.');
  const tenantId = state.activeTenantId;
  const id = randomUUID();
  if (intent.kind === 'run') {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidates = state.installedAgents.filter(a => normalize(a.name) === normalize(intent.name) || normalize(a.slug) === normalize(intent.name));
    if (candidates.length !== 1) throw new Error('Name one installed agent exactly. Open Agents to see the available names.');
    await requireNovaCapability(host, 'startAgents');
    const agent = candidates[0]!;
    return { preview: { id, title: `Run ${agent.name}`, target: state.tenants.find(t => t.id === tenantId)?.displayName || 'Selected tenant', body: `Run ${agent.name} against the selected tenant. Write plans require their normal review. Existing saved result-delivery routes may send notifications when the run finishes.`, kind: 'run' }, execute: outer => leased(host, tenantId, outer, async signal => {
      signal.throwIfAborted();
      await assertStillActive(host, tenantId);
      await requireNovaCapability(host, 'startAgents');
      const run = await host.startRun(agent.slug, { tenantId, providerId: state.activeProviderId });
      return { text: `${agent.name} was queued. Follow its progress in Runs; any required approvals remain in the app.`, route: `/runs/${run.id}` };
    }) };
  }
  const connector = (await host.connectors()).find(c => c.descriptor.id === intent.connectorId);
  if (!connector) throw new Error('This connector is unavailable. Open Connectors to configure a supported destination.');
  await requireConnectorSend(host, intent.connectorId, connector.descriptor.name);
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
      if (intent.channelName && intent.channelName.toLowerCase() !== str('defaultChannelName').toLowerCase()) throw new Error(`Teams is configured for ${str('defaultChannelName') || 'a different channel'}. Open Connectors to select ${intent.channelName}, then ask again.`);
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
  return { preview: { id, kind: 'send', title: `Send via ${connector.descriptor.name}`, target, body: evidence, ...(deliveryNote ? { deliveryNote } : {}) }, execute: outer => leased(host, tenantId, outer, async signal => {
    await assertStillActive(host, tenantId);
    await requireConnectorSend(host, intent.connectorId, connector.descriptor.name);
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
  }) };
}

const CAPABILITY_TITLES: Record<NovaProposableCapability, string> = {
  webSearch: 'Web search',
  startAgents: 'Starting agents',
  navigation: 'Opening pages',
};

/** Said when the setting changed between the card and the click. */
export const NOVA_PROFILE_CHANGED =
  'Nova settings changed after Nova prepared this. Nothing was changed. Ask Nova again to see the current values.';

/**
 * A card for a change to Nova's own settings. The change is checked
 * against the IT policy and the limits now, and again at the click. It
 * can turn an ability off, never on.
 */
export async function prepareNovaProfileChange(change: NovaProfileProposal, host: NovaActionHost): Promise<PreparedNovaAction> {
  if (!host.applyProfileProposal) throw new Error('Nova cannot change its settings in this app session. Open Settings, Nova, to change them.');
  const settings = await readNovaSettings(host);
  const { effective, profile, policy } = settings;
  let patch: NovaProfilePatch;
  let title: string, target: string, body: string, previousBody: string;
  const current = (read: Pick<NovaSettings, 'effective'>) =>
    change.field === 'instructions' ? read.effective.instructions
      : change.field === 'greetingName' ? read.effective.greetingName
        : String(read.effective.capabilities[change.capability]);
  if (change.field === 'instructions') {
    const next = change.mode === 'append' && effective.instructions.trim() ? `${effective.instructions.trim()}\n${change.text}` : change.text;
    patch = { instructions: next };
    title = change.mode === 'append' ? 'Add to Nova standing instructions' : 'Replace Nova standing instructions';
    target = 'Settings, Nova, standing instructions';
    body = next;
    previousBody = effective.instructions || 'None';
  } else if (change.field === 'greetingName') {
    patch = { greetingName: change.text };
    title = 'Change Nova greeting name';
    target = 'Settings, Nova, greeting name';
    body = change.text;
    previousBody = effective.greetingName || 'None';
  } else {
    if (!effective.capabilities[change.capability]) throw new Error(`${CAPABILITY_TITLES[change.capability]} is already off for Nova. Nothing was changed.`);
    patch = { capabilities: { [change.capability]: false } };
    title = `Turn off ${CAPABILITY_TITLES[change.capability].toLowerCase()} for Nova`;
    target = 'Settings, Nova, abilities';
    body = `${CAPABILITY_TITLES[change.capability]}: off. Turn it on again in Settings, Nova.`;
    previousBody = `${CAPABILITY_TITLES[change.capability]}: on`;
  }
  // The same checks Settings makes; a locked or too long value is refused here, before the card.
  applyNovaProfilePatch(profile, patch, policy, { now: new Date().toISOString(), newId: () => 'proposal', organizationIds: [], via: 'nova-proposal' });
  const before = current(settings);
  return {
    preview: { id: randomUUID(), kind: 'profile', title, target, body, previousBody },
    execute: async (signal) => {
      signal.throwIfAborted();
      if (current(await readNovaSettings(host)) !== before) throw new Error(NOVA_PROFILE_CHANGED);
      // Checked again inside the write, so a Settings save in between is never overwritten.
      await host.applyProfileProposal!(patch, (effective) => {
        if (current({ effective }) !== before) throw new Error(NOVA_PROFILE_CHANGED);
      });
      return {
        text: change.field === 'capability'
          ? `${CAPABILITY_TITLES[change.capability]} is now off for Nova.`
          : 'Saved in Settings, Nova. Nova uses it from the next conversation.',
      };
    },
  };
}

/** Said when notes are paused, or off by the IT policy. */
export function novaNotesOffMessage(effective: EffectiveNovaProfile): string {
  return effective.locked.memory
    ? 'Your IT department turned Nova notes off. Nothing was stored.'
    : 'Nova notes are paused. Resume them in Settings, Nova, then ask again. Nothing was stored.';
}

function organizationName(state: AppState, tenantId: string): string {
  return organizationForTenant(state.organizations ?? [], tenantId)?.name
    || state.tenants.find(t => t.id === tenantId)?.displayName
    || 'the active organization';
}

/**
 * A card for a note. Preparing stores it as proposed, for review in
 * Settings; it reaches no prompt. Only the click confirms it, and
 * Cancel forgets it.
 */
export async function prepareNovaNote(
  input: { text: string; source: NovaNoteSource; sessionId?: string; conversationId?: string; turnId?: string },
  state: AppState,
  host: NovaActionHost,
): Promise<PreparedNovaAction> {
  if (!host.notes) throw new Error('Nova cannot keep notes in this app session. Reopen the latest app build and try again.');
  if (!state.activeTenantId) throw new Error('Select an organization first. Nova keeps notes for one organization.');
  const tenantId = state.activeTenantId;
  const { effective } = await readNovaSettings(host);
  if (!effective.memoryEnabled) throw new Error(novaNotesOffMessage(effective));
  const text = novaNoteText(input.text);
  const note = await host.notes.propose({ tenantId, text, source: input.source, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}) });
  const name = organizationName(state, tenantId);
  const notes = host.notes;
  return {
    preview: {
      id: randomUUID(),
      kind: 'remember',
      title: 'Remember for Nova',
      target: name,
      body: note.text,
      deliveryNote: input.source === 'user-said'
        ? `You asked for this note in Nova, ${note.createdAt.slice(0, 16).replace('T', ' ')} UTC. Nova reads confirmed notes in this organization only.`
        : `Nova worded this note from your request, ${note.createdAt.slice(0, 16).replace('T', ' ')} UTC. Check it before you confirm. Nova reads confirmed notes in this organization only.`,
    },
    execute: async (signal) => {
      signal.throwIfAborted();
      await assertStillActive(host, tenantId);
      const settings = await readNovaSettings(host);
      if (!settings.effective.memoryEnabled) throw new Error(novaNotesOffMessage(settings.effective));
      await notes.confirm(note.id);
      return { text: `Nova will remember this in ${name} from the next conversation. Review notes in Settings, Nova.` };
    },
    cancel: () => notes.discardProposed(note.id),
  };
}

/** Said when the provider or model changed between the card and the click. */
export const NOVA_FOLLOW_UP_PROVIDER_CHANGED =
  'The agent provider or model changed after Nova prepared this. Nothing was set. Ask Nova again.';

/**
 * A card for a one-time read-only follow-up in the active organization,
 * with the provider and model it will use. Nothing is set until the click.
 */
export async function prepareNovaFollowUp(
  input: { question: string; minutes: number },
  state: AppState,
  host: NovaActionHost,
): Promise<PreparedNovaAction> {
  if (!host.followUps) throw new Error('Nova cannot set follow-ups in this app session. Reopen the latest app build and try again.');
  if (!state.activeTenantId) throw new Error('Select an organization first. A follow-up runs in the organization it was set in.');
  const tenantId = state.activeTenantId;
  // The same checks the click makes, so a card is never shown for a question that cannot be set.
  const question = novaFollowUpQuestion(input.question);
  const readOnlyIssue = novaShortcutPromptIssue(question);
  if (readOnlyIssue) throw new Error('A follow-up can only ask a read-only question again. Remove the request to send, run, schedule, change or remember something. Nothing was set.');
  await host.followUps.check(input.minutes);
  const provider = state.providers.find(p => p.id === state.activeProviderId);
  const model = resolveProviderDefaultModel(provider, state.activeModelByProviderId).model;
  const providerId = state.activeProviderId;
  const name = organizationName(state, tenantId);
  const due = new Date(Date.now() + input.minutes * 60_000);
  const delay = input.minutes % 1440 === 0 ? `${input.minutes / 1440} ${input.minutes === 1440 ? 'day' : 'days'}`
    : input.minutes % 60 === 0 ? `${input.minutes / 60} ${input.minutes === 60 ? 'hour' : 'hours'}`
      : `${input.minutes} ${input.minutes === 1 ? 'minute' : 'minutes'}`;
  const followUps = host.followUps;
  return {
    preview: {
      id: randomUUID(),
      kind: 'follow-up',
      title: `Ask again in ${delay}`,
      target: name,
      body: question,
      deliveryNote: `Runs once at about ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC with ${provider?.name ?? providerId}${model ? ` · ${model}` : ''}${provider && !provider.isLocal ? ', a hosted provider' : ''}. The answer appears in Chat. Read-only. Sending the result anywhere still needs your click.`,
    },
    execute: async (signal) => {
      signal.throwIfAborted();
      await assertStillActive(host, tenantId);
      const created = await followUps.create({ tenantId, question, providerId, ...(model ? { model } : {}), delayMinutes: input.minutes });
      return { text: `Set. Nova asks this again at about ${created.dueAt.slice(0, 16).replace('T', ' ')} UTC in ${name}. Cancel it in Settings, Nova.` };
    },
  };
}
