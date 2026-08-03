/**
 * `spine` domain (L4) — verbatim tool / parameter descriptions for the four
 * Spine control tools, transcribed from the upstream protocol so the model sees
 * an identical contract. Pure string constants; consumed by the tool classes.
 */

export const SPINE_OPEN_DESCRIPTION =
  'Start a focused child node for one small concrete goal under the current Spine cursor.';

export const SPINE_CLOSE_DESCRIPTION =
  'Finish the current Spine node and return compact continuation memory to the parent.';

export const SPINE_NEXT_DESCRIPTION =
  'Finish the current Spine node, return continuation memory for it, and start a new sibling for the next clear, bounded, completable goal under the resumed parent.';

export const SPINE_TREE_DESCRIPTION =
  'Inspect the current Spine tree, cursor, and context status.';

export const SPINE_OPEN_SUMMARY_DESCRIPTION =
  'Concise summary of one small concrete goal for the child node being opened.';

export const SPINE_NEXT_SUMMARY_DESCRIPTION =
  'Concise goal summary for the next sibling node being opened. Name only the next bounded, actionable, completable goal; closure state for the current node belongs in memory.';

export const SPINE_NODE_MEMORY_DESCRIPTION =
  'Continuation memory for the node being closed. Optimize for compact recoverability: preserve the smallest sufficient state that lets future work continue correctly without replaying this node. Treat inherited context and assembled child memory as already available; write only compact deltas and current state needed for continuation. Include objective/status, decisions, artifacts/evidence, validation, constraints or risks, next action when work remains, and [U#] request status. Use precise paths, ids, commit hashes, and test names when they matter.';

export const SPINE_TRIM_DESCRIPTION =
  'Conservatively trim one tagged tool-result projection without changing the Spine tree or creating memory. A TRIM_ID is valid only for the immediately preceding tool-result batch and expires after the next assistant tool request; after a miss, do not retry it. Use slice to retain needed evidence, use snip only after useful facts are preserved, and otherwise leave the result unchanged.';

export const SPINE_TRIM_ID_DESCRIPTION =
  'Trim id attached to a tool response in the immediately previous tool-result batch; it expires after your next assistant tool request.';

export const SPINE_TRIM_OP_DESCRIPTION =
  'Use snip only when useful facts are preserved elsewhere; use slice to keep the needed head, tail, or anchor window.';

export const SPINE_TRIM_HEAD_DESCRIPTION =
  'For op="slice", keep this many characters from the start of the current visible body. Mutually exclusive with tail and anchor.';

export const SPINE_TRIM_TAIL_DESCRIPTION =
  'For op="slice", keep this many characters from the end of the current visible body. Mutually exclusive with head and anchor.';

export const SPINE_TRIM_ANCHOR_DESCRIPTION =
  'For op="slice", locate this non-empty text in the current visible body and keep an anchor window. Mutually exclusive with head and tail.';

export const SPINE_TRIM_PRECEDING_DESCRIPTION =
  'For anchor slice, keep this many complete lines before the anchor line.';

export const SPINE_TRIM_FOLLOWING_DESCRIPTION =
  'For anchor slice, keep this many complete lines after the anchor line.';

export const SPINE_SPAWN_DESCRIPTION =
  'Fission the current work into two or more concurrent peer branches created from the current full history. ' +
  'Each branch receives a differentiated assignment and must own a semantically independent direction: either resolve a concrete uncertainty or produce an independently verifiable outcome, with an explicit scope, evidence boundary, and completion predicate. ' +
  'A branch may investigate, review, or implement directly and must return one terminal final memory. ' +
  'Give every branch a concise summary that is unique within this spawn call; the runtime uses it as the branch\u2019s public identity. ' +
  'Before fission, choose one task-local shared blackboard path and repeat the same `Shared blackboard: <path>` line verbatim in every task prompt. ' +
  'Every branch must inspect the blackboard before substantive work and once more before its final response. Discussion is optional: post only when seeking peer input or sharing useful findings, respond when useful, and never wait for a reply. ' +
  'Use `[summary]` to identify a post and `@summary` to address a peer. The blackboard is best-effort awareness, not a source of correctness-critical state. ' +
  'For exploration or review, treat inherited analytical conclusions as hypotheses to verify, refine, or falsify against primary evidence. ' +
  'The original continuation is suspended during the fission; no supervisory model remains active. ' +
  'Join waits for every branch, records their terminal results as closed task nodes under the current Spine scope atomically in input order, and then resumes the original continuation. ' +
  'Call spine_spawn at most once in one model response; place every concurrent branch in that call\u2019s tasks array. ' +
  'Use spawn when the current work can be differentiated into two or more independently owned branches and concurrent execution would materially improve speed or result quality. ' +
  'Do not spawn paraphrased branches over the same tightly coupled question unless they are deliberately assigned as independent replication or falsification. ' +
  'Branch workspace and external effects are non-transactional, so production-file writes require disjoint ownership or one explicitly named integration owner.';

/**
 * Task-count bounds sentence appended to the spawn tool description (the JSON
 * schema carries no min/max items; host validation is authoritative).
 */
export function spawnTaskCountDescription(minTasks: number, maxTasks: number): string {
  return `The tasks array must contain at least ${String(minTasks)} and at most ${String(maxTasks)} task assignments.`;
}

export const SPINE_SPAWN_TASKS_DESCRIPTION = 'Ordered differentiated branch assignments.';

export const SPINE_SPAWN_SUMMARY_DESCRIPTION =
  'Concise branch label, distinct within this spawn call, and its independently owned outcome.';

export const SPINE_SPAWN_PROMPT_DESCRIPTION =
  'Complete initial branch assignment. Repeat verbatim the same task-local `Shared blackboard: <path>` line used in every task prompt in this spawn. The branch identity is this task\u2019s summary. Blackboard discussion is optional and must never become a dependency or expand the assignment.';
