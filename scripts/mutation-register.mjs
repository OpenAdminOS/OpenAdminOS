#!/usr/bin/env node
// The mutation register: known defects in the write and audit guards that
// the named tests must catch. Adapted from the approach of
// CopilotKit/OpenBot's scripts/mutation-register.ts (MIT).
//
// For each entry a run:
//   1. Finds the entry's `find` text in its file. It must occur exactly once
//      (after `anchor`, when one is given), or the entry is stale: the
//      guarded code changed and the entry must be re-quoted deliberately.
//   2. Runs the entry's tests unmutated, once per distinct test set. They
//      must pass, or a kill would prove nothing.
//   3. Runs the same tests with the mutation applied in memory by
//      scripts/mutation-register-hooks.mjs. No file is written. The hooks
//      leave a mark when they rewrote the module; no mark means the tests
//      never loaded the file, which is the register being wrong.
//   4. The mutant is killed when at least one test fails and the run still
//      reports as many tests as the unmutated run. A crash that loses tests
//      is not a kill.
//
// An entry whose mutant survives fails the run, unless it carries
// `survivesUntil` naming the finding that owns the missing test. An entry
// with `survivesUntil` whose mutant is killed also fails: the debt is paid,
// so remove the field and let the entry guard.
//
// Usage:
//   npm run test:mutations                 run every entry
//   npm run test:mutations -- <id> ...     run only the named entries
//   npm run test:mutations -- --list       print the register

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How far past its anchor the `find` text may start. */
export const ANCHOR_WINDOW = 600;

const RUN_TIMEOUT_MS = 300_000;

/**
 * @typedef {object} MutationEntry
 * @property {string} id Stable name, used on the command line and in the report.
 * @property {string} path Repo-relative source file the mutation applies to.
 * @property {string} [anchor] Text occurring exactly once that locates a repeated `find`.
 * @property {string} find Exact text the mutation replaces.
 * @property {string} replace What it is replaced with. It must still compile.
 * @property {string[]} tests Repo-relative test files, all in one workspace.
 * @property {string} why The defect this plants and what it would let through.
 * @property {string} [survivesUntil] Finding that owns a known missing test.
 */

/** @type {MutationEntry[]} */
export const REGISTER = [
  {
    id: "confirmation-phrase-accepts-lowercase",
    path: "packages/runtime/src/confirmation-phrase.ts",
    find: "if (!/^[A-Z][A-Z0-9 -]*$/.test(normalized)) {",
    replace: "if (!/^[A-Za-z][A-Za-z0-9 -]*$/.test(normalized)) {",
    tests: ["packages/runtime/src/confirmation-phrase.test.ts"],
    why: "A lowercase phrase is easy to type by accident; plans must use uppercase words.",
  },
  {
    id: "confirmation-phrase-drops-word-count",
    path: "packages/runtime/src/confirmation-phrase.ts",
    find: "if (normalized.length < 12 || normalized.split(/\\s+/).length < 3) {",
    replace: "if (normalized.length < 12) {",
    tests: ["packages/runtime/src/confirmation-phrase.test.ts"],
    why: "A phrase must name an operation, a count and a target noun, not one long word.",
  },
  {
    id: "confirmation-phrase-drops-count",
    path: "packages/runtime/src/confirmation-phrase.ts",
    find: "if (!/\\d/.test(normalized)) {",
    replace: "if (false) {",
    tests: ["packages/runtime/src/confirmation-phrase.test.ts"],
    why: "A phrase without the number of affected objects does not bind the admin to the plan's size.",
  },
  {
    id: "write-limit-allows-one-more-action",
    path: "packages/agent-sdk/src/write-limits.ts",
    find: "if (plan.actions.length > maxActions) {",
    replace: "if (plan.actions.length > maxActions + 1) {",
    tests: ["packages/runtime/src/write-limits.test.ts"],
    why: "The per-run action limit must refuse the first action over the limit.",
  },
  {
    id: "write-limit-allows-one-more-per-kind",
    path: "packages/agent-sdk/src/write-limits.ts",
    find: "if (total > limit) {",
    replace: "if (total > limit + 1) {",
    tests: ["packages/runtime/src/write-limits.test.ts"],
    why: "The per-operation limit must refuse the first action of a kind over its limit.",
  },
  {
    id: "dry-run-lets-writes-through",
    path: "packages/runtime/src/dry-run.ts",
    find: 'if (input.method !== "GET") throw new Error(DRY_RUN_WRITE_ERROR);',
    replace: 'if (input.method === "DELETE") throw new Error(DRY_RUN_WRITE_ERROR);',
    tests: ["packages/runtime/src/dry-run.test.ts"],
    why: "A dry run may only read the tenant; any method but GET must be refused.",
  },
  {
    id: "connector-confirmation-fails-open",
    path: "packages/runtime/src/connectors.ts",
    anchor: "if (!input.confirmInvocation) {",
    find: "approved: false,",
    replace: "approved: true,",
    tests: ["packages/runtime/src/connectors.test.ts"],
    why: "A connector write with no confirmation hook attached must be refused, not approved.",
  },
  {
    id: "confirm-run-folds-phrase-case",
    path: "apps/desktop/electron/runs.ts",
    find: "if (phrase !== run.plan.confirmationPhrase) {",
    replace: "if (phrase.trim().toUpperCase() !== run.plan.confirmationPhrase) {",
    tests: ["apps/desktop/electron/run-confirmation.test.ts"],
    why: "The typed phrase must match exactly, case and whitespace included.",
  },
  {
    id: "confirm-run-crosses-organization",
    path: "apps/desktop/electron/runs.ts",
    find: "if (boundary.activeOrganizationOnly && run.tenantId !== persisted.activeTenantId) {",
    replace: "if (boundary.activeOrganizationOnly && false) {",
    tests: ["apps/desktop/electron/organizations.test.ts"],
    why: "A plan prepared in another organization must not be applied while a different one is active.",
  },
  {
    id: "apply-ignores-plan-change-since-review",
    path: "apps/desktop/electron/runs.ts",
    find: "if (change.changed) throw new Error(planChangedSinceReviewCopy(",
    replace: "if (false) throw new Error(planChangedSinceReviewCopy(",
    tests: ["apps/desktop/electron/runs-revalidation.test.ts"],
    why: "A plan whose actions changed in the tenant since review must not be applied.",
  },
  {
    id: "apply-ignores-failed-revalidation",
    path: "apps/desktop/electron/runs.ts",
    find: 'if (fresh.status === "failed" || !fresh.plan) {',
    replace: 'if (fresh.status === "failed" || !fresh.plan) fresh.plan = input.plan;\n      if (false) {',
    tests: ["apps/desktop/electron/runs-revalidation.test.ts"],
    why: "A plan that could not be checked against the tenant before apply must not be applied as if it matched.",
  },
  {
    id: "revalidation-graph-lets-writes-through",
    path: "apps/desktop/electron/runs.ts",
    find: 'if (request.method !== "GET") throw new Error(PLAN_REVALIDATION_READ_ONLY_COPY);',
    replace: 'if (request.method === "DELETE") throw new Error(PLAN_REVALIDATION_READ_ONLY_COPY);',
    tests: ["apps/desktop/electron/runs-revalidation.test.ts"],
    why: "The replan before apply has no write authority; any method but GET must be refused before it is sent.",
  },
  {
    id: "revalidation-connector-lets-graph-writes-through",
    path: "apps/desktop/electron/runs.ts",
    find: 'if (method !== "GET" && isGraphHost(url.hostname)) {',
    replace: 'if (method === "DELETE" && isGraphHost(url.hostname)) {',
    tests: ["apps/desktop/electron/runs-revalidation.test.ts"],
    why: "A connector's own Graph client, such as Outlook's, must not send a write during the replan before apply.",
  },
  {
    id: "revalidation-keys-retire-by-request",
    path: "apps/desktop/electron/runs.ts",
    find: "return stableStringify({ kind: action.kind, deviceId: action.metadata?.deviceId ?? null });",
    replace: "return stableStringify(request ? { kind: action.kind, request } : { kind: action.kind, deviceId: action.metadata?.deviceId ?? null });",
    tests: ["apps/desktop/electron/runs-revalidation.test.ts"],
    why: "A retire acts on metadata.deviceId; keying it by a request it also carries would hide a swapped device.",
  },
  {
    id: "graph-write-sent-when-attempt-unrecorded",
    path: "packages/runtime/src/graph-adapter.ts",
    find: "throw new GraphWriteAuditError(method, path, cause);",
    replace: "void cause;",
    tests: ["packages/runtime/src/graph-adapter.test.ts"],
    why: "A Graph write whose attempt the audit log cannot record must not be sent.",
  },
  {
    id: "graph-write-sent-without-audit-sink",
    path: "packages/runtime/src/graph-adapter.ts",
    find: "throw new GraphWriteUnauditedError(method, path);",
    replace: "return sendGraphRequest<T>(input, exchange);",
    tests: ["packages/runtime/src/graph-adapter.test.ts"],
    why: "A Graph client with no audit sink must refuse writes unless unaudited writes were asked for.",
  },
  {
    id: "connector-graph-write-sent-when-attempt-unrecorded",
    path: "packages/runtime/src/graph-adapter.ts",
    find: "throw new GraphWriteAuditError(writeMethod, path, cause);",
    replace: "void cause;",
    tests: ["packages/runtime/src/graph-adapter.test.ts"],
    why: "An Outlook or Teams Graph send whose attempt the audit log cannot record must not leave the device.",
  },
  {
    id: "graph-host-keeps-trailing-dot",
    path: "packages/runtime/src/graph-adapter.ts",
    find: 'return GRAPH_HOSTS.has(name.endsWith(".") ? name.slice(0, -1) : name);',
    replace: "return GRAPH_HOSTS.has(name);",
    tests: ["packages/runtime/src/graph-adapter.test.ts"],
    why: "graph.microsoft.com. reaches Graph too; a write sent to it must still be audited and refused during the replan.",
  },
  {
    id: "gateway-accepts-any-token",
    path: "apps/desktop/electron/gateway/service.ts",
    find: "if (client.tokenHash && hashesEqual(presented, client.tokenHash)) match = client;",
    replace: "if (client.tokenHash) match = client;",
    tests: ["apps/desktop/electron/gateway/service.test.ts"],
    why: "Each gateway client is admitted only with its own token.",
  },
  {
    id: "gateway-names-another-client",
    path: "apps/desktop/electron/gateway/service.ts",
    find: 'if (match) return { kind: "client", client: { id: match.id, name: match.name } };',
    replace: 'if (match) return { kind: "client", client: { id: match.id, name: config.clients[0].name } };',
    tests: ["apps/desktop/electron/gateway/service.test.ts"],
    why: "A proposal carries the name of the client record its token belongs to, not another one.",
  },
  {
    id: "gateway-tool-skips-reauthorization",
    path: "apps/desktop/electron/gateway/server.ts",
    find: 'if (auth.kind === "client") return tool();',
    replace: "if (auth.kind || true) return tool();",
    tests: ["apps/desktop/electron/gateway/service.test.ts"],
    why: "A request authenticates from its headers before its body arrives; a client revoked meanwhile must not read or propose.",
  },
  {
    id: "gateway-reauthorizes-revoked-client",
    path: "apps/desktop/electron/gateway/service.ts",
    find: "const record = config.clients.find((candidate) => candidate.id === client.id && candidate.tokenHash);",
    replace: "const record = config.clients.find((candidate) => candidate.tokenHash) ?? { id: client.id, name: client.name };",
    tests: ["apps/desktop/electron/gateway/service.test.ts"],
    why: "A tool call is checked against the client records as they are now, so a revoke stops the call it lands in.",
  },
  {
    id: "audit-log-allows-update",
    path: "apps/desktop/electron/audit-log.ts",
    find: "CREATE TRIGGER audit_log_refuse_update BEFORE UPDATE ON audit_log\n",
    replace: "CREATE TRIGGER audit_log_refuse_update BEFORE UPDATE ON audit_log WHEN 0\n",
    tests: ["apps/desktop/electron/audit-log.test.ts"],
    why: "The audit log is append-only; the database must refuse a changed row.",
  },
  {
    id: "audit-log-skips-hash-check",
    path: "apps/desktop/electron/audit-log.ts",
    find: "if (chainHash(previous, row.event_json) !== row.sha256) {",
    replace: "if (false) {",
    tests: ["apps/desktop/electron/audit-log.test.ts"],
    why: "A row whose content no longer matches its hash must fail verification and block export.",
  },
  {
    id: "nova-run-skips-click-check",
    path: "apps/desktop/electron/nova-actions.ts",
    find: "      await requireNovaCapability(host, 'startAgents');\n      const run = await host.startRun(",
    replace: "      const run = await host.startRun(",
    tests: ["apps/desktop/electron/nova-capabilities.test.ts"],
    why: "Starting agents turned off after the card was prepared must stop the run at the click.",
  },
  {
    id: "nova-send-skips-click-check",
    path: "apps/desktop/electron/nova-actions.ts",
    anchor: "execute: outer => leased(host, tenantId, outer, async signal => {\n    await assertStillActive(host, tenantId);",
    find: "    await requireConnectorSend(host, intent.connectorId, connector.descriptor.name);\n    let accepted = 0;",
    replace: "    let accepted = 0;",
    tests: ["apps/desktop/electron/nova-capabilities.test.ts"],
    why: "A connector send turned off after the card was prepared must stop the send at the click.",
  },
  {
    id: "nova-note-stored-confirmed",
    path: "apps/desktop/electron/nova-memory.ts",
    find: "VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)",
    replace: "VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)",
    tests: ["apps/desktop/electron/nova-memory.test.ts", "apps/desktop/electron/nova-notes-followups.test.ts"],
    why: "A note Nova prepares waits for review; only the click confirms it.",
  },
  {
    id: "nova-prompt-reads-proposed-notes",
    path: "apps/desktop/electron/nova-memory.ts",
    find: "review_state IN ('confirmed', 'edited') ORDER BY",
    replace: "review_state IN ('proposed', 'confirmed', 'edited') ORDER BY",
    tests: ["apps/desktop/electron/nova-memory.test.ts", "apps/desktop/electron/nova-notes-followups.test.ts"],
    why: "A proposed note must never reach a prompt.",
  },
  {
    id: "nova-follow-up-ignores-organization",
    path: "apps/desktop/electron/nova-followups.ts",
    find: "if (!context.tenantConnected || context.activeTenantId !== followUp.tenantId) return \"skipped-organization\";",
    replace: "if (!context.tenantConnected) return \"skipped-organization\";",
    tests: ["apps/desktop/electron/nova-followups.test.ts"],
    why: "A follow-up runs only in the organization it was set in, never in the one active at its time.",
  },
  {
    id: "nova-proposal-skips-write-check",
    path: "apps/desktop/electron/state.ts",
    find: "      assertUnchanged?.(effectiveNovaProfile(persisted.novaProfile, this.managedPolicy, this.activeOrganizationIdOf(persisted)));",
    replace: "",
    tests: ["apps/desktop/electron/nova-records-state.test.ts"],
    why: "A settings change confirmed on a Nova card never overwrites a Settings save made after the card was prepared.",
  },
  {
    id: "nova-hosted-session-keeps-removed-notes",
    path: "apps/desktop/electron/nova.ts",
    find: "  return hostedProfileKey(fresh.profile) !== hosted.instructions || hosted.notes.some((note) => !current.has(note));",
    replace: "  return hostedProfileKey(fresh.profile) !== hosted.instructions;",
    tests: ["apps/desktop/electron/nova-notes-followups.test.ts"],
    why: "A hosted voice session ends when a note it was given is forgotten, edited or paused.",
  },
  {
    id: "nova-follow-up-ignores-policy",
    path: "apps/desktop/electron/nova-followups.ts",
    find: "  if (context.providerAllowed === false) return \"skipped-provider\";",
    replace: "",
    tests: ["apps/desktop/electron/nova-followups.test.ts"],
    why: "A follow-up does not run with a provider or model the IT policy no longer allows.",
  },
  {
    id: "nova-follow-up-ignores-provider-locality",
    path: "apps/desktop/electron/nova-followups.ts",
    find: "  if (followUp.providerLocal === undefined || context.activeProviderLocal !== followUp.providerLocal) return \"skipped-provider\";",
    replace: "",
    tests: ["apps/desktop/electron/nova-followups.test.ts"],
    why: "A follow-up set against a provider on this device is not asked once that provider runs off this device.",
  },
  {
    id: "nova-voice-consent-not-required",
    path: "apps/desktop/electron/nova.ts",
    find: "        if (!this.actions?.recordVoiceConsent) throw new Error(NOVA_VOICE_CONSENT_NOT_KEPT);",
    replace: "",
    tests: ["apps/desktop/electron/nova-notes-followups.test.ts", "apps/desktop/electron/nova.test.ts"],
    why: "Hosted voice sends nothing to OpenAI unless the consent was kept on this device.",
  },
  {
    id: "nova-hosted-start-skips-context-check",
    path: "apps/desktop/electron/nova.ts",
    find: "      if (sessionContextDiffers(session, latest, activeTenantId, endpoint)) throw new Error(\"Nova's tenant or provider changed. Start a new conversation.\");",
    replace: "",
    tests: ["apps/desktop/electron/nova-notes-followups.test.ts"],
    why: "A hosted voice start sends nothing after its organization, connection or reasoning provider changed while it started.",
  },
  {
    id: "nova-addendum-for-inactive-organization",
    path: "apps/desktop/electron/nova-profile.ts",
    find: "  if (organizationId !== context.activeOrganizationId) throw new NovaProfileError(NOVA_ADDENDUM_NOT_ACTIVE);",
    replace: "",
    tests: ["apps/desktop/electron/nova-profile.test.ts"],
    why: "A save or restore queued before an organization switch does not change the organization left behind.",
  },
  {
    id: "nova-note-card-confirms-changed-note",
    path: "apps/desktop/electron/nova-memory.ts",
    find: "    if (expectedText !== undefined && (!note || note.reviewState !== \"proposed\" || note.text !== expectedText)) throw new NovaMemoryError(NOVA_NOTE_CHANGED);",
    replace: "",
    tests: ["apps/desktop/electron/nova-notes-followups.test.ts"],
    why: "A note card confirms only the text it showed, not a note edited or reviewed in Settings since.",
  },
  {
    id: "nova-purge-deletes-unaudited",
    path: "apps/desktop/electron/nova-memory.ts",
    find: "    (this.options.auditDurably ?? this.options.audit)(rows.map(",
    replace: "    this.options.audit(rows.map(",
    tests: ["apps/desktop/electron/nova-memory.test.ts"],
    why: "Disconnect deletes no Nova note before its purge event is on disk.",
  },
];

/**
 * Where `entry.find` starts in `source`, or why it cannot be found.
 * @param {string} source
 * @param {Pick<MutationEntry, "path" | "find" | "anchor">} entry
 * @returns {{ index: number } | { error: string }}
 */
export function locate(source, entry) {
  const count = (needle) => source.split(needle).length - 1;
  if (entry.anchor === undefined) {
    const n = count(entry.find);
    if (n === 1) return { index: source.indexOf(entry.find) };
    return {
      error: n === 0
        ? `${entry.path} no longer contains ${JSON.stringify(entry.find)}. The guarded code changed; re-quote the entry.`
        : `${entry.path} contains ${JSON.stringify(entry.find)} ${n} times. Give the entry an anchor that occurs once.`,
    };
  }
  const anchors = count(entry.anchor);
  if (anchors !== 1) {
    return { error: `${entry.path} contains the anchor ${JSON.stringify(entry.anchor)} ${anchors} times; it must occur exactly once.` };
  }
  const after = source.indexOf(entry.anchor) + entry.anchor.length;
  const index = source.indexOf(entry.find, after);
  if (index === -1 || index - after > ANCHOR_WINDOW) {
    return {
      error: `${entry.path} has no ${JSON.stringify(entry.find)} within ${ANCHOR_WINDOW} characters after ${JSON.stringify(entry.anchor)}. The guarded code changed; re-quote the entry.`,
    };
  }
  return { index };
}

/**
 * `source` with the entry's mutation applied. Throws when it cannot be located.
 * @param {string} source
 * @param {Pick<MutationEntry, "path" | "find" | "anchor" | "replace">} entry
 */
export function mutate(source, entry) {
  const found = locate(source, entry);
  if ("error" in found) throw new Error(found.error);
  return source.slice(0, found.index) + entry.replace + source.slice(found.index + entry.find.length);
}

/** The workspace directory holding every test of the entry. */
export function workspaceOf(entry) {
  const dirs = new Set(entry.tests.map((test) => {
    let dir = dirname(join(REPO_ROOT, test));
    while (dir !== REPO_ROOT && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
    return dir;
  }));
  if (dirs.size !== 1 || dirs.has(REPO_ROOT)) {
    throw new Error(`${entry.id}: its tests must all live in one workspace package.`);
  }
  return [...dirs][0];
}

/** Totals from a TAP summary. */
export function tapTotals(output) {
  const total = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(output)?.[1] ?? NaN);
  return { tests: total("tests"), failed: total("fail") + total("cancelled") };
}

let activeChild;

function runTests(entry, env) {
  const cwd = workspaceOf(entry);
  const hooks = join(REPO_ROOT, "scripts", "mutation-register-hooks.mjs");
  const args = [
    ...(env.MUTATION_REGISTER_ENTRY ? ["--import", hooks] : []),
    "--import", "tsx",
    "--test", "--test-reporter=tap",
    ...entry.tests.map((test) => relative(cwd, join(REPO_ROOT, test))),
  ];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      done({ exitCode: code ?? -1, signal, output, ...tapTotals(output) });
    });
  });
}

/** The verdict for one entry, and whether it passes the register. */
export function judge(entry, verdict, detail) {
  if (verdict === "killed" && entry.survivesUntil) {
    return { verdict, ok: false, detail: `${detail}. The tests now catch this; remove survivesUntil "${entry.survivesUntil}".` };
  }
  if (verdict === "survived" && entry.survivesUntil) {
    return { verdict, ok: true, detail: `known gap, owned by ${entry.survivesUntil}` };
  }
  return { verdict, ok: verdict === "killed", detail };
}

async function main(argv) {
  if (argv.includes("--list")) {
    for (const entry of REGISTER) {
      console.log(`${entry.id}  ${entry.path}${entry.survivesUntil ? `  survivesUntil ${entry.survivesUntil}` : ""}`);
    }
    return 0;
  }
  const wanted = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = wanted.filter((id) => !REGISTER.some((entry) => entry.id === id));
  if (unknown.length > 0) {
    console.error(`No register entry named ${unknown.join(", ")}.`);
    return 1;
  }
  const entries = wanted.length ? REGISTER.filter((entry) => wanted.includes(entry.id)) : REGISTER;

  const markDir = mkdtempSync(join(tmpdir(), "openadminos-mutation-register-"));
  const stop = (signal) => {
    activeChild?.kill("SIGKILL");
    rmSync(markDir, { recursive: true, force: true });
    console.error(`\nStopped by ${signal}. No source file was written.`);
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const started = Date.now();
  const controls = new Map();
  const outcomes = [];
  try {
    for (const entry of entries) {
      const target = join(REPO_ROOT, entry.path);
      const before = readFileSync(target, "utf8");
      const found = locate(before, entry);
      if ("error" in found) {
        outcomes.push({ entry, ...judge(entry, "stale", found.error) });
        console.log(`stale     ${entry.id}`);
        continue;
      }
      const key = `${workspaceOf(entry)}\0${[...entry.tests].sort().join("\0")}`;
      let control = controls.get(key);
      if (!control) {
        control = await runTests(entry, {});
        controls.set(key, control);
        console.log(`control   ${entry.tests.join(" ")}: ${control.exitCode === 0 ? `green, ${control.tests} tests` : "RED"}`);
      }
      if (control.exitCode !== 0) {
        outcomes.push({ entry, ...judge(entry, "control-red", `the tests fail without the mutation, so a kill would prove nothing:\n${control.output.slice(-2000)}`) });
        continue;
      }
      const mark = join(markDir, entry.id);
      const run = await runTests(entry, { MUTATION_REGISTER_ENTRY: entry.id, MUTATION_REGISTER_MARK: mark });
      if (readFileSync(target, "utf8") !== before) {
        throw new Error(`${entry.path} changed on disk during the mutant run. Inspect it with git diff.`);
      }
      let outcome;
      if (!existsSync(mark)) {
        outcome = judge(entry, "not-reached", `the tests never loaded ${entry.path}, so the mutation was not applied. Name a test that exercises it.\n${run.output.slice(-2000)}`);
      } else if (run.failed > 0 && run.tests === control.tests) {
        outcome = judge(entry, "killed", `${run.failed} of ${run.tests} tests failed`);
      } else if (run.exitCode === 0) {
        outcome = judge(entry, "survived", "every test still passes with the guard broken");
      } else {
        outcome = judge(entry, "broken", `the mutant run reported ${run.tests} tests where the unmutated run reported ${control.tests}; a crash is not a kill:\n${run.output.slice(-2000)}`);
      }
      console.log(`${outcome.verdict.padEnd(9)} ${entry.id}`);
      outcomes.push({ entry, ...outcome });
    }
  } finally {
    rmSync(markDir, { recursive: true, force: true });
  }

  console.log("");
  for (const outcome of outcomes) {
    console.log(`${outcome.ok ? "ok  " : "FAIL"}  ${outcome.verdict.padEnd(11)}  ${outcome.entry.id}: ${outcome.detail}`);
  }
  const failures = outcomes.filter((outcome) => !outcome.ok).length;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n${outcomes.length - failures} ok, ${failures} failing, of ${outcomes.length} entries, in ${seconds}s.`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
