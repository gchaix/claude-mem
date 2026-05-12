import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/services/sqlite/SessionStore.ts';

test('fresh DB: pending_messages supports failed status + retry_count', () => {
  const db = new Database(':memory:');
  new SessionStore(db);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_messages'").get() as { sql: string };
  expect(schema.sql).toContain("'failed'");

  const cols = db.query('PRAGMA table_info(pending_messages)').all() as Array<{name: string}>;
  expect(cols.some(c => c.name === 'retry_count')).toBe(true);
  expect(cols.some(c => c.name === 'completed_at_epoch')).toBe(true);

  db.run("INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch) VALUES ('test-session', 'p', 'x', 'now', 0)");
  expect(() => {
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, retry_count, created_at_epoch) VALUES (?, ?, 'observation', 'failed', 2, ?)`, 1, 'test-session', Date.now());
  }).not.toThrow();
  db.close();
});

test('upgrade from v13.1.0-baseline DB: preserves rows, adds failed + retry_count', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT UNIQUE NOT NULL, memory_session_id TEXT UNIQUE, project TEXT, platform_source TEXT DEFAULT 'claude', user_prompt TEXT, started_at TEXT, started_at_epoch INTEGER, completed_at TEXT, completed_at_epoch INTEGER, status TEXT DEFAULT 'active')`);
  db.run(`CREATE TABLE pending_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER NOT NULL, content_session_id TEXT NOT NULL, tool_use_id TEXT, message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')), tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT, last_user_message TEXT, last_assistant_message TEXT, prompt_number INTEGER, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')), created_at_epoch INTEGER NOT NULL, agent_type TEXT, agent_id TEXT, FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE)`);
  for (const v of [4,5,6,7,8,9,10,11,16,17,20,21,23,25,27,29,30,31,32,34]) {
    db.run(`INSERT INTO schema_versions (version, applied_at) VALUES (${v}, 'test')`);
  }
  db.run("INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch) VALUES ('old-session', 'p', 'x', 'now', 0)");
  db.run("INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (1, 'old-session', 'observation', 'pending', 0)");

  new SessionStore(db);

  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_messages'").get() as { sql: string };
  expect(schema.sql).toContain("'failed'");

  const count = (db.prepare("SELECT COUNT(*) as c FROM pending_messages").get() as {c: number}).c;
  expect(count).toBe(1);

  const cols = db.query('PRAGMA table_info(pending_messages)').all() as Array<{name: string}>;
  expect(cols.some(c => c.name === 'retry_count')).toBe(true);
  db.close();
});
