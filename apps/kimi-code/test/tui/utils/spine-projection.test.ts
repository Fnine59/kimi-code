import { describe, expect, it } from 'vitest';

import {
  applyAcceptedSpineTransition,
  createSpineProjectionState,
  isSpineProjectionActive,
  projectSpineTree,
  scanSpineProjectionFromHistory,
} from '#/tui/utils/spine-projection';

/** Core's real accepted receipt (ACCEPTED_OUTPUT in agent-core-v2's
 *  controlResult.ts) — the replay scan must match it. */
const ACCEPTED_OUTPUT = 'accepted — commits after this step completes';

function assistant(callId: string, name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }],
  };
}

function tool(callId: string, output: string) {
  return {
    role: 'tool',
    toolCallId: callId,
    content: [{ type: 'text', text: output }],
  };
}

function bash(callId: string) {
  return assistant(callId, 'Bash', { command: 'echo hi' });
}

describe('spine projection reducer', () => {
  it('opens the first node as the active in-progress root', () => {
    const state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'read the auth module',
    });

    expect(isSpineProjectionActive(state)).toBe(true);
    expect(projectSpineTree(state)).toEqual([
      { title: 'read the auth module', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('next closes the current node and opens a sibling after it', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'task A',
    });
    state = applyAcceptedSpineTransition(state, 'spine_next', {
      summary: 'task B',
      memory: 'A is done',
    });

    expect(projectSpineTree(state)).toEqual([
      { title: 'task A', status: 'done', children: [] },
      { title: 'task B', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('opening a child nests it under the cursor', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'parent goal',
    });
    state = applyAcceptedSpineTransition(state, 'spine_open', { summary: 'child step' });

    expect(projectSpineTree(state)).toEqual([
      {
        title: 'parent goal',
        status: 'in_progress',
        children: [
          { title: 'child step', status: 'in_progress', active: true, children: [] },
        ],
      },
    ]);
  });

  it('closing the child returns the cursor to the parent', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'parent goal',
    });
    state = applyAcceptedSpineTransition(state, 'spine_open', { summary: 'child step' });
    state = applyAcceptedSpineTransition(state, 'spine_close', { memory: 'child done' });

    expect(projectSpineTree(state)).toEqual([
      {
        title: 'parent goal',
        status: 'in_progress',
        active: true,
        children: [{ title: 'child step', status: 'done', children: [] }],
      },
    ]);
  });

  it('closing back to the root epoch keeps the all-done tree visible', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'only task',
    });
    state = applyAcceptedSpineTransition(state, 'spine_close', { memory: 'all done' });

    expect(isSpineProjectionActive(state)).toBe(true);
    expect(projectSpineTree(state)).toEqual([
      { title: 'only task', status: 'done', children: [] },
    ]);
  });

  it('keeps siblings nested under their parent and supports multiple roots', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {
      summary: 'root one',
    });
    state = applyAcceptedSpineTransition(state, 'spine_open', { summary: 'child one' });
    state = applyAcceptedSpineTransition(state, 'spine_next', {
      summary: 'child two',
      memory: 'one done',
    });
    state = applyAcceptedSpineTransition(state, 'spine_close', { memory: 'two done' });
    state = applyAcceptedSpineTransition(state, 'spine_next', {
      summary: 'root two',
      memory: 'root one done',
    });

    expect(projectSpineTree(state)).toEqual([
      {
        title: 'root one',
        status: 'done',
        children: [
          { title: 'child one', status: 'done', children: [] },
          { title: 'child two', status: 'done', children: [] },
        ],
      },
      { title: 'root two', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('ignores transitions with empty or missing summaries', () => {
    let state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_open', {});
    expect(isSpineProjectionActive(state)).toBe(false);

    state = applyAcceptedSpineTransition(state, 'spine_open', { summary: 'fine' });
    const unchanged = applyAcceptedSpineTransition(state, 'spine_next', { summary: '  ' });
    expect(projectSpineTree(unchanged)).toEqual([
      { title: 'fine', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('close at the root epoch is a no-op', () => {
    const state = applyAcceptedSpineTransition(createSpineProjectionState(), 'spine_close', {
      memory: 'nowhere to go',
    });
    expect(isSpineProjectionActive(state)).toBe(false);
    // Never opened → nothing to show: the panel stays hidden while idle.
    expect(projectSpineTree(state)).toEqual([]);
  });
});

describe('spine projection history scan', () => {
  it('rebuilds the tree from accepted receipts in transcript order', () => {
    const history = [
      assistant('c1', 'spine_open', { summary: 'task A' }),
      tool('c1', ACCEPTED_OUTPUT),
      bash('c2'),
      tool('c2', 'hi\n'),
      assistant('c3', 'spine_next', { summary: 'task B', memory: 'A done' }),
      tool('c3', ACCEPTED_OUTPUT),
    ];

    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      { title: 'task A', status: 'done', children: [] },
      { title: 'task B', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('skips rejected transitions so the tree stays truthful', () => {
    const history = [
      assistant('c1', 'spine_open', { summary: 'task A' }),
      tool('c1', ACCEPTED_OUTPUT),
      assistant('c2', 'spine_close', { memory: 'root close gets rejected' }),
      tool('c2', 'Root-epoch nodes cannot be closed. Use open to start a child node under the current scope.'),
      assistant('c3', 'spine_next', { summary: 'task B', memory: 'moving on' }),
      tool('c3', ACCEPTED_OUTPUT),
    ];

    // The rejected close did not pop the cursor, so `task B` landed as a
    // sibling of `task A`, not at the root.
    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      { title: 'task A', status: 'done', children: [] },
      { title: 'task B', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('rebuilds nested structure from the stored history', () => {
    const history = [
      assistant('c1', 'spine_open', { summary: 'parent' }),
      tool('c1', ACCEPTED_OUTPUT),
      assistant('c2', 'spine_open', { summary: 'child' }),
      tool('c2', ACCEPTED_OUTPUT),
      assistant('c3', 'spine_close', { memory: 'child done' }),
      tool('c3', ACCEPTED_OUTPUT),
    ];

    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      {
        title: 'parent',
        status: 'in_progress',
        active: true,
        children: [{ title: 'child', status: 'done', children: [] }],
      },
    ]);
  });

  it('applies a tool result only to the first matching call', () => {
    const history = [
      assistant('c1', 'spine_open', { summary: 'task A' }),
      tool('c1', ACCEPTED_OUTPUT),
      tool('c1', ACCEPTED_OUTPUT),
      tool('c9', ACCEPTED_OUTPUT),
    ];

    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      { title: 'task A', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('ignores non-spine calls, object arguments, and non-text content', () => {
    const history = [
      assistant('c1', 'TodoList', { todos: [] }),
      tool('c1', 'Todo list cleared.'),
      {
        role: 'assistant',
        content: 'text',
        toolCalls: [{ id: 'c2', name: 'spine_open', arguments: { summary: 'kept' } }],
      },
      { role: 'tool', toolCallId: 'c2', content: 'accepted' },
    ];

    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      { title: 'kept', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('matches the live reducer on the same transition sequence', () => {
    const transitions: Array<['spine_open' | 'spine_close' | 'spine_next', Record<string, unknown>]> = [
      ['spine_open', { summary: 'parent' }],
      ['spine_open', { summary: 'child' }],
      ['spine_next', { summary: 'sibling', memory: 'x' }],
      ['spine_close', { memory: 'y' }],
    ];

    let live = createSpineProjectionState();
    const history = transitions.flatMap(([name, args], index) => {
      const callId = `c${String(index)}`;
      live = applyAcceptedSpineTransition(live, name, args);
      return [assistant(callId, name, args), tool(callId, ACCEPTED_OUTPUT)];
    });

    expect(scanSpineProjectionFromHistory(history)).toEqual(live);
  });

  it('rebuilds a fully closed tree as the all-done forest on resume', () => {
    const history = [
      assistant('c1', 'spine_open', { summary: 'task A' }),
      tool('c1', ACCEPTED_OUTPUT),
      assistant('c2', 'spine_close', { memory: 'A done' }),
      tool('c2', ACCEPTED_OUTPUT),
    ];

    const state = scanSpineProjectionFromHistory(history);
    expect(projectSpineTree(state)).toEqual([
      { title: 'task A', status: 'done', children: [] },
    ]);
  });
});
