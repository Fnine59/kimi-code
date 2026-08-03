/**
 * `skillCatalog` domain (L3) — CLI-injected skill directory carrier.
 *
 * Holds the `--skills-dir` values passed by the host (CLI / SDK), seeded into
 * the App scope so the Session-scope `ExplicitSkillSource` can resolve them
 * relative to each session's `workDir`. App-scoped token, pure data.
 *
 * The token carries its own App-scope default (`dirs: []`), not a bootstrap
 * seed: scopes assembled without `bootstrap()` (test harnesses) must still
 * resolve. Hosts override the default via `extraSeeds`, which win over the
 * scoped-registry default in `buildCollection`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService, ScopeActivation } from '#/_base/di/scope';

export interface ICliSkillDirs {
  readonly _serviceBrand: undefined;
  readonly dirs: readonly string[];
}

export const ICliSkillDirs: ServiceIdentifier<ICliSkillDirs> =
  createDecorator<ICliSkillDirs>('cliSkillDirs');

class DefaultCliSkillDirs implements ICliSkillDirs {
  declare readonly _serviceBrand: undefined;

  readonly dirs: readonly string[] = [];
}

registerScopedService(
  LifecycleScope.App,
  ICliSkillDirs,
  DefaultCliSkillDirs,
  ScopeActivation.OnDemand,
  'skillCatalog',
);
