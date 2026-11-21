import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStateStore } from './state.js';
import type { RequestClassificationEvent } from '@openadminos/runtime/data-classification';

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
    const firstObservation = new Promise<void>(resolve => {
      const off = store.observeRequestClassifications(() => { off(); resolve(); });
    });
    assert.equal(await store.classifyNovaCommand('Bring up the integrations', context, options), '{"kind":"navigate","page":"connectors"}');
    await firstObservation;
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
    local = true;
    const cache = store["requireIntelligenceStore"]();
    await cache.waitForCacheClassification();
    cache.replaceGraphResources({ tenantId: 'test', resource: 'users', label: 'Users', scopeSet: [],
      refreshedAt: '2026-11-19T00:00:00Z', rows: [{ id: 'synthetic-user', displayName: 'Yelena Fixture' }] });
    const previousRequest = 'What is going on with Yelena Fixture?';
    const observed = new Promise<RequestClassificationEvent>(resolve => {
      const off = store.observeRequestClassifications(event => {
        if (!event.scopePresent) return;
        off();
        resolve(event);
      });
    });
    await store.classifyNovaCommand('Take care of things', { agents: [], previousRequest }, options);
    const event = await observed;
    const { options: { prompt } } = calls.at(-1) as { options: { prompt: string } };
    assert.equal(prompt, JSON.stringify({ currentRequest: 'Take care of things', previousRequest, agents: [] }));
    assert.ok(event.classification.spans.some(span => span.section === 'prompt' && span.kind === 'identity' &&
      prompt.slice(span.start, span.end) === 'Yelena Fixture'));
    assert.ok(event.classification.unexamined.ranges.some(range => range.section === 'prompt' &&
      range.reason === 'history-evidence-unavailable' && prompt.slice(range.start, range.end) === JSON.stringify(previousRequest)));
    assert.equal(event.classification.effectiveClass, 'credential');
    assert.ok(store.getRequestClassifications().includes(event));
    await store.disconnectTenant('test');
    assert.deepEqual(store.getRequestClassifications(), []);

  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
