/**
 * Scenario: the shared McpOAuthService stamps token writes with `obtained_at`,
 * exposes the offline token state, emits credential events, and runs token
 * refreshes single-flight per credential.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core exec vitest run test/mcp/oauth-service.test.ts`.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonFileStore,
  McpOAuthService,
  type McpOAuthEvent,
  type McpOAuthStoreMeta,
} from '../../src/mcp/oauth';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.example.test/mcp';

interface Fixture {
  readonly service: McpOAuthService;
  readonly store: JsonFileStore;
  readonly storeDir: string;
  readonly events: McpOAuthEvent[];
}

function makeFixture(): Fixture {
  const events: McpOAuthEvent[] = [];
  const storeDir = `${tmpdir()}/kimi-mcp-oauth-service-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const store = new JsonFileStore(storeDir);
  const service = new McpOAuthService({ store });
  service.onEvent((event) => events.push(event));
  return { service, store, storeDir, events };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('McpOAuthService credential bookkeeping', () => {
  it('stamps token writes with obtained_at and a name/url meta record', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.stopProactiveRefresh());
    cleanups.push(() => rm(fixture.storeDir, { recursive: true, force: true }));

    const before = Date.now();
    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });

    const state = fixture.service.tokenState(SERVER_NAME, SERVER_URL);
    expect(state.hasTokens).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.expiresAt).toBeDefined();
    expect(state.expiresAt!).toBeGreaterThanOrEqual(before + 3600_000);
    expect(state.expiresAt!).toBeLessThanOrEqual(Date.now() + 3600_000);

    const metaFiles = fixture.store.list('-meta.json');
    expect(metaFiles).toHaveLength(1);
    expect(fixture.store.read<McpOAuthStoreMeta>(metaFiles[0]!)).toEqual({
      serverName: SERVER_NAME,
      serverUrl: `${SERVER_URL}`,
    });

    expect(fixture.events).toEqual([
      { type: 'tokens-saved', serverName: SERVER_NAME, serverUrl: SERVER_URL },
    ]);
  });

  it('treats tokens without expiry data as non-expiring, and expired grants as expired', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.stopProactiveRefresh());
    cleanups.push(() => rm(fixture.storeDir, { recursive: true, force: true }));

    expect(fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toEqual({
      hasTokens: false,
      hasRefreshToken: false,
      expired: false,
    });

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
      expiresAt: undefined,
    });

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      expires_in: -60,
    });
    expect(fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      hasRefreshToken: false,
      expired: true,
    });
  });

  it('emits tokens-invalidated and drops the meta record when credentials are cleared', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.stopProactiveRefresh());
    cleanups.push(() => rm(fixture.storeDir, { recursive: true, force: true }));

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(fixture.store.list('-meta.json')).toHaveLength(1);

    await fixture.service.invalidate(SERVER_NAME, SERVER_URL, 'tokens');
    expect(fixture.service.tokenState(SERVER_NAME, SERVER_URL).hasTokens).toBe(false);
    expect(fixture.store.list('-meta.json')).toHaveLength(0);
    expect(fixture.events).toContainEqual({
      type: 'tokens-invalidated',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      scope: 'tokens',
    });
  });
});

describe('McpOAuthService single-flight refresh', () => {
  it('shares one in-flight refresh across concurrent callers', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.stopProactiveRefresh());
    cleanups.push(() => rm(fixture.storeDir, { recursive: true, force: true }));

    let tokenRequests = 0;
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        tokenRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    const port = (httpServer.address() as HttpAddress).port;
    const authServerUrl = `http://127.0.0.1:${port}`;

    const provider = fixture.service.getProvider(SERVER_NAME, SERVER_URL);
    provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await Promise.all([
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
    ]);
    expect(tokenRequests).toBe(1);
    expect(fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
    });
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('rejects when no refresh token is stored', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.stopProactiveRefresh());
    cleanups.push(() => rm(fixture.storeDir, { recursive: true, force: true }));

    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).rejects.toThrow(
      /no refreshable OAuth grant/,
    );
  });
});
