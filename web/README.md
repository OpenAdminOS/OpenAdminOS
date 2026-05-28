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

## Scripts

| Script             | What it does                              |
| ------------------ | ----------------------------------------- |
| `npm run dev`      | Next.js dev server with Turbopack.        |
| `npm run build`    | Production build.                         |
| `npm run start`    | Run the production build.                 |
| `npm run preview`  | `build` then `start` in one go.           |
| `npm run typecheck`| TypeScript-only check, no emit.           |
