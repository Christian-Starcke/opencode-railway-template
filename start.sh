#!/bin/sh
set -e

# Monitoring feature toggle, disabled by default
# Actual monitor startup logic moved to server.js and runs after OpenCode is ready
export ENABLE_MONITOR="${ENABLE_MONITOR:-false}"

# Enable OpenCode's Railway sleep-friendly behavior by default.
export OPENCODE_RAILWAY_SLEEP_MODE="${OPENCODE_RAILWAY_SLEEP_MODE:-true}"

# Allow injecting extra PATH entries via Railway dashboard env var
# Set PREPEND_PATH in Railway dashboard to e.g. /data/.steel/bin:/data/.railway/bin
if [ -n "${PREPEND_PATH:-}" ]; then
  export PATH="${PREPEND_PATH}:${PATH}"
fi

# Update globally installed skills on each deploy (enabled by default)
# Set SKILLS_UPDATE_ON_START=false to disable
if [ "${SKILLS_UPDATE_ON_START:-true}" != "false" ]; then
  echo "[skills] Updating global skills..."
  npx skills update -g 2>&1 || echo "[skills] WARNING: Skills update failed, continuing anyway..."
fi

exec node /app/server.js
