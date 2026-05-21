# OpenAdminOS - marketing site

Public landing page for [openadminos.example](https://openadminos.example). Captures waitlist signups in Supabase.

This directory lives inside the [OpenAdminOS monorepo](https://github.com/OpenAdminOS/OpenAdminOS) but is intentionally **not** an npm workspace — it has its own `package.json` and `package-lock.json` and is deployed independently. Vercel's project Root Directory is set to `web`.

## Stack

- Next.js 15 (App Router)
- React 19
- Tailwind CSS 4
- Supabase JS (waitlist storage)
- `@t3-oss/env-nextjs` + Zod (env validation)

## Local development

```sh
cd web
npm install
cp .env.example .env
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev
```

The dev server runs on http://localhost:3000.

## Environment variables

| Name                            | Required | Description                                  |
| ------------------------------- | -------- | -------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Yes      | Supabase project URL.                        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes      | Supabase anon key (safe to ship to clients). |

Both must be set in Vercel's project Environment Variables for production.

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
