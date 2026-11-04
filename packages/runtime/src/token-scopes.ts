/**
 * Read the `scp` claim of an access token. The payload is decoded without
 * verifying the signature: this only reads OpenAdminOS's own grants, and
 * Microsoft Graph stays responsible for validating the token.
 */
export function scopesFromAccessToken(token: string): string[] | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.scp === "string" ? claims.scp.split(/\s+/).filter(Boolean) : undefined;
  } catch {
    return undefined;
  }
}

const NOT_A_GRANT = new Set(["openid", "profile", "offline_access", ".default"]);

function isGrant(scope: string): boolean {
  const name = scope.slice(scope.lastIndexOf("/") + 1);
  return name.length > 0 && !NOT_A_GRANT.has(name);
}

/**
 * The scopes a token result carries. MSAL's `scopes` comes first. When it
 * is empty or holds only `.default` and sign-in scopes, as it can after a
 * `.default` request, the access token's `scp` claim is used instead.
 */
export function scopesFromAuthenticationResult(result: {
  scopes?: readonly string[] | null;
  accessToken?: string | null;
}): string[] {
  const listed = [...(result.scopes ?? [])];
  if (listed.some(isGrant)) return listed;
  const decoded = result.accessToken ? scopesFromAccessToken(result.accessToken) : undefined;
  return decoded ?? listed;
}
