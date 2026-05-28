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
 *
 * Structured to mirror OpenRouterAgent so the worker has a single shape for
 * non-SDK providers: sequential message processing, fire-and-forget
 * processAgentResponse() (failure handling lives inside the response processor),
 * and no fallback-agent indirection.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
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

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start Anthropic agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getAnthropicConfig();

    // Generate synthetic memorySessionId (Anthropic is stateless)
    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `anthropic-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Anthropic`);
    }

    const mode = ModeManager.getInstance().getActiveMode();

    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, config);
      await this.handleInitResponse(initResponse, session, worker, config.model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Anthropic init failed', { sessionId: session.sessionDbId, model: config.model }, error);
      } else {
        logger.error('SDK', 'Anthropic init failed with non-Error', { sessionId: session.sessionDbId, model: config.model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, config, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Anthropic message processing failed', { sessionId: session.sessionDbId, model: config.model }, error);
      } else {
        logger.error('SDK', 'Anthropic message processing failed with non-Error', { sessionId: session.sessionDbId, model: config.model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Anthropic agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model: config.model
    });
  }

  /**
   * Track this message and capture subagent identity so the response processor
   * can label observation rows correctly.
   */
  private prepareMessageMetadata(session: ActiveSession, message: { _persistentId: number; agentId?: string | null; agentType?: string | null }): void {
    session.processingMessageIds.push(message._persistentId);
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  /**
   * Update token counts and forward init response to the shared processor.
   */
  private async handleInitResponse(
    initResponse: { content: string; inputTokens?: number; outputTokens?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const inputTokens = initResponse.inputTokens || 0;
      const outputTokens = initResponse.outputTokens || 0;
      const tokensUsed = inputTokens + outputTokens;
      session.cumulativeInputTokens += inputTokens;
      session.cumulativeOutputTokens += outputTokens;

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, 'Anthropic', undefined, model
      );
    } else {
      logger.error('SDK', 'Empty Anthropic init response - session may lack context', {
        sessionId: session.sessionDbId, model
      });
    }
  }

  /**
   * Dispatch one queue message to the right handler.
   */
  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type?: string; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    config: AnthropicConfig,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(session, message, originalTimestamp, lastCwd, config, worker, mode);
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(session, message, originalTimestamp, lastCwd, config, worker, mode);
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    config: AnthropicConfig,
    worker: WorkerRef | undefined,
    _mode: ModeConfig
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, config);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      const inputTokens = obsResponse.inputTokens || 0;
      const outputTokens = obsResponse.outputTokens || 0;
      tokensUsed = inputTokens + outputTokens;
      session.cumulativeInputTokens += inputTokens;
      session.cumulativeOutputTokens += outputTokens;
    }

    await processAgentResponse(
      obsResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'Anthropic', lastCwd, config.model
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    config: AnthropicConfig,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, config);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      const inputTokens = summaryResponse.inputTokens || 0;
      const outputTokens = summaryResponse.outputTokens || 0;
      tokensUsed = inputTokens + outputTokens;
      session.cumulativeInputTokens += inputTokens;
      session.cumulativeOutputTokens += outputTokens;
    }

    await processAgentResponse(
      summaryResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'Anthropic', lastCwd, config.model
    );
  }

  private async handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): Promise<never> {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Anthropic agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'Anthropic agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  /**
   * Get a fresh auth token for Anthropic API requests.
   * Static API key takes precedence; otherwise the helper script is invoked
   * with execFileSync (no shell) to produce a token to stdout.
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

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Sliding window: keep most recent messages within the configured budget.
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
   * The first user message becomes the system prompt; consecutive same-role
   * messages are merged because Anthropic requires alternating turns.
   */
  private conversationToAnthropicFormat(history: ConversationMessage[]): {
    system: string;
    messages: AnthropicMessage[];
  } {
    if (history.length === 0) {
      return { system: '', messages: [] };
    }

    let system = '';
    let startIdx = 0;
    if (history[0].role === 'user') {
      system = history[0].content;
      startIdx = 1;
    }

    const messages: AnthropicMessage[] = [];
    for (let i = startIdx; i < history.length; i++) {
      const role: 'user' | 'assistant' = history[i].role === 'assistant' ? 'assistant' : 'user';
      const content = history[i].content;

      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n\n' + content;
      } else {
        messages.push({ role, content });
      }
    }

    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Process the above instructions.' });
    } else if (messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '(continue)' });
    }

    return { system, messages };
  }

  private async queryAnthropicMultiTurn(
    history: ConversationMessage[],
    config: AnthropicConfig
  ): Promise<{ content: string; inputTokens?: number; outputTokens?: number }> {
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
        signal: AbortSignal.timeout(300_000),
      });
    } catch (fetchError: unknown) {
      // TLS diagnostic for corporate proxy environments — most useful hint we can
      // surface is to point at NODE_EXTRA_CA_CERTS, which the launchd plist owns.
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

    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`);
    }

    const textBlock = data.content?.find(block => block.type === 'text');
    if (!textBlock?.text) {
      logger.error('SDK', 'Empty response from Anthropic');
      return { content: '' };
    }

    const content = textBlock.text;
    const inputTokens = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;

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
 * Anthropic is "available" when either a static API key or a helper script
 * has been configured. The helper path must exist on disk; if it doesn't, we
 * treat the provider as unavailable so the worker falls back cleanly.
 */
export function isAnthropicAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (settings.CLAUDE_MEM_ANTHROPIC_API_KEY) {
    return true;
  }

  const helper = settings.CLAUDE_MEM_ANTHROPIC_API_KEY_HELPER;
  if (helper && existsSync(helper)) {
    return true;
  }

  return false;
}

export function isAnthropicSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'anthropic';
}
