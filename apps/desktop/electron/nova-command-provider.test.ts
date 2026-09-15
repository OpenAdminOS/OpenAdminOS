import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStateStore } from './state.js';

it('uses only the pinned reasoning provider for classification and rejects scope changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-command-provider-'));
  const filePath = join(dir, 'state.json');
  await writeFile(filePath, JSON.stringify({ activeTenantId: 'test', activeProviderId: 'ollama', installedAgents: [], runs: [], tenants: [{ id: 'test', displayName: 'Test tenant', homeAccountId: 'test', addedAt: new Date().toISOString() }] }));
  let local = true;
  const calls: unknown[] = [];
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: '',
    tokenStore: { read: async () => '', write: async () => {} },
    providerListFactory: () => [{ id: 'ollama', name: 'Ollama', isLocal: local, status: 'connected', models: ['test'], defaultModel: 'test' } as never],
    llmFactory: (provider, model) => ({ available: true, complete: async options => {
      calls.push({ provider, model, options });
      assert.equal(options.signal?.aborted, false);
      assert.equal(options.maxTokens, 400);
      assert.doesNotMatch(options.prompt, /Test tenant|homeAccountId|deviceName/);
      return { text: '{"kind":"navigate","page":"connectors"}', model: 'test' };
    }, async *stream() { throw new Error('Unexpected stream'); } }),
    graphFactory: () => { throw new Error('Classification must not query Graph'); },
  });
  const scope = { tenantId: 'test', providerId: 'ollama' as const, model: 'test', isLocal: true };
  const context = { agents: [] };
  const options = { scope, signal: new AbortController().signal };
  try {
    assert.equal(await store.classifyNovaCommand('Bring up the integrations', context, options), '{"kind":"navigate","page":"connectors"}');
    assert.equal((calls[0] as any).provider, 'ollama');
    assert.equal((calls[0] as any).model, 'test');
    await assert.rejects(store.classifyNovaCommand('Send it', context, { ...options, scope: { ...scope, tenantId: 'other' } }), /changed/);
    await assert.rejects(store.classifyNovaCommand('Send it', context, { ...options, scope: { ...scope, model: 'other' } }), /changed/);
    await assert.rejects(store.classifyNovaCommand('x'.repeat(12000), context, options), /input budget/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(store.classifyNovaCommand('Send it', context, { ...options, signal: cancelled.signal }), /abort/i);
    local = false;
    await assert.rejects(store.classifyNovaCommand('Send it', context, options), /changed/);
    assert.equal(calls.length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
