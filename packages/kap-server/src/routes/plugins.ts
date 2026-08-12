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
 * read on demand from the configured location (`pluginMarketplaceUrl` server
 * option, env `KIMI_CODE_PLUGIN_MARKETPLACE_URL`, default the production
 * catalog; plain paths and `file://` URLs read from disk like the CLI loader)
 * and merged with the live install state — install status is always detected
 * from the local records, never from the catalog. Catalog-relative sources
 * (`./official/*.zip`) resolve against the catalog location so the returned
 * `source` is directly installable.
 *
 * **Action suffix**: `:enable` / `:disable` / `:remove` via `parseActionSuffix`
 * (bare ids rejected).
 *
 * **Error mapping**:
 *   - unknown plugin id            → `40419 plugin.not_found` (from the domain code)
 *   - bad install source / path    → `40001 validation.failed` / `40409 fs.path_not_found`
 *   - malformed `{tail}` / body    → `40001 validation.failed`
 *   - catalog unreachable/invalid  → `50001` with a plain-language message
 *   - other errors                 → `50001` via the global error handler
 */

import {
  ErrorCodes as DomainErrorCodes,
  IPluginService,
  PluginErrors,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Custom catalogs accepted by the CLI may carry the source under the legacy
// `url` / `downloadUrl` aliases — normalize before validating so a catalog
// that works in the CLI works here too.
const rawMarketplaceEntrySchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    // CLI stringField semantics: non-string or blank counts as missing, and
    // the first valid of source / url / downloadUrl wins (trimmed).
    const pick = (v: unknown) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
    // A blank tier means "missing" (third-party), same as the CLI parser.
    const tier = pick(record['tier']);
    const source = pick(record['source']) ?? pick(record['url']) ?? pick(record['downloadUrl']);
    const normalized: Record<string, unknown> = { ...record };
    if (tier === undefined) delete normalized['tier'];
    else normalized['tier'] = tier;
    // A source with no valid value or alias must fail validation (not slip
    // through as whitespace): drop the key so the schema reports it missing.
    if (source !== undefined) normalized['source'] = source;
    else delete normalized['source'];
    return normalized;
  },
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
);

const rawMarketplaceSchema = z.object({
  plugins: z.array(rawMarketplaceEntrySchema),
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

/**
 * Catalog sources may be relative to the catalog location (the production CDN
 * catalog uses `./official/*.zip`). Clients hand `source` back to
 * `POST /plugins`, whose normalizer rejects non-absolute paths — resolve
 * against the catalog URL (or, for a local catalog, its directory) so every
 * returned source is directly installable.
 */
function resolveEntrySource(source: string, marketplaceUrl: string): string {
  if (/^https?:\/\//.test(source)) return source;
  // `file://` entry sources convert to filesystem paths up front — the
  // install normalizer only accepts http(s) or absolute local paths.
  if (source.startsWith('file://')) return fileURLToPath(source);
  // Home-relative entry sources expand before any absolute/relative decision.
  const expanded = expandHome(source);
  if (isAbsolute(expanded)) return expanded;
  if (/^https?:\/\//.test(marketplaceUrl)) {
    try {
      return new URL(expanded, marketplaceUrl).href;
    } catch {
      return expanded;
    }
  }
  return resolve(dirname(localCatalogPath(marketplaceUrl)), expanded);
}

/** `~` / `~/` home expansion, same as the CLI loader's resolveLocalPath. */
function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Derive a version from a GitHub release/tree/commit source (same shapes as
 * the CLI parser; strict `x.y.z`, no prerelease — mirrors `semverGt`).
 */
function deriveVersionFromGithubSource(source: string): string | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  const [, , kind, a, b] = url.pathname.split('/').filter(Boolean);
  const ref =
    kind === 'releases' && a === 'tag' ? b : kind === 'tree' || kind === 'commit' ? a : undefined;
  if (ref === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    decoded = ref;
  }
  const candidate = decoded.replace(/^v/i, '');
  return /^(\d+)\.(\d+)\.(\d+)$/.test(candidate) ? candidate : undefined;
}

/**
 * Local catalog location → filesystem path: `file://` conversion plus home
 * expansion.
 */
function localCatalogPath(location: string): string {
  return expandHome(location.startsWith('file://') ? fileURLToPath(location) : location);
}

/**
 * Read the raw marketplace catalog JSON. Remote catalogs go through fetch;
 * local catalogs (plain path or `file://`, both accepted by the CLI loader)
 * are read from disk so the same custom catalog works for desktop/web hosts.
 */
async function readMarketplaceCatalog(opts: PluginsRouteOptions): Promise<unknown> {
  const location = opts.marketplaceUrl;
  if (!/^https?:\/\//.test(location)) {
    return JSON.parse(await readFile(localCatalogPath(location), 'utf8'));
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(location, {
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
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
      let raw: unknown;
      try {
        raw = await readMarketplaceCatalog(opts);
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
            : { enabled: record.enabled, version: record.version };
        const source = resolveEntrySource(entry.source, opts.marketplaceUrl);
        // Entries may omit `version` and encode it in a GitHub release/tag
        // source — derive it so update checks still fire (CLI parity).
        const version = entry.version ?? deriveVersionFromGithubSource(source);
        const updateAvailable =
          version !== undefined &&
          record?.version !== undefined &&
          semverGt(version, record.version);
        return {
          id: entry.id,
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName ?? entry.id,
          description: entry.description,
          homepage: entry.homepage,
          keywords: entry.keywords,
          version,
          source,
          installed: installedInfo,
          updateAvailable: updateAvailable ? true : undefined,
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
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
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

const PLUGIN_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  [PluginErrors.codes.PLUGIN_NOT_FOUND]: ErrorCode.PLUGIN_NOT_FOUND,
  // Client-fixable input mistakes (relative source, missing local path) keep
  // their 4xx semantics instead of collapsing into a 50001.
  [DomainErrorCodes.VALIDATION_FAILED]: ErrorCode.VALIDATION_FAILED,
  [DomainErrorCodes.FS_PATH_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
};

function mapPluginError(error: unknown, requestId: string) {
  const mapped = isError2(error) ? PLUGIN_ERROR_MAP[error.code] : undefined;
  if (mapped !== undefined && isError2(error)) {
    return errEnvelope(mapped, error.message, requestId, error.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
    error instanceof Error ? error.stack : undefined,
  );
}
