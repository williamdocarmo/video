#!/usr/bin/env bash
set -euo pipefail

CONFIG="${CODEX_CONFIG:-/root/.codex/config.toml}"

if [[ ! -f "$CONFIG" ]]; then
  echo "Codex config not found: $CONFIG" >&2
  exit 1
fi

cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"

if grep -q '^sandbox_mode = ' "$CONFIG"; then
  sed -i 's/^sandbox_mode = .*/sandbox_mode = "danger-full-access"/' "$CONFIG"
else
  printf '\nsandbox_mode = "danger-full-access"\n' >> "$CONFIG"
fi

if grep -q '^approval_policy = ' "$CONFIG"; then
  sed -i 's/^approval_policy = .*/approval_policy = "on-request"/' "$CONFIG"
else
  printf 'approval_policy = "on-request"\n' >> "$CONFIG"
fi

echo "Updated $CONFIG"
grep -nE '^(sandbox_mode|approval_policy) = ' "$CONFIG"
