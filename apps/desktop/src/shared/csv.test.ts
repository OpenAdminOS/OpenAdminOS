import { describe, expect, it } from "vitest";

import { csvCell } from "./csv";

describe("csvCell", () => {
  it("opens a cell a spreadsheet would run as a formula as text", () => {
    expect(csvCell("=HYPERLINK(\"https://example.test\")")).toBe("\"'=HYPERLINK(\"\"https://example.test\"\")\"");
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe("\"'\rcmd\"");
  });

  it("quotes cells with a quote, comma or line break and leaves plain cells alone", () => {
    expect(csvCell("LAPTOP-01")).toBe("LAPTOP-01");
    expect(csvCell("a,b")).toBe("\"a,b\"");
    expect(csvCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
    expect(csvCell(undefined)).toBe("");
  });
});
