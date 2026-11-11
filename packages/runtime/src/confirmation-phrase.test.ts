import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmationPhraseProblem } from "./confirmation-phrase.js";

describe("confirmationPhraseProblem", () => {
  it("accepts an uppercase operation, count and target noun", () => {
    assert.equal(confirmationPhraseProblem("RETIRE 47 DEVICES"), undefined);
    assert.equal(confirmationPhraseProblem("REMOVE 2 GROUP-MEMBERS"), undefined);
  });

  it("refuses an empty or non-string phrase", () => {
    for (const value of [undefined, 47, "", "   "]) {
      assert.equal(confirmationPhraseProblem(value), "must be a non-empty string");
    }
  });

  it("refuses lowercase or mixed-case words", () => {
    for (const value of ["retire 47 devices", "Retire 47 Devices", "RETIRE 47 devices"]) {
      assert.equal(confirmationPhraseProblem(value), "must use uppercase words, digits, spaces, and hyphens only");
    }
  });

  it("refuses a phrase with fewer than three words, however long", () => {
    for (const value of ["RETIREALLDEVICES47", "RETIRE ALLDEVICES47"]) {
      assert.equal(confirmationPhraseProblem(value), "must contain an explicit operation, count, and target noun");
    }
  });

  it("refuses a phrase without the number of affected objects", () => {
    assert.equal(confirmationPhraseProblem("RETIRE ALL DEVICES"), "must include the number of affected objects");
  });

  it("checks a template with each expression standing in for a count", () => {
    assert.equal(confirmationPhraseProblem("RETIRE {{ actions.length }} DEVICES", { template: true }), undefined);
    assert.equal(
      confirmationPhraseProblem("RETIRE {{ actions.length }} DEVICES"),
      "must use uppercase words, digits, spaces, and hyphens only",
    );
  });
});
