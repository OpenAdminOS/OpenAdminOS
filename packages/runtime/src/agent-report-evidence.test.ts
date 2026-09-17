import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSummary, RunGraphApi, RunLlmApi } from '@openadminos/agent-sdk';
import { createQueuedRun, executeRun } from './index.js';

for (const slug of ['dormant-app-registrations', 'tenant-change-audit']) {
  test(`${slug} preserves full counts while limiting oversized report evidence`, async () => {
    const records = Array.from({ length: 120 }, (_, i) => ({
      id: String(i), displayName: `App ${i}`, createdDateTime: '2020-01-01T00:00:00Z',
      activityDateTime: '2026-09-15T00:00:00Z', activityDisplayName: 'Update application',
      signInAudience: 'AzureADMyOrg', publisherDomain: 'example.test', category: 'ApplicationManagement', result: 'success',
      notes: i === 0 ? 'x'.repeat(100_000) : 'Review ownership',
      targetResources: i === 0 ? [{ modifiedProperties: [{ newValue: 'y'.repeat(100_000) }] }] : [],
    }));
    const agent = { id: slug, slug, name: slug, description: 'Evidence budget test', installedAt: new Date().toISOString(), requiresEntraTier: 'free', author: { name: 'Test', verified: false }, mode: 'read', category: 'apps', tier: 'agent', scopes: [], version: '1.1.1', registryPath: resolve(fileURLToPath(new URL('../../../agents/', import.meta.url)), slug) } as AgentSummary;
    let prompt = '';
    const llm = { available: true, complete: async () => ({ text: 'Reviewed.', model: 'test' }), async *stream(p: { prompt: string }) { prompt = p.prompt; yield { delta: 'Reviewed.', accumulated: 'Reviewed.', model: 'test', done: true }; } } as RunLlmApi;
    const graph = { request: async () => ({ value: records }) } as unknown as RunGraphApi;
    const completed = await executeRun({ run: createQueuedRun({ agent, providerId: 'ollama' }), agent, providerId: 'ollama', llm, createGraph: () => graph, onProgress: () => {} });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal((completed.result as { total: number }).total, records.length);
    assert.ok(prompt.length < 10_000, `Prompt has ${prompt.length} characters`);
    assert.match(prompt, /"coverage":"partial/);
    assert.match(prompt, /"omittedRecords":[1-9]/);
    assert.doesNotMatch(prompt, /x{1000}|y{1000}/);
    if (slug === 'dormant-app-registrations') assert.match(prompt, /Created 3y\+ ago: 120/);
  });
}
