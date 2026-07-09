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

# One-shot flatten: remove nested .git clones under /data/workspace (SSH unreliable).
# Set OPENCODE_FLATTEN_WORKSPACE=true for one deploy, then delete the variable.
if [ "${OPENCODE_FLATTEN_WORKSPACE:-}" = "true" ]; then
  mkdir -p /data/logs
  FLATTEN_LOG="/data/logs/flatten-workspace.log"
  {
    echo "[flatten] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"
    WS="${OPENCODE_WORKSPACE:-/data/workspace}"
    if [ ! -d "${WS}/.git" ]; then
      echo "[flatten] skip: ${WS}/.git missing (expected n8n-as-code root)"
    else
      for dir in "${WS}"/*/; do
        [ -d "$dir" ] || continue
        if [ -d "${dir}.git" ]; then
          echo "[flatten] removing nested git clone: $dir"
          rm -rf "$dir"
        fi
      done
      WT="/data/.local/share/opencode/worktree"
      if [ -d "$WT" ]; then
        echo "[flatten] clearing stale worktrees under $WT"
        rm -rf "${WT:?}"/*
      fi
    fi
    echo "[flatten] done — delete OPENCODE_FLATTEN_WORKSPACE after this deploy"
  } >> "$FLATTEN_LOG" 2>&1 || true
fi

# Update globally installed skills on each deploy (enabled by default)
# Set SKILLS_UPDATE_ON_START=false to disable
if [ "${SKILLS_UPDATE_ON_START:-true}" != "false" ]; then
  echo "[skills] Updating global skills..."
  npx skills update -g 2>&1 || echo "[skills] WARNING: Skills update failed, continuing anyway..."
fi

exec node /app/server.js
