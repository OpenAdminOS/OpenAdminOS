import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUTHORITY,
  GRAPH_CLI_CLIENT_ID,
  OPENADMINOS_CLIENT_ID,
  authorityForDirectory,
  defaultClientId,
} from "./msal.js";

describe("app identity resolution", () => {
  it("signs in as the OpenAdminOS app, not Microsoft's Graph CLI app", () => {
    assert.equal(defaultClientId(), OPENADMINOS_CLIENT_ID);
    assert.notEqual(defaultClientId(), GRAPH_CLI_CLIENT_ID);
    assert.match(
      OPENADMINOS_CLIENT_ID,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses the common authority when no directory is supplied", () => {
    assert.equal(authorityForDirectory(), DEFAULT_AUTHORITY);
    assert.equal(authorityForDirectory("   "), DEFAULT_AUTHORITY);
  });

  it("targets a single-tenant directory when one is supplied", () => {
    assert.equal(
      authorityForDirectory("00000000-1111-2222-3333-444444444444"),
      "https://login.microsoftonline.com/00000000-1111-2222-3333-444444444444",
    );
    assert.equal(
      authorityForDirectory("contoso.onmicrosoft.com"),
      "https://login.microsoftonline.com/contoso.onmicrosoft.com",
    );
  });

  it("rejects a directory value that could smuggle a different authority host", () => {
    for (const bad of ["evil.com/../..", "a/b", "tenant?x=1", "ten ant"]) {
      assert.throws(() => authorityForDirectory(bad), /GUID or a verified domain/);
    }
  });
});
