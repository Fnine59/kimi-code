/**
 * Spine → todo panel projection.
 *
 * Pure reducer that mirrors the main agent's Spine task tree from the
 * transcript alone — no server/protocol changes: the TUI already sees every
 * top-level tool call and its result, and core's contract is accepted ⟺
 * non-error tool result (a rejected transition surfaces its reason as an
 * error), so the panel can be driven entirely app-side, through the same
 * channel the legacy `TodoList` scrape uses.
 *
 * The tree is rebuilt from accepted transitions in transcript order:
 *   spine_open(summary)         → push a child under the cursor; cursor = child
 *   spine_close(memory)         → close the cursor node; pop
 *   spine_next(summary, memory) → close the cursor node; open a sibling
 * The panel renders the mirrored tree directly (closed → done, the open
 * cursor chain → in_progress, cursor flagged `active`), folding done
 * subtrees panel-side; see `projectSpineTree`. Rejected transitions (error
 * results live; stored results whose text lacks the `accepted` receipt
 * prefix on replay) never touch the state; that also bounds drift to a
 * single transition when core drops a pending move (e.g. abort before the
 * afterStep commit).
 *
 * Subagents route their sub-tool calls through `subagent.*` events rather
 * than the top-level tool result stream, so the projection only ever tracks
 * the main agent's tree.
 */

import type { TodoTreeNode } from '#/tui/components/chrome/todo-panel';

export type SpineControlToolName = 'spine_open' | 'spine_close' | 'spine_next';

const SPINE_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'spine_open',
  'spine_close',
  'spine_next',
]);

/** Prefix of the receipt the spine control tools return when core accepts the
 *  intent — core's ACCEPTED_OUTPUT is `accepted — commits after this step
 *  completes`; the replay scan matches the prefix so suffix wording tweaks
 *  don't break resume. */
export const SPINE_ACCEPTED_RECEIPT = 'accepted';

export function isSpineControlToolName(name: string): name is SpineControlToolName {
  return SPINE_CONTROL_TOOL_NAMES.has(name);
}

export interface SpineProjectionNode {
  readonly summary: string;
  readonly parentIndex: number | null;
  readonly closed: boolean;
}

export interface SpineProjectionState {
  readonly nodes: readonly SpineProjectionNode[];
  /** Ancestor chain root → cursor as node indexes; empty at the root epoch. */
  readonly cursorStack: readonly number[];
}

export function createSpineProjectionState(): SpineProjectionState {
  return { nodes: [], cursorStack: [] };
}

/** True once any accepted transition landed — the panel then follows spine. */
export function isSpineProjectionActive(state: SpineProjectionState): boolean {
  return state.nodes.length > 0;
}

function readSummary(args: Record<string, unknown>): string | null {
  const summary = args['summary'];
  if (typeof summary !== 'string' || summary.trim().length === 0) return null;
  return summary;
}

/**
 * Applies one accepted transition. Callers must only pass results core
 * accepted (`event.isError === false` live; an `accepted`-prefixed receipt
 * on replay) — rejected or malformed calls leave the state untouched.
 */
export function applyAcceptedSpineTransition(
  state: SpineProjectionState,
  toolName: SpineControlToolName,
  args: Record<string, unknown>,
): SpineProjectionState {
  switch (toolName) {
    case 'spine_open': {
      const summary = readSummary(args);
      if (summary === null) return state;
      const parentIndex = state.cursorStack.at(-1) ?? null;
      return {
        nodes: [...state.nodes, { summary, parentIndex, closed: false }],
        cursorStack: [...state.cursorStack, state.nodes.length],
      };
    }
    case 'spine_close': {
      const cursor = state.cursorStack.at(-1);
      if (cursor === undefined) return state;
      return {
        nodes: state.nodes.map((node, index) =>
          index === cursor ? { ...node, closed: true } : node,
        ),
        cursorStack: state.cursorStack.slice(0, -1),
      };
    }
    case 'spine_next': {
      const summary = readSummary(args);
      const cursor = state.cursorStack.at(-1);
      if (summary === null || cursor === undefined) return state;
      const parentIndex = state.nodes[cursor]?.parentIndex ?? null;
      const nodes: SpineProjectionNode[] = state.nodes.map((node, index) =>
        index === cursor ? { ...node, closed: true } : node,
      );
      return {
        nodes: [...nodes, { summary, parentIndex, closed: false }],
        cursorStack: [...state.cursorStack.slice(0, -1), nodes.length],
      };
    }
  }
}

/**
 * Whole-tree todo-panel view of the projection, preserving insertion order
 * within each sibling group: closed nodes become done, the open cursor chain
 * becomes in_progress, and the cursor node is flagged `active`. Empty only
 * before the first `spine_open`; once the cursor stack empties (every node
 * closed) the projection is the all-done forest, so the panel keeps showing
 * the completed tree — as a flat all-done todo list does — until `clear()`
 * or the next task's `spine_open` starts a fresh root beside it.
 */
export function projectSpineTree(state: SpineProjectionState): readonly TodoTreeNode[] {
  const cursor = state.cursorStack.at(-1);

  const childrenByParent = new Map<number | null, number[]>();
  for (const [index, node] of state.nodes.entries()) {
    let bucket = childrenByParent.get(node.parentIndex);
    if (bucket === undefined) {
      bucket = [];
      childrenByParent.set(node.parentIndex, bucket);
    }
    bucket.push(index);
  }

  const build = (index: number): TodoTreeNode => {
    const node = state.nodes[index] as SpineProjectionNode;
    return {
      title: node.summary,
      status: node.closed ? 'done' : 'in_progress',
      active: index === cursor ? true : undefined,
      children: (childrenByParent.get(index) ?? []).map(build),
    };
  };
  return (childrenByParent.get(null) ?? []).map(build);
}

// ── Replay scan ────────────────────────────────────────────────
//
// Resumed sessions carry no spine snapshot on the wire, so the projection is
// rebuilt by walking the stored context history: every assistant spine call
// whose matching tool message returned the `accepted` receipt is replayed in
// order. Context messages the fold dropped never disappear from the stored
// history (folding affects only the wire projection), so the scan is complete
// up to the last full-compaction boundary.

interface SpineHistoryMessage {
  readonly role: string;
  readonly toolCalls?: readonly SpineHistoryToolCall[];
  readonly toolCallId?: string;
  readonly content: unknown;
}

interface SpineHistoryToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: unknown;
}

function parseStoredArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (value.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const value = (part as { readonly text?: unknown }).text;
    if (typeof value === 'string') text += value;
  }
  return text;
}

export function scanSpineProjectionFromHistory(
  history: readonly SpineHistoryMessage[],
): SpineProjectionState {
  let state = createSpineProjectionState();
  const pending = new Map<
    string,
    { readonly name: SpineControlToolName; readonly args: Record<string, unknown> }
  >();
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (call.id === undefined || !isSpineControlToolName(call.name)) continue;
        pending.set(call.id, { name: call.name, args: parseStoredArguments(call.arguments) });
      }
      continue;
    }
    if (message.role !== 'tool' || message.toolCallId === undefined) continue;
    const call = pending.get(message.toolCallId);
    if (call === undefined) continue;
    pending.delete(message.toolCallId);
    if (!textContent(message.content).trim().startsWith(SPINE_ACCEPTED_RECEIPT)) continue;
    state = applyAcceptedSpineTransition(state, call.name, call.args);
  }
  return state;
}
