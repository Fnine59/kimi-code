import type { ContentPart, Message } from '#/kosong/contract/message';

import type { AgentTaskStatus } from '#/agent/task/task';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
  readonly ownerPromptId?: string;
  readonly disclosure?: ContextInjectionDisclosure;
}

export type ContextInjectionDisclosure = {
  readonly kind: 'date';
  readonly renderGeneration: number;
  readonly localDate: string;
  readonly timeZone: string;
};

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: AgentTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | TaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type ContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly note?: string;
};

export interface UserMessageRecord {
  content: readonly ContentPart[];
  origin: PromptOrigin;
}

export interface SystemReminderRecord {
  content: string;
  origin: PromptOrigin;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

/**
 * Fold cursor carried inside `ContextState` — the reduction position of the
 * loop-event fold across records. `pending` holds toolCallIds with no result
 * yet; `deferred` holds entries appended while a tool exchange is still open
 * (flushed once it closes, preserving assistant↔tool adjacency). Plain data:
 * arrays instead of Sets so the state stays freeze- and JSON-safe.
 *
 * Generic over the entry type: the wire model folds `ContextMessage`s, while
 * the display transcript folds time-stamped entries through the same kernel.
 */
export interface ContextFoldState<E = ContextMessage> {
  readonly openStepUuid?: string;
  readonly pending: readonly string[];
  readonly deferred: readonly E[];
}

export const EMPTY_FOLD: ContextFoldState<never> = Object.freeze({
  pending: Object.freeze([]),
  deferred: Object.freeze([]),
});

/**
 * `ContextModel` state: the folded messages plus the fold cursor. The cursor
 * lives in the state (not beside it) so every wholesale replacement — undo,
 * clear, compaction — resets it structurally, by returning `EMPTY_FOLD`.
 */
export interface ContextState {
  readonly messages: readonly ContextMessage[];
  readonly fold: ContextFoldState;
}

/**
 * Deeply freezes a `ContextState` (the wire service only shallow-freezes the
 * top-level object, which covered the consumer view back when the state WAS
 * the messages array). `Object.freeze` returns the same reference, so the
 * wire's reference-equality gate is unaffected.
 */
export function freezeContextState(state: ContextState): ContextState {
  const { fold } = state;
  Object.freeze(fold.pending);
  Object.freeze(fold.deferred);
  Object.freeze(fold);
  Object.freeze(state.messages);
  return Object.freeze(state);
}
