# Polywhaler — Development Guidelines

## Cloudflare Resource Isolation (CRITICAL)

This project shares a Cloudflare account with another project (ParlayWhaler). Never touch the other project's resources.

- **This project's D1 database:** `polywhaler-db` (ID: `5c45f749-3557-4307-8384-c499fe2f5359`)
- **This project's worker:** `tanstack-start-app`
- **This project's queue:** `sharp-pipeline`
- **This project's durable object:** `SharpPipeline`

Only run `wrangler d1`, `wrangler deploy`, and other Cloudflare commands targeting the resources listed above. Never run `wrangler d1 delete`, `wrangler d1 create`, or deploy commands that could affect databases or workers outside this project.

## Canonical Documentation

- `docs/STRATEGY.md` — strategy era table (`STRATEGY_VERSION` in
  `src/lib/strategy-version.ts`). Bump the era ONLY when picking behavior
  changes (gates, scoring, calibration, grading) — never for UI/infra/data
  fixes — and update the table + `git tag strategy-vN` when you do.
- `docs/KNOWN-ISSUES.md` — data-validity caveats and deferred issues. Check it
  before trusting historical metrics; update it when fixing or finding issues.
- `docs/audits/` — dated audit and incident reports. Add one for substantive
  audits or incidents.

## Bot Deployment (separate repo)

The trading bot (`polywhaler-bot.service` on the VPS) runs from its **own git
repo** — the `bot/` directory here is only a reference mirror. Changes
committed to `bot/` in this repo do NOT reach the VPS; hand the user a patch
(`git apply -p2` strips the `bot/` prefix) or the manual edits, then
`sudo systemctl restart polywhaler-bot`. Bot config is env-driven
(`BOT_POLL_SECONDS`, `BOT_MAX_CALLS_PER_HOUR`, etc.) via the systemd unit.

## Operational Gotchas

- Always query D1 with `--remote`; the local miniflare DB is empty.
- `manual_picks` timestamps are **seconds**; `canonical_sync_runs` are
  **milliseconds**.
- Stored `clv` is valid only for picks settled after 2026-07-20; earlier
  values were scrubbed to NULL (see docs/KNOWN-ISSUES.md).
- Deploy with `pnpm run build && pnpm run deploy` (commit first so the build
  SHA stamped into `strategy_version` matches the deployed code).
