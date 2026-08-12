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
 * `source` is directly installable. Entries without a `version` get one from
 * a GitHub ref tail or the bare repo's latest release (CLI parity), which is
 * what drives `updateAvailable`.
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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gt, valid } from 'semver';
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

/**
 * Capability wiring plugin id → capability id, applied only to the DEFAULT
 * catalog (a custom catalog may legitimately carry a same-id fork — the CLI
 * likewise injects built-in rows only for the default catalog). The closed
 * id set belongs to the client/engine contract (mirrored by the klient
 * schema; the CLI names it inline). Marking these rows lets clients route
 * them through `/capabilities/{id}:install` — a plain `POST /plugins`
 * installs only the wiring layer, never the binary runtime.
 */
const CAPABILITY_ROW_IDS: Readonly<Record<string, string>> = {
  'kimi-cu': 'kimi-cu',
  'kimi-cu-win': 'kimi-cu',
  'kimi-webbridge': 'kimi-webbridge',
};

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
    const normalized: Record<string, unknown> = { ...record };
    // The id keys the install-state join — trim it like the CLI's
    // requiredString; a blank id drops out so the schema rejects the entry.
    const id = pick(record['id']);
    if (id === undefined) delete normalized['id'];
    else normalized['id'] = id;
    // Metadata: blank reads as missing, and the CLI parser's aliases are
    // honored (name / shortDescription / websiteURL).
    const metadataAliases = [
      ['displayName', 'name'],
      ['description', 'shortDescription'],
      ['homepage', 'websiteURL'],
    ] as const;
    for (const [field, alias] of metadataAliases) {
      const value = pick(record[field]) ?? pick(record[alias]);
      if (value === undefined) delete normalized[field];
      else normalized[field] = value;
    }
    // A blank tier means "missing" (third-party); a non-string tier keeps
    // failing validation, matching the CLI parser's type error.
    const tier = record['tier'];
    if (typeof tier === 'string') {
      if (tier.trim().length === 0) delete normalized['tier'];
      else normalized['tier'] = tier.trim();
    }
    // Keywords keep only non-blank strings (a junk member never fails the
    // catalog); a non-array value reads as missing — CLI stringArrayField
    // semantics.
    const keywords = record['keywords'];
    if (keywords !== undefined) {
      const kept = Array.isArray(keywords)
        ? keywords
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      if (kept.length > 0) normalized['keywords'] = kept;
      else delete normalized['keywords'];
    }
    // Version: blank or non-string reads as missing (derivation from the
    // source then kicks in downstream) — the raw trimmed string is kept
    // as-is otherwise (strictness lives in the update check, not here).
    const version = pick(record['version']);
    if (version === undefined) delete normalized['version'];
    else normalized['version'] = version;
    const source = pick(record['source']) ?? pick(record['url']) ?? pick(record['downloadUrl']);
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

/** CLI-parity update check: both sides must be valid semver (`v` prefix and
 *  prerelease tags accepted), catalog strictly greater. */
function semverGt(a: string, b: string): boolean {
  return valid(a) !== null && valid(b) !== null && gt(a, b);
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
 * the CLI parser; validity follows `semver.valid`).
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
  return valid(candidate) !== null ? candidate : undefined;
}

/**
 * Bare-repo GitHub sources carry no version — resolve the latest release tag
 * through the `/releases/latest` redirect (a UI route, not the rate-limited
 * API), same as the CLI. Lookups never fail the listing: any error degrades
 * to no version.
 */
async function resolveLatestGithubRelease(
  source: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  // Only bare repo URLs (/<owner>/<repo>) qualify — ref tails are already
  // handled by deriveVersionFromGithubSource.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return undefined;
  const [owner, repo] = segments;
  try {
    const resp = await fetchImpl(`https://github.com/${owner}/${repo}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    });
    if (resp.status !== 301 && resp.status !== 302) return undefined;
    const location = resp.headers.get('location');
    if (location === null) return undefined;
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
    if (tag === undefined) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(tag);
    } catch {
      decoded = tag;
    }
    const candidate = decoded.replace(/^v/i, '');
    return valid(candidate) !== null ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local catalog location → filesystem path: `file://` conversion plus home
 * expansion.
 */
function localCatalogPath(location: string): string {
  return expandHome(location.startsWith('file://') ? fileURLToPath(location) : location);
}

/**
 * The repo checkout's own catalog — the CLI loader's fallback when the
 * configured catalog is unreachable (offline / source-checkout dev). Absent
 * in bundled installs, where the fallback simply never fires.
 */
function sourceCheckoutCatalogPath(): string | undefined {
  const candidate = resolve(import.meta.dirname, '../../../../plugins/marketplace.json');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Read the raw marketplace catalog JSON. Remote catalogs go through fetch;
 * local catalogs (plain path or `file://`, both accepted by the CLI loader)
 * are read from disk so the same custom catalog works for desktop/web hosts.
 * A failed remote read falls back to the source checkout's catalog when one
 * exists (CLI parity).
 */
/**
 * Read the raw marketplace catalog JSON plus the location it was actually
 * read from — relative entry sources resolve against the latter (the
 * source-checkout fallback serves local directory sources).
 */
async function readMarketplaceCatalog(
  opts: PluginsRouteOptions,
): Promise<{ raw: unknown; location: string }> {
  const location = opts.marketplaceUrl;
  if (!/^https?:\/\//.test(location)) {
    return {
      raw: JSON.parse(await readFile(localCatalogPath(location), 'utf8')),
      location,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resp = await fetchImpl(location, {
      signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { raw: await resp.json(), location };
  } catch (error) {
    const fallback =
      opts.marketplaceIsDefault === true ? sourceCheckoutCatalogPath() : undefined;
    if (fallback === undefined) throw error;
    return { raw: JSON.parse(await readFile(fallback, 'utf8')), location: fallback };
  }
}

export interface PluginsRouteOptions {
  /** Resolved catalog URL (server option / env already applied by start.ts). */
  readonly marketplaceUrl: string;
  /**
   * True when the catalog location is the built-in default (neither the
   * server option nor the env var set) — only then does a failed remote read
   * fall back to the source-checkout catalog (CLI parity: an explicitly
   * configured catalog fails hard).
   */
  readonly marketplaceIsDefault?: boolean;
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
      let catalog: { raw: unknown; location: string };
      try {
        catalog = await readMarketplaceCatalog(opts);
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
      const parsed = rawMarketplaceSchema.safeParse(catalog.raw);
      if (!parsed.success) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'Plugin marketplace returned an invalid catalog', req.id),
        );
        return;
      }
      const fetchImpl = opts.fetchImpl ?? fetch;
      // Resolve sources and versions up front (parallel; latest-release
      // lookups for bare GitHub repos ride the shared per-call timeout).
      const resolved = await Promise.all(
        parsed.data.plugins.map(async (entry) => {
          const source = resolveEntrySource(entry.source, catalog.location);
          // Entries may omit `version`: derive it from a GitHub ref tail, or
          // look up the latest release of a bare repo source (CLI parity).
          const version =
            entry.version ??
            deriveVersionFromGithubSource(source) ??
            (await resolveLatestGithubRelease(source, fetchImpl));
          return { entry, source, version };
        }),
      );
      const installed = await core.accessor.get(IPluginService).listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      const entries: PluginMarketplaceEntryWire[] = resolved.map(({ entry, source, version }) => {
        const record = byId.get(entry.id);
        const installedInfo =
          record === undefined
            ? undefined
            : { enabled: record.enabled, version: record.version };
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
          capabilityId:
            opts.marketplaceIsDefault === true ? CAPABILITY_ROW_IDS[entry.id] : undefined,
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
