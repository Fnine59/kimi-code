/**
 * `spine` domain (L4) — shared tool-registration gate.
 *
 * The spine control tools (`spine_open` / `spine_close` / `spine_next`)
 * activate for the main agent and for spawned execution branches — forked
 * agents carrying `SPINE_BRANCH_LABEL` (stamped by `spineSpawn.startBranch`
 * at fork time and seeded into the branch's `IAgentScopeContext`). This
 * mirrors the upstream branch envelope granting branches `spine.open` /
 * `spine.close` / `spine.next` for genuine descendant work within their
 * assignment.
 *
 * `spine_spawn` / `spine_trim` / `spine_tree` stay main-only: nested spawn is
 * structurally disabled (upstream gates it through the general
 * `agents.max_depth` config — default 1 — which this engine does not have),
 * and the branch envelope only grants the three control tools.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

export const SPINE_BRANCH_LABEL = 'spineBranch';

export function isSpineControlHost(accessor: ServicesAccessor): boolean {
  const scope = accessor.get(IAgentScopeContext);
  return scope.agentId === 'main' || scope.labels[SPINE_BRANCH_LABEL] === 'true';
}
