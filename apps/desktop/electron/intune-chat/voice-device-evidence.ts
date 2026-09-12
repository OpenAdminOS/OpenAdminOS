import { graphCacheRequestFromNextLink } from "../state-helpers.js";
import { randomUUID } from "node:crypto";
import type { GraphCacheResourceStatus, IntuneChatToolTraceEntry } from '@openadminos/agent-sdk';
import type { IntuneChatToolContext } from './tools.js';

export function voiceDeviceEvidenceIntent(question: string): 'compliance' | 'encryption' | 'causes' | undefined {
  const q = question.toLowerCase().trim().replace(/non[ -]compliant/g, 'noncompliant')
    .replace(/^(?:stop[,.!]?\s+)?(?:can|could|would) you (?:please )?(?:tell me )?/, '')
    .replace(/^(?:please |tell me )/, '').replace(/[?.!]+$/, '').trim();
  if (/^(?:why (?:they|these devices|those devices|my devices|the devices) (?:are|are marked)|why are (?:they|these devices|those devices|my devices|the devices)) noncompliant$/.test(q)) return 'causes';
  if (/^(?:(?:list|show)(?: me)? (?:the )?devices (?:that |which )?(?:are )?|which (?:of my )?devices are )noncompliant$/.test(q)) return 'compliance';
  if (/^(?:(?:list|show)(?: me)? (?:the )?devices (?:that |which )?(?:are )?|which (?:of my )?devices are )(?:not encrypted|unencrypted)$/.test(q)) return 'encryption';
  return undefined;
}

/** Render verified fields directly. No model can invent causal explanations on this path. */
export async function voiceDeviceEvidenceAnswer(question: string, statuses: GraphCacheResourceStatus[], ctx: IntuneChatToolContext, progress: (message: string) => void, trace?: (entry: IntuneChatToolTraceEntry) => void): Promise<string | undefined> {
  const kind = voiceDeviceEvidenceIntent(question);
  if (!kind) return undefined;
  const status = statuses.find(s => s.resource === 'managedDevices');
  if (!status?.refreshedAt) return 'Device inventory is unavailable. Open Cache to resolve the connection or permission error; I cannot establish which devices match.';
  const result = ctx.store.queryGraphCache({ tenantId: ctx.tenantId, resource: 'managedDevices', limit: 50,
    filters: [{ field: kind === 'encryption' ? 'isEncrypted' : 'complianceState', op: 'eq', value: kind === 'encryption' ? false : 'noncompliant' }] });
  trace?.({ id: randomUUID(), tool: "query_cache", params: { resource: "managedDevices", where: kind === "encryption" ? { isEncrypted: false } : { complianceState: "noncompliant" }, limit: 50 }, resultSummary: `${result.returnedRows} of ${result.totalCount} matching rows; snapshot ${status.refreshedAt}`, durationMs: 0, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  const rows = result.rows.map(r => r.row as Record<string, unknown>);
  const partial = status.pageLimitReached || (status.tenantTotal !== undefined && status.rows < status.tenantTotal);
  const prefix = `Intune snapshot refreshed ${status.refreshedAt}: ${status.rows} cached device records${partial ? '; coverage is partial' : ''}.${status.lastError ? ' The latest refresh failed; this is older evidence.' : ''}`;
  const label = kind === 'encryption' ? 'report not encrypted' : 'are marked non-compliant';
  progress(`Reading reported ${kind === 'encryption' ? 'encryption' : 'compliance'}: ${result.returnedRows} of ${result.totalCount} matching cached devices.`);
  if (kind !== 'causes') {
    const names = rows.map(r => String(r.deviceName || r.id || 'Unnamed device'));
    const unknown = kind === 'encryption' ? ' Missing encryption values are unknown, not counted as unencrypted.' : '';
    return `${prefix}\n${result.totalCount} ${label}.${unknown}${result.totalCount > rows.length ? ` Showing the first ${rows.length}; this is not the complete list.` : ''}\n${names.map(n => `- ${n}`).join('\n')}`;
  }
  const lines = [prefix, `${result.totalCount} devices are marked non-compliant. Causes below come from live policy setting states checked ${new Date().toISOString()}, not inferred from inventory fields.`];
  let graph: Awaited<ReturnType<IntuneChatToolContext['graphForScopes']>>;
  try { graph = await ctx.graphForScopes(['DeviceManagementConfiguration.Read.All']); }
  catch { ctx.signal?.throwIfAborted(); return `${prefix} I cannot read compliance policy details with this connection. Check DeviceManagementConfiguration.Read.All consent in tenant settings. The causes remain unverified.`; }
  const readCollection = async (path: string) => {
    const found: Record<string, unknown>[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < 10; page++) {
      ctx.signal?.throwIfAborted();
      const request = next.startsWith('https:') ? graphCacheRequestFromNextLink(next, undefined) : { path: next };
      const started = Date.now();
      const entry: IntuneChatToolTraceEntry = { id: randomUUID(), tool: 'graph_get', params: request, resultSummary: '', durationMs: 0, createdAt: new Date().toISOString(), completedAt: '' };
      let response: Record<string, unknown>;
      try {
        response = await graph.request({ method: 'GET', ...request, signal: ctx.signal }) as Record<string, unknown>;
        entry.resultSummary = `${Array.isArray(response?.value) ? response.value.length : 0} policy setting/state records returned`;
      } catch (error) { entry.error = error instanceof Error ? error.message : 'Graph query failed'; throw error; }
      finally { entry.durationMs = Date.now() - started; entry.completedAt = new Date().toISOString(); trace?.(entry); }
      if (!Array.isArray(response.value)) throw new Error('Graph did not return a policy-state collection.');
      found.push(...response.value);
      if (found.length > 1000) throw new Error('Policy details exceed the per-device review limit.');
      const link: unknown = response['@odata.nextLink'];
      if (link !== undefined && (typeof link !== 'string' || !link.startsWith('https://graph.microsoft.com/beta/deviceManagement/managedDevices/'))) throw new Error('Graph returned an unexpected continuation link.');
      next = typeof link === 'string' ? link : undefined;
    }
    if (next) throw new Error('Policy details are incomplete after ten pages.');
    return found;
  };
  const selected = rows.slice(0, 10);
  if (result.totalCount > selected.length) lines.push(`Investigating the first ${selected.length} of ${result.totalCount} devices; remaining causes are not checked.`);
  for (const device of selected) {
    ctx.signal?.throwIfAborted();
    const name = String(device.deviceName || device.id || 'Unnamed device');
    progress(`Reading failed compliance settings for ${name}.`);
    try {
      if (typeof device.id !== 'string') throw new Error('The cached record has no device ID.');
      const path = `/deviceManagement/managedDevices/${encodeURIComponent(device.id)}/deviceCompliancePolicyStates`;
      const policies = await readCollection(path);
      const failed: string[] = [];
      for (const policy of policies) {
        if (typeof policy.id !== 'string') throw new Error('A policy state has no ID.');
        const settings = await readCollection(`${path}/${encodeURIComponent(policy.id)}/settingStates`);
        for (const setting of settings) if (String(setting.state).toLowerCase() === 'noncompliant')
          failed.push(`${String(policy.displayName || 'Compliance policy')}: ${String(setting.settingName || setting.setting || 'Unnamed failed setting')}`);
      }
      lines.push(`- ${name}: ${failed.length ? failed.join('; ') : 'No failed setting was returned. The reason is unverified; I will not infer one from OS, encryption or retirement status.'}`);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      lines.push(`- ${name}: reason unavailable (${error instanceof Error ? error.message : 'policy query failed'}). Check device compliance details and permissions in Intune.`);
    }
  }
  return lines.join('\n');
}
