#!/bin/bash

# Polywhaler Setup Verification Script
# This script checks that your Cloudflare/Wrangler setup is working correctly

set -e

echo "🔍 Polywhaler Setup Verification"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track if we have any issues
HAS_ISSUES=0

# Check 1: Node.js and pnpm
echo "1. Checking Node.js and pnpm..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "   ✓ Node.js: $NODE_VERSION"
else
    echo "   ${RED}✗ Node.js not found${NC}"
    HAS_ISSUES=1
fi

if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm --version)
    echo "   ✓ pnpm: $PNPM_VERSION"
else
    echo "   ${RED}✗ pnpm not found. Install with: npm install -g pnpm${NC}"
    HAS_ISSUES=1
fi
echo ""

# Check 2: Dependencies installed
echo "2. Checking dependencies..."
if [ -d "node_modules" ]; then
    echo "   ✓ node_modules directory exists"
else
    echo "   ${YELLOW}⚠ node_modules not found. Run: pnpm install${NC}"
    HAS_ISSUES=1
fi
echo ""

# Check 3: Wrangler CLI
echo "3. Checking Wrangler CLI..."
if command -v npx &> /dev/null; then
    WRANGLER_VERSION=$(npx wrangler --version 2>/dev/null || echo "not found")
    if [[ "$WRANGLER_VERSION" == "not found" ]]; then
        echo "   ${YELLOW}⚠ Wrangler not found in node_modules. It should be installed via pnpm install${NC}"
    else
        echo "   ✓ Wrangler: $WRANGLER_VERSION"
    fi
else
    echo "   ${RED}✗ npx not found${NC}"
    HAS_ISSUES=1
fi
echo ""

# Check 4: Cloudflare authentication
echo "4. Checking Cloudflare authentication..."
if npx wrangler whoami &> /dev/null; then
    CLOUDFLARE_EMAIL=$(npx wrangler whoami 2>/dev/null | grep -oP 'You are logged in as \K[^ ]+' || echo "unknown")
    echo "   ✓ Logged in to Cloudflare as: $CLOUDFLARE_EMAIL"
else
    echo "   ${YELLOW}⚠ Not logged in to Cloudflare. Run: npx wrangler login${NC}"
    HAS_ISSUES=1
fi
echo ""

# Check 5: Local D1 database
echo "5. Checking local D1 database..."
if [ -d ".wrangler/state/v3/d1" ]; then
    echo "   ✓ Local D1 database directory exists"
    DB_SIZE=$(du -sh .wrangler/state/v3/d1 2>/dev/null | cut -f1 || echo "unknown")
    echo "   ✓ Database size: $DB_SIZE"
else
    echo "   ${YELLOW}⚠ Local D1 database not initialized. Run: npx wrangler d1 migrations apply polywhaler${NC}"
    HAS_ISSUES=1
fi
echo ""

# Check 6: Database migrations
echo "6. Checking database migrations..."
MIGRATION_COUNT=$(ls -1 migrations/*.sql 2>/dev/null | wc -l)
echo "   ✓ Found $MIGRATION_COUNT migration files"
echo ""

# Check 7: Environment variables and secrets
echo "7. Checking Cloudflare secrets..."
echo "   ${YELLOW}Note: Secrets are stored in Cloudflare and won't show locally${NC}"
echo "   To check/update secrets, use: npx wrangler secret list"
echo "   To set a secret: npx wrangler secret put APP_PASSWORD"
echo ""

# Check 8: Remote database connection
echo "8. Testing remote database connection..."
if npx wrangler d1 execute polywhaler --remote --command "SELECT 1" &> /dev/null; then
    echo "   ✓ Can connect to remote D1 database"
else
    echo "   ${YELLOW}⚠ Cannot connect to remote database (may need authentication)${NC}"
fi
echo ""

# Summary
echo "================================"
if [ $HAS_ISSUES -eq 0 ]; then
    echo "${GREEN}✓ Setup looks good!${NC}"
    echo ""
    echo "Next steps:"
    echo "  • Run migrations: npx wrangler d1 migrations apply polywhaler"
    echo "  • Start dev server: pnpm run dev"
    echo "  • Check secrets: npx wrangler secret list"
else
    echo "${YELLOW}⚠ Some issues found. Please address them above.${NC}"
    echo ""
    echo "Quick setup commands:"
    echo "  • Install dependencies: pnpm install"
    echo "  • Login to Cloudflare: npx wrangler login"
    echo "  • Apply migrations: npx wrangler d1 migrations apply polywhaler"
    echo "  • Start dev: pnpm run dev"
fi
echo ""
