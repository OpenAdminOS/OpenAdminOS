import assert from "node:assert/strict";
import { test } from "node:test";
import { speechLanguage } from "./language.js";

test("selects the answer language for localized device reports", () => {
  assert.equal(speechLanguage("Die Geräte müssen neu gestartet werden.", "en"), "de");
  assert.equal(speechLanguage("Bonjour, voici les appareils qui nécessitent une intervention.", "en"), "fr");
  assert.equal(speechLanguage("De apparaten zijn bijgewerkt.", "en"), "nl");
  assert.equal(speechLanguage("Microsoft Intune and BitLocker are ready."), "en");
  assert.equal(speechLanguage("Intune, Entra, and Autopilot."), "en");
  assert.equal(speechLanguage("Intune.", "de"), "de");
});

test("short, uncertain answers follow the spoken-language hint or default to English", () => {
  for (const text of ["Done.", "Two devices need a restart.", "BitLocker is off on three laptops."]) {
    assert.equal(speechLanguage(text, "en"), "en");
    assert.equal(speechLanguage(text), "en");
  }
  assert.equal(speechLanguage("Fertig.", "de"), "de");
  assert.equal(speechLanguage("Zwei Geräte brauchen einen Neustart.", "en"), "de");
});
