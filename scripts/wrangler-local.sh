#!/usr/bin/env bash

set -euo pipefail

# If the caller already chose a Wrangler config home, respect it.
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
	exec "$@"
fi

STATE_DIR="${PWD}/.wrangler-state"
LOCAL_WRANGLER_DIR="${STATE_DIR}/.wrangler"
GLOBAL_WRANGLER_DIR="${HOME}/.config/.wrangler"

mkdir -p "${LOCAL_WRANGLER_DIR}"

# Seed the repo-local Wrangler config from the user's normal config only on
# first use. Re-copying every run can resurrect stale grants after a fresh
# login has already updated the repo-local state.
if [ -d "${GLOBAL_WRANGLER_DIR}" ] && [ -z "$(ls -A "${LOCAL_WRANGLER_DIR}" 2>/dev/null)" ]; then
	cp -R "${GLOBAL_WRANGLER_DIR}/." "${LOCAL_WRANGLER_DIR}/" 2>/dev/null || true
fi

export XDG_CONFIG_HOME="${STATE_DIR}"

exec "$@"
