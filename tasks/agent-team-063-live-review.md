# Agent Team 0.6.3 installed-app review

Date: 2026-09-15. This review operates the installed macOS application with the
admin's existing tenant, credentials, installed workflows and local providers.
It does not use the fixture rehearsal or a source-built Electron harness.

## Environment and scope

- `/Applications/OpenAdminOS.app` reports 0.6.3 and passes
  `codesign --verify --deep --strict`.
- The exact packaging commit was not independently identified. A version label
  alone does not prove that every PR #88 follow-up is in the installed binary.
- Chief of Staff uses Apple Foundation. Research Bot and Script Bot use Ollama
  `qwen3:8b`. Their pinned providers differ from the global Chat selection.
- Chief runs Compliance overview followed by Team evidence review. Research Bot
  runs Team evidence review; Script Bot runs Team PowerShell draft.
- Only the existing managed-device read permission is used. No consent expansion,
  tenant mutation, message delivery or generated-script execution is part of this test.

## Local setup and trigger semantics

Research Bot and Script Bot initially had no event triggers and no completed runs.
The review configured Research Bot to watch Chief of Staff, and Script Bot to watch
Research Bot, using "A first finding appears" with the existing 60-minute cooldown.
Their schedules remain Manual only, but enabled event triggers can start work
independently of that interval setting. Standing instructions ask for source-linked,
read-only diagnostics and prohibit inferred causes or executed remediation.

The fresh compliance assessment had unchanged structured evidence and retained its
previously acknowledged finding. To exercise the chain, the reviewer explicitly
reopened that finding. The UI required Resolve followed by Reopen because it did not
offer Reopen directly for an acknowledged finding. That was a local review-state
transition, not evidence of tenant remediation or newly detected compliance drift.
The runtime subsequently described the first unconsumed revision as a new finding.

This is a real-data handoff rehearsal with a manually prepared trigger. Repeated
manual assessments do not imply repeated handoffs: review state, freshness,
cooldowns and revision deduplication still apply.

## Verified execution and original failure

- The installed app completed its managed-device GET with HTTP 200, one attempt,
  followed by all count/filter steps and a real Apple Foundation summary.
- Chief completed both assigned workflows.
- The host automatically created the Chief-to-Research handoff, storing today's
  and the previous assessment run references. Research received both as task evidence.
- Research completed with the actual local Ollama model in approximately 67 seconds
  of assignment execution time. It cited both sources, compared the counts, and
  identified missing device-level and policy-level evidence.
- The host automatically created a second handoff to Script Bot, with the completed
  Research run as its source. Script Bot started generating a diagnostic draft,
  but its Ollama step aborted at approximately 180 seconds. The run reached Failed
  after about 264 seconds overall; it has no completed result.
- Evidence links and run details were inspected through the installed app UI;
  persisted run and handoff records were inspected read-only to verify linkage.

## Findings that matter for a live demonstration

1. **Assessment result drops additional compliance states.** The count transform
   reported `inGracePeriod`, but the manifest's final result and summary prompt only
   preserve compliant, noncompliant and unknown counts. Downstream teammates therefore
   receive an incomplete state breakdown even when the inventory read completes.
2. **Apple Foundation output was repetitive.** The fresh assessment summary repeated
   the same sentence across its drift section. Successful execution does not establish
   acceptable report quality. This is one observed output, not a failure-rate estimate.
3. **The generated script needs technical validation.** Its initial output omitted
   `DeviceManagementManagedDevices.Read.All` from prerequisites and constructed the
   client-credentials scope with an API-version segment. The correct Graph resource
   scope is `https://graph.microsoft.com/.default`. No new app registration, secret,
   permission grant or token request was performed to follow the draft's suggestions.
4. **First-run configuration is material.** Role names and descriptions alone did not
   connect the existing teammates. A complete assignment, an open eligible finding,
   and configured event links were all necessary for this chain.
5. **Automatic does not mean immediate.** Research took about a minute and the local
   script generation timed out after several minutes. Do not present this setup as instant.
6. **Run again loses task evidence.** The current `RunResult.tsx` rerun handler
   preserves tenant/provider/model but starts a normal agent run without the original
   Office task context. This source finding means it is not an evidence-preserving
   retry for the failed Team PowerShell draft. That button was not used in this review.
7. **Failure propagation was delayed.** The draft's step log recorded its abort
   about 84 seconds before the final Agent failed event. The cause has not been
   established; do not attribute this measurement to model latency alone.

## Bounded retry

A separate local teammate, Script Bot rehearsal retry, was created with the same
Ollama model and Research Bot source. This preserves the original failed attempt
and uses a new receiver identity to exercise a fresh handoff without removing
deduplication records. Its instructions constrain output to one short code block,
give the documented managed-device endpoint/read permission, and require an already
authenticated Graph PowerShell session rather than new authentication or secrets.
This is an assisted, narrowly specified retry, not proof that an unrestricted draft
request produces correct code. No generated script is executed.

The retry completed in about 28 seconds with the real local model. Its saved task
context references the completed Research run, and its output cites that run. The
installed app shows Completed, one of one steps complete, and the full code block.
PowerShell's parser reported zero syntax errors; command inspection found only
`Get-MgContext`, `Invoke-MgGraphRequest`, `Select-Object` and `Write-Error`, with the
Graph call using GET and a next-link loop. This is static verification only: the
Graph PowerShell module was not available for a live execution test, and no script
was executed. Static API review found an execution blocker: the draft passes
`-Url`, but the official `Invoke-MgGraphRequest` command declares `-Uri` without a
`Url` alias. A successful syntax parse does not validate command parameters.
The draft also selects display fields after retrieval rather than
applying the requested server-side `$select`; its missing-module check is also
less precise than the instructions requested.

References: [command documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.graph.authentication/invoke-mggraphrequest?view=graph-powershell-1.0)
and [official parameter declaration](https://github.com/microsoftgraph/msgraph-sdk-powershell/blob/main/src/Authentication/Authentication/Cmdlets/InvokeMgGraphRequest.cs).

**Outcome:** the installed app successfully demonstrated assessment, automatic
evidence handoffs and a completed draft after a bounded retry. The original request
failed at script generation, and the completed retry still needs correction before
it can execute. This does not establish an unattended, repeatable,
presentation-ready flow or generally correct generated PowerShell.

References: [managed-device permissions](https://learn.microsoft.com/en-us/graph/api/intune-devices-manageddevice-list?view=graph-rest-1.0)
and [Graph client-credentials token scope](https://learn.microsoft.com/en-us/graph/auth-v2-service?tabs=http).

## Reversing the local setup

For Research Bot and Script Bot, use Edit > Advanced instructions, handoffs and
schedules, set Watch another teammate to No event trigger, clear the standing
instructions added for this test, and save. This restores their previous manual-only
behavior without deleting completed evidence. Chief's workflow/provider configuration
was not changed. Acknowledge the reopened compliance finding to restore its original
review state. Existing run history remains as the record of the rehearsal.
For the separate retry teammate, Stop & pause disables future work while retaining
its evidence. Removing it is not required to undo the test configuration.

Private tenant results and generated output belong in the local app history or a
local review artifact, not this public-repository report.
