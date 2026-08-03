/**
 * `scopeContext` domain — agent-scope identity token.
 *
 * Exposes `IAgentScopeContext`, the identity of the current agent scope (its
 * `agentId`) plus a `scope(subKey?)` helper that returns the agent's
 * persistence scope (or a child under it, e.g. `scope('cron')`). Seeded into
 * every agent scope at creation so Agent-scoped consumers
 * can refer to themselves and address their per-agent storage without any
 * path arithmetic. Bound at Agent scope via a per-agent seed, not the scoped
 * registry.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;

  readonly agentId: string;
  /**
   * Identity labels recorded for this agent at creation (the same value
   * `ISessionMetadata.registerAgent` persists). Empty for agents created
   * without labels. Lets Agent-scoped consumers recognize their own kind
   * (e.g. a spawned spine branch) without re-reading session metadata.
   */
  readonly labels: Readonly<Record<string, string>>;
  scope(subKey?: string): string;
}

export const IAgentScopeContext: ServiceIdentifier<IAgentScopeContext> =
  createDecorator<IAgentScopeContext>('agentScopeContext');

export function makeAgentScopeContext(input: {
  readonly agentId: string;
  readonly agentScope: string;
  readonly labels?: Readonly<Record<string, string>>;
}): IAgentScopeContext {
  const { agentScope } = input;
  return {
    _serviceBrand: undefined,
    agentId: input.agentId,
    labels: input.labels ?? {},
    scope: (subKey?: string): string => {
      if (subKey === undefined || subKey === '') return agentScope;
      if (agentScope === '') return subKey;
      return `${agentScope}/${subKey}`;
    },
  };
}
