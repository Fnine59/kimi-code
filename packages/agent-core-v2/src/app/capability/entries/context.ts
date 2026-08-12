/**
 * Shared context injected into capability entries. Every field is
 * constructor-wired by `CapabilityService`; tests substitute fakes
 * (temp dirs, fake fetch, fake plugin service) rather than touching the
 * host.
 *
 * `resolveRegion` supplies the Kimi region for region-managed download URLs
 * (plugin zips on the region `cdnBase`). `CapabilityService` wires it to the
 * persisted login host through `IProviderService` (read synchronously at
 * install time, after provider config has hydrated; before that the resolver
 * falls through). Entries without the hook resolve env override > install
 * marker > cn default themselves. Content-CDN artifacts (daemon/runtime
 * binaries) go through `kimiCdnContentUrl` directly and need no region here.
 */

import type { KimiRegion } from '@moonshot-ai/kimi-code-oauth';

import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface CapabilityEntryContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly kimiHomeDir: string;
  readonly userHomeDir: string;
  readonly plugins: IPluginService;
  readonly hostProcess: IHostProcessService;
  readonly fetchImpl?: typeof fetch;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly resolveRegion?: () => KimiRegion | Promise<KimiRegion>;
}
