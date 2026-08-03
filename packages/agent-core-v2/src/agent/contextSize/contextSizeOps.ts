/**
 * `contextSize` domain — wire Model (`ContextSizeModel`) and the
 * `context_size.measured` (`contextSizeMeasured`) Op for the last measured
 * context token count.
 *
 * Declares the deterministic measured prefix as `{ length, tokens }` (initial
 * `{ 0, 0 }`): the length (in messages) and total token count of the most
 * recent `context_size.measured` record. That record is written from two live
 * paths: `llmRequester` after each measured exchange (a true LLM-reported
 * count), and `contextMemoryService` / `fullCompactionService` cascading
 * alongside every context mutation that changes the measured prefix (`clear`
 * resets, `applyCompaction` adopts `tokensAfter`, `undo`/`sizeOpsForCut`
 * rebases to an estimate, epoch compaction adopts the post-compaction total);
 * `append` is intentionally not cascaded because new messages are the
 * unmeasured tail.
 *
 * `snapshots` is a live-only chain of those records (`storageLength` = prefix
 * length at write time, `tokens` = prefix total, `kind`): it lets
 * `contextSizeService.get()` size a measured sub-range by DIFFERENCING two
 * records instead of re-estimating message text (e.g. the spine cursor-context
 * between the request measured at node-open and the latest one). Convergence
 * rules: an estimate-kind record is written by content mutations whose new
 * prefix describes different message text, so it RESTARTS the chain (older
 * snapshots refer to a superseded layout); a measured-kind record drops
 * snapshots at or beyond its own length, replaces a same-length snapshot, and
 * keeps the chain FIFO-bounded at 64 so only recent exchange pairs diff.
 * Token totals are request-caliber (provider usage counts system prompt,
 * tools, and the spine status line too), so a diff between records also
 * absorbs any system-prompt/tool drift between the two exchanges — accepted
 * status-line noise. The Op is live-only because `context_size.measured` is
 * not a v1 record type: resume starts from `{ 0, 0, [] }` and
 * `contextSizeService.get()` estimates until the next measured exchange.
 * `apply` is pure — it normalizes the payload and returns the SAME reference
 * on a no-op so the wire's reference-equality gate stays quiet — and carries
 * no non-determinism (the last measured record wins). The sparse
 * `measuredPrefixTokens` array and the per-message live `estimates` are
 * intentionally NOT in the Model.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export type ContextSizeSnapshotKind = 'measured' | 'estimate';

export interface ContextSizeSnapshot {
  readonly storageLength: number;
  readonly tokens: number;
  readonly kind: ContextSizeSnapshotKind;
}

export interface ContextSizeState {
  readonly length: number;
  readonly tokens: number;
  readonly snapshots: readonly ContextSizeSnapshot[];
}

const MAX_SNAPSHOTS = 64;

export const ContextSizeModel = defineModel<ContextSizeState>('contextSize', () => ({
  length: 0,
  tokens: 0,
  snapshots: [],
}));

declare module '#/wire/types' {
  interface TransientOpMap {
    'context_size.measured': typeof contextSizeMeasured;
  }
}

export const contextSizeMeasured = ContextSizeModel.defineOp('context_size.measured', {
  schema: z.object({
    length: z.number(),
    tokens: z.number(),
    // Provenance of the record. `measured` (default) = LLM-reported usage;
    // `estimate` = cascade computed alongside a content mutation (clear,
    // compaction, undo rebase) — restarts the snapshot chain.
    kind: z.enum(['measured', 'estimate']).optional(),
  }),
  persist: false,
  apply: (s, p) => {
    const length = normalizeMeasuredLength(p.length);
    const tokens = Math.max(0, p.tokens);
    const kind = p.kind ?? 'measured';
    const snapshot: ContextSizeSnapshot = { storageLength: length, tokens, kind };
    let snapshots: readonly ContextSizeSnapshot[];
    if (kind === 'estimate') {
      // Content mutations rebase or replace message text: older snapshots
      // describe a superseded layout, so the chain restarts here.
      snapshots = [snapshot];
    } else {
      snapshots = [...s.snapshots.filter((snap) => snap.storageLength < length), snapshot];
      if (snapshots.length > MAX_SNAPSHOTS) {
        snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);
      }
    }
    if (
      s.length === length &&
      s.tokens === tokens &&
      sameSnapshots(s.snapshots, snapshots)
    ) {
      return s;
    }
    return { length, tokens, snapshots };
  },
});

function sameSnapshots(
  a: readonly ContextSizeSnapshot[],
  b: readonly ContextSizeSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left === undefined ||
      right === undefined ||
      left.storageLength !== right.storageLength ||
      left.tokens !== right.tokens ||
      left.kind !== right.kind
    ) {
      return false;
    }
  }
  return true;
}

function normalizeMeasuredLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
