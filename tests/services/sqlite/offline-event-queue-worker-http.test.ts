// Tag1 worker-path offline queue: verifies the `worker_http` event type round-trips
// a buffered { url, method, body } worker request and that the drain-facing API
// (peekDeliverable / markDelivered / markFailed / pendingCount) behaves as the
// worker drain in worker-utils.ts depends on.

import { describe, it, expect, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { OfflineEventQueue } from '../../../src/services/sqlite/OfflineEventQueue.js';

describe('OfflineEventQueue worker_http (tag1 worker-path offline queue)', () => {
  const dbPath = join(tmpdir(), `cm-offline-worker-http-${process.pid}.db`);
  let q: OfflineEventQueue | undefined;

  afterEach(() => {
    q?.close();
    q = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('self-creates its table and round-trips a worker_http request, then drains by id', () => {
    q = new OfflineEventQueue(dbPath);
    const req = {
      url: '/api/sessions/observations',
      method: 'POST',
      body: { contentSessionId: 's1', tool_name: 'write_file', hostname: 'roger' },
    };
    q.enqueue('worker_http', req);
    expect(q.pendingCount()).toBe(1);

    const events = q.peekDeliverable(10);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('worker_http');
    // The drain parses payload back into the exact request it will replay.
    expect(JSON.parse(events[0].payload)).toEqual(req);

    q.markDelivered(events[0].id);
    expect(q.pendingCount()).toBe(0);
    expect(q.peekDeliverable(10)).toHaveLength(0);
  });

  it('preserves oldest-first order across multiple buffered requests', () => {
    q = new OfflineEventQueue(dbPath);
    q.enqueue('worker_http', { url: '/api/sessions/init', method: 'POST', body: { n: 1 } });
    q.enqueue('worker_http', { url: '/api/sessions/observations', method: 'POST', body: { n: 2 } });
    q.enqueue('worker_http', { url: '/api/sessions/summarize', method: 'POST', body: { n: 3 } });

    const order = q.peekDeliverable(10).map(e => (JSON.parse(e.payload).body.n));
    expect(order).toEqual([1, 2, 3]);
  });

  it('markFailed increments attempts and abandons a poison request after MAX_ATTEMPTS (10)', () => {
    q = new OfflineEventQueue(dbPath);
    const id = q.enqueue('worker_http', { url: '/api/sessions/summarize', method: 'POST', body: {} });
    for (let i = 0; i < 10; i++) {
      q.markFailed(id, 'worker_api_503');
    }
    // attempt_count == MAX_ATTEMPTS -> no longer deliverable; the drain stops retrying it.
    expect(q.pendingCount()).toBe(0);
    expect(q.peekDeliverable(10)).toHaveLength(0);
  });
});
