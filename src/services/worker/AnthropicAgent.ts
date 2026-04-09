/**
 * AnthropicAgent: Anthropic Messages API-based observation extraction
 *
 * Alternative to SDKAgent that calls the Anthropic Messages API directly
 * via REST HTTP. Supports both static API keys and dynamic token helpers
 * (e.g., corporate proxy OAuth via a token helper script).
 *
 * Responsibility:
 * - Call Anthropic Messages API for observation extraction
 * - Parse XML responses (same format as other agents)
 * - Sync to database and Chroma
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Anthropic Messages API response format
interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
  };
}

// Anthropic message format
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyHelper: string;
}

export class AnthropicAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Anthropic API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Anthropic agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const config = this.getAnthropicConfig();

      // Generate synthetic memorySessionId (Anthropic is stateless)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `anthropic-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Anthropic`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Anthropic with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, config);

      if (initResponse.content) {
        // Track token usage (Anthropic provides exact counts)
        const inputTokens = initResponse.inputTokens || 0;
        const outputTokens = initResponse.outputTokens || 0;
        const tokensUsed = inputTokens + outputTokens;
        session.cumulativeInputTokens += inputTokens;
        session.cumulativeOutputTokens += outputTokens;

        // Process response using shared ResponseProcessor
        const initResult = await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Anthropic',
          undefined
        );

        if (initResult.status === 'rate_limited' || initResult.status === 'error') {
          logger.warn('SDK', `Anthropic init response failed (${initResult.status}), aborting session`, {
            sessionId: session.sessionDbId
          });
          return;
        }
      } else {
        logger.error('SDK', 'Empty Anthropic init response - session may lack context', {
          sessionId: session.sessionDbId,
          model: config.model
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Read batch size from settings
      const batchSize = Math.max(1, parseInt(
        SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_ANTHROPIC_BATCH_SIZE
      ) || 8);

      // Process pending messages in batches for parallel LLM utilization
      for await (const firstMessage of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Build batch: first message from iterator + additional from DB
        const batchMessages: PendingMessageWithId[] = [firstMessage];

        if (batchSize > 1) {
          const pendingStore = this.sessionManager.getPendingMessageStore();
          const additional = pendingStore.claimBatch(session.sessionDbId, batchSize - 1);
          for (const pm of additional) {
            const msg = pendingStore.toPendingMessage(pm);
            batchMessages.push({ ...msg, _persistentId: pm.id, _createdAtEpoch: pm.created_at_epoch } as PendingMessageWithId);
          }
        }

        logger.info('SDK', `BATCH_START | sessionDbId=${session.sessionDbId} | size=${batchMessages.length} | ids=[${batchMessages.map(m => m._persistentId).join(',')}]`);

        // Phase 1: Build batch items with independent history snapshots
        interface BatchItem {
          message: PendingMessageWithId;
          historySnapshot: ConversationMessage[];
          prompt: string;
          originalTimestamp: number | null;
          cwd: string | undefined;
          promptType: 'observation' | 'summarize';
        }

        const batchItems: BatchItem[] = [];
        for (const message of batchMessages) {
          if (message.cwd) {
            lastCwd = message.cwd;
          }
          const itemCwd = message.cwd || lastCwd;
          const originalTimestamp = message._createdAtEpoch ?? session.earliestPendingTimestamp;

          if (message.type === 'observation') {
            if (message.prompt_number !== undefined) {
              session.lastPromptNumber = message.prompt_number;
            }
            if (!session.memorySessionId) {
              throw new Error('Cannot process observations: memorySessionId not yet captured.');
            }

            const obsPrompt = buildObservationPrompt({
              id: 0,
              tool_name: message.tool_name!,
              tool_input: JSON.stringify(message.tool_input),
              tool_output: JSON.stringify(message.tool_response),
              created_at_epoch: originalTimestamp ?? Date.now(),
              cwd: message.cwd
            });

            // Snapshot history + this prompt for independent LLM call
            const historySnapshot = [...session.conversationHistory, { role: 'user' as const, content: obsPrompt }];
            batchItems.push({ message, historySnapshot, prompt: obsPrompt, originalTimestamp, cwd: itemCwd, promptType: 'observation' });

          } else if (message.type === 'summarize') {
            if (!session.memorySessionId) {
              throw new Error('Cannot process summary: memorySessionId not yet captured.');
            }

            const summaryPrompt = buildSummaryPrompt({
              id: session.sessionDbId,
              memory_session_id: session.memorySessionId,
              project: session.project,
              user_prompt: session.userPrompt,
              last_assistant_message: message.last_assistant_message || ''
            }, mode);

            const historySnapshot = [...session.conversationHistory, { role: 'user' as const, content: summaryPrompt }];
            batchItems.push({ message, historySnapshot, prompt: summaryPrompt, originalTimestamp, cwd: itemCwd, promptType: 'summarize' });
          }
        }

        // Phase 2: Fire parallel LLM calls via Promise.all
        const llmResults = await Promise.all(
          batchItems.map(async (item) => {
            try {
              const response = await this.queryAnthropicMultiTurn(item.historySnapshot, config);
              return { success: true as const, response, item };
            } catch (error) {
              // Convert request exceptions to result objects so
              // other batch items can proceed. Failed items are retried via markFailed().
              return { success: false as const, error, item };
            }
          })
        );

        // Phase 3: Process results SEQUENTIALLY to protect shared session state
        const pendingStore = this.sessionManager.getPendingMessageStore();
        for (const result of llmResults) {
          const { item } = result;

          if (!result.success) {
            logger.warn('SDK', `BATCH_ITEM_FAILED | messageId=${item.message._persistentId} | error=${result.error instanceof Error ? result.error.message : String(result.error)}`);
            pendingStore.markFailed(item.message._persistentId);
            continue;
          }

          const { response } = result;
          const inputTokens = response.inputTokens || 0;
          const outputTokens = response.outputTokens || 0;
          const tokensUsed = inputTokens + outputTokens;
          session.cumulativeInputTokens += inputTokens;
          session.cumulativeOutputTokens += outputTokens;

          // Push prompt to real conversation history (sequential, so order is preserved)
          session.conversationHistory.push({ role: 'user', content: item.prompt });

          // Set processingMessageIds to just this item before calling processAgentResponse
          session.processingMessageIds = [item.message._persistentId];

          // Process response using shared ResponseProcessor.
          // Empty/non-XML paths call markFailed() to preserve messages for retry.
          const obsResult = await processAgentResponse(
            response.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            item.originalTimestamp,
            'Anthropic',
            item.cwd
          );

          if (obsResult.status === 'rate_limited') {
            logger.warn('SDK', 'Anthropic rate-limited during batch item, aborting session', {
              sessionId: session.sessionDbId
            });
            return;
          }
        }

        logger.info('SDK', `BATCH_COMPLETE | sessionDbId=${session.sessionDbId} | total=${batchItems.length} | succeeded=${llmResults.filter(r => r.success).length} | failed=${llmResults.filter(r => !r.success).length}`);
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Anthropic agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model: config.model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Anthropic agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude SDK
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Anthropic API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Anthropic agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Get a fresh auth token for Anthropic API requests.
   * If CLAUDE_MEM_ANTHROPIC_API_KEY is set, use it directly.
   * Otherwise, call the API_KEY_HELPER script to get a dynamic token.
   * Uses execFileSync (not execSync) to avoid shell injection.
   */
  private getAuthToken(config: AnthropicConfig): string {
    if (config.apiKey) {
      return config.apiKey;
    }

    if (!config.apiKeyHelper) {
      throw new Error('Anthropic provider selected but no API key or key helper configured. Set CLAUDE_MEM_ANTHROPIC_API_KEY or CLAUDE_MEM_ANTHROPIC_API_KEY_HELPER in settings.');
    }

    try {
      const token = execFileSync(config.apiKeyHelper, [], {
        timeout: 30_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (!token) {
        throw new Error(`API key helper script returned empty output: ${config.apiKeyHelper}`);
      }

      return token;
    } catch (error) {
      if (error instanceof Error && error.message.includes('ETIMEDOUT')) {
        throw new Error(`API key helper script timed out after 30s: ${config.apiKeyHelper}`);
      }
      throw error;
    }
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_ANTHROPIC_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_ANTHROPIC_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Anthropic context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Convert shared ConversationMessage array to Anthropic Messages API format.
   * Extracts the first user message as the system prompt.
   * Merges consecutive same-role messages (Anthropic requires alternating turns).
   */
  private conversationToAnthropicFormat(history: ConversationMessage[]): {
    system: string;
    messages: AnthropicMessage[];
  } {
    if (history.length === 0) {
      return { system: '', messages: [] };
    }

    // Use first user message as system prompt
    let system = '';
    let startIdx = 0;
    if (history[0].role === 'user') {
      system = history[0].content;
      startIdx = 1;
    }

    // Convert remaining messages, merging consecutive same-role messages
    const messages: AnthropicMessage[] = [];
    for (let i = startIdx; i < history.length; i++) {
      const role: 'user' | 'assistant' = history[i].role === 'assistant' ? 'assistant' : 'user';
      const content = history[i].content;

      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        // Merge consecutive same-role messages
        messages[messages.length - 1].content += '\n\n' + content;
      } else {
        messages.push({ role, content });
      }
    }

    // Anthropic requires at least one message and it must start with 'user' role
    if (messages.length === 0) {
      // All content was extracted as system prompt — add a placeholder user message
      messages.push({ role: 'user', content: 'Process the above instructions.' });
    } else if (messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '(continue)' });
    }

    return { system, messages };
  }

  /**
   * Query Anthropic Messages API with full conversation history (multi-turn)
   */
  private async queryAnthropicMultiTurn(
    history: ConversationMessage[],
    config: AnthropicConfig
  ): Promise<{ content: string; inputTokens?: number; outputTokens?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const { system, messages } = this.conversationToAnthropicFormat(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying Anthropic multi-turn (${config.model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens,
      apiMessages: messages.length
    });

    // Get a fresh token for each request (helper scripts cache internally)
    const token = this.getAuthToken(config);

    const url = `${config.baseUrl}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          system,
          messages,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(300_000),  // 5-minute timeout
      });
    } catch (fetchError: unknown) {
      // TLS diagnostic for corporate proxy environments
      if (fetchError instanceof Error && fetchError.message.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
        logger.error('SDK', 'TLS certificate verification failed. If using a corporate proxy, set NODE_EXTRA_CA_CERTS to your CA bundle path in the launchd plist.', {
          url,
          hint: 'export NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.crt'
        });
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;

    // Check for API error in response body
    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`);
    }

    // Extract text from content blocks
    const textBlock = data.content?.find(block => block.type === 'text');
    if (!textBlock?.text) {
      logger.error('SDK', 'Empty response from Anthropic');
      return { content: '' };
    }

    const content = textBlock.text;
    const inputTokens = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;

    // Log actual token usage for cost tracking
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const totalTokens = (inputTokens || 0) + (outputTokens || 0);

      logger.info('SDK', 'Anthropic API usage', {
        model: config.model,
        inputTokens: inputTokens || 0,
        outputTokens: outputTokens || 0,
        totalTokens,
        messagesInContext: messages.length
      });

      if (totalTokens > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens
        });
      }
    }

    return { content, inputTokens, outputTokens };
  }

  /**
   * Get Anthropic configuration from settings
   */
  private getAnthropicConfig(): AnthropicConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    return {
      baseUrl: settings.CLAUDE_MEM_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: settings.CLAUDE_MEM_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      apiKey: settings.CLAUDE_MEM_ANTHROPIC_API_KEY || '',
      apiKeyHelper: settings.CLAUDE_MEM_ANTHROPIC_API_KEY_HELPER || '',
    };
  }
}

/**
 * Check if Anthropic is available (has API key or key helper configured)
 */
export function isAnthropicAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  // Static API key
  if (settings.CLAUDE_MEM_ANTHROPIC_API_KEY) {
    return true;
  }

  // Key helper script exists and is accessible
  const helper = settings.CLAUDE_MEM_ANTHROPIC_API_KEY_HELPER;
  if (helper && existsSync(helper)) {
    return true;
  }

  return false;
}

/**
 * Check if Anthropic is the selected provider
 */
export function isAnthropicSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'anthropic';
}
