/**
 * `contextSize` domain — `IAgentContextSizeService` implementation.
 *
 * Owns the measured context token counts in the wire `ContextSizeModel`:
 * reads it through `wire.getModel`, writes it through
 * `wire.dispatch(contextSizeMeasured(...))` (called by `llmRequester` after
 * each measured exchange). Both live gauges — `contextTokens`
 * (= `get().size`, the measured prefix plus the unmeasured tail estimate) and
 * `rawContextTokens` (the unfolded-request cost, always >= the projected
 * size — see `rawSize`) — are re-derived and published together on every
 * live change to `ContextModel` or `ContextSizeModel`, so the pair stays
 * mutually consistent and in the same caliber as `getStatus()`. `get(start?, end?)` returns `{ size, measured, estimated }` for the
 * context-message range `[start, end)`, resolved like `Array.prototype.slice`
 * (defaulting to the whole context; negative indices count back from the end;
 * an inverted range is empty). `measured` resolves as follows: the full
 * measured-prefix aggregate is exact; a measured-prefix SUB-range diffs the
 * nearest snapshot at or before each endpoint (plus a narrow estimate strip
 * past each anchor) when both endpoints anchor, and otherwise falls back to a
 * per-message estimate; `estimated` is the live token estimate of the
 * not-yet-measured portion, and `size = measured + estimated`. Snapshot-chain
 * bookkeeping lives in `contextSizeOps` (notably: cascade estimate records
 * restart the chain, since their new prefix describes replaced message text).
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import type { Message } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IWireService } from '#/wire/wire';

import { IAgentContextSizeService, type ContextSize, type ContextSizeMeasurement } from './contextSize';
import { ContextSizeModel, type ContextSizeSnapshot, contextSizeMeasured } from './contextSizeOps';

export class AgentContextSizeService extends Disposable implements IAgentContextSizeService {
  declare readonly _serviceBrand: undefined;

  private estimatingProjected = false;
  private lastEmitted:
    | { readonly contextTokens: number; readonly rawContextTokens: number }
    | null = null;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
  ) {
    super();
    // Both gauges are re-derived on every live change to either model: the
    // stored history drives the unmeasured tail and the raw estimate, while a
    // measurement landing re-bases the measured prefix without touching the
    // history. Publishing the pair from one place keeps them mutually
    // consistent (raw >= projected) and in the same caliber as `getStatus()`.
    // The wire exposes no model-change subscription — instead every live
    // `ContextModel` mutation publishes `context.spliced` (appends included),
    // and measured-prefix updates land through `measured()` below (the op is
    // live-only, so replay stays silent).
    this._register(this.eventBus.subscribe('context.spliced', () => this.publishSizes()));
  }

  private publishSizes(): void {
    const contextTokens = this.get().size;
    const rawContextTokens = this.rawSize();
    const last = this.lastEmitted;
    if (
      last !== null &&
      last.contextTokens === contextTokens &&
      last.rawContextTokens === rawContextTokens
    ) {
      return;
    }
    this.lastEmitted = { contextTokens, rawContextTokens };
    this.eventBus.publish({
      type: 'agent.status.updated',
      contextTokens,
      rawContextTokens,
    });
  }

  get(start?: number, end?: number): ContextSize {
    const context = this.context.get();
    const model = this.wire.getModel(ContextSizeModel);
    const measuredLength = Math.min(model.length, context.length);
    const from = normalizeSliceIndex(start ?? 0, context.length);
    const to = normalizeSliceIndex(end ?? context.length, context.length);
    const measuredEnd = Math.min(to, measuredLength);
    const estimatedStart = Math.max(from, measuredLength);
    const measured =
      from === 0 && measuredEnd === measuredLength
        ? model.tokens
        : measuredSubRange(context, model.snapshots, from, measuredEnd);
    // Before the first measured exchange (e.g. right after a resume — the Op
    // is live-only), a raw estimate of the stored history overstates the next
    // request's cost whenever a fold is registered: the model only sees the
    // projected view, so estimate that instead.
    const neverMeasured = model.length === 0 && model.snapshots.length === 0;
    const tail = context.slice(estimatedStart, to);
    const estimated =
      neverMeasured && from === 0 && to === context.length
        ? this.estimateProjected(tail)
        : estimateTokensForMessages(tail);
    return { size: measured + estimated, measured, estimated };
  }

  private estimateProjected(messages: readonly ContextMessage[]): number {
    // Projecting runs the registered folds, and a fold (spine's status line)
    // may read the gauge back through `get()` — which would re-enter this
    // method and never terminate. Fall back to a raw estimate on re-entry;
    // the outer estimate stays projection-caliber.
    if (this.estimatingProjected) return estimateTokensForMessages(messages);
    this.estimatingProjected = true;
    try {
      return this.projector.estimateProjectedTokens(messages);
    } finally {
      this.estimatingProjected = false;
    }
  }

  rawSize(): number {
    const history = this.context.get();
    const rawMessages = estimateTokensForMessages(history);
    // Projecting the stored history gives the message side of the projected
    // request cost, so `rawMessages - projectedMessages` is exactly what the
    // folds removed — the system-prompt/tool overhead cancels. Clamping at
    // zero keeps fold-added noise (the status line, synthesized results)
    // from ever pushing raw below the projected size.
    let projectedMessages: number;
    try {
      projectedMessages = estimateTokensForMessages(this.projector.project(history));
    } catch {
      projectedMessages = rawMessages;
    }
    return this.get().size + Math.max(0, rawMessages - projectedMessages);
  }

  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void {
    const context = this.context.get();
    if (!matchesContext(input, context)) return;
    const length = context.length;
    const tokens = tokenUsageTotal(usage);
    this.wire.dispatch(contextSizeMeasured({ length, tokens }));
    this.publishSizes();
  }

  latestMeasurement(): ContextSizeMeasurement | undefined {
    const snapshots = this.wire.getModel(ContextSizeModel).snapshots;
    const latest = snapshots.at(-1);
    if (latest === undefined) return undefined;
    return { length: latest.storageLength, tokens: latest.tokens, kind: latest.kind };
  }
}

/**
 * Measured size of the stored range `[from, to)`. Diffs snapshot anchors when
 * both endpoints resolve one; a range that can't anchor (no snapshot reaches
 * the endpoint, or the diff came out negative because anchors straddle a
 * mutation) falls back to the per-message estimate.
 */
function measuredSubRange(
  context: readonly ContextMessage[],
  snapshots: readonly ContextSizeSnapshot[],
  from: number,
  to: number,
): number {
  const prefixFrom = prefixTokens(context, snapshots, from);
  const prefixTo = prefixTokens(context, snapshots, to);
  if (prefixFrom === undefined || prefixTo === undefined || prefixTo < prefixFrom) {
    return estimateTokensForMessages(context.slice(from, to));
  }
  return prefixTo - prefixFrom;
}

/**
 * Tokens of the storage prefix `[0, end)`: the newest snapshot at or before
 * `end`, plus a narrow per-message estimate of the strip past it. `undefined`
 * when no snapshot reaches `end`.
 */
function prefixTokens(
  context: readonly ContextMessage[],
  snapshots: readonly ContextSizeSnapshot[],
  end: number,
): number | undefined {
  let anchor: ContextSizeSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.storageLength <= end) anchor = snapshot;
  }
  if (anchor === undefined) return undefined;
  return anchor.tokens + estimateTokensForMessages(context.slice(anchor.storageLength, end));
}

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextSizeService,
  AgentContextSizeService,
  ScopeActivation.OnScopeCreated,
  'contextSize',
);
