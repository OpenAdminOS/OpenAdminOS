import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signInRefusal } from "./refusal.js";

describe("signInRefusal", () => {
  it("names each known sign-in failure and quotes an unknown code", () => {
    assert.equal(signInRefusal("AADSTS700027", "").reason, "signin-certificate-not-registered");
    assert.equal(signInRefusal("AADSTS7000112", "").reason, "signin-app-disabled");
    assert.equal(signInRefusal("AADSTS700016", "").reason, "signin-app-not-found");
    assert.equal(signInRefusal("AADSTS53003", "").reason, "signin-blocked-by-conditional-access");
    assert.equal(signInRefusal("AADSTS700024", "").reason, "signin-client-assertion-expired");
    const unknown = signInRefusal("AADSTS90002", "");
    assert.equal(unknown.reason, "signin-failed");
    assert.match(unknown.message, /AADSTS90002/);
    assert.match(signInRefusal(undefined, "fetch failed").message, /login\.microsoftonline\.com/);
  });
});
