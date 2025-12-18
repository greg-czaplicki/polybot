# Polywhaler Setup Guide

This guide will help you set up the Polywhaler project on a new machine with Cloudflare infrastructure.

## Quick Start Checklist

1. ✅ **Install dependencies**
   ```bash
   pnpm install
   ```

2. ✅ **Authenticate with Cloudflare**
   ```bash
   npx wrangler login
   ```
   This will open your browser to authenticate with Cloudflare.

3. ✅ **Initialize local D1 database**
   ```bash
   npx wrangler d1 migrations apply polywhaler
   ```
   This creates a local SQLite database at `.wrangler/state/v3/d1` and applies all migrations.

4. ✅ **Verify setup**
   ```bash
   ./scripts/verify-setup.sh
   ```

5. ✅ **Start development server**
   ```bash
   pnpm run dev
   ```
   The app will be available at `http://localhost:3000`

## Detailed Setup Steps

### 1. Prerequisites

- **Node.js** (v18 or later recommended)
- **pnpm** package manager
  ```bash
  npm install -g pnpm
  ```

### 2. Install Dependencies

```bash
pnpm install
```

This installs all project dependencies including:
- `wrangler` - Cloudflare Workers CLI
- `@cloudflare/vite-plugin` - Vite plugin for Cloudflare Workers
- All React, TanStack, and other dependencies

### 3. Cloudflare Authentication

You need to be logged in to Cloudflare to:
- Access D1 databases
- Deploy workers
- Manage secrets

```bash
npx wrangler login
```

This will:
- Open your browser
- Prompt you to log in to Cloudflare
- Authorize Wrangler to access your account

Verify you're logged in:
```bash
npx wrangler whoami
```

### 4. Database Setup

#### Local Development Database

For local development, Wrangler uses a local SQLite database. Initialize it with:

```bash
npx wrangler d1 migrations apply polywhaler
```

This:
- Creates `.wrangler/state/v3/d1/` directory
- Applies all migration files from `migrations/`
- Sets up all tables and indexes

**Note:** If you need to reset your local database:
```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply polywhaler
```

#### Remote Database (Production/Preview)

To apply migrations to the remote Cloudflare D1 database:

```bash
npx wrangler d1 migrations apply polywhaler --remote
```

**⚠️ Warning:** This modifies your production database. Make sure you want to do this!

### 5. Environment Variables & Secrets

#### Secrets (Cloudflare Workers Secrets)

Secrets are stored in Cloudflare and are not in your codebase. To manage them:

**List all secrets:**
```bash
npx wrangler secret list
```

**Set a secret:**
```bash
npx wrangler secret put APP_PASSWORD
```
You'll be prompted to enter the value.

**Delete a secret:**
```bash
npx wrangler secret delete APP_PASSWORD
```

**Required secrets:**
- `APP_PASSWORD` (optional) - Password protection for the app

**Optional secrets for alerts:**
- `PUSHER_BEAMS_SECRET_KEY` - Pusher Beams secret key for push notifications
- `ALERT_POSITION_THRESHOLD_USD` - Override default alert threshold (default: 50000)

#### Environment Variables

Some variables are set in `wrangler.jsonc`:
- `PRIMARY_USER_ID` - Default user ID
- `PUSHER_BEAMS_INSTANCE_ID` - Pusher Beams instance ID

These are already configured in the project.

### 6. Development Modes

#### Local Development (Default)
Uses local SQLite database:
```bash
pnpm run dev
```

#### Remote Development (Preview Environment)
Uses the remote Cloudflare D1 database:
```bash
pnpm run dev:remote
# or
CLOUDFLARE_ENV=preview pnpm run dev
```

**⚠️ Warning:** Remote mode edits live data. Only use when that's acceptable.

### 7. Testing the Setup

Run the verification script:
```bash
./scripts/verify-setup.sh
```

Or manually test:

**Test Wrangler:**
```bash
npx wrangler --version
npx wrangler whoami
```

**Test local database:**
```bash
npx wrangler d1 execute polywhaler --command "SELECT name FROM sqlite_master WHERE type='table';"
```

**Test remote database:**
```bash
npx wrangler d1 execute polywhaler --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

### 8. Common Issues

#### "D1_ERROR: no such table"
**Solution:** Run migrations:
```bash
npx wrangler d1 migrations apply polywhaler
```

#### "You are not authenticated"
**Solution:** Log in to Cloudflare:
```bash
npx wrangler login
```

#### "Cannot find module 'wrangler'"
**Solution:** Install dependencies:
```bash
pnpm install
```

#### Local database out of sync
**Solution:** Reset and reapply migrations:
```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply polywhaler
```

### 9. Deployment

When ready to deploy:

1. **Apply migrations to remote database:**
   ```bash
   npx wrangler d1 migrations apply polywhaler --remote
   ```

2. **Build the project:**
   ```bash
   pnpm run build
   ```

3. **Deploy:**
   ```bash
   pnpm run deploy
   # or
   npx wrangler deploy
   ```

### 10. Useful Commands

```bash
# Development
pnpm run dev              # Start local dev server
pnpm run dev:remote       # Start dev server with remote DB

# Database
npx wrangler d1 migrations apply polywhaler              # Apply to local
npx wrangler d1 migrations apply polywhaler --remote     # Apply to remote
npx wrangler d1 execute polywhaler --command "SELECT * FROM users LIMIT 5;"

# Secrets
npx wrangler secret list
npx wrangler secret put SECRET_NAME
npx wrangler secret delete SECRET_NAME

# Deployment
pnpm run build
pnpm run deploy

# Type generation
pnpm run cf-typegen      # Generate Cloudflare types

# Code quality
pnpm run lint
pnpm run format
pnpm run check
```

## Project Structure

- `migrations/` - SQL migration files for D1 database
- `src/server/` - Cloudflare Workers server code
- `src/routes/` - TanStack Router routes
- `wrangler.jsonc` - Cloudflare Workers configuration
- `.wrangler/` - Local development state (gitignored)

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)
- [D1 Database Docs](https://developers.cloudflare.com/d1/)
- [TanStack Start Docs](https://tanstack.com/start)
