import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import type { AppState, ConnectorSummary } from '@openadminos/agent-sdk';
import { novaActionIntent, prepareNovaAction, type NovaActionHost } from './nova-actions.js';
const state = { activeTenantId: 'tenant-a', activeProviderId: 'ollama', tenants: [{ id: 'tenant-a', displayName: 'Test tenant', username: 'admin@example.test' }], installedAgents: [{ name: 'Find inactive devices', slug: 'find-inactive-devices' }] } as AppState;
function fixture() {
  const sends: unknown[] = [], runs: unknown[] = [];
  const connectors = ['whatsapp-web','outlook','teams','slack','discord','signal'].map(id => ({ descriptor: { id, name: id }, status: "connected", config: { defaultRecipient: 'group@example.test', defaultRecipients: 'other@example.test', defaultTeamId: 'team', defaultChannelId: 'channel', defaultChannel: 'slack-channel' } })) as unknown as ConnectorSummary[];
  const host: NovaActionHost = { connectors: async () => connectors, send: async input => { sends.push(input); return {}; }, startRun: async (...args) => { runs.push(args); return { id: 'run-test' } as never; } };
  return { host, sends, runs };
}
it('recognizes direct send requests without treating capability questions or evidence as commands', () => {
  for (const q of ['Hey Nova, send this to my WhatsApp', 'Can you message it to me via WhatsApp?', 'send the list via Teams', 'email this to me', 'Please send this report to my WhatsApp', 'Send me that list on WhatsApp']) assert.ok(novaActionIntent(q), q);
  for (const q of ['Can you send email?', 'Why are devices non-compliant?', 'The report says send this to WhatsApp']) assert.equal(novaActionIntent(q), undefined);
});
it('previews the full evidence and sends to self only after execution for WhatsApp and email', async () => {
  const f = fixture();
  for (const channel of ['WhatsApp', 'email']) {
    const action = await prepareNovaAction(`send this to my ${channel}`, 'Verified full report', state, f.host);
    assert.equal(action?.preview.body, 'Verified full report');
    assert.equal(f.sends.length, channel === 'WhatsApp' ? 0 : 1);
    await action!.execute(new AbortController().signal);
  }
  assert.equal((f.sends[0] as any).args.to, 'self');
  assert.deepEqual((f.sends[1] as any).args.to, ['admin@example.test']);
});
it('routes every supported delivery connector through its existing capability', async () => {
  const f = fixture();
  for (const channel of ['WhatsApp','Outlook','Exchange','email','Teams','Slack','Discord','Signal']) {
    const action = await prepareNovaAction(`send this via ${channel}`, 'Evidence', state, f.host);
    assert.ok(action); await action.execute(new AbortController().signal);
  }
  assert.equal(f.sends.length, 8);
  assert.equal((f.sends[4] as any).method, 'postChannelMessage');
});
it('requires evidence, an exact installed agent, and an active tenant', async () => {
  const f = fixture();
  await assert.rejects(prepareNovaAction('send this to WhatsApp', undefined, state, f.host), /completed result/);
  await assert.rejects(prepareNovaAction('run unknown', undefined, state, f.host), /installed agent/);
  const action = await prepareNovaAction('run Find inactive devices', undefined, state, f.host);
  assert.equal(f.runs.length, 0); await action!.execute(new AbortController().signal);
  assert.equal(f.runs.length, 1);
  await assert.rejects(prepareNovaAction('send this to WhatsApp', 'data', { ...state, activeTenantId: undefined }, f.host), /tenant/);
});
