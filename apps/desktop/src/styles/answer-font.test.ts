import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete document.documentElement.dataset.answerFont;
});

describe("saved Chat answer font", () => {
  it("defaults to serif and applies a device-local preference", async () => {
    const answerFont = await import("./answer-font");

    expect(answerFont.readAnswerFont()).toBe("serif");
    answerFont.initializeAnswerFont();
    expect(document.documentElement.dataset.answerFont).toBe("serif");

    answerFont.setAnswerFont("sans");
    expect(answerFont.readAnswerFont()).toBe("sans");
    expect(localStorage.getItem(answerFont.ANSWER_FONT_STORAGE_KEY)).toBe("sans");
    expect(document.documentElement.dataset.answerFont).toBe("sans");
  });

  it("follows the saved preference from another renderer window", async () => {
    const answerFont = await import("./answer-font");
    answerFont.initializeAnswerFont();
    localStorage.setItem(answerFont.ANSWER_FONT_STORAGE_KEY, "sans");

    window.dispatchEvent(
      new StorageEvent("storage", { key: answerFont.ANSWER_FONT_STORAGE_KEY }),
    );

    expect(document.documentElement.dataset.answerFont).toBe("sans");
  });
});
