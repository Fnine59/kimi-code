/**
 * `/plugins` REST routes — plugin management and the marketplace catalog.
 *
 *   GET  /plugins                                  data: {plugins: PluginSummary[]}
 *   GET  /plugins/marketplace                      data: {entries: MarketplaceEntry[]}
 *   POST /plugins                 body {source}    data: PluginSummary
 *   POST /plugins/{plugin_id}:enable|:disable|:remove
 *
 * Thin projection of the App-scope `IPluginService` (install/remove/enable
 * are serialized there and fire `onDidReload`, which converges session skill
 * catalogs and the capability shelf-install hook). The marketplace catalog is
 * fetched on demand from the configured URL (`pluginMarketplaceUrl` server
 * option, env `KIMI_CODE_PLUGIN_MARKETPLACE_URL`, default the production
 * catalog) and merged with the live install state — install status is always
 * detected from the local records, never from the catalog.
 *
 * **Action suffix**: `:enable` / `:disable` / `:remove` via `parseActionSuffix`
 * (bare ids rejected).
 *
 * **Error mapping**:
 *   - unknown plugin id            → `40419 plugin.not_found` (from the domain code)
 *   - malformed `{tail}` / body    → `40001 validation.failed`
 *   - catalog unreachable/invalid  → `50001` with a plain-language message
 *   - other errors                 → `50001` via the global error handler
 */

import { IPluginService, PluginErrors, isError2, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  installPluginRequestSchema,
  listPluginsResponseSchema,
  pluginMarketplaceResponseSchema,
  pluginIdParamSchema,
  pluginSummarySchema,
  type PluginMarketplaceEntryWire,
} from '../protocol/rest-plugin';
import { parseActionSuffix } from './action-suffix';

interface PluginsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const PLUGIN_ACTIONS = ['enable', 'disable', 'remove'] as const;

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

const rawMarketplaceSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string().min(1),
      tier: z.enum(['official', 'curated']).optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      homepage: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      version: z.string().optional(),
      source: z.string().min(1),
    }),
  ),
});

/** Strict `x.y.z` numeric comparison (no prerelease); avoids a semver dep. */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! > pb[i]!) return true;
    if (pa[i]! < pb[i]!) return false;
  }
  return false;
}

export interface PluginsRouteOptions {
  /** Resolved catalog URL (server option / env already applied by start.ts). */
  readonly marketplaceUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export function registerPluginsRoutes(
  app: PluginsRouteHost,
  core: Scope,
  opts: PluginsRouteOptions,
): void {
  // GET /plugins/marketplace — registered BEFORE /plugins/{tail} so the
  // literal segment wins over the param route.
  const marketplaceRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/marketplace',
      success: { data: pluginMarketplaceResponseSchema },
      errors: {},
      description: 'List the plugin marketplace catalog merged with live install state',
      tags: ['plugins'],
      operationId: 'listPluginMarketplace',
    },
    async (req, reply) => {
      const fetchImpl = opts.fetchImpl ?? fetch;
      let raw: unknown;
      try {
        const resp = await fetchImpl(opts.marketplaceUrl, {
          signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        raw = await resp.json();
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace is unreachable: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      const parsed = rawMarketplaceSchema.safeParse(raw);
      if (!parsed.success) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'Plugin marketplace returned an invalid catalog', req.id),
        );
        return;
      }
      const installed = await core.accessor.get(IPluginService).listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      const entries: PluginMarketplaceEntryWire[] = parsed.data.plugins.map((entry) => {
        const record = byId.get(entry.id);
        const installedInfo =
          record === undefined
            ? undefined
            : {
                enabled: record.enabled,
                ...(record.version !== undefined ? { version: record.version } : {}),
              };
        const updateAvailable =
          entry.version !== undefined &&
          record?.version !== undefined &&
          semverGt(entry.version, record.version);
        return {
          id: entry.id,
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName ?? entry.id,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
          ...(entry.keywords !== undefined ? { keywords: entry.keywords } : {}),
          ...(entry.version !== undefined ? { version: entry.version } : {}),
          source: entry.source,
          ...(installedInfo !== undefined ? { installed: installedInfo } : {}),
          ...(updateAvailable ? { updateAvailable: true } : {}),
        };
      });
      reply.send(okEnvelope({ entries }, req.id));
    },
  );
  app.get(
    marketplaceRoute.path,
    marketplaceRoute.options,
    marketplaceRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  // GET /plugins ------------------------------------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins',
      success: { data: listPluginsResponseSchema },
      errors: {},
      description: 'List installed plugins',
      tags: ['plugins'],
      operationId: 'listPlugins',
    },
    async (req, reply) => {
      const plugins = await core.accessor.get(IPluginService).listPlugins();
      reply.send(okEnvelope({ plugins }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  // POST /plugins {source} --------------------------------------------------
  const installRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins',
      body: installPluginRequestSchema,
      success: { data: pluginSummarySchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Install a plugin from a local path, zip URL, or GitHub repo',
      tags: ['plugins'],
      operationId: 'installPlugin',
    },
    async (req, reply) => {
      try {
        const plugin = await core.accessor.get(IPluginService).installPlugin(req.body);
        reply.send(okEnvelope(plugin, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    installRoute.path,
    installRoute.options,
    installRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );

  // POST /plugins/{plugin_id}:{enable|disable|remove} ------------------------
  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins/{tail}',
      params: pluginIdParamSchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
      },
      description: 'Enable, disable, or remove an installed plugin',
      tags: ['plugins'],
      operationId: 'pluginAction',
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: PLUGIN_ACTIONS,
        resourceLabel: 'plugin',
      });
      if (parsed.kind !== 'action') {
        const message =
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      const plugins = core.accessor.get(IPluginService);
      try {
        switch (parsed.action) {
          case 'enable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: true });
            break;
          case 'disable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: false });
            break;
          case 'remove':
            await plugins.removePlugin({ id: parsed.id });
            break;
        }
        reply.send(okEnvelope({ ok: true as const }, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );
}

function mapPluginError(error: unknown, requestId: string) {
  if (isError2(error) && error.code === PluginErrors.codes.PLUGIN_NOT_FOUND) {
    return errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, error.message, requestId, error.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
    error instanceof Error ? error.stack : undefined,
  );
}
