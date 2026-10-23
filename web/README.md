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
