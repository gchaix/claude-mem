#!/usr/bin/env bash
# Redeploy the patched v13.1.0-tag1.1 build into the active cache dir and
# restart the worker. Unlike `sync-marketplace`, this deliberately does NOT
# touch ~/.claude/plugins/marketplaces/thedotmack/ — the marketplace clone
# is pinned to our fork and must not be overwritten by rsync mid-flight.
#
# Run from the root of the patched worktree:
#   npm run deploy-patched

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(node -p 'require("./plugin/.claude-plugin/plugin.json").version')"
CACHE_BASE="${HOME}/.claude/plugins/cache/thedotmack/claude-mem"
CACHE_DIR="${CACHE_BASE}/${VERSION}"

echo "==> Patched deploy — version ${VERSION}"
echo "    cache dir: ${CACHE_DIR}"
echo

echo "==> Building..."
npm run build

if [[ ! -d "${CACHE_DIR}" ]]; then
  echo "==> Cache dir missing; creating: ${CACHE_DIR}"
  mkdir -p "${CACHE_DIR}"
fi

echo
echo "==> Rsyncing plugin/ → cache dir..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data/' \
  --exclude='data.backup/' \
  plugin/ "${CACHE_DIR}/"

echo
echo "==> Installing runtime dependencies in cache..."
( cd "${CACHE_DIR}" && bun install --silent )

echo
echo "==> Verifying patched markers are bundled..."
MARKERS=$(grep -c -E 'CLAUDE_MEM_BEDROCK|rateLimitBackoffCount|hydrateOrphan|triageFailedMessages|pending_messages_m35' "${CACHE_DIR}/scripts/worker-service.cjs" || echo 0)
echo "    markers found: ${MARKERS} (expected ≥ 5)"
if (( MARKERS < 5 )); then
  echo "    ERROR: patched bundle missing expected markers — refusing to restart worker" >&2
  exit 1
fi

echo
echo "==> Triggering worker restart..."
SETTINGS_PATH="${HOME}/.claude-mem/settings.json"
if [[ -f "${SETTINGS_PATH}" ]]; then
  WORKER_PORT=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('${SETTINGS_PATH}','utf8')).CLAUDE_MEM_WORKER_PORT || '') } catch { console.log('') }")
fi
if [[ -z "${WORKER_PORT:-}" ]]; then
  WORKER_PORT=$((37700 + $(id -u) % 100))
fi

if curl --silent --fail --max-time 3 -X POST "http://127.0.0.1:${WORKER_PORT}/api/admin/restart" > /dev/null; then
  echo "    restart triggered on port ${WORKER_PORT}"
else
  echo "    no worker reachable on port ${WORKER_PORT} (it may already be down or on a different port)"
fi

echo
echo "==> Deploy complete. The new worker should be up within ~2s on port ${WORKER_PORT}."
