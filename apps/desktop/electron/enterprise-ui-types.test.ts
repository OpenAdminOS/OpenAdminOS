// The renderer's view types of team features UI mirror the contract in
// `@openadminos/enterprise`. This fails to type check (npm run typecheck)
// when the two drift apart in either direction.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  EnterpriseScheduleTargetsView,
  EnterpriseScheduleTargetView,
  EnterpriseSettingsSectionView,
  EnterpriseUiBodyView,
  EnterpriseUiElementView,
  EnterpriseUiNoticeView,
  EnterpriseUiReplyView,
} from "@openadminos/agent-sdk";
import type {
  EnterpriseScheduleTarget,
  EnterpriseScheduleTargets,
  EnterpriseSettingsSectionSnapshot,
  EnterpriseUiBody,
  EnterpriseUiElement,
  EnterpriseUiNotice,
  EnterpriseUiReply,
} from "@openadminos/enterprise";

type Assignable<From, To> = From extends To ? true : false;
type Both<A, B> = Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;

const checks: [
  Both<EnterpriseUiElementView, EnterpriseUiElement>,
  Both<EnterpriseUiBodyView, EnterpriseUiBody>,
  Both<EnterpriseUiNoticeView, EnterpriseUiNotice>,
  Both<EnterpriseUiReplyView, EnterpriseUiReply>,
  Both<EnterpriseScheduleTargetView, EnterpriseScheduleTarget>,
  Both<EnterpriseScheduleTargetsView, EnterpriseScheduleTargets>,
  Assignable<EnterpriseSettingsSectionSnapshot, EnterpriseSettingsSectionView>,
] = [true, true, true, true, true, true, true];

describe("team features UI types", () => {
  it("keep the renderer's view types assignable to the contract both ways", () => {
    assert.ok(checks.every(Boolean));
  });
});
