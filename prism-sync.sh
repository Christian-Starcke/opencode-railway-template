#!/bin/sh
# prism-sync: git pull all repos under the workspace directory
set -e

WORKSPACE="${OPENCODE_WORKSPACE:-/data/workspace}"

if [ ! -d "$WORKSPACE" ]; then
  echo "[prism-sync] Workspace $WORKSPACE does not exist, skipping"
  exit 0
fi

cd "$WORKSPACE"

# Check if the workspace root is a git repo
if [ -d ".git" ]; then
  echo "[prism-sync] Pulling workspace root repo..."
  git pull --ff-only --prune 2>&1 | sed 's/^/[prism-sync]   /'
fi

# Pull all subdirectory repos
for dir in */; do
  [ -d "${dir}.git" ] || continue
  repo_name="${dir%/}"
  echo "[prism-sync] Pulling ${repo_name}..."
  (cd "$repo_name" && git pull --ff-only --prune 2>&1) | sed 's/^/[prism-sync]   /'
done

echo "[prism-sync] Done"
