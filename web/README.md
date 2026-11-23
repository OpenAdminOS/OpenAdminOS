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
| `ADVENT_SESSION_SECRET` | At least 32 bytes of entropy for session, login-link and reminder unsubscribe signatures. If unset or shorter than 32 bytes, accounts and login are unavailable. Changing it invalidates active sessions and unredeemed links. |
| `ADVENT_RESEND_API_KEY` | Enables Resend for sign-in emails and, separately, for door reminders. If unset, `next dev` prints the sign-in link to the server console and production sign-in shows a configuration error. |
| `ADVENT_REMINDERS_SEND` | Set to `true` to enable reminder delivery when the campaign, API key, sender and signing secret are configured. Unset or any other value runs a count-only dry run. |
| `CRON_SECRET` | Existing bearer secret for cron authorization. If unset, the reminder route rejects requests. |
| `ADVENT_EMAIL_FROM` | Sender on a verified Resend domain. If unset while the API key is set, sign-in email is unavailable. |
| `ADVENT_ADMIN_EMAILS` | Comma-separated list of participant email addresses that can access the admin page. When unset, no account has admin access. |
| `ADVENT_NOW` | ISO timestamp with a time-zone offset, such as `2026-12-01T06:00:00+01:00`. If unset, invalid, or running in production, the campaign uses the system clock. Login-link and session expiry always use the system clock. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Existing Redis settings used for sign-in rate limits. If either is unset, sign-in and signup are unavailable. |

Provision the EU Supabase project, enable its Data API, and apply
`supabase/advent/0001_init.sql` before opening registration. Its tables and
functions are accessible only to the service role. Configure Redis and a verified
Resend sender, with open and click tracking disabled for its domain. A sign-in email opens a confirmation page
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

### Daily door reminders

Reminders are a separate opt-in from release emails. Participants can turn them
off in My Advent or use the unsubscribe link in any reminder. A signed link
works without an account session and expires after 90 days.

The authenticated `POST /api/advent/reminders` endpoint evaluates the current
Berlin date and only handles 1 to 24 December, after that day’s door opens.
With sending disabled, including when the campaign flag is off, an authorised
request counts eligible participants and logs only totals. No recipient records
are claimed or sent to Resend during a dry run.

<!-- TODO(ugur): Schedule an authenticated POST to /api/advent/reminders at 05:05 UTC daily. Vercel crons issue GET requests, so use a scheduler that supports POST and can securely supply CRON_SECRET. -->
Schedule a job capable of POST at 05:05 UTC daily using the cron secret in the
Authorization bearer header. The existing Vercel cron configuration sends GET
requests. Confirm that the sender domain has open and click tracking disabled
before switching on delivery.

Each run reserves opted-in participants who still need that day’s completion,
then sends up to 100 emails per Resend batch. The daily send record prevents
duplicate email on reruns. A rejected or unconfirmed send stays recorded and
the job continues with later batches. Check the admin page for the current
opt-in total, per-door send totals, delivery issues and the HTML and plain-text
preview.
