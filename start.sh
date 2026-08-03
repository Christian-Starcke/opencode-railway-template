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

# Orchestrator P1 — checkout user repo when ORCHESTRATOR_CHECKOUT_URL is set.
# Align OpenCode cwd env names (template uses OPENCODE_WORKSPACE; Orchestrator injects PATH).
CHECKOUT_PATH="${ORCHESTRATOR_CHECKOUT_PATH:-${OPENCODE_WORKSPACE:-${OPENCODE_WORKSPACE_PATH:-/data/workspace}}}"
export OPENCODE_WORKSPACE="${CHECKOUT_PATH}"
export OPENCODE_WORKSPACE_PATH="${CHECKOUT_PATH}"
if [ -n "${ORCHESTRATOR_CHECKOUT_URL:-}" ]; then
  if [ -f /app/orchestrator-checkout.sh ]; then
    sh /app/orchestrator-checkout.sh
  else
    echo "[orch-checkout] WARNING: ORCHESTRATOR_CHECKOUT_URL set but /app/orchestrator-checkout.sh missing"
  fi
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

# One-shot: remove non-essential workspace dirs (SSH unreliable).
# Set OPENCODE_CLEANUP_DIRS=true for one deploy, then delete the variable.
if [ "${OPENCODE_CLEANUP_DIRS:-}" = "true" ]; then
  mkdir -p /data/logs
  CLEANUP_LOG="/data/logs/cleanup-dirs.log"
  {
    echo "[cleanup] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"
    WS="${OPENCODE_WORKSPACE:-/data/workspace}"
    for name in data retell scripts supabase; do
      target="${WS}/${name}"
      if [ -e "$target" ]; then
        echo "[cleanup] removing $target"
        rm -rf "$target"
      else
        echo "[cleanup] skip missing $target"
      fi
    done
    echo "[cleanup] done — delete OPENCODE_CLEANUP_DIRS after this deploy"
  } >> "$CLEANUP_LOG" 2>&1 || true
fi

# One-shot: reset OpenCode SQLite DB (keeps workspace repos).
# Needed when a newer OpenCode migrated the DB (e.g. session_message.seq)
# and an older runtime like v1.14.x cannot write prompts.
# Set OPENCODE_RESET_DB=true for one deploy, then delete the variable.
if [ "${OPENCODE_RESET_DB:-}" = "true" ]; then
  mkdir -p /data/logs /data/.local/share/opencode/backups
  RESET_LOG="/data/logs/reset-opencode-db.log"
  {
    echo "[reset-db] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"
    DB_DIR="/data/.local/share/opencode"
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    for f in "${DB_DIR}"/opencode.db "${DB_DIR}"/opencode.db-wal "${DB_DIR}"/opencode.db-shm; do
      if [ -e "$f" ]; then
        base="$(basename "$f")"
        echo "[reset-db] backing up $f -> ${DB_DIR}/backups/${base}.${STAMP}"
        cp -a "$f" "${DB_DIR}/backups/${base}.${STAMP}" || true
        echo "[reset-db] removing $f"
        rm -f "$f"
      else
        echo "[reset-db] skip missing $f"
      fi
    done
    echo "[reset-db] done — delete OPENCODE_RESET_DB after this deploy"
  } >> "$RESET_LOG" 2>&1 || true
fi

# Update globally installed skills on each deploy (enabled by default)
# Set SKILLS_UPDATE_ON_START=false to disable
if [ "${SKILLS_UPDATE_ON_START:-true}" != "false" ]; then
  echo "[skills] Updating global skills..."
  npx skills update -g 2>&1 || echo "[skills] WARNING: Skills update failed, continuing anyway..."
fi

# R3 — Orchestrator runner-agent sidecar (heartbeat + pending → harness → CP ingest).
# Bootstrapped when provision injects ORCHESTRATOR_RUNNER_TOKEN + ORCHESTRATOR_API_URL.
# Downloads entry from CP so the agent script stays source-of-truth in Orchestrator.
if [ -n "${ORCHESTRATOR_RUNNER_TOKEN:-}" ] && [ -n "${ORCHESTRATOR_API_URL:-}" ]; then
  mkdir -p /data/logs
  AGENT_JS="${ORCHESTRATOR_AGENT_PATH:-/data/runner-agent-entry.mjs}"
  BOOTSTRAP_URL="${ORCHESTRATOR_API_URL%/}/api/runner/bootstrap"
  if curl -fsS -m 45 "$BOOTSTRAP_URL" -o "$AGENT_JS"; then
    export ORCHESTRATOR_AGENT="${ORCHESTRATOR_AGENT:-opencode}"
    # Prefer loopback; Railway sets PORT for the OpenCode wrapper.
    if [ -z "${RUNTIME_URL:-}" ] && [ -n "${PORT:-}" ]; then
      export RUNTIME_URL="http://127.0.0.1:${PORT}"
    fi
    nohup node "$AGENT_JS" >> /data/logs/runner-agent.log 2>&1 &
    echo "[runner-agent] started pid=$! log=/data/logs/runner-agent.log from $BOOTSTRAP_URL"
  else
    echo "[runner-agent] WARNING: bootstrap download failed ($BOOTSTRAP_URL); continuing without sidecar"
  fi
fi

exec node /app/server.js
