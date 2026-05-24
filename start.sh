#!/bin/sh
set -e

# Monitoring feature toggle, disabled by default
# Actual monitor startup logic moved to server.js and runs after OpenCode is ready
export ENABLE_MONITOR="${ENABLE_MONITOR:-false}"
export SOURCE_MODE="${SOURCE_MODE:-true}"

# Allow injecting extra PATH entries via Railway dashboard env var
# Set PREPEND_PATH in Railway dashboard to e.g. /data/.steel/bin:/data/.railway/bin
if [ -n "${PREPEND_PATH:-}" ]; then
  export PATH="${PREPEND_PATH}:${PATH}"
fi

exec node /app/server.js
