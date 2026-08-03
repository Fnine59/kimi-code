/**
 * `spine` domain (L4) — the `<spine_view>` protocol block appended to the
 * system prompt when spine is enabled, plus the `appendSpineView` splicer and
 * the `~/spine_instruction.md` override loader.
 *
 * The text is transcribed from the upstream protocol (with the `spine.trim`
 * guidance removed, since trim is not implemented in this milestone) so the
 * model sees an identical contract. `loadSpineViewOverride` returns the
 * `<spine_view>` block extracted from `~/spine_instruction.md` (`undefined`
 * when the file is missing, unreadable, empty, or carries no block); the
 * caller owns the result — there is no module-level cache, so co-resident
 * agents never share an override by accident, and `spineService` can await
 * the load before its first turn request to keep every request's system
 * prompt byte-identical. Pure string handling apart from the single file
 * read. Consumed by `spineService` and the `llmRequester` request assembly.
 */

export const SPINE_VIEW = `<spine_view>
All work must be Spine-managed to make every test-time step produce efficient,
explicit task progress: the Spine tree enables scaling by recursively
decomposing tasks into scoped nodes and merging them through compact
continuation memory, while just-in-time context compilation turns each node's
local working context into that memory to keep scaling cost-efficient.

Use Spine as a recursive task-boundary workflow. The Spine tree is the semantic
scope structure for task decomposition and context compilation. Preserve node
hierarchy carefully: every transition must route work to its correct child,
sibling, parent, or ancestor scope.

1. Start task work with \`spine_open(<concrete task goal>)\` under the startup node.
2. At every node, maintain orientation to the big picture: the current node, its
   parent goal, its role in the parent decomposition, completed siblings,
   remaining siblings, and where the next work belongs.
3. If the current node is unclear, too broad, or not concrete enough to verify,
   use \`spine_open(<concrete child goal for exploration, planning, or decomposition>)\`
   only when that goal is a true child of the current node. Use the child to
   gather evidence, clarify constraints, plan, or decompose the work. Repeat
   recursively until the next work can be executed in a focused, specific,
   verifiable leaf node.
4. When an exploration/planning/decomposition node is complete, use
   \`spine_next(<concrete sibling goal>, memory)\` if the next work is a true sibling
   under the same parent. Use \`spine_close(memory)\` if the distilled result should
   return to the parent before deciding the next node.
5. Use \`spine_next(<concrete sibling goal>, memory)\` for remaining sibling work under
   the same parent. \`spine_next\` finalizes the current node and continues in a fresh
   sibling with distilled continuation memory.
6. Use \`spine_close(memory)\` when the current task node is complete enough for its
   parent or later siblings to continue correctly. \`spine_close\` is the upward merge
   operation: it returns compact state to the parent, not the local trace. If
   the next work belongs to an ancestor's scope, close upward until the correct
   parent scope is reached, then continue with \`spine_next\` or \`spine_open\`.

Optimize the tree for correct progress per unit of working context. Node summaries
should name concrete goals. Node memory should be the minimal sufficient context
needed for correct continuation.

Hierarchy and placement rules:

* Before any \`spine_open\`, \`spine_next\`, or \`spine_close\`, identify the current node's parent goal,
  the current node's role in that parent, and whether the next work belongs to
  the current node, the same parent, or an ancestor scope.
* Use \`spine_open\` only when the new goal is truly a child of the current node.
* Use \`spine_next\` only when the new goal is truly a sibling under the same parent.
* Use \`spine_close\` when the remaining work belongs to the parent or to an ancestor's
  scope; if necessary, close upward before continuing.
* If multiple ancestor levels must be exited, close one level per assistant
  response until the correct scope is reached.
* Every \`spine_next\` or \`spine_close\` memory must preserve compact big-picture state:
  current position, parent goal, completed siblings, remaining siblings, key
  decisions/evidence, unresolved risks, and why the transition is
  child/sibling/parent/ancestor-level.

Conventions:
* A single assistant response may batch ordinary task-progress tool calls with at
  most one Spine transition. Never include more than one of \`spine_open\`, \`spine_next\`, or
  \`spine_close\` in the same assistant response.
* \`summary\` is the concise goal summary for the node being opened: for \`spine_open\`,
  the child goal; for \`spine_next\`, the next sibling goal.
* \`memory\` is concise continuation state with progress, big-picture position,
  decisions, evidence, constraints, risks, remaining work, and critical
  references.
* Optimize for compact recoverability: preserve the smallest sufficient state
  that lets future work continue correctly without replaying this node. Treat
  inherited context and assembled child memory as already available, then write
  only compact deltas and current state needed to continue correctly.
* Use \`spine_open\` to start child work, \`spine_close\` to return completed evidence to the
  parent, and \`spine_next\` to finish the current node and continue from distilled
  memory in a fresh sibling.
* \`spine_tree\` is read-only; actual transitions happen only through \`spine_open\`,
  \`spine_close\`, and \`spine_next\`.
* Spine transitions change task scope, not communication state. A final response,
  status update, or user-facing report does not by itself require a \`spine_open\`,
  \`spine_next\`, or \`spine_close\` call; never create a reporting node or perform
  a transition solely for delivery.
* Root-epoch ids such as \`1\` or \`2\` cannot be closed. The initial \`1.1\` is a
  startup work node, not a concrete task node; use \`spine_open\` before doing task work.
* \`<spine_tran_status>\` gives current node orientation; \`<spine_memory>\` gives
  continuation memory from closed work.
* \`[U#]\` anchors refer to numbered user requests. When writing memory, preserve
  \`[U#]\` anchors for user requests that still matter. Do not maintain a separate
  request-status ledger when the relevant intent is already captured in ordinary
  continuation state. After \`<spine_memory>\` continuity or a node transition,
  report only new results, blockers, or requested details.
* Place user-facing replies where they are most useful: local intermediate
  results may wait for later merge, while complete conclusions, blocking status,
  or decisions needing user input should be surfaced promptly.

</spine_view>`;

const SPINE_VIEW_START_MARKER = '\n\n<spine_view>';
const SPINE_VIEW_OPEN = '<spine_view>';
const SPINE_VIEW_CLOSE = '</spine_view>';
const OVERRIDE_FILENAME = 'spine_instruction.md';

export function extractSpineView(contents: string): string | undefined {
  const start = contents.indexOf(SPINE_VIEW_OPEN);
  if (start < 0) return undefined;
  const bodyStart = start + SPINE_VIEW_OPEN.length;
  const relativeEnd = contents.slice(bodyStart).indexOf(SPINE_VIEW_CLOSE);
  if (relativeEnd < 0) return undefined;
  const end = bodyStart + relativeEnd + SPINE_VIEW_CLOSE.length;
  return contents.slice(start, end).trim();
}

export async function loadSpineViewOverride(
  hostFs: { readText(path: string): Promise<string> },
  homeDir: string,
): Promise<string | undefined> {
  const path = `${homeDir}/${OVERRIDE_FILENAME}`;
  try {
    const contents = await hostFs.readText(path);
    return contents.trim().length === 0 ? undefined : extractSpineView(contents);
  } catch {
    return undefined;
  }
}

export function appendSpineView(baseInstructions: string, viewOverride?: string): string {
  const view = viewOverride ?? SPINE_VIEW;
  const existing = baseInstructions.lastIndexOf(SPINE_VIEW_START_MARKER);
  const base = existing < 0 ? baseInstructions : baseInstructions.slice(0, existing);
  if (base.includes(view)) return base;
  if (base.length === 0) return view;
  return `${base}\n\n${view}`;
}
