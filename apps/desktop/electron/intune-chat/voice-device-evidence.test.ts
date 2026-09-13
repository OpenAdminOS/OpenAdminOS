import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { GraphCacheResourceStatus } from '@openadminos/agent-sdk';
import type { IntuneChatToolContext } from './tools.js';
import { voiceDeviceEvidenceAnswer, voiceDeviceEvidenceIntent } from './voice-device-evidence.js';
const status = [{ resource: 'managedDevices', refreshedAt: '2026-09-12T10:00:00Z', rows: 9 }] as GraphCacheResourceStatus[];
function fixture(request: (input: any) => Promise<unknown>) {
  const reads: any[] = [];
  const ctx = { tenantId: 'test', store: { queryGraphCache: (input: any) => { reads.push(input); return { totalCount: 1, returnedRows: 1, rows: [{ row: { id: 'device-1', deviceName: 'Test device', isEncrypted: false, complianceState: 'noncompliant' } }] }; } }, graphForScopes: async () => ({ request }) } as unknown as IntuneChatToolContext;
  return { ctx, reads };
}
it('recognizes the actual transcript without silently dropping OS or ownership filters', () => {
  assert.equal(voiceDeviceEvidenceIntent('Can you tell me which devices are non-compliant'), 'compliance');
  assert.equal(voiceDeviceEvidenceIntent('Can you list the devices that are not encrypted'), 'encryption');
  assert.equal(voiceDeviceEvidenceIntent('Can you tell me why they are non-compliant'), 'causes');
  assert.equal(voiceDeviceEvidenceIntent('List Windows devices that are non-compliant'), undefined);
  assert.equal(voiceDeviceEvidenceIntent('List devices that are not encrypted in group Sales'), undefined);
});
it('lists only explicitly reported false encryption and retains freshness and truncation caveats', async () => {
  const f = fixture(async () => { throw new Error('Unexpected network'); });
  const text = await voiceDeviceEvidenceAnswer('List devices that are not encrypted', status, f.ctx, () => {});
  assert.equal(f.reads[0].filters[0].value, false);
  assert.match(text!, /1 report not encrypted/); assert.match(text!, /unknown/); assert.match(text!, /2026-09-12/);
});
it('reads paged failed policy settings and never substitutes guessed encryption or OS causes', async () => {
  const paths: string[] = [];
  const f = fixture(async ({ path, query }) => {
    paths.push(path);
    if (path.endsWith('/deviceCompliancePolicyStates')) return { value: [{ id: 'policy', displayName: 'Default compliance' }] };
    if (!query) return { value: [], '@odata.nextLink': 'https://graph.microsoft.com/beta/deviceManagement/managedDevices/device-1/deviceCompliancePolicyStates/policy/settingStates?$skiptoken=next' };
    return { value: [{ settingName: 'RequireRemainContact', state: 'nonCompliant' }] };
  });
  const traces: unknown[] = [];
  const text = await voiceDeviceEvidenceAnswer('Why are they non-compliant?', status, f.ctx, () => {}, t => traces.push(t));
  assert.match(text!, /RequireRemainContact/); assert.doesNotMatch(text!, /missing encryption|outdated/);
  assert.equal(paths.length, 3); assert.equal(traces.length, 4);
  assert.ok(paths.every(p => p.startsWith('/deviceManagement/')));
});
it('reports unavailable causes when policy settings fail or are absent', async () => {
  for (const fail of [true, false]) {
    const f = fixture(async () => { if (fail) throw new Error('HTTP 403'); return { value: [] }; });
    const text = await voiceDeviceEvidenceAnswer('Why are they non-compliant?', status, f.ctx, () => {});
    assert.match(text!, fail ? /reason unavailable.*403/ : /reason is unverified/);
  }
});
