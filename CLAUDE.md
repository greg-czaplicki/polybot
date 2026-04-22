# Polywhaler — Development Guidelines

## Cloudflare Resource Isolation (CRITICAL)

This project shares a Cloudflare account with another project (ParlayWhaler). Never touch the other project's resources.

- **This project's D1 database:** `polywhaler-db` (ID: `5c45f749-3557-4307-8384-c499fe2f5359`)
- **This project's worker:** `tanstack-start-app`
- **This project's queue:** `sharp-pipeline`
- **This project's durable object:** `SharpPipeline`

Only run `wrangler d1`, `wrangler deploy`, and other Cloudflare commands targeting the resources listed above. Never run `wrangler d1 delete`, `wrangler d1 create`, or deploy commands that could affect databases or workers outside this project.
