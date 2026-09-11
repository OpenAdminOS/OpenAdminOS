# Team PowerShell draft

Prepares a PowerShell script for review from an Agent Team task and its supplied evidence.

Assign this workflow to a persona in Agent Team. Configure that persona to watch a source persona or place this workflow after an assessment in an ordered assignment. The host supplies bounded evidence references and the task question. Large results may be omitted from the prompt; the source run remains available for review.

This workflow makes no tenant API requests and performs no writes. It uses the assigned model; a hosted provider receives the supplied context under the persona's consent. Output is a proposal for human review, not a verified diagnosis or executed change. Without a team task, it reports missing context.
