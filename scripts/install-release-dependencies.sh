#!/usr/bin/env bash
set -euo pipefail

: "${ANTIGRAVITY_SOURCE_TOKEN:?Set the read-only ANTIGRAVITY_SOURCE_TOKEN Actions secret}"
auth=$(printf 'x-access-token:%s' "$ANTIGRAVITY_SOURCE_TOKEN" | base64 | tr -d '\n')
printf '::add-mask::%s\n' "$auth"
unset ANTIGRAVITY_SOURCE_TOKEN

GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.https://github.com/kid7st/pi-antigravity.git.extraHeader \
  GIT_CONFIG_VALUE_0="Authorization: Basic $auth" \
  npm ci --ignore-scripts --no-audit --no-fund
npm rebuild
