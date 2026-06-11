// SPDX-License-Identifier: Apache-2.0
//
// Drain logic for the offline event queue. Called opportunistically at the
// start of each successful server-beta hook delivery so that events buffered
// during prior outages are replayed before new events are sent.
//
// Ordering contract: events are replayed oldest-first. If a replay call
// fails with a fallback-eligible error we stop draining for this hook
// invocation (sonic is still down) and leave the remaining rows in the queue.
// Non-fallback errors (4xx client bugs) are treated as permanent failures:
// the row's attempt_count is incremented and it will be abandoned after
// MAX_ATTEMPTS.

import { OfflineEventQueue, type OfflineEventType } from '../sqlite/OfflineEventQueue.js';
import type { ServerBetaClient } from './server-beta-client.js';
import { isServerBetaClientError } from './server-beta-client.js';
import { logger } from '../../utils/logger.js';

export interface DrainContext {
  client: ServerBetaClient;
  projectId: string;
}

/**
 * Replay buffered offline events through `ctx.client`. Stops on the first
 * transport/5xx failure (sonic still down). Returns the number of events
 * successfully delivered this call.
 */
export async function drainOfflineQueue(ctx: DrainContext): Promise<number> {
  const queue = OfflineEventQueue.shared();
  const pending = queue.pendingCount();
  if (pending === 0) return 0;

  logger.info('OFFLINE_QUEUE', `Draining ${pending} offline event(s)`);

  const events = queue.peekDeliverable(50);
  let delivered = 0;

  for (const event of events) {
    try {
      await replayEvent(ctx, event.event_type, JSON.parse(event.payload) as unknown);
      queue.markDelivered(event.id);
      delivered++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isServerBetaClientError(err) && err.isFallbackEligible()) {
        // Remote is still down: stop draining; try again next hook.
        logger.info('OFFLINE_QUEUE', `Drain halted (remote unavailable): ${errMsg}`, {
          eventId: event.id,
          eventType: event.event_type,
        });
        break;
      }

      // Permanent client error: record the failure but keep going.
      logger.warn('OFFLINE_QUEUE', `Event delivery failed permanently, incrementing attempt`, {
        eventId: event.id,
        eventType: event.event_type,
        error: errMsg,
      });
      queue.markFailed(event.id, errMsg);
    }
  }

  if (delivered > 0) {
    logger.info('OFFLINE_QUEUE', `Drained ${delivered} event(s) successfully`);
  }
  return delivered;
}

async function replayEvent(
  ctx: DrainContext,
  eventType: OfflineEventType,
  payload: unknown,
): Promise<void> {
  const p = payload as Record<string, unknown>;

  switch (eventType) {
    case 'session_start':
      await ctx.client.startSession({
        projectId: ctx.projectId,
        externalSessionId: (p.externalSessionId as string | null) ?? null,
        contentSessionId: (p.contentSessionId as string | null) ?? null,
        agentId: (p.agentId as string | null) ?? null,
        agentType: (p.agentType as string | null) ?? null,
        platformSource: (p.platformSource as string | null) ?? null,
        metadata: (p.metadata as Record<string, unknown> | undefined) ?? undefined,
      });
      break;

    case 'tool_use':
    case 'assistant_message':
      await ctx.client.recordEvent({
        projectId: ctx.projectId,
        serverSessionId: (p.serverSessionId as string | null) ?? null,
        contentSessionId: (p.contentSessionId as string | null) ?? null,
        sourceType: 'hook',
        eventType: eventType,
        occurredAtEpoch: (p.occurredAtEpoch as number) ?? Date.now(),
        payload: p.payload,
        generate: (p.generate as boolean | undefined) ?? undefined,
      });
      break;

    case 'session_end': {
      const sessionId = p.sessionId as string | undefined;
      if (!sessionId) {
        throw new Error('session_end event missing sessionId');
      }
      await ctx.client.endSession({ sessionId });
      break;
    }

    default:
      // Unknown type from a future version — skip silently.
      logger.warn('OFFLINE_QUEUE', `Unknown event type in offline queue: ${eventType}`);
  }
}
