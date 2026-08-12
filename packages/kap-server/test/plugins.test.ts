/**
 * `/api/v1` plugins routes — wire contract:
 *   - GET  /plugins                         → installed list (empty → 1 after install)
 *   - POST /plugins {source}                → installs (local path), returns summary
 *   - POST /plugins/{id}:disable / :enable  → toggles enabled
 *   - POST /plugins/{id}:remove             → removes
 *   - POST bare id / bogus action           → 40001
 *   - POST unknown id :remove               → 40419
 *   - GET  /plugins/marketplace             → catalog merged with live install state
 *   - GET  /plugins/marketplace unreachable → 50001
 *
 * The marketplace catalog is served by a stubbed global fetch; installs use
 * local-path sources in temp dirs (no network).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_URL = 'http://marketplace.test/marketplace.json';

const CATALOG = {
  version: '1',
  plugins: [
    {
      id: 'demo-plugin',
      tier: 'official',
      displayName: 'Demo Plugin',
      version: '2.0.0',
      source: 'https://cdn.example.test/demo.zip',
    },
    {
      id: 'third-party-plugin',
      displayName: 'Third Party',
      source: 'https://github.com/example/third',
    },
  ],
};

describe('server-v2 /api/v1 plugins', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-plugins-'));
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(JSON.stringify(CATALOG), { status: 200 });
        }
        return realFetch(url as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      pluginMarketplaceUrl: CATALOG_URL,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      // A JSON content-type with an empty body is rejected by Fastify.
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function makePluginDir(id: string, version: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `kimi-test-plugin-${id}-`));
    createdDirs.push(dir);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({ name: id, version, description: 'test plugin' }),
    );
    return dir;
  }

  it('installs, lists, disables, enables, and removes a plugin', async () => {
    const empty = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(empty.body.data.plugins).toEqual([]);

    const source = await makePluginDir('demo-plugin', '1.0.0');
    const installed = await call<{ id: string; version: string; enabled: boolean }>(
      'POST',
      '/api/v1/plugins',
      { source },
    );
    expect(installed.body.code).toBe(0);
    expect(installed.body.data).toMatchObject({ id: 'demo-plugin', version: '1.0.0', enabled: true });

    const list = await call<{ plugins: { id: string; enabled: boolean }[] }>(
      'GET',
      '/api/v1/plugins',
    );
    expect(list.body.data.plugins.map((p) => [p.id, p.enabled])).toEqual([['demo-plugin', true]]);

    const disabled = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:disable');
    expect(disabled.body.code).toBe(0);
    const afterDisable = await call<{ plugins: { enabled: boolean }[] }>('GET', '/api/v1/plugins');
    expect(afterDisable.body.data.plugins[0]?.enabled).toBe(false);

    const enabled = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:enable');
    expect(enabled.body.code).toBe(0);

    const removed = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:remove');
    expect(removed.body.code).toBe(0);
    const afterRemove = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(afterRemove.body.data.plugins).toEqual([]);
  });

  it('rejects bare ids, bogus actions, and unknown plugins', async () => {
    const bare = await call('POST', '/api/v1/plugins/demo-plugin');
    expect(bare.body.code).toBe(40001);
    const bogus = await call('POST', '/api/v1/plugins/demo-plugin:explode');
    expect(bogus.body.code).toBe(40001);
    const unknown = await call('POST', '/api/v1/plugins/nope:remove');
    expect(unknown.body.code).toBe(40419);
    const badSource = await call('POST', '/api/v1/plugins', { source: '' });
    expect(badSource.body.code).toBe(40001);
  });

  it('serves the marketplace catalog merged with live install state', async () => {
    const before = await call<{
      entries: { id: string; tier: string; installed?: { version?: string } }[];
    }>('GET', '/api/v1/plugins/marketplace');
    expect(before.body.code).toBe(0);
    expect(before.body.data.entries.map((e) => [e.id, e.tier])).toEqual([
      ['demo-plugin', 'official'],
      ['third-party-plugin', 'third-party'],
    ]);
    expect(before.body.data.entries[0]?.installed).toBeUndefined();

    // Install an older version than the catalog → updateAvailable.
    const source = await makePluginDir('demo-plugin', '1.0.0');
    await call('POST', '/api/v1/plugins', { source });

    const after = await call<{
      entries: {
        id: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
      }[];
    }>('GET', '/api/v1/plugins/marketplace');
    const demo = after.body.data.entries.find((e) => e.id === 'demo-plugin');
    expect(demo?.installed).toEqual({ version: '1.0.0', enabled: true });
    expect(demo?.updateAvailable).toBe(true);
  });

  it('maps an unreachable marketplace to 50001', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          throw new Error('network down');
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('unreachable');
  });
});
