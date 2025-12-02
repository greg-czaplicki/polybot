# polywhaler workflow

This repo uses Vite + the Cloudflare Vite plugin for local development, Cloudflare Workers for deployment, and D1 for storage. The steps below keep local and remote environments straight so you always know which database you are talking to.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Keep the local D1 database in sync

Wrangler stores the local SQLite copy at `.wrangler/state/v3/d1`. Any time you add a migration or need a clean slate:

```bash
rm -rf .wrangler/state/v3/d1      # optional clean slate
npx wrangler d1 migrations apply polywhaler
```

This runs the `migrations/*.sql` files against the local database so tables like `users` exist during `pnpm run dev`.

## 3. Run the app locally

Local dev is entirely driven by Vite – **do not** run `wrangler dev` directly.

```bash
pnpm run dev
```

This starts Vite’s dev server and spins up workerd via `@cloudflare/vite-plugin`, so your server code can hit `env.POLYWHALER_DB` while you still get hot reload.

## 4. Remote database access (optional)

If you want your local worker to talk to a remote D1 instance:

1. Create a remote DB (preview recommended): `npx wrangler d1 create <name>`
2. Add its ID to `wrangler.jsonc` as `"preview_database_id"` under the `POLYWHALER_DB` binding.
3. Seed it once: `npx wrangler d1 migrations apply polywhaler --remote`
4. Run dev with `CLOUDFLARE_ENV=preview pnpm run dev` so the plugin proxies bindings remotely.

Leave `preview_database_id` unset to use the local SQLite copy instead.

## 5. Deploying to Cloudflare

1. Ensure the remote database has the latest schema:
   ```bash
   npx wrangler d1 migrations apply polywhaler --remote
   ```
2. Build the worker + client bundle:
   ```bash
   pnpm run build
   ```
3. Deploy:
   ```bash
   npx wrangler deploy
   ```

This publishes the code from `dist/server` and uploads the static assets from `dist/client`.

## 6. Troubleshooting checklist

- `D1_ERROR: no such table`: run the migrations for whichever database (local or remote) you’re hitting.
- `SQLITE_CANTOPEN`: workerd couldn’t open `.wrangler/state/v3/d1/...sqlite`; stop dev, delete that directory, rerun the migrations, then restart `pnpm run dev`.
- Build errors mentioning `#tanstack-router-entry`: you accidentally ran `wrangler dev`; stop it and go back to `pnpm run dev`.

Keep this file up to date as the workflow evolves so future contributors can bootstrap quickly.