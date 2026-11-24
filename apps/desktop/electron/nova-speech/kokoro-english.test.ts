import assert from "node:assert/strict";
import { test } from "node:test";
import { englishPhonemes } from "./kokoro-english.js";

test("Kokoro text uses lexicon defaults, pronounces unknown words and expands numbers", () => {
  const gold = {
    Device: { DEFAULT: "dɪvˈIs", NN: "dɪvˈIs" },
    C: "sˈi",
    X: "ˈɛks",
    one: "wˈʌn",
    zero: "zˈɪɹO",
  };
  assert.equal(englishPhonemes("Device Grosh 10.", gold, {}), "dɪvˈIs gɹˈɑʃ wˈʌn zˈɪɹO.");
});

test("pronounces Microsoft admin terms as words and uses conventional acronym readings", () => {
  assert.equal(
    englishPhonemes("Intune Entra Autopilot Autopatch BitLocker Defender for Endpoint Purview Conditional Access OneDrive", { for: "fɔɹ" }, {}),
    "ɪntˈun ˈɛntɹə ˈɔɾəpIlət ˈɔɾəpæʧ bˈɪtlɑkəɹ dɪfˈɛndəɹ fɔɹ ˈɛndpYnt pˈɜɹvju kəndˈɪʃənəl ˈæksɛs wˈʌndɹIv",
  );
  assert.equal(englishPhonemes("MFA MDM MAM GPO OMA-URI CSP UPN SID TPM IME", {}, {}),
    "ˌɛm ˌɛf ˈA ˌɛm ˌdi ˈɛm ˌɛm ˌA ˈɛm ˌʤi ˌpi ˈO ˌO ˌɛm ˌA ˌju ˌɑɹ ˈI ˌsi ˌɛs ˈpi ˌju ˌpi ˈɛn sˈɪd ˌti ˌpi ˈɛm ˌI ˌɛm ˈi");
});
