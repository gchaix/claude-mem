import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';
import { RestartGuard } from '../RestartGuard.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  restartGenerator: (session: ActiveSession, source: string) => void | Promise<void>;
}

function isHardStopReason(reason: ActiveSession['abortReason']): boolean {
  return reason === 'shutdown' ||
    reason === 'restart-guard' ||
    reason === 'overflow' ||
    reason === 'quota' ||
    (typeof reason === 'string' && reason.startsWith('quota:'));
}

/**
 * Post-generator-exit handler. Under the new model:
 *   - 'processing' rows reset to 'pending' on next generator start (handled by SessionManager.getMessageIterator).
 *   - Per-message retry/drain logic is gone; messages live in the queue until clearPendingForSession lands.
 *
 * Behavior:
 *   1. Always: ensure SDK subprocess is dead.
 *   2. Hard-stop reasons (shutdown / restart-guard / overflow / quota): clear pending rows for the session and finalize.
 *   3. Otherwise (idle / natural completion):
 *        - If 0 pending → finalize.
 *        - If pending > 0 and restart guard allows → respawn with backoff.
 *        - If guard tripped → clear pending and finalize.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler, restartGenerator } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  const pendingStore = sessionManager.getPendingMessageStore();

  const terminateSession = async (logPrefix: string, clearPending: boolean) => {
    try {
      if (clearPending) {
        try {
          await pendingStore.clearPendingForSession(sessionDbId);
        } catch (e) {
          const normalized = e instanceof Error ? e : new Error(String(e));
          logger.error('SESSION', `${logPrefix} pending cleanup failed; continuing finalization`, {
            sessionId: sessionDbId,
            reason
          }, normalized);
        }
      }
      try {
        await completionHandler.finalizeSession(sessionDbId);
      } catch (e) {
        const normalized = e instanceof Error ? e : new Error(String(e));
        logger.error('SESSION', `${logPrefix} finalization failed; forcing in-memory session removal`, {
          sessionId: sessionDbId,
          reason
        }, normalized);
      }
    } finally {
      sessionManager.removeSessionImmediate(sessionDbId);
    }
  };

  if (isHardStopReason(reason)) {
    logger.info('SESSION', `Generator exited with hard-stop reason — clearing pending and finalizing`, {
      sessionId: sessionDbId,
      reason
    });
    await terminateSession('Hard-stop', true);
    return;
  }

  let pendingCount: number;
  try {
    pendingCount = await pendingStore.getPendingCount(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Error during recovery pending-count check; aborting to prevent leaks', {
      sessionId: sessionDbId
    }, normalized);
    await terminateSession('Recovery abort', true);
    return;
  }

  if (pendingCount === 0) {
    session.restartGuard?.recordSuccess();
    session.consecutiveRestarts = 0;
    session.rateLimitBackoffCount = 0;
    session.retryAfterMs = undefined;
    await terminateSession('Natural completion', false);
    return;
  }

  // Rate-limit path: preserve pending work, bypass the restart-guard's
  // consecutive-failure trip, and use an extended backoff that honors the
  // provider's Retry-After when supplied. Rate-limit windows can last 30+
  // minutes; the normal 1s→8s schedule would retry 5 times in <15s and trip
  // the guard, abandoning pending observations.
  if (reason === 'rate-limit') {
    session.rateLimitBackoffCount = (session.rateLimitBackoffCount ?? 0) + 1;

    // Exponential schedule: 30s → 60s → 120s → 300s cap.
    // Provider-supplied retryAfterMs takes precedence when present.
    const scheduled = [30_000, 60_000, 120_000, 300_000];
    const idx = Math.min(session.rateLimitBackoffCount - 1, scheduled.length - 1);
    const backoffMs = session.retryAfterMs ?? scheduled[idx];

    logger.warn('SESSION', `Rate-limit backoff — preserving pending and scheduling retry`, {
      sessionId: sessionDbId,
      pendingCount,
      rateLimitBackoffCount: session.rateLimitBackoffCount,
      backoffMs,
      retryAfterMsFromProvider: session.retryAfterMs,
    });

    // Clear the one-shot retryAfterMs so the next rate-limit round falls back
    // to the scheduled exponential unless the provider hints again.
    session.retryAfterMs = undefined;

    const oldController = session.abortController;
    session.abortController = new AbortController();
    oldController.abort();

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
    }
    session.respawnTimer = setTimeout(() => {
      session.respawnTimer = undefined;
      const stillExists = deps.sessionManager.getSession(sessionDbId);
      if (stillExists && !stillExists.generatorPromise) {
        void restartGenerator(stillExists, 'rate-limit-restart');
      }
    }, backoffMs);
    return;
  }

  if (!session.restartGuard) session.restartGuard = new RestartGuard();
  const restartAllowed = session.restartGuard.recordRestart();
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  if (!restartAllowed) {
    logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, clearing pending and terminating`, {
      sessionId: sessionDbId,
      pendingCount,
      restartsInWindow: session.restartGuard.restartsInWindow,
      windowMs: session.restartGuard.windowMs,
      maxRestarts: session.restartGuard.maxRestarts,
      consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
    });
    session.consecutiveRestarts = 0;
    await terminateSession('Restart guard', true);
    return;
  }

  logger.info('SESSION', `Restarting generator after exit with pending work`, {
    sessionId: sessionDbId,
    pendingCount,
    consecutiveRestarts: session.consecutiveRestarts,
    restartsInWindow: session.restartGuard.restartsInWindow,
    maxRestarts: session.restartGuard.maxRestarts,
  });

  const oldController = session.abortController;
  session.abortController = new AbortController();
  oldController.abort();

  const backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveRestarts - 1), 8000);

  if (session.respawnTimer) {
    clearTimeout(session.respawnTimer);
  }
  session.respawnTimer = setTimeout(() => {
    session.respawnTimer = undefined;
    const stillExists = deps.sessionManager.getSession(sessionDbId);
    if (stillExists && !stillExists.generatorPromise) {
      void restartGenerator(stillExists, 'pending-work-restart');
    }
  }, backoffMs);
}
