/**
 * `sessionSkillCatalog` domain (L3) — CLI explicit-directory `ISkillSource`.
 *
 * Discovers skills from the host-injected `--skills-dir` values
 * (`ICliSkillDirs`) through `ISkillDiscovery`, contributing them at priority
 * 30 (above plugin, matching v1 where explicit dirs win every name collision).
 * Bound at Session scope so relative dirs resolve against each session's
 * `workDir`. When the host injects no dirs, contributes nothing.
 */

import { homedir } from 'node:os';

import { isAbsolute, join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ICliSkillDirs } from '#/app/skillCatalog/cliSkillDirs';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import type { ISkillSource, SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillRoot } from '#/app/skillCatalog/types';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExplicitSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitSkillSource: ServiceIdentifier<IExplicitSkillSource> =
  createDecorator<IExplicitSkillSource>('explicitSkillSource');

export class ExplicitSkillSource implements IExplicitSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'cli';
  readonly priority = 30;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ICliSkillDirs private readonly cliSkillDirs: ICliSkillDirs,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  async load(): Promise<SkillContribution> {
    if (this.cliSkillDirs.dirs.length === 0) return { skills: [] };
    const roots: SkillRoot[] = this.cliSkillDirs.dirs.map((dir) => ({
      path: this.resolveDir(dir),
      source: 'user',
    }));
    return this.discovery.discover(roots);
  }

  private resolveDir(dir: string): string {
    const expanded = dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir;
    return isAbsolute(expanded) ? expanded : join(this.workspace.workDir, expanded);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExplicitSkillSource,
  ExplicitSkillSource,
  ScopeActivation.OnDemand,
  'sessionSkillCatalog',
);
