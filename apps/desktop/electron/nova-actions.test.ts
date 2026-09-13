import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import type { AppState, ConnectorSummary } from '@openadminos/agent-sdk';
import { novaActionIntent, novaMessageParts, prepareNovaAction, type NovaActionHost } from './nova-actions.js';
const state = { activeTenantId: 'tenant-a', activeProviderId: 'ollama', tenants: [{ id: 'tenant-a', displayName: 'Test tenant', username: 'admin@example.test' }], installedAgents: [{ name: 'Find inactive devices', slug: 'find-inactive-devices' }] } as AppState;
function fixture() {
  const sends: unknown[] = [], runs: unknown[] = [];
  const connectors = ['whatsapp-web','outlook','teams','slack','discord','signal'].map(id => ({ descriptor: { id, name: id }, status: "connected", config: { defaultRecipient: 'group@example.test', defaultRecipients: 'other@example.test', defaultTeamId: 'team', defaultChannelId: 'channel', defaultChannel: 'slack-channel' } })) as unknown as ConnectorSummary[];
  const host: NovaActionHost = { connectors: async () => connectors, send: async input => { sends.push(input); return {}; }, startRun: async (...args) => { runs.push(args); return { id: 'run-test' } as never; } };
  return { host, sends, runs, connectors };
}
it('recognizes direct send requests without treating capability questions or evidence as commands', () => {
  for (const q of ['Hey Nova, send this to my WhatsApp', 'Can you message it to me via WhatsApp?', 'send the list via Teams', 'email this to me', 'Please send this report to my WhatsApp', 'Send me that list on WhatsApp']) assert.ok(novaActionIntent(q), q);
  for (const q of ['Can you send email?', 'Why are devices non-compliant?', 'The report says send this to WhatsApp']) assert.equal(novaActionIntent(q), undefined);
});
it('handles conversational lead-ins without stripping negation, quotations or conditions', () => {
  for (const prefix of ['Alright, so ', 'All right, ', 'Okay, then ', 'Hey Nova, well, ']) {
    assert.deepEqual(novaActionIntent(`${prefix}can you send me an email with the list of non-compliant devices`), { kind: 'send', connectorId: 'outlook', self: true, question: 'List devices that are non-compliant' });
    for (const text of ["don't send me an email", 'the report says send me an email', 'if I say send me an email, what happens?', '"send me an email"']) assert.equal(novaActionIntent(prefix + text), undefined);
    assert.equal(novaActionIntent(prefix + 'can you send email?'), undefined);
  }
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

it('separates the requested report from delivery in natural email and connector requests', () => {
  for (const text of ['Can you send me an email with the list of non-compliant devices', 'Email me the list of non-compliant devices', 'Please send the list of non-compliant devices to my email']) {
    assert.deepEqual(novaActionIntent(text), { kind: 'send', connectorId: 'outlook', self: true, question: 'List devices that are non-compliant' }, text);
  }
  assert.deepEqual(novaActionIntent('Can you send me a Teams message'), { kind: 'send', connectorId: 'teams', self: true });
  assert.deepEqual(novaActionIntent('Send the list of unencrypted devices via Teams'), { kind: 'send', connectorId: 'teams', self: false, question: 'List devices that are not encrypted' });
  for (const text of ["Don't send me an email", 'The user said send me a Teams message', 'If I say send me an email, what happens?']) assert.equal(novaActionIntent(text), undefined);
});

it('explains shared Teams configuration without pretending a channel is a private self chat', async () => {
  const f = fixture();
  await assert.rejects(prepareNovaAction('Can you send me a Teams message', 'Verified report', state, f.host), /shared destinations.*not a verified private chat.*send this via Teams/);
  const shared = await prepareNovaAction('Send this via Teams', 'Verified report', state, f.host);
  assert.equal(shared?.preview.target, 'team / channel');
  assert.equal(f.sends.length, 0);
});

it('recognizes report, message and provider-name variants for every connector', () => {
  for (const [channel, id] of [['WhatsApp Web','whatsapp-web'], ['Outlook','outlook'], ['Exchange Online','outlook'], ['email','outlook'], ['Microsoft Teams','teams'], ['Slack','slack'], ['Discord','discord'], ['Signal','signal']]) {
    for (const text of [`Can you send a ${channel} message`, `Send a message via ${channel}`, `Share this report through ${channel}`]) {
      assert.deepEqual(novaActionIntent(text), { kind: 'send', connectorId: id, self: false }, text);
    }
    assert.equal(novaActionIntent(`Send the list of non-compliant devices via ${channel}`)?.kind, 'send');
  }
  assert.equal(novaActionIntent('Send this to Alice via email'), undefined);
  assert.equal(novaActionIntent('Email this to Alice'), undefined);
  assert.deepEqual(novaActionIntent('Send the list of my devices via Teams'), { kind: 'send', connectorId: 'teams', self: false, question: 'Show the list of my devices' });
});

it('checks setup on every connector and does not misroute personal delivery to shared defaults', async () => {
  const f = fixture();
  for (const connector of f.connectors) {
    const channel = connector.descriptor.id === 'whatsapp-web' ? 'WhatsApp' : connector.descriptor.id;
    for (const status of ['needs-setup', 'needs-scope', 'error', 'unknown'] as const) {
      connector.status = status;
      await assert.rejects(prepareNovaAction(`send this via ${channel}`, 'Evidence', state, f.host), /Open Connectors/);
    }
    connector.status = 'connected';
  }
  for (const channel of ['Teams','Slack','Discord','Signal']) await assert.rejects(prepareNovaAction(`send this to my ${channel}`, 'Evidence', state, f.host), /private|personal/);
  assert.equal(f.sends.length, 0);
});

it('preserves long Unicode reports, discloses multiple messages, and sends distinct ordered parts', async () => {
  const f = fixture();
  const report = 'Device 🖥️ · non-compliant\n'.repeat(90);
  for (const channel of ['discord', 'slack', 'teams']) assert.equal(novaMessageParts(report.repeat(20), channel).join(''), report.repeat(20));
  const action = await prepareNovaAction('Send this via Discord', report, state, f.host);
  assert.match(action!.preview.deliveryNote!, /numbered messages/);
  assert.equal(action!.preview.body, report);
  await action!.execute(new AbortController().signal);
  const inputs = f.sends as Parameters<NovaActionHost['send']>[0][];
  assert.equal(new Set(inputs.map(i => i.actionId)).size, inputs.length);
  assert.equal(inputs.map(i => String(i.args.text).replace(/^\(\d+\/\d+\)\n/, '')).join(''), report);
  assert.ok(inputs.every(i => String(i.args.text).length <= 2000));
});

it('stops a partial send without retrying or claiming delivery', async () => {
  const f = fixture();
  let calls = 0;
  f.host.send = async () => { if (++calls === 2) throw new Error('Service unavailable'); };
  const action = await prepareNovaAction('Send this via Discord', 'x'.repeat(5000), state, f.host);
  await assert.rejects(action!.execute(new AbortController().signal), /1 of 3 messages confirmed accepted.*Remaining messages were stopped/);
  assert.equal(calls, 2);
});
