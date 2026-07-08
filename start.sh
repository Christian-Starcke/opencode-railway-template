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

# Volume maintenance + workspace bootstrap (scripts on /data volume; hermes-agent-railway)
mkdir -p /data/logs
if [ -x /data/workspace-bootstrap.sh ]; then
  bash /data/workspace-bootstrap.sh >> /data/logs/workspace-bootstrap.log 2>&1 || true
elif [ -n "${OPENCODE_BOOTSTRAP_RAW_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  curl -fsSL "${OPENCODE_BOOTSTRAP_RAW_URL}" | bash >> /data/logs/workspace-bootstrap.log 2>&1 || true
else
  [ -x /data/opencode-volume-maintain.sh ] && bash /data/opencode-volume-maintain.sh >> /data/logs/volume-maintain.log 2>&1 || true
  [ -x /data/opencode-mcp-bootstrap.sh ] && bash /data/opencode-mcp-bootstrap.sh >> /data/logs/mcp-bootstrap.log 2>&1 || true
  if [ -x /data/prism-workspace-bootstrap.sh ]; then
    WORKSPACE_BOOTSTRAP=true OPENCODE_WORKSPACE=/data/workspace bash /data/prism-workspace-bootstrap.sh >> /data/logs/workspace-bootstrap.log 2>&1 || true
  fi
fi

# Update globally installed skills on each deploy (enabled by default)
# Set SKILLS_UPDATE_ON_START=false to disable
if [ "${SKILLS_UPDATE_ON_START:-true}" != "false" ]; then
  echo "[skills] Updating global skills..."
  npx skills update -g 2>&1 || echo "[skills] WARNING: Skills update failed, continuing anyway..."
fi

# Sync workspace repos — pull latest from all git repos under the workspace
# Runs on every start/deploy. Skips silently if prism-sync.sh isn't present.
if [ -x /app/prism-sync.sh ]; then
  /app/prism-sync.sh 2>&1 || echo "[prism-sync] WARNING: Sync failed, continuing anyway..."
fi

exec node /app/server.js
