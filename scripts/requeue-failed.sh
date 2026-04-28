#!/usr/bin/env bash
# requeue-failed.sh - Triage failed pending_messages: requeue salvageable, delete the rest
#
# Usage:
#   ./scripts/requeue-failed.sh          # Triage with defaults (48h cutoff, 5 max retries)
#   ./scripts/requeue-failed.sh --all    # Requeue ALL failed messages (bypass triage)
#   ./scripts/requeue-failed.sh --dry    # Show what would happen without changing anything

set -euo pipefail

WORKER_URL="http://localhost:${CLAUDE_MEM_WORKER_PORT:-37777}"
DB="${CLAUDE_MEM_DATA_DIR:-${HOME}/.claude-mem}/claude-mem.db"
MAX_RETRIES=5
MAX_AGE_HOURS=48
MODE="triage"

for arg in "$@"; do
  case "$arg" in
    --all) MODE="all" ;;
    --dry) MODE="dry" ;;
  esac
done

if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 is not installed." >&2
  exit 1
fi

if [ ! -f "$DB" ]; then
  echo "Error: Database not found at $DB" >&2
  exit 1
fi

echo "=== Failed Message Triage ==="
echo ""

FAILED_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE status = 'failed';")

if [ "$FAILED_COUNT" -eq 0 ]; then
  echo "No failed messages."
  exit 0
fi

# Show breakdown
echo "Failed messages by session and type:"
sqlite3 -box "$DB" "
  SELECT pm.session_db_id as session, s.project, pm.message_type as type,
         pm.retry_count as retries, count(*) as count,
         datetime(min(pm.created_at_epoch)/1000, 'unixepoch', 'localtime') as oldest,
         datetime(max(pm.created_at_epoch)/1000, 'unixepoch', 'localtime') as newest
  FROM pending_messages pm
  LEFT JOIN sdk_sessions s ON pm.session_db_id = s.id
  WHERE pm.status = 'failed'
  GROUP BY pm.session_db_id, pm.message_type, pm.retry_count
  ORDER BY count DESC
"
echo ""

CUTOFF_EPOCH=$(( $(date +%s) * 1000 - MAX_AGE_HOURS * 3600 * 1000 ))
SALVAGEABLE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE status = 'failed' AND retry_count < $MAX_RETRIES AND created_at_epoch > $CUTOFF_EPOCH;")
UNSALVAGEABLE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE status = 'failed' AND (retry_count >= $MAX_RETRIES OR created_at_epoch <= $CUTOFF_EPOCH);")

echo "Triage (${MAX_AGE_HOURS}h cutoff, max ${MAX_RETRIES} retries):"
echo "  Salvageable (will requeue): $SALVAGEABLE"
echo "  Unsalvageable (will delete): $UNSALVAGEABLE"
echo ""

if [ "$MODE" = "dry" ]; then
  echo "[DRY RUN] No changes made."
  exit 0
fi

if [ "$MODE" = "all" ]; then
  sqlite3 "$DB" "UPDATE pending_messages SET status = 'pending', retry_count = 0, worker_pid = NULL WHERE status = 'failed';"
  echo "Requeued all $FAILED_COUNT failed message(s)."
else
  if [ "$SALVAGEABLE" -gt 0 ]; then
    sqlite3 "$DB" "UPDATE pending_messages SET status = 'pending', worker_pid = NULL WHERE status = 'failed' AND retry_count < $MAX_RETRIES AND created_at_epoch > $CUTOFF_EPOCH;"
    echo "Requeued $SALVAGEABLE salvageable message(s)."
  fi
  if [ "$UNSALVAGEABLE" -gt 0 ]; then
    sqlite3 "$DB" "DELETE FROM pending_messages WHERE status = 'failed' AND (retry_count >= $MAX_RETRIES OR created_at_epoch <= $CUTOFF_EPOCH);"
    echo "Deleted $UNSALVAGEABLE unsalvageable message(s)."
  fi
fi

echo ""
echo "=== Queue Status (after) ==="
sqlite3 -box "$DB" "SELECT status, COUNT(*) as count FROM pending_messages GROUP BY status ORDER BY status;"

# Check if worker is running and notify
if curl -sf "${WORKER_URL}/api/health" >/dev/null 2>&1; then
  echo ""
  echo "Worker is running. Requeued messages will be picked up on the next hook event or worker restart."
else
  echo ""
  echo "Worker is not running. Start it to process requeued messages."
fi
