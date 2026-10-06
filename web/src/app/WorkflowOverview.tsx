import Link from "next/link";

export function WorkflowOverview() {
  return (
    <section className="home-section" aria-labelledby="workflow-heading">
      <div className="home-section-heading"><div><p className="home-eyebrow">02 / Built around your workstation</p><h2 id="workflow-heading">A clear path.<br />At every step.</h2></div><p>Connect your tenant, choose your model, and see exactly what an agent is allowed to do.</p></div>
      <div className="workflow-grid">
        <article className="workflow-local">
          <div className="flex items-center justify-between gap-3"><span className="home-eyebrow">Your data boundary</span><span className="rounded-full bg-emerald-800/10 px-3 py-1 text-xs font-medium text-emerald-800">Local provider selected</span></div>
          <div className="data-route" aria-label="Microsoft Graph supplies tenant data to OpenAdminOS; the local model processes it on the same device.">
            <div className="data-source"><span aria-hidden="true">↙</span><strong>Microsoft Graph</strong><small>Your selected tenant</small></div>
            <span className="data-route-arrow" aria-hidden="true">↓</span>
            <div className="device-boundary"><span className="font-mono text-[10px] uppercase tracking-widest text-brand-muted">On your device</span><div className="mt-4 flex items-center justify-center gap-4"><strong>OpenAdminOS</strong><span aria-hidden="true">↔</span><strong>Local model</strong></div><p className="mt-4 text-xs text-brand-muted">Prompts · tenant context · results</p></div>
          </div>
          <h3 className="mt-7 text-xl font-semibold">Choose where the model runs.</h3><p className="mt-3 max-w-lg text-sm leading-6 text-brand-muted">Ollama and LM Studio process context locally. Hosted providers are optional; the app tells you when context goes to the selected provider.</p><Link href="/llm-providers" className="home-text-link mt-5">Compare providers <span aria-hidden="true">↗</span></Link>
        </article>
        <article className="workflow-detail"><p className="home-eyebrow">Know the permissions</p><div className="manifest-preview"><div className="flex items-center justify-between gap-3"><span>Find inactive devices</span><span className="rounded bg-emerald-800/10 px-2 py-1 text-[10px] text-emerald-800">READ</span></div><div className="mt-4 border-t border-brand-ink/10 pt-4 text-xs text-brand-muted">Declared Graph scope</div><code className="mt-2 block break-all text-xs">DeviceManagementManagedDevices.Read.All</code></div><h3 className="mt-6 text-xl font-semibold">Inspect before you install.</h3><p className="mt-3 text-sm leading-6 text-brand-muted">Every agent declares its scopes, read or write mode, and model requirements. Use the community registry or your own curated source.</p><Link href="/registry" className="home-text-link mt-5">Browse agents <span aria-hidden="true">↗</span></Link></article>
        <article className="workflow-detail"><p className="home-eyebrow">Keep the context</p><ol className="run-trail" aria-label="Example run record"><li><span aria-hidden="true">✓</span> Tenant scope recorded</li><li><span aria-hidden="true">✓</span> Evidence and results saved locally</li><li><span aria-hidden="true">→</span> Proposed changes wait for review</li></ol><h3 className="mt-6 text-xl font-semibold">Return to the evidence.</h3><p className="mt-3 text-sm leading-6 text-brand-muted">Keep investigations in workspaces and revisit local run history. Your next question starts with context, not a blank page.</p><Link href="/trust-model" className="home-text-link mt-5">Explore the trust model <span aria-hidden="true">↗</span></Link></article>
      </div>
    </section>
  );
}
