#!/usr/bin/env bash
# queue-status.sh - Show pending_messages queue status with box-drawing table
set -euo pipefail

DB="${CLAUDE_MEM_DATA_DIR:-${HOME}/.claude-mem}/claude-mem.db"

if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 is not installed." >&2
  exit 1
fi

if [ ! -f "$DB" ]; then
  echo "Error: Database not found at $DB" >&2
  exit 1
fi

echo "=== Queue Status ==="
sqlite3 -box "$DB" "SELECT status, COUNT(*) AS count FROM pending_messages GROUP BY status ORDER BY status;"
