
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { getHostname } from '../../shared/hostname.js';
import { resolveRuntimeContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';
import { OfflineEventQueue } from '../../services/sqlite/OfflineEventQueue.js';
import { drainOfflineQueue } from '../../services/hooks/offline-drain.js';

async function dispatchToWorker(
  input: NormalizedHookInput,
  platformSource: string,
  hostname: string,
): Promise<HookResult> {
  const result = await executeWithWorkerFallback<{ status?: string }>(
    '/api/sessions/observations',
    'POST',
    {
      contentSessionId: input.sessionId,
      platformSource,
      hostname,
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      cwd: input.cwd,
      agentId: input.agentId,
      agentType: input.agentType,
    },
  );

  if (isWorkerFallback(result)) {
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  }

  logger.debug('HOOK', 'Observation sent successfully via worker', { toolName: input.toolName });
  return { continue: true, suppressOutput: true };
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);
    const hostname = getHostname();

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      const eventPayload = {
        contentSessionId: sessionId,
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
          hostname,
        },
      };
      try {
        await drainOfflineQueue(runtime);
        await runtime.client.recordEvent({
          projectId: runtime.projectId,
          sourceType: 'hook',
          eventType: 'tool_use',
          ...eventPayload,
        });
        logger.debug('HOOK', 'Observation sent successfully via server-beta', { toolName });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          OfflineEventQueue.shared().enqueue('tool_use', eventPayload);
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        } else {
          logger.error('HOOK', 'Server beta event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    return dispatchToWorker(input, platformSource, hostname);
  },
};
