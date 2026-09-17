import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStateStore } from './state.js';
import { NovaService } from './nova.js';

it('answers the reported fleet conversation through real SQLite and prepares the resulting report without an LLM or send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-device-workflow-'));
  const filePath = join(dir, 'state.json');
  await writeFile(filePath, JSON.stringify({ activeTenantId: 'test', activeProviderId: 'ollama', installedAgents: [], runs: [], tenants: [{ id: 'test', displayName: 'Test tenant', username: 'admin@example.test', homeAccountId: 'test', addedAt: new Date().toISOString() }] }));
  let modelCalls = 0, sends = 0;
  const requests: string[] = [];
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: '',
    tokenStore: { read: async () => '', write: async () => {} },
    providerListFactory: () => [{ id: 'ollama', name: 'Ollama', isLocal: true, status: 'connected', models: ['test'], defaultModel: 'test' } as never],
    llmFactory: () => ({ available: true, complete: async () => { modelCalls++; throw new Error('Must not guess'); }, async *stream() { modelCalls++; throw new Error('Must not guess'); } }),
    graphFactory: () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => { throw new Error('Unexpected write'); }, request: async input => {
      assert.equal(input.method, 'GET'); requests.push(input.path);
      if (input.path === '/deviceManagement/managedDevices') return { value: [
        { id: 'one', deviceName: 'Device A', complianceState: 'noncompliant', isEncrypted: false },
        { id: 'two', deviceName: 'Device B', complianceState: 'compliant', isEncrypted: true },
        { id: 'three', deviceName: 'Device C', complianceState: 'noncompliant', isEncrypted: null },
      ] };
      if (input.path.endsWith('/deviceCompliancePolicyStates')) return { value: [{ id: 'policy', displayName: 'Compliance policy' }] };
      if (input.path.endsWith('/settingStates')) return { value: [{ settingName: 'RequireRemainContact', state: 'nonCompliant' }] };
      throw new Error(`Unexpected endpoint: ${input.path}`);
    } }),
  });
  try {
    const nova = new NovaService({ get: async () => undefined, set: async () => {}, remove: async () => {} }, () => store.getAppState(),
      (input, options) => store.streamIntuneChatMessage(input, event => options.onEvent?.(event), { ...options, voice: true }), fetch,
      { connectors: async () => [{ descriptor: { id: 'whatsapp-web', name: 'WhatsApp' }, config: {} } as never, { descriptor: { id: 'outlook', name: 'Outlook' }, status: 'connected', config: { defaultRecipients: 'admin@example.test' } } as never, { descriptor: { id: 'teams', name: 'Teams' }, status: 'connected', config: { defaultTeamId: 'team', defaultTeamName: 'Test team', defaultChannelId: 'channel', defaultChannelName: 'General' } } as never], send: async () => { sends++; }, startRun: (...args) => store.startRun(...args) });
    const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'test', consent: false });
    const ask = (text: string) => nova.handle({ action: 'answer', sessionId: sessionId!, text });
    const combined = await ask('Can you send me an email with the list of non-compliant devices');
    assert.equal(combined.pendingAction?.target, 'admin@example.test');
    assert.match(combined.pendingAction!.body, /2 devices are marked non-compliant/);
    assert.match(combined.pendingAction!.body, /Device A/);
    assert.match(combined.pendingAction!.body, /Device C/);
    assert.equal(sends, 0);
    const personalTeams = await ask('Can you send me a Teams message');
    assert.match(personalTeams.text!, /shared destinations/);
    assert.match(personalTeams.text!, /Test team \/ General/);
    const teams = await ask('Send this via Teams');
    assert.equal(teams.pendingAction?.target, 'Test team / General');
    assert.equal(teams.pendingAction?.body, combined.pendingAction?.body);
    const noncompliant = await ask('Can you tell me which devices are non-compliant');
    assert.match(noncompliant.text!, /2 devices are marked non-compliant/); assert.match(noncompliant.text!, /Device A/); assert.match(noncompliant.text!, /Device C/);
    const why = await ask('Can you tell me why they are non-compliant');
    assert.match(why.text!, /RequireRemainContact/); assert.doesNotMatch(why.text!, /missing encryption/);
    const encrypted = await ask('Can you list the devices that are not encrypted');
    assert.match(encrypted.text!, /1 device reports not encrypted/); assert.match(encrypted.text!, /Device A/); assert.doesNotMatch(encrypted.text!, /Device C/);
    const preview = await ask('Send this to my WhatsApp');
    assert.match(preview.pendingAction!.body, /Device A/); assert.match(preview.pendingAction!.body, /unknown/);
    assert.equal(modelCalls, 0); assert.equal(sends, 0);
    assert.equal(requests.filter(p => p === '/deviceManagement/managedDevices').length, 1, 'reuse the populated snapshot');
    assert.equal(requests.filter(p => p.endsWith('/settingStates')).length, 2);
    await nova.handle({ action: 'stop' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
