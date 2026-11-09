import { describe, expect, it } from "vitest";

import { referenceMarkText } from "./ServiceMark";

describe("reference marks (design round review)", () => {
  it("lead with the host's brand, so they never collide with provider marks", () => {
    expect(referenceMarkText("learn.microsoft.com")).toBe("ML");
    expect(referenceMarkText("www.kqlsearch.com")).toBe("KQ");
    expect(referenceMarkText("www.intuneautomation.com")).toBe("IN");
    // Microsoft Learn's host never takes LM, the letters of LM Studio.
    expect(referenceMarkText("LM Studio")).toBe("LS");
    expect(referenceMarkText("learn.microsoft.com")).not.toBe("LM");
    expect(referenceMarkText("Microsoft Teams")).toBe("MT");
  });
});
