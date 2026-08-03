import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ModelRequestTiming } from '#/kosong/model/modelRequester';
import type { LogContext } from '#/_base/log/log';

export type AgentLLMRequestLogFields = Readonly<LogContext>;

export type AgentLLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: AgentLLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly turnId?: number;
      readonly requestKind?: string;
      readonly logFields?: AgentLLMRequestLogFields;
    };

export interface LLMRequestRetryContext {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export type LLMRequestRetryHandler = (
  context: LLMRequestRetryContext,
) => void | Promise<void>;

export interface LLMRequestRetryOptions {
  readonly maxAttempts?: number;
  readonly onRetry?: LLMRequestRetryHandler;
}

/**
 * Spine name kept as an alias of kosong's canonical `ModelRequestTiming`
 * (identical shape); new code should import `ModelRequestTiming` directly.
 */
export type LLMStreamTiming = ModelRequestTiming;

export interface LLMRequestParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  source?: AgentLLMRequestSource;
}

export interface AgentLLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: ModelRequestTiming;
  traceId?: string;
}

export type AgentLLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
  retry?: LLMRequestRetryOptions;
}

/**
 * Read-only view of the request being assembled, handed to system-prompt
 * contributions so they can decide whether they apply: `source` distinguishes
 * turns from operations (e.g. compaction), and `tools` is the final
 * provider-visible tool list of the request.
 */
export interface SystemPromptContributionContext {
  readonly source: AgentLLMRequestSource | undefined;
  readonly tools: readonly Tool[];
}

/**
 * Transform over the assembled system prompt. Prompt-shaping features (e.g.
 * the spine view protocol block) register a contribution instead of the
 * requester importing them: the requester stays closed for modification.
 *
 * The contract a contribution signs up for:
 *   - It receives the prompt assembled so far plus the request's source and
 *     final tool list, and returns the prompt to pass on; return the input
 *     unchanged to decline.
 *   - Contributions compose in registration order, each seeing the output of
 *     the previous one.
 *   - The input prompt and context are read-only.
 */
export type SystemPromptContribution = (
  prompt: string,
  context: SystemPromptContributionContext,
) => string;

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}
export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  /**
   * Register a contribution applied to every assembled system prompt; returns
   * a disposable that unregisters it. With no contributions registered the
   * profile's system prompt passes through unchanged.
   */
  registerSystemPromptContribution(
    id: string,
    contribution: SystemPromptContribution,
  ): IDisposable;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
