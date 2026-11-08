---
title: "Consent and sign-in errors"
description: "The AADSTS errors OpenAdminOS recognises at sign-in, what causes them and how to fix them, plus services that stay not connected."
---

# Consent And Sign-In Errors

When Microsoft sign-in fails, OpenAdminOS replaces the raw error with a message that names the app used, either the OpenAdminOS app or your app registration with its client ID, and the fix. **Try again** retries with the same app. **Change sign-in options** returns to the choice with your entries kept, so you can correct a client ID or directory ID.

Microsoft's full list of codes is the [Microsoft Entra authentication and authorization error codes](https://learn.microsoft.com/entra/identity-platform/reference-error-codes) reference.

## AADSTS Codes

| Code | Cause | Fix with your own registration | With the OpenAdminOS app |
| --- | --- | --- | --- |
| AADSTS50011 | The redirect URI in the request does not match the registration's reply addresses. | In the registration, under **Authentication**, add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`, save, and try again. | A problem with the published app, not your tenant. Report it, and connect with your own registration in the meantime. |
| AADSTS500113 | No reply address is registered for the application. Not listed on Microsoft's reference page; OpenAdminOS treats it like AADSTS50011. | Same as AADSTS50011. | Same as AADSTS50011. |
| AADSTS7000218 | Microsoft expected a client secret or client assertion, because the app is not set up as a public client. | Under **Authentication**, set **Allow public client flows** to **Yes**, save, and try again. OpenAdminOS never uses a client secret. | A problem with the published app. Report it. |
| AADSTS50194 | The app is single-tenant, so sign-in through the common endpoint is not allowed. | Enter the **Directory (tenant) ID** from the registration overview in the connect dialog. | A problem with the published app. Report it. |
| AADSTS900023 | The directory entered for sign-in was not recognised. Not listed on Microsoft's reference page. | Use the Directory (tenant) ID GUID or a verified domain from the registration overview. | Check the account you signed in with. |
| AADSTS700016 | The application was not found in the directory you signed in to: a wrong client ID, the wrong directory, or the app was never installed or consented there. | Check the **Application (client) ID**. For a single-tenant app, also enter its Directory (tenant) ID. | Your organization may block third-party multi-tenant apps. Ask an Entra administrator to allow it, or use your own registration. |
| AADSTS50105 | The signed-in user is not assigned to the app, and the enterprise application requires assignment. | Assign the user under **Enterprise applications**, or sign in with an assigned account. | Same. |
| AADSTS65001 | Consent for the requested permissions does not exist yet. | Under **API permissions**, select **Grant admin consent**, or create a registration with the setup script. Then try again. | An administrator who can grant tenant-wide consent signs in once and approves. See [Roles](../guides/roles.md). |
| AADSTS90094, AADSTS90095 | Administrator consent is required; the signed-in user cannot consent alone. 90095 is the admin consent workflow asking the user to request approval. | Same as AADSTS65001. | Same as AADSTS65001. |
| AADSTS50020 | The account does not exist in the tenant, for example a personal Microsoft account. | Sign in with an account from the tenant's directory. | Same. |

Other messages you may see:

- **Sign-in was cancelled.** Nothing was connected. Start again when ready.
- **Microsoft sign-in timed out after five minutes.** The browser sign-in was not completed. Start again.
- **Couldn't reach Microsoft's sign-in endpoint.** Check the network, proxy, VPN or DNS.
- **The previous sign-in session expired.** Reconnect from Connections and complete the consent prompt.

## A Service Shows Not Connected

Connections shows a service as **Not connected** when none of its parts is granted, and **Partial** when some are. A part counts as granted only when every one of its scopes is.

With the OpenAdminOS app:

- The service was not selected when the tenant was connected. Choose **Add access** on it and approve the consent screen.
- Consent was cancelled or not granted by an administrator. Choose **Add access** again, signed in with an account that can grant consent.

With your own app registration:

- The registration does not have the permissions. The row lists the exact missing permissions. Choose **Add permissions**, then run the script or merge the JSON snippet, as described in [Own app registration](../getting-started/own-app-registration.md).
- The permissions were added but admin consent was not granted. Grant it under **API permissions**.
- A part is missing one permission. Add the whole part: a part is on only when all of its permissions are granted.

After fixing it, choose **Check again**.

## Check Again Found Nothing New

**Check again** asks Microsoft for a new token and compares the permissions it carries with the ones recorded. If they are the same, OpenAdminOS shows "Microsoft returned no new permissions. Admin consent can take a minute to appear."

- Wait a minute and choose **Check again** once more. New consent can take a short time to appear in tokens.
- In the Entra admin center, open the registration, then **API permissions**, and confirm the permissions show as granted for the tenant. A permission that is listed but not granted is not in the token.
- Confirm the permissions are delegated Microsoft Graph permissions, not application permissions. OpenAdminOS uses delegated permissions only.
- Confirm you added them to the registration whose client ID the tenant was connected with. Connections shows it.

## Related

- [Own app registration](../getting-started/own-app-registration.md)
- [Connect with the shared app](../getting-started/connect-shared-app.md)
- [Authentication and permissions](../trust/authentication.md)
