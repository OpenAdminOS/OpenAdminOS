import assert from "node:assert/strict";
import { it } from "node:test";
import { validateSaveTextFileArgs } from "./save-text-file-args.js";

it("accepts a CSV at the export limit and reports the limit for larger CSVs", () => {
  const limit = 8 * 1024 * 1024;
  const args = { suggestedName: "cached-results.csv", content: "x".repeat(limit) };
  assert.equal(validateSaveTextFileArgs(args).content.length, limit);
  assert.throws(
    () => validateSaveTextFileArgs({ ...args, content: args.content + "x" }),
    { message: `File content exceeds the ${limit.toLocaleString()} character export limit.` },
  );
});
