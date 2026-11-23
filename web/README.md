# OpenAdminOS - marketing site

Public landing page for [openadminos.com](https://openadminos.com).

This directory lives inside the [OpenAdminOS monorepo](https://github.com/OpenAdminOS/OpenAdminOS) but is intentionally **not** an npm workspace — it has its own `package.json` and `package-lock.json` and is deployed independently. Vercel's project Root Directory is set to `web`.

## Stack

- Next.js 15 (App Router)
- React 19
- Tailwind CSS 4
- `@t3-oss/env-nextjs` + Zod (env validation)

## Local development

```sh
cd web
npm install
cp .env.example .env
npm run dev
```

The dev server runs on http://localhost:3000.

## Environment variables

The static marketing pages have no required build-time environment variables.
The optional stats routes use server-side variables documented in
`web/src/env.js`.

## Deployment

Vercel automatically deploys on every push to `main` that changes files under `web/`. Commits that only touch the desktop app or agents do not trigger a marketing rebuild.

## Documentation site

The same app serves the documentation at docs.openadminos.com. `next.config.js` rewrites requests for that host to `src/app/docs-host`, which renders the docs at the root of the domain. Previews and local dev serve the same pages under `/docs` (for example http://localhost:3000/docs).

The pages come from `docs/gitbook` in the repository root. Vercel cannot read that folder, because the project's Root Directory is `web/`, so `npm run docs:generate` (run from the repository root) copies them into `content/docs` with a `manifest.json` of URLs and redirects. Do not edit `content/docs` by hand; edit `docs/gitbook` and regenerate. `npm run docs:check` fails CI when the copy is stale.

Search runs in the browser against `/docs/search-index.json`, which is built with the site.

## Scripts

| Script             | What it does                              |
| ------------------ | ----------------------------------------- |
| `npm run dev`      | Next.js dev server with Turbopack.        |
| `npm run build`    | Production build.                         |
| `npm run start`    | Run the production build.                 |
| `npm run preview`  | `build` then `start` in one go.           |
| `npm run typecheck`| TypeScript-only check, no emit.           |

## Advent of Admin

The December 2026 campaign is off by default. Set the flags at build and runtime
when enabling it. All variables below are server-only and optional for building
and running the rest of the site.

| Variable | Behavior when set or unset |
| --- | --- |
| `ADVENT_ENABLED` | Set to `true` to enable the pages and API. Otherwise the routes return 404, and site navigation, privacy and sitemap omit the campaign. |
| `ADVENT_RULES_APPROVED` | Set to `true` after legal review to publish the rules and allow registration. Otherwise the rules page displays a placeholder and registration is closed. |
| `ADVENT_SUPABASE_URL` | HTTPS project origin for the dedicated EU-region Supabase project. If unset or invalid, the public calendar and door content remain visible and account storage is unavailable. |
| `ADVENT_SUPABASE_SERVICE_KEY` | Supabase server secret key or legacy service-role key. If unset, storage is unavailable. Keep this out of client variables and source control. |
| `ADVENT_SESSION_SECRET` | At least 32 bytes of entropy for session and login-link signatures. If unset or shorter than 32 bytes, accounts and login are unavailable. Changing it invalidates active sessions and unredeemed links. |
| `ADVENT_RESEND_API_KEY` | Sends sign-in emails via Resend. If unset, `next dev` prints the sign-in link to the server console and production sign-in shows a configuration error. |
| `ADVENT_EMAIL_FROM` | Sender on a verified Resend domain. If unset while the API key is set, sign-in email is unavailable. |
| `ADVENT_ADMIN_EMAILS` | Comma-separated list of participant email addresses that can access the admin page. When unset, no account has admin access. |
| `ADVENT_NOW` | ISO timestamp with a time-zone offset, such as `2026-12-01T06:00:00+01:00`. If unset, invalid, or running in production, the campaign uses the system clock. Login-link and session expiry always use the system clock. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Existing Redis settings used for sign-in rate limits. If either is unset, sign-in and signup are unavailable. |

Provision the EU Supabase project, enable its Data API, and apply
`supabase/advent/0001_init.sql` before opening registration. Its tables and
functions are accessible only to the service role. Configure Redis and a verified
Resend sender, with link tracking off. A sign-in email opens a confirmation page
so automated mail previews leave the one-time link usable.

Review the draft doors against the desktop release and set accepted answers from
the campaign admin page. The database stores only hashes of accepted answers.
The admin page can export CSVs for manual prize contact and run each draw once
after its eligibility window closes. The audit snapshot lists participant IDs
and weights, the SHA-256 digest and the 32-byte seed needed to replay the draw.
The purge control becomes available 90 days after the grand draw. Schedule an
admin to run it when due. Purging also removes non-winning admin accounts, so
export any records you need before running it.

Run `npm run test` in `web/` on Node.js 22 to check the campaign rules, the draw
algorithm and token primitives.
