#!/usr/bin/env bash

set -euo pipefail

STATE_DIR="${PWD}/.wrangler-state"
LOCAL_WRANGLER_DIR="${STATE_DIR}/.wrangler"
GLOBAL_WRANGLER_DIR="${HOME}/.config/.wrangler"

mkdir -p "${LOCAL_WRANGLER_DIR}"

# Seed the repo-local Wrangler config from the user's normal config so
# OAuth/session-based auth still works while keeping logs/config writes
# inside the writable workspace.
if [ -d "${GLOBAL_WRANGLER_DIR}" ]; then
	cp -R "${GLOBAL_WRANGLER_DIR}/." "${LOCAL_WRANGLER_DIR}/" 2>/dev/null || true
fi

export XDG_CONFIG_HOME="${STATE_DIR}"

exec "$@"
