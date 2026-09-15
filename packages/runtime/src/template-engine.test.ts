import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderDeep, renderTemplate } from "./template-engine.js";

describe("renderTemplate", () => {
  it("bounds evidence without clipping records or hiding omitted coverage", () => {
    const records = [{ id: "oversized", data: "x".repeat(5000) }, { id: "small", nested: { values: [1, 2] } }, ...Array.from({ length: 30 }, (_, i) => ({ id: i, data: "é".repeat(200) }))];
    const result = renderTemplate("{{ records | boundedJson(1000) }}", { records }) as string;
    assert.ok(result.length <= 1000);
    const parsed = JSON.parse(result);
    assert.equal(parsed.totalRecords, records.length);
    assert.equal(parsed.includedRecords + parsed.omittedRecords, records.length);
    assert.deepEqual(parsed.records[0], records[1]);
    assert.match(parsed.coverage, /partial/);
    assert.equal(records.length, 32);
  });

  it("identifies complete, empty and entirely omitted evidence accurately", () => {
    for (const records of [[], [{ id: "one" }], [{ data: "x".repeat(5000) }]]) {
      const parsed = JSON.parse(renderTemplate("{{ records | boundedJson(512) }}", { records }) as string);
      assert.equal(parsed.totalRecords, records.length);
      assert.equal(parsed.coverage === "complete", parsed.omittedRecords === 0);
    }
    assert.throws(() => renderTemplate("{{ records | boundedJson(10) }}", { records: [] }), /character budget/);
    assert.throws(() => renderTemplate("{{ records | boundedJson(512) }}", { records: {} }), /requires an array/);
  });
  it("returns the raw typed value for a standalone expression", () => {
    assert.equal(renderTemplate("{{ count }}", { count: 47 }), 47);
    assert.deepEqual(renderTemplate("{{ items }}", { items: [1, 2, 3] }), [1, 2, 3]);
  });

  it("coerces interpolated values to string inside surrounding text", () => {
    const out = renderTemplate("Found {{ count }} devices", { count: 47 });
    assert.equal(out, "Found 47 devices");
  });

  it("renders missing paths as empty string in mixed text", () => {
    assert.equal(renderTemplate("Hello {{ user.name }}!", {}), "Hello !");
  });

  it("returns undefined for a standalone missing path (forgiving lookup)", () => {
    assert.equal(renderTemplate("{{ user.name }}", {}), undefined);
  });

  it("walks dotted paths", () => {
    const ctx = { tenant: { name: "Contoso" } };
    assert.equal(renderTemplate("{{ tenant.name }}", ctx), "Contoso");
  });

  it("applies the size filter to arrays, objects and strings", () => {
    assert.equal(renderTemplate("{{ xs | size }}", { xs: [1, 2, 3] }), 3);
    assert.equal(renderTemplate("{{ xs | size }}", { xs: { a: 1, b: 2 } }), 2);
    assert.equal(renderTemplate("{{ xs | size }}", { xs: "abcd" }), 4);
    assert.equal(renderTemplate("{{ xs | size }}", { xs: null }), 0);
  });

  it("applies default(...) when the value is null, undefined or empty string", () => {
    assert.equal(renderTemplate('{{ x | default("n/a") }}', { x: null }), "n/a");
    assert.equal(renderTemplate('{{ x | default("n/a") }}', { x: "" }), "n/a");
    assert.equal(renderTemplate('{{ x | default("n/a") }}', { x: "set" }), "set");
  });

  it("chains filters left-to-right", () => {
    const out = renderTemplate('{{ xs | sample(2) | join(", ") }}', {
      xs: ["a", "b", "c", "d"],
    });
    assert.equal(out, "a, b");
  });

  it("throws on unknown filter", () => {
    assert.throws(() => renderTemplate("{{ x | nope }}", { x: 1 }), /Unknown template filter/);
  });

  it("throws on malformed filter syntax", () => {
    assert.throws(() => renderTemplate("{{ x | 1bad }}", { x: 1 }), /Invalid filter syntax/);
  });
});

describe("renderDeep", () => {
  it("renders strings inside nested objects and arrays", () => {
    const ctx = { tenant: { name: "Contoso" }, count: 3 };
    const out = renderDeep(
      {
        title: "{{ tenant.name }}",
        meta: { summary: "Found {{ count }} items" },
        list: ["{{ tenant.name }}", "static"],
      },
      ctx,
    );
    assert.deepEqual(out, {
      title: "Contoso",
      meta: { summary: "Found 3 items" },
      list: ["Contoso", "static"],
    });
  });

  it("preserves non-string scalars", () => {
    const out = renderDeep({ n: 5, b: true, x: null }, {});
    assert.deepEqual(out, { n: 5, b: true, x: null });
  });
});
