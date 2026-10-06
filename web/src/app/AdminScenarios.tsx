"use client";

import Link from "next/link";
import { useState } from "react";

const scenarios = [
  {
    title: "Find stale devices", category: "Device hygiene", mode: "Read-only investigation",
    question: "Which devices have not checked in during the last 30 days?",
    answer: "Three devices need a closer look.",
    description: "Check the last sync, ownership, and compliance evidence before deciding what to do next.",
    columns: ["Device", "Last sync", "Compliance"],
    rows: [["WIN-FINANCE-042", "46 days ago", "Noncompliant"], ["MACBOOK-AUDIT-17", "38 days ago", "Compliant"], ["SURFACE-FIELD-31", "32 days ago", "Unknown"]],
    sources: ["Intune managed devices", "Entra devices"],
    next: "Inspect the evidence before preparing a change.", href: "/examples", link: "Explore device prompts",
  },
  {
    title: "Investigate a sign-in", category: "Identity & access", mode: "Read-only investigation",
    question: "Why was this user's sign-in blocked?",
    answer: "Follow the sign-in back to its policy.",
    description: "Bring the sign-in result and Conditional Access evidence together, with the source records available for review.",
    columns: ["Evidence", "Result", "Source"],
    rows: [["Sign-in", "Blocked", "Sign-in logs"], ["Device state", "Not compliant", "Intune"], ["Policy requirement", "Compliant device", "Conditional Access"]],
    sources: ["Entra sign-in logs", "Conditional Access policies"],
    next: "Understand the policy before changing access.", href: "/examples", link: "Explore identity prompts",
  },
  {
    title: "Review a proposed change", category: "Controlled action", mode: "Human approval required",
    question: "Prepare to retire the stale devices we reviewed.",
    answer: "A proposal is ready. Nothing has changed.",
    description: "Inspect each target and proposed operation. A destructive action needs a typed confirmation before it can run.",
    columns: ["Target", "Proposed action", "State"],
    rows: [["WIN-FINANCE-042", "Retire", "Awaiting review"], ["MACBOOK-AUDIT-17", "Retire", "Awaiting review"], ["SURFACE-FIELD-31", "Retire", "Awaiting review"]],
    sources: ["Declared agent scopes", "Proposed Graph operations"],
    next: "You review the diff. You decide whether to proceed.", href: "/trust-model", link: "Read the approval rules",
  },
];

export function AdminScenarios() {
  const [selected, setSelected] = useState(0);
  const scenario = scenarios[selected]!;
  return (
    <section id="admin-workflows" className="home-section scroll-mt-8" aria-labelledby="scenario-heading">
      <div className="home-section-heading">
        <div><p className="home-eyebrow">01 / From question to evidence</p><h2 id="scenario-heading">Start with the work<br className="hidden sm:block" /> on your desk.</h2></div>
        <p>Investigate devices, explain access decisions, and prepare changes. Keep the tenant context and supporting records together.</p>
      </div>
      <div className="scenario-layout">
        <div className="scenario-options" role="group" aria-label="Example admin workflows">
          {scenarios.map((item, index) => (
            <button key={item.title} type="button" aria-pressed={selected === index} aria-controls="scenario-result" onClick={() => setSelected(index)} className="scenario-option">
              <span className="font-mono text-xs opacity-70">0{index + 1} / {item.category}</span>
              <span className="mt-2 flex items-center justify-between gap-3 text-lg font-semibold">{item.title}<span aria-hidden="true">↗</span></span>
            </button>
          ))}
          <p className="px-1 text-xs leading-5 text-brand-muted">Illustrative workflows with synthetic data. Available evidence depends on your tenant permissions.</p>
        </div>
        <div id="scenario-result" className="scenario-result" aria-live="polite" aria-atomic="true">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-ink/10 pb-5"><span className="font-mono text-xs text-brand-muted">EXAMPLE / CONTOSO</span><span className="rounded-full bg-brand-bg px-3 py-1 text-xs font-medium">{scenario.mode}</span></div>
          <p className="scenario-question">“{scenario.question}”</p>
          <h3 className="mt-6 text-xl font-semibold tracking-tight">{scenario.answer}</h3>
          <p className="mt-2 max-w-xl text-sm leading-6 text-brand-muted">{scenario.description}</p>
          <div className="mt-6 overflow-x-auto rounded-lg bg-brand-bg p-1">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead><tr>{scenario.columns.map(column => <th key={column} scope="col" className="px-3 py-3 font-medium text-brand-muted">{column}</th>)}</tr></thead>
              <tbody>{scenario.rows.map(row => <tr key={row[0]} className="border-t border-brand-ink/10">{row.map((cell, index) => <td key={index} className={`px-3 py-3 ${index === 0 ? "font-mono text-[11px] sm:text-xs" : ""}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-brand-muted"><span>Sources</span>{scenario.sources.map(source => <span key={source} className="rounded-md border border-brand-ink/15 px-2 py-1">{source}</span>)}</div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-brand-ink/10 pt-5"><p className="max-w-sm text-xs leading-5 text-brand-muted">{scenario.next}</p><Link href={scenario.href} className="home-text-link">{scenario.link} <span aria-hidden="true">↗</span></Link></div>
        </div>
      </div>
    </section>
  );
}
