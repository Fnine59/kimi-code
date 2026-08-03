/**
 * `contextProjector` domain — Agent-scope context projection contract.
 *
 * Defines wire-safe history projections and an opaque snapshot of the media
 * identities that a provider rejected, allowing later steps to strip only
 * that content while preserving newly generated recovery media.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Message } from '#/kosong/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

/**
 * Pre-projection transform over the stored history. History-shaping features
 * (spine collapsing, toolSelect view shaping) register a fold instead of the
 * projector importing them: the projector stays closed for modification.
 *
 * The contract a fold signs up for:
 *   - The input is the complete live stored history. Folds compose in
 *     ascending `order` (registration order within the same order): COLLAPSE
 *     folds run first, so they may anchor on absolute history positions
 *     (spine collapses spans by stored indices) — no message-dropping fold
 *     can have shifted those positions yet. VIEW folds run once collapsing is
 *     settled and shape the provider-visible view; they may drop or rewrite
 *     messages, so nothing may rely on the positions they see or leave.
 *   - Projections over an explicit, non-live message list (e.g. a compaction
 *     request) skip folds entirely (`applyFolds: false`): a fold never sees
 *     a foreign array whose positions would not line up with the stored
 *     history it was built against.
 *   - A fold must treat the input as read-only and return a new array when it
 *     changes anything.
 */
export type ContextFold = (messages: readonly ContextMessage[]) => readonly ContextMessage[];

/**
 * Composition order for context folds. Lower runs first. COLLAPSE folds see
 * the untouched live history (and may anchor on its positions); VIEW folds
 * run after all collapsing is settled.
 */
export const CONTEXT_FOLD_ORDER = {
  COLLAPSE: 0,
  VIEW: 100,
} as const;

export type ContextFoldOrder = (typeof CONTEXT_FOLD_ORDER)[keyof typeof CONTEXT_FOLD_ORDER];

export interface ContextFoldOptions {
  /** Composition order; defaults to COLLAPSE (sees the untouched live history). */
  readonly order?: ContextFoldOrder;
}

export interface ProjectOptions {
  /**
   * Whether to apply registered folds before projecting. Folds assume the
   * complete live stored history, so a projection over an explicit message
   * list (e.g. a compaction request) must pass false. Defaults to true.
   */
  readonly applyFolds?: boolean;
}

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[], options?: ProjectOptions): readonly Message[];
  projectStrict(messages: readonly ContextMessage[], options?: ProjectOptions): readonly Message[];

  /**
   * Token estimate of the projected view of `messages` — the caliber a real
   * request would cost under the registered folds. Falls back to a raw
   * estimate when projection fails. Use this for gauge / trigger arithmetic;
   * `project` + `estimateTokensForMessages` inline at each call site drifts.
   */
  estimateProjectedTokens(messages: readonly ContextMessage[]): number;

  /**
   * Register a fold applied to every projection; returns a disposable that
   * unregisters it. With no folds registered the projection passes the stored
   * history through unchanged.
   */
  registerContextFold(id: string, fold: ContextFold, options?: ContextFoldOptions): IDisposable;

  projectMediaDegraded(
    messages: readonly ContextMessage[],
    options?: ProjectOptions,
  ): readonly Message[];
  captureMediaStripSnapshot(
    messages: readonly ContextMessage[],
    options?: ProjectOptions,
  ): MediaStripSnapshot;
  projectMediaStripped(
    messages: readonly ContextMessage[],
    snapshot?: MediaStripSnapshot,
    options?: ProjectOptions,
  ): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
