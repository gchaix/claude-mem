#!/usr/bin/env bash
# Redeploy the patched build into the correct cache dir and restart the worker.
#
# Unlike `sync-marketplace`, this deliberately does NOT touch
# ~/.claude/plugins/marketplaces/thedotmack/ — the marketplace clone is
# pinned to our fork and must not be overwritten by rsync mid-flight.
#
# Handles three scenarios automatically:
#   1. Same-version redeploy: rsync into existing cache dir, restart worker.
#   2. Version transition: create new cache dir, update installed_plugins.json,
#      update the /12.4.7 back-compat symlink, clean up old cache dir, restart.
#   3. Fresh install: create cache dir, wire up installed_plugins.json.
#
# Usage:
#   npm run deploy-patched          # normal run
#   npm run deploy-patched -- --dry # print planned actions, don't execute
#   npm run deploy-patched -- --keep-old  # don't delete the previous cache dir
#
# Run from anywhere inside the patched worktree.

set -euo pipefail

DRY=0
KEEP_OLD=0
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run) DRY=1 ;;
    --keep-old)      KEEP_OLD=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if (( DRY )); then
    echo "[dry] $*"
  else
    eval "$@"
  fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(node -p 'require("./plugin/.claude-plugin/plugin.json").version')"
CACHE_BASE="${HOME}/.claude/plugins/cache/thedotmack/claude-mem"
CACHE_DIR="${CACHE_BASE}/${VERSION}"
INSTALLED_PLUGINS="${HOME}/.claude/plugins/installed_plugins.json"
COMPAT_SYMLINK="${CACHE_BASE}/12.4.7"

# Read the version claude-mem@thedotmack currently points at.
# Empty if the entry is missing or malformed.
CURRENT_INSTALLED_VERSION="$(
  node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('${INSTALLED_PLUGINS}','utf8'));
      const e = (d.plugins||{})['claude-mem@thedotmack'];
      if (e && e[0] && e[0].version) console.log(e[0].version);
    } catch (err) { /* stay empty */ }
  " 2>/dev/null || true
)"
CURRENT_INSTALLED_PATH="$(
  node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('${INSTALLED_PLUGINS}','utf8'));
      const e = (d.plugins||{})['claude-mem@thedotmack'];
      if (e && e[0] && e[0].installPath) console.log(e[0].installPath);
    } catch (err) { /* stay empty */ }
  " 2>/dev/null || true
)"

IS_TRANSITION=0
if [[ -n "${CURRENT_INSTALLED_VERSION}" && "${CURRENT_INSTALLED_VERSION}" != "${VERSION}" ]]; then
  IS_TRANSITION=1
fi

echo "==> Patched deploy"
echo "    declared version:  ${VERSION}"
echo "    installed version: ${CURRENT_INSTALLED_VERSION:-<none>}"
echo "    cache dir:         ${CACHE_DIR}"
if (( IS_TRANSITION )); then
  echo "    mode:              VERSION TRANSITION"
elif [[ -z "${CURRENT_INSTALLED_VERSION}" ]]; then
  echo "    mode:              FRESH INSTALL"
else
  echo "    mode:              same-version redeploy"
fi
(( DRY )) && echo "    (dry-run: nothing will be executed)"
echo

# --- Build -------------------------------------------------------------------

echo "==> Building..."
run "npm run build"

# --- Sync to cache dir -------------------------------------------------------

if [[ ! -d "${CACHE_DIR}" ]]; then
  echo "==> Creating new cache dir: ${CACHE_DIR}"
  run "mkdir -p '${CACHE_DIR}'"
fi

echo
echo "==> Rsyncing plugin/ → cache dir..."
run "rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data/' \
  --exclude='data.backup/' \
  plugin/ '${CACHE_DIR}/'"

echo
echo "==> Installing runtime dependencies in cache..."
run "( cd '${CACHE_DIR}' && bun install --silent )"

# --- Verify patched markers before any destructive step ---------------------

echo
echo "==> Verifying patched markers are bundled..."
if (( DRY )); then
  echo "[dry] skipping marker check"
else
  MARKERS=$(grep -c -E 'CLAUDE_MEM_BEDROCK_ENABLED|CLAUDE_MEM_BEDROCK_BASE_URL|OBSERVER_SESSIONS_PROJECT|observer_session' "${CACHE_DIR}/scripts/worker-service.cjs" || echo 0)
  echo "    markers found: ${MARKERS} (expected ≥ 3)"
  if (( MARKERS < 3 )); then
    echo "    ERROR: patched bundle missing expected markers — refusing to continue" >&2
    exit 1
  fi
fi

# --- Mirror into upstream-version dir ---------------------------------------
# When our declared version carries a fork suffix (e.g. 13.2.0-tag1.1), Claude
# Code's plugin-install machinery will still materialize a dir for the bare
# upstream version (e.g. 13.2.0/) and set CLAUDE_PLUGIN_ROOT to it for
# sessions that loaded before our transition landed. Mirror our patched
# content into that dir too so hooks resolving via CLAUDE_PLUGIN_ROOT find
# patched code, not stock upstream.
#
# Preserves Claude-Code-managed metadata (.in_use/, .orphaned_at,
# .install-version) by excluding them from the sync.

UPSTREAM_VERSION="${VERSION%-tag*}"
if [[ "${UPSTREAM_VERSION}" != "${VERSION}" ]]; then
  UPSTREAM_DIR="${CACHE_BASE}/${UPSTREAM_VERSION}"
  echo
  echo "==> Mirroring patched bundle → ${UPSTREAM_DIR} (for CLAUDE_PLUGIN_ROOT compatibility)"
  if [[ -e "${UPSTREAM_DIR}" && ! -d "${UPSTREAM_DIR}" ]]; then
    echo "    WARNING: ${UPSTREAM_DIR} exists and is not a directory — skipping mirror" >&2
  else
    if [[ ! -d "${UPSTREAM_DIR}" ]]; then
      run "mkdir -p '${UPSTREAM_DIR}'"
    fi
    # No --delete: preserves .in_use/, .orphaned_at, .install-version etc.
    run "rsync -a \
      --exclude='.git' \
      --exclude='.in_use/' \
      --exclude='.orphaned_at' \
      --exclude='.install-version' \
      '${CACHE_DIR}/' '${UPSTREAM_DIR}/'"
  fi
fi

# --- Version-transition steps (only if installed version is changing) -------

if (( IS_TRANSITION )) || [[ -z "${CURRENT_INSTALLED_VERSION}" ]]; then
  echo
  echo "==> Updating installed_plugins.json → version ${VERSION}"
  BACKUP="${INSTALLED_PLUGINS}.pre-${VERSION}.bak"
  run "cp '${INSTALLED_PLUGINS}' '${BACKUP}'"

  GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short=8 HEAD)"

  if (( DRY )); then
    echo "[dry] would set installPath=${CACHE_DIR}, version=${VERSION}, gitCommitSha=${GIT_SHA}"
  else
    node -e "
      const fs = require('fs');
      const p = '${INSTALLED_PLUGINS}';
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.plugins['claude-mem@thedotmack']) {
        d.plugins['claude-mem@thedotmack'] = [{
          scope: 'user',
          installedAt: new Date().toISOString(),
        }];
      }
      const entry = d.plugins['claude-mem@thedotmack'][0];
      entry.installPath = '${CACHE_DIR}';
      entry.version = '${VERSION}';
      entry.gitCommitSha = '${GIT_SHA}';
      entry.lastUpdated = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      console.log('    updated: ' + JSON.stringify(entry, null, 2).replace(/\n/g, '\n    '));
    "
  fi

  # --- Back-compat symlink -------------------------------------------------
  # Any stale in-memory path cache from a running Claude Code session may
  # still reference the previous cache dir. Repoint /12.4.7 (the historical
  # baked-in path) at the new version dir so those stale references resolve
  # to current content instead of 404ing hooks.
  echo
  echo "==> Updating /12.4.7 back-compat symlink → ${VERSION}"
  if [[ -L "${COMPAT_SYMLINK}" ]]; then
    run "rm '${COMPAT_SYMLINK}'"
  elif [[ -e "${COMPAT_SYMLINK}" ]]; then
    echo "    WARNING: ${COMPAT_SYMLINK} exists but is not a symlink — leaving it alone" >&2
  fi
  if [[ ! -e "${COMPAT_SYMLINK}" ]] || [[ -L "${COMPAT_SYMLINK}" ]]; then
    run "ln -s '${VERSION}' '${COMPAT_SYMLINK}'"
  fi

  # --- Clean up old cache dir ----------------------------------------------
  # NOTE: Claude Code sessions loaded before this transition keep
  # CLAUDE_PLUGIN_ROOT pointing at the OLD cache dir. Deleting it would make
  # their hooks 404. We previously ran with a global --keep-old default; now
  # we replace the old dir with a symlink to the new one so stale references
  # resolve instead of breaking. Skipped entirely with --keep-old for users
  # who want to keep old dirs intact (e.g. for rollback testing).
  if (( IS_TRANSITION )) && (( ! KEEP_OLD )); then
    OLD_DIR="${CACHE_BASE}/${CURRENT_INSTALLED_VERSION}"
    if [[ -d "${OLD_DIR}" && ! -L "${OLD_DIR}" ]]; then
      echo
      echo "==> Replacing old cache dir with symlink: ${OLD_DIR} → ${VERSION}"
      echo "    (use --keep-old to preserve the old dir as a full copy)"
      # Mirror any Claude-Code metadata markers out first, then remove dir
      # contents, then symlink. We do NOT attempt to preserve .in_use markers
      # here because the old dir's PIDs reference sessions whose PLUGIN_ROOT
      # is baked at startup — a symlink replacement is transparent to them.
      run "rm -rf '${OLD_DIR}'"
      run "ln -s '${VERSION}' '${OLD_DIR}'"
    fi
  fi
fi

# --- Worker restart ----------------------------------------------------------

echo
echo "==> Triggering worker restart..."
SETTINGS_PATH="${HOME}/.claude-mem/settings.json"
WORKER_PORT=""
if [[ -f "${SETTINGS_PATH}" ]]; then
  WORKER_PORT=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('${SETTINGS_PATH}','utf8')).CLAUDE_MEM_WORKER_PORT || '') } catch { console.log('') }")
fi
if [[ -z "${WORKER_PORT}" ]]; then
  WORKER_PORT=$((37700 + $(id -u) % 100))
fi

if (( DRY )); then
  echo "[dry] would POST /api/admin/restart on port ${WORKER_PORT}"
else
  if curl --silent --fail --max-time 3 -X POST "http://127.0.0.1:${WORKER_PORT}/api/admin/restart" > /dev/null; then
    echo "    restart triggered on port ${WORKER_PORT}"
  else
    echo "    no worker reachable on port ${WORKER_PORT} (it may already be down; the next hook fire will spawn a new one)"
  fi
fi

echo
echo "==> Deploy complete."
if (( IS_TRANSITION )); then
  echo "    transitioned ${CURRENT_INSTALLED_VERSION} → ${VERSION}"
  if (( ! KEEP_OLD )); then
    echo "    old cache dir symlinked to ${VERSION} (use --keep-old to preserve old copy)"
  fi
  echo "    installed_plugins.json backup: ${INSTALLED_PLUGINS}.pre-${VERSION}.bak"
fi
if [[ "${UPSTREAM_VERSION}" != "${VERSION}" ]]; then
  echo "    mirrored patched bundle into ${CACHE_BASE}/${UPSTREAM_VERSION} for CLAUDE_PLUGIN_ROOT compat"
fi
