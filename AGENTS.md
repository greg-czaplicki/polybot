# AGENTS.md

## Scope
These instructions apply to the entire `polywhaler` repository.

## Build, Lint, Test

### Install
- `pnpm install`

### Development
- `pnpm run dev` (local DB, Cloudflare preview env)
- `pnpm run dev:local` (local-only Vite dev server)
- `pnpm run dev:remote` (remote Cloudflare D1 DB)

### Build / Preview / Deploy
- `pnpm run build`
- `pnpm run serve`
- `pnpm run deploy`

### Lint / Format / Check
- `pnpm run lint` (Biome lint)
- `pnpm run format` (Biome format)
- `pnpm run check` (Biome lint + format)

### Tests (Vitest)
- `pnpm test` (alias for `vitest run`)
- Run a single test file: `pnpm test -- path/to/file.test.ts`
- Run a single test by name: `pnpm test -- -t "test name"`
- Run tests in watch mode: `pnpm exec vitest`

### Type Generation
- `pnpm run cf-typegen` (Cloudflare types)

### Cloudflare / D1 helpers
- Local migrations: `npx wrangler d1 migrations apply polywhaler`
- Remote migrations: `npx wrangler d1 migrations apply polywhaler --remote`

## Code Style Guidelines

### Formatting (Biome)
- Use tabs for indentation.
- Use double quotes for strings.
- Let Biome organize imports (auto on format).
- Prefer formatting with `pnpm run format` rather than manual tweaks.

### TypeScript / React
- Repo is ESM (`"type": "module"`), keep `import`/`export` syntax.
- TypeScript is strict: avoid `any`, prefer explicit types.
- Use `import type { ... }` for type-only imports.
- Prefer `const` and immutable patterns by default.
- Use PascalCase for React components and exported types.
- Use camelCase for functions, variables, and hooks.
- Use SCREAMING_SNAKE_CASE for file-level constants.

### Imports
- Use `@/` path aliases for `src` imports when reasonable (`@/lib/...`).
- Keep imports grouped: external first, then internal, then types (Biome handles ordering).
- Avoid relative imports that traverse many directories when `@/` is available.

### File/Folder Conventions
- Routes live in `src/routes/` (TanStack file-based routing).
- Server code lives in `src/server/`.
- Shared utilities live in `src/lib/`.
- Do not edit generated files such as `src/routeTree.gen.ts`.

### Error Handling
- Prefer early returns and clear guards for nullable values.
- When dealing with external APIs, validate inputs and responses.
- Catch and rethrow with helpful context when appropriate.
- Avoid swallowing errors; log or surface actionable messages.

### Data Fetching / APIs
- Server functions use `@tanstack/react-start` (e.g., `createServerFn`).
- Keep payload/response types near the API functions.
- Validate inputs at the boundary of server functions.

### UI / Styling
- Tailwind CSS is the styling system.
- Use `class-variance-authority` and `clsx` patterns where they already exist.
- Prefer existing component patterns in `src/components/`.

## Cursor Rules
- Use the latest Shadcn version when adding components:
  - `pnpx shadcn@latest add button`

## Notes for Agents
- Biome ignores `src/routeTree.gen.ts` and `src/styles.css`.
- The project uses Cloudflare D1; check `wrangler.jsonc` for bindings.
- Password protection uses the `APP_PASSWORD` secret.
