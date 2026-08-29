import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProposalPlan } from "./service.js";

describe("gateway proposal plan builder", () => {
  it("validates paths against the Graph catalog and marks deletes destructive", () => {
    const { plan, requiredScopes } = buildProposalPlan({
      title: "Tighten compliance",
      clientName: "Claude Code",
      actions: [
        {
          method: "PATCH",
          path: "/deviceManagement/deviceCompliancePolicies/policy-1",
          body: { displayName: "Renamed" },
          label: "Rename compliance policy",
        },
        {
          method: "DELETE",
          path: "/deviceManagement/deviceCompliancePolicies/policy-2",
          label: "Delete stale policy",
        },
      ],
    });

    assert.equal(plan.actions.length, 2);
    assert.equal(plan.confirmationPhrase, "APPLY 2 CHANGES");
    assert.match(plan.summary, /Claude Code proposes 2 changes/);
    const del = plan.actions.find((action) => action.request?.method === "DELETE");
    assert.equal(del?.severity, "destructive");
    assert.ok(
      requiredScopes.some((scope) => /ReadWrite/.test(scope)),
      "should collect write scopes from the catalog",
    );
  });

  it("rejects unknown Graph endpoints instead of forwarding them", () => {
    assert.throws(
      () =>
        buildProposalPlan({
          title: "Sneaky",
          clientName: "Unknown client",
          actions: [
            {
              method: "POST",
              path: "/not/a/real/graph/path",
              label: "Do something undocumented",
            },
          ],
        }),
      /not a known Microsoft Graph endpoint/,
    );
  });

  it("uses singular confirmation copy for a single change", () => {
    const { plan } = buildProposalPlan({
      title: "One change",
      clientName: "Codex",
      actions: [
        {
          method: "PATCH",
          path: "/deviceManagement/deviceCompliancePolicies/policy-1",
          label: "Update policy",
        },
      ],
    });
    assert.equal(plan.confirmationPhrase, "APPLY 1 CHANGE");
  });
});
