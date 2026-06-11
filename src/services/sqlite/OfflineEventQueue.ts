// SPDX-License-Identifier: Apache-2.0
//
// Lightweight WAL buffer for server-beta hook events that could not be
// delivered because the remote worker (sonic) was unreachable.
//
// Design constraints:
//   - Must be openable directly from a hook process (no worker required).
//   - No foreign-key dependencies on sdk_sessions or any other table.
//   - Payload is stored as raw JSON so the drain path can replay it without
//     knowing the event type at write time.
//   - Uses Bun's synchronous SQLite API so hooks (which are sync-ish
//     processes) can write without spawning async infrastructure.

import { Database } from 'bun:sqlite';
import { DB_PATH, DATA_DIR } from '../../shared/paths.js';
import { ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export type OfflineEventType =
  | 'session_start'
  | 'tool_use'
  | 'assistant_message'
  | 'session_end';

export interface OfflineEvent {
  id: number;
  event_type: OfflineEventType;
  /** ISO timestamp of when the hook ran (not when it will be delivered). */
  occurred_at_epoch: number;
  /** Serialized JSON of the original payload passed to ServerBetaClient. */
  payload: string;
  /** Number of delivery attempts made so far. */
  attempt_count: number;
  /** Epoch of last delivery attempt, or null if never tried. */
  last_attempt_epoch: number | null;
  /** Short human-readable reason the last attempt failed, for diagnostics. */
  last_error: string | null;
}

const MAX_ATTEMPTS = 10;
// Rows older than 72 h are considered stale and purged on open.
const STALE_WINDOW_MS = 72 * 60 * 60 * 1000;

let singleton: OfflineEventQueue | null = null;

export class OfflineEventQueue {
  private db: Database;

  constructor(dbPath: string = DB_PATH) {
    ensureDir(DATA_DIR);
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = OFF');
    this.ensureSchema();
    this.purgeStale();
  }

  static shared(): OfflineEventQueue {
    if (!singleton) {
      singleton = new OfflineEventQueue();
    }
    return singleton;
  }

  /** Reset the singleton (used in tests). */
  static resetShared(): void {
    singleton?.close();
    singleton = null;
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS offline_event_queue (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type         TEXT    NOT NULL,
        occurred_at_epoch  INTEGER NOT NULL,
        payload            TEXT    NOT NULL,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        last_attempt_epoch INTEGER,
        last_error         TEXT
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_offline_event_queue_epoch
        ON offline_event_queue(occurred_at_epoch ASC)
    `);
  }

  private purgeStale(): void {
    const cutoff = Date.now() - STALE_WINDOW_MS;
    const result = this.db.prepare(`
      DELETE FROM offline_event_queue WHERE occurred_at_epoch < ?
    `).run(cutoff);
    if (result.changes > 0) {
      logger.info('OFFLINE_QUEUE', `Purged ${result.changes} stale events older than 72h`);
    }
  }

  enqueue(eventType: OfflineEventType, payload: unknown): number {
    const result = this.db.prepare(`
      INSERT INTO offline_event_queue (event_type, occurred_at_epoch, payload)
      VALUES (?, ?, ?)
    `).run(eventType, Date.now(), JSON.stringify(payload));
    const id = result.lastInsertRowid as number;
    logger.debug('OFFLINE_QUEUE', `Enqueued offline event`, { id, eventType });
    return id;
  }

  /**
   * Claim up to `limit` events for delivery, ordered by insertion time.
   * Only returns events that have not exceeded MAX_ATTEMPTS.
   */
  peekDeliverable(limit = 50): OfflineEvent[] {
    return this.db.prepare(`
      SELECT * FROM offline_event_queue
      WHERE attempt_count < ?
      ORDER BY occurred_at_epoch ASC
      LIMIT ?
    `).all(MAX_ATTEMPTS, limit) as OfflineEvent[];
  }

  /** Count events waiting for delivery. */
  pendingCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM offline_event_queue WHERE attempt_count < ?
    `).get(MAX_ATTEMPTS) as { n: number };
    return row.n;
  }

  markDelivered(id: number): void {
    this.db.prepare(`DELETE FROM offline_event_queue WHERE id = ?`).run(id);
    logger.debug('OFFLINE_QUEUE', `Delivered and removed event`, { id });
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE offline_event_queue
         SET attempt_count      = attempt_count + 1,
             last_attempt_epoch = ?,
             last_error         = ?
       WHERE id = ?
    `).run(Date.now(), error.substring(0, 500), id);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore errors on close
    }
  }
}
