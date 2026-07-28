#!/bin/sh
# Orchestrator P1 — clone/checkout user repo into the OpenCode workspace volume.
# Invoked from start.sh when ORCHESTRATOR_CHECKOUT_URL is set.
# Contract: ORCHESTRATOR_CHECKOUT_URL, _BRANCH, _BASE, _PATH (+ optional ORCHESTRATOR_MANAGED_GIT_TOKEN).
set -eu

CHECKOUT_URL="${ORCHESTRATOR_CHECKOUT_URL:-}"
if [ -z "$CHECKOUT_URL" ]; then
  exit 0
fi

CHECKOUT_PATH="${ORCHESTRATOR_CHECKOUT_PATH:-${OPENCODE_WORKSPACE:-${OPENCODE_WORKSPACE_PATH:-/data/workspace}}}"
CHECKOUT_BRANCH="${ORCHESTRATOR_CHECKOUT_BRANCH:-}"
CHECKOUT_BASE="${ORCHESTRATOR_CHECKOUT_BASE:-main}"
TOKEN="${ORCHESTRATOR_MANAGED_GIT_TOKEN:-}"

mkdir -p /data/logs
LOG="/data/logs/orchestrator-checkout.log"

log() {
  echo "[orch-checkout] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

auth_url() {
  url="$1"
  if [ -z "$TOKEN" ]; then
    printf '%s' "$url"
    return
  fi
  case "$url" in
    https://*)
      rest="${url#https://}"
      printf 'https://x-access-token:%s@%s' "$TOKEN" "$rest"
      ;;
    http://*)
      rest="${url#http://}"
      printf 'http://x-access-token:%s@%s' "$TOKEN" "$rest"
      ;;
    *)
      printf '%s' "$url"
      ;;
  esac
}

CLONE_URL="$(auth_url "$CHECKOUT_URL")"

log "path=$CHECKOUT_PATH base=$CHECKOUT_BASE branch=${CHECKOUT_BRANCH:-none}"

if [ ! -d "$CHECKOUT_PATH/.git" ]; then
  rm -rf "$CHECKOUT_PATH"
  mkdir -p "$(dirname "$CHECKOUT_PATH")"
  log "cloning $CHECKOUT_URL -> $CHECKOUT_PATH"
  if ! git clone --depth 1 --branch "$CHECKOUT_BASE" "$CLONE_URL" "$CHECKOUT_PATH" >>"$LOG" 2>&1; then
    log "shallow clone of base failed; trying full clone + checkout base"
    rm -rf "$CHECKOUT_PATH"
    git clone "$CLONE_URL" "$CHECKOUT_PATH" >>"$LOG" 2>&1
    git -C "$CHECKOUT_PATH" checkout "$CHECKOUT_BASE" >>"$LOG" 2>&1 || \
      git -C "$CHECKOUT_PATH" checkout -B "$CHECKOUT_BASE" "origin/$CHECKOUT_BASE" >>"$LOG" 2>&1
  fi
else
  log "existing git dir; fetching"
  git -C "$CHECKOUT_PATH" remote set-url origin "$CLONE_URL" >>"$LOG" 2>&1 || true
  git -C "$CHECKOUT_PATH" fetch --depth 1 origin "$CHECKOUT_BASE" >>"$LOG" 2>&1 || \
    git -C "$CHECKOUT_PATH" fetch origin >>"$LOG" 2>&1 || true
fi

if [ -n "$CHECKOUT_BRANCH" ]; then
  if git -C "$CHECKOUT_PATH" rev-parse --verify "$CHECKOUT_BRANCH" >/dev/null 2>&1; then
    log "checking out existing branch $CHECKOUT_BRANCH"
    git -C "$CHECKOUT_PATH" checkout "$CHECKOUT_BRANCH" >>"$LOG" 2>&1
  elif git -C "$CHECKOUT_PATH" rev-parse --verify "origin/$CHECKOUT_BRANCH" >/dev/null 2>&1; then
    log "checking out remote branch $CHECKOUT_BRANCH"
    git -C "$CHECKOUT_PATH" checkout -B "$CHECKOUT_BRANCH" "origin/$CHECKOUT_BRANCH" >>"$LOG" 2>&1
  else
    log "creating branch $CHECKOUT_BRANCH from $CHECKOUT_BASE"
    git -C "$CHECKOUT_PATH" checkout -B "$CHECKOUT_BRANCH" "$CHECKOUT_BASE" >>"$LOG" 2>&1 || \
      git -C "$CHECKOUT_PATH" checkout -B "$CHECKOUT_BRANCH" "origin/$CHECKOUT_BASE" >>"$LOG" 2>&1
  fi
fi

# Drop token from remote URL after clone/fetch so it is not persisted in .git/config.
if [ -n "$TOKEN" ]; then
  git -C "$CHECKOUT_PATH" remote set-url origin "$CHECKOUT_URL" >>"$LOG" 2>&1 || true
fi

HEAD_SHA="$(git -C "$CHECKOUT_PATH" rev-parse --short HEAD 2>/dev/null || echo unknown)"
HEAD_BR="$(git -C "$CHECKOUT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
log "done HEAD=$HEAD_SHA branch=$HEAD_BR"
