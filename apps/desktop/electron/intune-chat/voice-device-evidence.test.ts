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
  assert.equal(voiceDeviceEvidenceIntent('List Windows devices that are non-compliant'), 'compliance');
  assert.equal(voiceDeviceEvidenceIntent('List devices that are not encrypted in group Sales'), undefined);
});
it('lists only explicitly reported false encryption and retains freshness and truncation caveats', async () => {
  const f = fixture(async () => { throw new Error('Unexpected network'); });
  const text = await voiceDeviceEvidenceAnswer('List devices that are not encrypted', status, f.ctx, () => {});
  assert.equal(f.reads[0].filters[0].value, false);
  assert.match(text!, /1 device reports not encrypted/); assert.match(text!, /unknown/); assert.match(text!, /2026-09-12/);
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

it('renders actual rows for list wording instead of asking the model to summarize unseen rows', async () => {
  const f = fixture(async () => { throw new Error('Unexpected Graph call'); });
  for (const question of ['Show all the non-compliant devices as a list', 'list of non-compliant devices', 'List noncompliant devices', 'Show the list of non-compliant devices']) {
    assert.equal(voiceDeviceEvidenceIntent(question), 'compliance', question);
    const answer = await voiceDeviceEvidenceAnswer(question, status, f.ctx, () => {});
    assert.match(answer!, /- Test device/);
    assert.doesNotMatch(answer!, /refer to.*rows/);
  }
  for (const question of ['List non-compliant devices except Windows', 'Show all the non-compliant devices in Sales as a list']) assert.equal(voiceDeviceEvidenceIntent(question), undefined);
});

// Real SQLite predicates, mixed populations and tenant isolation, not a row-returning stub.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntelligenceSqliteStore } from './sqlite-store.js';
it('answers encryption and compliance lists/counts across platforms using actual matching rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-evidence-matrix-'));
  const store = new IntelligenceSqliteStore(join(dir, 'cache.db'));
  const rows = [
    { id: 'w-false', deviceName: 'WIN-FALSE', operatingSystem: 'Windows', isEncrypted: false, complianceState: 'noncompliant' },
    { id: 'w-true', deviceName: 'WIN-TRUE', operatingSystem: 'Windows', isEncrypted: true, complianceState: 'compliant' },
    { id: 'w-null', deviceName: 'WIN-NULL', operatingSystem: 'Windows', isEncrypted: null, complianceState: 'inGracePeriod' },
    { id: 'w-missing', deviceName: 'WIN-MISSING', operatingSystem: 'Windows', complianceState: 'unknown' },
    { id: 'm-false', deviceName: 'MAC-FALSE', operatingSystem: 'macOS', isEncrypted: false, complianceState: 'noncompliant' },
    { id: 'a-true', deviceName: 'ANDROID-TRUE', operatingSystem: 'Android', isEncrypted: true, complianceState: 'compliant' },
  ];
  for (const tenantId of ['test', 'other']) store.replaceGraphResources({ tenantId, resource: 'managedDevices', label: 'Devices', scopeSet: [], refreshedAt: status[0]!.refreshedAt!, rows: tenantId === 'test' ? rows : [{ ...rows[0], deviceName: 'OTHER-TENANT' }] });
  const ctx = { ...fixture(async () => { throw Error('Unexpected live read'); }).ctx, store };
  const matrix: Array<[string, string[]]> = [
    ['Which Windows devices are not encrypted?', ['WIN-FALSE']],
    ['Show me unencrypted Windows devices', ['WIN-FALSE']],
    ['List Windows devices that are encrypted', ['WIN-TRUE']],
    ['Which Windows devices are with unknown encryption status?', ['WIN-NULL', 'WIN-MISSING']],
    ['List Windows devices with unknown encryption status', ['WIN-NULL', 'WIN-MISSING']],
    ['List macOS devices that are not encrypted', ['MAC-FALSE']],
    ['Which Android devices are encrypted?', ['ANDROID-TRUE']],
    ['List Windows devices that are non-compliant', ['WIN-FALSE']],
    ['Which Windows devices are compliant?', ['WIN-TRUE']],
    ['Which Windows devices are in grace period?', ['WIN-NULL']],
    ['List unencrypted devices', ['WIN-FALSE', 'MAC-FALSE']],
    ['Which Linux devices are unencrypted?', []],
  ];
  try {
    for (const [question, expected] of matrix) {
      const answer = await voiceDeviceEvidenceAnswer(question, status, ctx, () => {});
      assert.ok(answer, question);
      assert.deepEqual(answer.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)).sort(), expected.sort(), question);
      assert.doesNotMatch(answer, /OTHER-TENANT/);
    }
    for (const question of ['How many Windows devices are not encrypted?', 'How many unencrypted Windows devices do we have?']) {
      const answer = await voiceDeviceEvidenceAnswer(question, status, ctx, () => {});
      assert.match(answer!, /1 Windows device reports not encrypted/);
      assert.doesNotMatch(answer!, /- WIN/);
    }
    for (const question of ['List unencrypted Windows 11 devices', 'List unencrypted devices except Windows', 'List encrypted and noncompliant Windows devices', 'Retire unencrypted Windows devices']) assert.equal(voiceDeviceEvidenceIntent(question), undefined, question);
    for (const changed of [{ pageLimitReached: true }, { rows: 6, tenantTotal: 12 }, { lastError: 'HTTP 403' }]) {
      const answer = await voiceDeviceEvidenceAnswer('Which Linux devices are unencrypted?', [{ ...status[0]!, ...changed }], ctx, () => {});
      assert.match(answer!, /does not establish the current tenant-wide count/);
    }
    assert.match((await voiceDeviceEvidenceAnswer(matrix[0]![0], [], ctx, () => {}))!, /unavailable/);
    store.replaceGraphResources({ tenantId: 'test', resource: 'managedDevices', label: 'Devices', scopeSet: [], refreshedAt: status[0]!.refreshedAt!, rows: Array.from({ length: 55 }, (_, i) => ({ ...rows[0], id: String(i) })) });
    const capped = await voiceDeviceEvidenceAnswer(matrix[0]![0], [{ ...status[0]!, rows: 55 }], ctx, () => {});
    assert.match(capped!, /55 Windows devices/); assert.match(capped!, /first 50/);
    assert.equal(capped!.split('\n').filter(line => line.startsWith('- ')).length, 50);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
