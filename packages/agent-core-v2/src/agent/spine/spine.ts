/**
 * `spine` domain (L4) — Agent-scoped spine service contract and the tool-name
 * constants shared by the four control tools.
 *
 * `IAgentSpineService` is the boundary between the read-only / receipt-only
 * control tools and the tree state machine: the tools hand validated intent to
 * the service (which accepts every individually valid call — plan mode
 * rejected, multiplicity never rejected) and read the rendered tree back; the
 * accepted receipt landing in `contextMemory` IS the transition, and the
 * derivation resolves one assistant response as one tool-call group (a lone
 * accepted control applies; two or more, or any mix with `spine_spawn`,
 * applies none). Loud admission — spawn mixed with controls, a second spawn
 * in one response — is vetoed at the executor's before-execute hook. It also owns
 * archive publication: node archives on close / next, and the epoch archive
 * the full-compaction flow publishes before dispatching `spine.root_compact`.
 * Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { SpineEpochArchiveInput } from './spineArchive';
import type { SpineState } from './spineOps';
import type { SpineTrimOp } from './spineTrimDerive';

export const SPINE_TOOL_OPEN = 'spine_open';
export const SPINE_TOOL_CLOSE = 'spine_close';
export const SPINE_TOOL_NEXT = 'spine_next';
export const SPINE_TOOL_TREE = 'spine_tree';
export const SPINE_TOOL_TRIM = 'spine_trim';
export const SPINE_TOOL_SPAWN = 'spine_spawn';

/**
 * All six spine tool names. Profiles whitelist these so the main agent's
 * active-tool filter lets the registered tools through; surfaces that merely
 * display a profile's tool list (e.g. the `Agent` tool description) filter
 * them out instead, since the tools register only for the main agent.
 * `spine_trim` and `spine_spawn` are NOT control tools: they carry no tree
 * transition and are gated on separate flags.
 */
export const SPINE_TOOL_NAMES = [
  SPINE_TOOL_OPEN,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_TREE,
  SPINE_TOOL_TRIM,
  SPINE_TOOL_SPAWN,
] as const;

export type SpineControlToolName =
  | typeof SPINE_TOOL_OPEN
  | typeof SPINE_TOOL_CLOSE
  | typeof SPINE_TOOL_NEXT;

export interface SpineSpawnTaskInput {
  readonly summary: string;
  readonly prompt: string;
}

export interface SpineTransitionAccepted {
  readonly accepted: true;
}

export interface SpineTransitionRejected {
  readonly accepted: false;
  readonly reason: string;
}

export type SpineTransitionResult = SpineTransitionAccepted | SpineTransitionRejected;

export interface IAgentSpineService {
  readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  acceptOpen(summary: string): SpineTransitionResult;
  acceptClose(memory: string): SpineTransitionResult;
  acceptNext(summary: string, memory: string): SpineTransitionResult;

  /**
   * Validates a `spine_trim` call against the derived trim projection (the
   * single eligibility source): unknown, consumed, out-of-window, or
   * anchor-missing ids reject with a do-not-retry reason. Not a transition —
   * no per-step budget; the accepted receipt in history IS the trim.
   */
  acceptTrim(trimId: string, op: SpineTrimOp): SpineTransitionResult;

  /**
   * Executes a `spine_spawn` fission: forks one child agent per task, runs them
   * in parallel, and returns a structured JSON receipt. The receipt landing in
   * history IS the join; derive synthesizes the closed child nodes from it.
   * Rejected results surface capacity/validation reasons as errors so the model
   * can retry.
   */
  executeSpawn(
    tasks: readonly SpineSpawnTaskInput[],
    signal: AbortSignal,
  ): Promise<SpineTransitionResult & { readonly receipt?: string }>;

  archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined>;

  renderTree(): string;

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[];

  /** The current tree state, derived from the message stream on read. */
  currentState(): SpineState;
}

export const IAgentSpineService = createDecorator<IAgentSpineService>('agentSpineService');
