/**
 * `spine` domain (L4) — `spine_close` control tool.
 *
 * Receipt-only: validates the continuation memory and earns the accepted
 * receipt through `spine`; the receipt landing in `contextMemory` IS the close
 * (memory assembly and tree move) — unless the same assistant response carries
 * another accepted control (or any `spine_spawn` call), in which case the
 * derivation applies none of them. Self-registers via
 * `registerAgentToolService` gated on the `KIMI_CODE_SPINE` flag and
 * `agentId === 'main'` (main-agent-only, like the goal tools);
 * `AgentToolActivationService` activates it into the main agent's tool
 * registry only, never a sub-agent's. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_CLOSE } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { toControlResult } from './controlResult';
import { SPINE_CLOSE_DESCRIPTION, SPINE_NODE_MEMORY_DESCRIPTION } from './descriptions';

export interface SpineCloseInput {
  readonly memory: string;
}

const SpineCloseInputSchema: z.ZodType<SpineCloseInput> = z.object({
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export interface ISpineCloseTool extends AgentTool<SpineCloseInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineCloseTool = createDecorator<ISpineCloseTool>('spineCloseTool');

export class SpineCloseTool implements ISpineCloseTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_CLOSE;
  readonly description = SPINE_CLOSE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineCloseInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineCloseInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Close the current Spine node',
      execute: async (_ctx) => toControlResult(this.spine.acceptClose(input.memory)),
    };
  }
}

registerAgentToolService(ISpineCloseTool, SpineCloseTool, {
  name: SPINE_TOOL_CLOSE,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main',
});
