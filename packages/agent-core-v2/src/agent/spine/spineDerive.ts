/**
 * `spine` domain (L4) — derives the task tree purely from the stored
 * `contextMemory` message stream.
 *
 * The message stream is the single source of truth: a spine control-tool call
 * whose accepted receipt landed in history IS the transition — no parallel op
 * records, no commit protocol, and nothing to repair when the history shrinks
 * (an undo that removes a transition's messages removes the transition).
 * `deriveSpineState` scans the surviving messages, matches each `spine_open` /
 * `spine_close` / `spine_next` call to its accepted receipt — the exact
 * `ACCEPTED_OUTPUT` carrier text, or the legacy bare `accepted` left by older
 * sessions; persisted metadata can degrade, so the match is textual and a
 * near-miss does not count — and replays the transitions under the same
 * guards the legacy ops enforced (cursor position, non-empty bodies, root
 * epochs never close). Transition multiplicity resolves at CARRIER-group
 * granularity, mirroring the upstream reducer's `classify_control`: one
 * assistant response is one tool-call group — a group carrying exactly one
 * accepted control receipt applies it, a group carrying two or more applies
 * none (the calls still returned their success carriers; the tree simply
 * does not move), and a group mixing `spine_spawn` with any control call
 * applies nothing at all, spawn nodes included. A rejected or empty-body
 * control call does not count toward the group's multiplicity. A `spine_spawn` call whose structured JSON receipt lands
 * in history synthesizes N closed sibling nodes under the current cursor in
 * input order; every sibling shares the receipt message as a point span
 * (`openedAt === closedAt === receipt index`), so the first sibling's span
 * absorbs the receipt tool message and the carrier stays visible in the parent
 * context. Root-epoch boundaries come from the compaction summary message
 * itself (`origin.kind === 'compaction_summary'`, with the summary prefix text
 * as the fallback carrier when the origin metadata is absent). A closing node's
 * memory is the model-written body verbatim: the projection fold re-materializes
 * the span's surviving user requests and each closed child's own
 * `<spine_memory node_id="...">` slot from the surviving stream, so an undo
 * that rewrites the span rewrites the folded view with it — the memory itself
 * never needs patching. Consumed by `spineService`; the fold projection and
 * archive rendering read this state.
 *
 * Silence is the design, not an oversight: a call whose accepted receipt never
 * landed, a receipt whose call is missing, or a transition the guards reject
 * (a close under a stale cursor, an empty body) simply does not happen, with
 * no lost-commit audit and no repair op. The stream is the whole truth, so a
 * transition the stream does not fully witness is not a transition — the
 * legacy op world needed `reportLostCommits` precisely because it kept a
 * second record that could disagree with the receipts. `spine_spawn` receipts
 * are all-or-nothing in the same spirit: a malformed or partially-invalid
 * receipt is ignored entirely, synthesizing zero nodes.
 */

import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';

import { SPINE_TOOL_CLOSE, SPINE_TOOL_NEXT, SPINE_TOOL_OPEN } from './spine';
import type { SpineNode, SpineSpawnEvidence, SpineState } from './spineOps';
import {
  childNodeId,
  epochStartupNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  SPINE_VOID_OPENED_AT,
} from './spineTree';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

/** Receipt left by sessions predating the delayed-commit receipt wording. */
const LEGACY_ACCEPTED_RECEIPT = 'accepted';

/** Tool name for the parallel-branch spawn control call. */
const SPINE_TOOL_SPAWN = 'spine_spawn';

export function deriveSpineState(messages: readonly ContextMessage[]): SpineState {
  const accepted = collectAcceptedCallIds(messages);
  const spawnReceipts = collectSpawnReceipts(messages);
  const nodes: Record<string, SpineNode> = {};
  let openStack: readonly string[] = [];
  let rootEpoch = 0;
  let epochStartAt = 0;
  let epochMemoryAt: number | undefined;

  function openEpoch(epoch: number, startupOpenedAt: number): void {
    const epochId = String(epoch);
    const startupId = epochStartupNodeId(epoch);
    nodes[epochId] = {
      id: epochId,
      summary: `root epoch ${String(epoch)}`,
      openedAt: SPINE_VOID_OPENED_AT,
      children: [startupId],
    };
    nodes[startupId] = {
      id: startupId,
      summary: 'startup',
      openedAt: startupOpenedAt,
      children: [],
    };
    openStack = [epochId, startupId];
    rootEpoch = epoch;
  }

  function openNode(summary: string, openedAt: number): void {
    const parentId = openStack.at(-1);
    if (parentId === undefined) return;
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return;
    const id = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[id] = { id, summary: trimmed, openedAt, children: [] };
    nodes[parentId] = { ...parent, children: [...parent.children, id] };
    openStack = [...openStack, id];
  }

  function closeNode(memory: string, carrierAt: number): void {
    const id = openStack.at(-1);
    if (id === undefined || isRootEpoch(id)) return;
    const node = nodes[id];
    if (node === undefined || node.closedAt !== undefined) return;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return;
    // The span ends BEFORE the assistant message carrying the transition call,
    // so the carrier and its receipt stay visible in the parent context.
    const closedAt = Math.max(carrierAt - 1, node.openedAt);
    nodes[id] = { ...node, closedAt, memory: trimmed };
    openStack = openStack.slice(0, -1);
  }

  function nextNode(summary: string, memory: string, carrierAt: number): void {
    const closedId = openStack.at(-1);
    if (closedId === undefined || isRootEpoch(closedId)) return;
    const closing = nodes[closedId];
    if (closing === undefined || closing.closedAt !== undefined) return;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0 || trimmedMemory.length === 0) return;
    const parentId = parentNodeId(closedId);
    if (parentId === null) return;
    const parent = nodes[parentId];
    if (parent === undefined) return;
    const closedAt = Math.max(carrierAt - 1, closing.openedAt);
    const openedId = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[closedId] = {
      ...closing,
      closedAt,
      memory: trimmedMemory,
    };
    // The sibling opens right after the closing span — at the carrier's index —
    // so the carrier and its receipt ride inside the new sibling's span.
    nodes[openedId] = {
      id: openedId,
      summary: trimmedSummary,
      openedAt: closedAt + 1,
      children: [],
    };
    nodes[parentId] = { ...parent, children: [...parent.children, openedId] };
    openStack = [...openStack.slice(0, -1), openedId];
  }

  function spawnNodes(parentId: string, spawn: SpawnReceiptInfo): void {
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const receiptAt = spawn.receiptAt;
    let childIndex = nextChildIndex(parent.children);
    const newChildren: string[] = [];
    const newNodes: Record<string, SpineNode> = {};
    for (const result of spawn.results) {
      const id = childNodeId(parentId, childIndex);
      const spawnEvidence: SpineSpawnEvidence = {
        summary: result.summary,
        outcome: result.outcome,
      };
      newNodes[id] = {
        id,
        summary: result.summary,
        openedAt: receiptAt,
        closedAt: receiptAt,
        memory: result.memoryBody,
        spawn:
          result.diagnostic === undefined
            ? spawnEvidence
            : { ...spawnEvidence, diagnostic: result.diagnostic },
        children: [],
      };
      newChildren.push(id);
      childIndex += 1;
    }
    nodes[parentId] = { ...parent, children: [...parent.children, ...newChildren] };
    Object.assign(nodes, newNodes);
  }

  openEpoch(1, 0);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isEpochBoundary(message)) {
      openEpoch(rootEpoch + 1, i + 1);
      epochStartAt = i + 1;
      epochMemoryAt = i;
      continue;
    }
    if (message.role !== 'assistant') continue;
    // Carrier-group classification (the upstream reducer's rule): one
    // assistant response is one tool-call group. A group mixing spine_spawn
    // with any control call applies nothing; a group carrying two or more
    // accepted control receipts applies none of them — the whole group
    // becomes an ordinary tool group, silently. Only a lone accepted control
    // receipt moves the tree.
    let hasSpawnCall = false;
    let hasControlCall = false;
    const spawns: SpawnReceiptInfo[] = [];
    const transitions: Array<{ readonly name: string; readonly args: SpineTransitionArgs }> =
      [];
    for (const call of message.toolCalls) {
      if (call.name === SPINE_TOOL_SPAWN) {
        hasSpawnCall = true;
        const spawn = spawnReceipts.get(call.id);
        if (spawn !== undefined) spawns.push(spawn);
        continue;
      }
      if (!isSpineTransitionTool(call.name)) continue;
      hasControlCall = true;
      if (!accepted.has(call.id)) continue;
      const args = parseTransitionArgs(call.arguments);
      if (args === undefined) continue;
      // The upstream classifier counts a control only when its body is
      // non-empty, so an accepted-but-empty call neither applies nor vetoes
      // a sibling. The host never accepts empty bodies; this guard keeps
      // degraded / legacy streams aligned.
      if (!hasTransitionBody(call.name, args)) continue;
      transitions.push({ name: call.name, args });
    }
    if (hasSpawnCall) {
      if (hasControlCall) continue;
      const parentId = openStack.at(-1);
      if (parentId !== undefined) {
        for (const spawn of spawns) spawnNodes(parentId, spawn);
      }
      continue;
    }
    if (transitions.length !== 1) continue;
    const transition = transitions[0];
    if (transition === undefined) continue;
    if (transition.name === SPINE_TOOL_OPEN) {
      openNode(transition.args.summary, i);
    } else if (transition.name === SPINE_TOOL_CLOSE) {
      closeNode(transition.args.memory, i);
    } else if (transition.name === SPINE_TOOL_NEXT) {
      nextNode(transition.args.summary, transition.args.memory, i);
    }
  }

  return { nodes, openStack, rootEpoch, epochStartAt, epochMemoryAt };
}

interface SpineTransitionArgs {
  readonly summary: string;
  readonly memory: string;
}

function parseTransitionArgs(raw: string | null | undefined): SpineTransitionArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const summary = record['summary'];
  const memory = record['memory'];
  return {
    summary: typeof summary === 'string' ? summary : '',
    memory: typeof memory === 'string' ? memory : '',
  };
}

function collectAcceptedCallIds(messages: readonly ContextMessage[]): ReadonlySet<string> {
  const spineCallIds = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (isSpineTransitionTool(call.name)) spineCallIds.add(call.id);
    }
  }
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined || !spineCallIds.has(callId)) continue;
    if (message.isError === true) continue;
    const text = messageText(message);
    if (text === ACCEPTED_OUTPUT || text === LEGACY_ACCEPTED_RECEIPT) accepted.add(callId);
  }
  return accepted;
}

function isSpineTransitionTool(name: string): boolean {
  return name === SPINE_TOOL_OPEN || name === SPINE_TOOL_CLOSE || name === SPINE_TOOL_NEXT;
}

/**
 * The upstream classifier counts a control call toward a group's transition
 * only when its body is non-empty (an empty-body call is not a control at
 * all), so it neither applies nor voids a sibling control.
 */
function hasTransitionBody(name: string, args: SpineTransitionArgs): boolean {
  if (name === SPINE_TOOL_OPEN) return args.summary.trim().length > 0;
  if (name === SPINE_TOOL_CLOSE) return args.memory.trim().length > 0;
  if (name === SPINE_TOOL_NEXT) {
    return args.summary.trim().length > 0 && args.memory.trim().length > 0;
  }
  return false;
}

interface SpawnTask {
  readonly summary: string;
  readonly prompt: string;
}

interface SpawnCallInfo {
  readonly carrierAt: number;
  readonly tasks: readonly SpawnTask[];
}

interface SpawnResult {
  readonly summary: string;
  readonly outcome: 'completed' | 'errored' | 'aborted';
  readonly memoryBody: string;
  readonly diagnostic?: string;
}

interface SpawnReceiptInfo {
  readonly receiptAt: number;
  readonly results: readonly SpawnResult[];
}

function parseSpawnArgs(raw: string | null | undefined): readonly SpawnTask[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const tasksRaw = record['tasks'];
  if (!Array.isArray(tasksRaw) || tasksRaw.length < 2) return undefined;
  const tasks: SpawnTask[] = [];
  for (const item of tasksRaw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const itemRecord = item as Record<string, unknown>;
    const summary = itemRecord['summary'];
    const prompt = itemRecord['prompt'];
    if (typeof summary !== 'string' || typeof prompt !== 'string') return undefined;
    tasks.push({ summary, prompt });
  }
  return tasks;
}

function collectSpawnReceipts(
  messages: readonly ContextMessage[],
): ReadonlyMap<string, SpawnReceiptInfo> {
  const calls = new Map<string, SpawnCallInfo>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name !== SPINE_TOOL_SPAWN) continue;
      const tasks = parseSpawnArgs(call.arguments);
      if (tasks !== undefined) calls.set(call.id, { carrierAt: i, tasks });
    }
  }
  const receipts = new Map<string, SpawnReceiptInfo>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    const call = calls.get(callId);
    if (call === undefined) continue;
    if (message.isError === true) continue;
    const validated = validateSpawnReceipt(call.tasks, messageText(message), i);
    if (validated !== undefined) receipts.set(callId, validated);
  }
  return receipts;
}

function validateSpawnReceipt(
  tasks: readonly SpawnTask[],
  receiptText: string,
  receiptAt: number,
): SpawnReceiptInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['schema'] !== 'spine.spawn.result.v1') return undefined;
  const resultsRaw = record['results'];
  if (!Array.isArray(resultsRaw) || resultsRaw.length < 2 || resultsRaw.length !== tasks.length) {
    return undefined;
  }
  const results: SpawnResult[] = [];
  const seenOrdinals = new Set<number>();
  for (const item of resultsRaw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const itemRecord = item as Record<string, unknown>;
    const ordinal = itemRecord['ordinal'];
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal)) return undefined;
    if (ordinal < 0 || ordinal >= tasks.length || seenOrdinals.has(ordinal)) return undefined;
    seenOrdinals.add(ordinal);
    const outcome = itemRecord['outcome'];
    if (outcome !== 'completed' && outcome !== 'errored' && outcome !== 'aborted') return undefined;
    const memoryBody = itemRecord['memory_body'];
    if (typeof memoryBody !== 'string' || memoryBody.length === 0) return undefined;
    const diagnostic = itemRecord['diagnostic'];
    if (diagnostic !== undefined && (typeof diagnostic !== 'string' || diagnostic.length === 0)) {
      return undefined;
    }
    const executionRef = itemRecord['execution_ref'];
    if (
      executionRef !== undefined &&
      (typeof executionRef !== 'string' || executionRef.length === 0)
    ) {
      return undefined;
    }
    if (outcome !== 'completed' && diagnostic === undefined) return undefined;
    const task = tasks[ordinal];
    if (task === undefined || task.summary.trim().length === 0) return undefined;
    results[ordinal] = {
      summary: task.summary,
      outcome,
      memoryBody,
      diagnostic,
    };
  }
  if (seenOrdinals.size !== tasks.length) return undefined;
  return { receiptAt, results };
}

function isEpochBoundary(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  if (isCompactionSummaryMessage(message)) return true;
  // Fallback carrier for degraded persistence: only when the origin metadata
  // is absent — a message that still carries a non-summary origin is trusted.
  if (message.origin !== undefined) return false;
  return messageText(message).startsWith(COMPACTION_SUMMARY_PREFIX);
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
