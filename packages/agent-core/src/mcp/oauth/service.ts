/**
 * Process-wide OAuth orchestrator for MCP remote servers.
 *
 * One instance per process (KimiCore shares it with every Session). The
 * service owns one {@link McpOAuthClientProvider} per server/resource and
 * mediates both the synthetic `mcp__<server>__authenticate` tool flow and the
 * management-plane login/reset RPCs:
 *
 *  1. `getProvider(serverName, serverUrl)` returns the cached provider.
 *     `HttpMcpClient` hands this to `StreamableHTTPClientTransport.authProvider`
 *     only when the server has no static bearer token configured **and** the
 *     provider has stored tokens for that same server URL — first-time
 *     connections that lack tokens skip the provider entirely so a 401 surfaces
 *     as `UnauthorizedError` from the transport instead of being swallowed by an
 *     in-flight `auth()` attempt.
 *  2. `beginAuthorization(serverName, serverUrl)` spins up a one-shot
 *     localhost callback listener, sets the redirect URL on the provider,
 *     and drives the SDK `auth()` orchestrator forward until it surfaces an
 *     authorization URL. It returns that URL plus a `complete()` callback
 *     that finishes the code exchange once the user finishes the browser
 *     flow.
 *  3. After `complete()` resolves successfully the provider has tokens on
 *     disk; the caller (the synthetic tool) drives a manager-level
 *     `reconnect` to swap the synthetic tool out for the real MCP tools.
 *
 * Centralized credential care, so N sessions sharing one server cannot
 * interfere:
 *
 *  - Every token write is stamped with `obtained_at`, giving the service an
 *    absolute expiry to reason about (`tokenState`).
 *  - `refresh()` is single-flight per credential: concurrent callers (proactive
 *    timer, manual trigger) share one in-flight SDK refresh.
 *  - A proactive timer refreshes tokens shortly before they expire
 *    (`sweepProactiveRefresh` re-arms it at process start from the credential
 *    store's meta files; the save hook re-arms it after every write). The
 *    SDK transport's own 401-driven refresh remains as the backstop.
 *  - Token saves, invalidations, and refresh failures are emitted as events
 *    so the engine can push the outcome into live sessions instead of leaving
 *    them in a stale `needs-auth` / doomed-connected state.
 */

import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { startCallbackServer, type CallbackServer } from './callback-server';
import {
  META_SUFFIX,
  McpOAuthClientProvider,
  type McpOAuthStoreMeta,
  type StoredMcpOAuthTokens,
} from './provider';
import {
  JsonFileStore,
  canonicalMcpOAuthResource,
  mcpCredentialsDir,
  mcpOAuthStoreKey,
} from './store';

export interface McpOAuthServiceOptions {
  /** Storage backend; overrides `kimiHomeDir` when supplied. */
  readonly store?: JsonFileStore;
  /** Resolved Kimi home; credentials default to `<kimiHomeDir>/credentials/mcp/`. */
  readonly kimiHomeDir?: string;
  /** Override for the label embedded in DCR `client_name`. */
  readonly clientLabel?: string;
}

export interface BeginAuthorizationOptions {
  /** Override the `client_name` embedded in the DCR registration request. */
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  /** The authorization URL the user must open in their browser. */
  readonly authorizationUrl: URL;
  /**
   * Awaits the OAuth callback, validates `state`, exchanges the code for
   * tokens, and persists them via the provider. Resolves on success;
   * rejects on abort, timeout, or auth-server error.
   */
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /**
   * Tears down the callback listener without finishing the flow. Safe to
   * call repeatedly; called automatically by `complete()`.
   */
  cancel(): Promise<void>;
}

export type McpOAuthEvent =
  | {
      readonly type: 'tokens-saved';
      readonly serverName: string;
      readonly serverUrl: string;
    }
  | {
      readonly type: 'tokens-invalidated';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
    }
  | {
      readonly type: 'refresh-failed';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly error: string;
    };

export type McpOAuthEventListener = (event: McpOAuthEvent) => void;

/** Offline credential snapshot for one server/resource identity. */
export interface McpOAuthTokenState {
  readonly hasTokens: boolean;
  readonly hasRefreshToken: boolean;
  /** Absolute expiry in epoch ms, when the stored grant carries enough data. */
  readonly expiresAt?: number;
  readonly expired: boolean;
}

/** Refresh this far ahead of the absolute expiry. */
const REFRESH_AHEAD_MS = 120_000;
/** `setTimeout` cannot schedule beyond 2^31-1 ms; later saves/sweeps re-arm. */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

export class McpOAuthService {
  private readonly store: JsonFileStore;
  private readonly clientLabel: string | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();
  private readonly listeners = new Set<McpOAuthEventListener>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: McpOAuthServiceOptions = {}) {
    this.store =
      options.store ??
      new JsonFileStore(
        options.kimiHomeDir === undefined ? undefined : mcpCredentialsDir(options.kimiHomeDir),
      );
    this.clientLabel = options.clientLabel;
  }

  /** Returns the cached provider for `serverName` + `serverUrl`, constructing it on first use. */
  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = this.createProvider(serverName, serverUrl);
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  /** True once the provider has persisted tokens for this server/resource identity. */
  hasTokens(serverName: string, serverUrl: string | URL): boolean {
    return this.getProvider(serverName, serverUrl).tokens() !== undefined;
  }

  /**
   * Offline view of the stored grant. `expired` is only computable when the
   * tokens were written with an `obtained_at` stamp and carry `expires_in`;
   * older or foreign writes without both are treated as non-expiring.
   */
  tokenState(serverName: string, serverUrl: string | URL): McpOAuthTokenState {
    const tokens = this.getProvider(serverName, serverUrl).tokens() as
      | StoredMcpOAuthTokens
      | undefined;
    if (tokens === undefined) {
      return { hasTokens: false, hasRefreshToken: false, expired: false };
    }
    const expiresAt =
      typeof tokens.obtained_at === 'number' && typeof tokens.expires_in === 'number'
        ? tokens.obtained_at + tokens.expires_in * 1000
        : undefined;
    return {
      hasTokens: true,
      hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
      expiresAt,
      expired: expiresAt !== undefined && Date.now() >= expiresAt,
    };
  }

  onEvent(listener: McpOAuthEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Single-flight token refresh per credential: concurrent callers share one
   * in-flight SDK `auth()` run, so two sessions expiring together cannot race
   * a rotating refresh token. Resolves when the grant is usable again;
   * rejects when the refresh token was rejected (or never existed) and an
   * interactive login is required.
   */
  async refresh(serverName: string, serverUrl: string | URL): Promise<void> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const existing = this.refreshes.get(storeKey);
    if (existing !== undefined) return existing;
    const task = this.refreshNow(serverName, serverUrl).finally(() => {
      this.refreshes.delete(storeKey);
    });
    this.refreshes.set(storeKey, task);
    return task;
  }

  /**
   * Arm the proactive refresh timer for every stored credential that carries
   * enough data to expire. Called once at engine start; subsequent token
   * writes re-arm through the provider save hook.
   */
  sweepProactiveRefresh(): void {
    for (const file of this.store.list(META_SUFFIX)) {
      const meta = this.store.read<McpOAuthStoreMeta>(file);
      if (meta === undefined) continue;
      const state = this.tokenState(meta.serverName, meta.serverUrl);
      if (!state.hasTokens || !state.hasRefreshToken || state.expiresAt === undefined) continue;
      this.scheduleRefresh(meta.serverName, meta.serverUrl, state.expiresAt);
    }
  }

  /** Clear every pending proactive-refresh timer (engine shutdown, tests). */
  stopProactiveRefresh(): void {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
  }

  /**
   * Drive the SDK `auth()` orchestrator far enough to surface an
   * authorization URL. The caller is responsible for displaying the URL
   * (typically via the synthetic authenticate tool) and then awaiting
   * `complete()` to finish the code exchange.
   */
  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider =
      options.clientLabel === undefined
        ? this.getProvider(serverName, serverUrl)
        : this.createProvider(serverName, serverUrl, options.clientLabel);
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError('failed to start OAuth callback listener', error);
    }

    provider.setRedirectUrl(new URL(callbackServer.redirectUri));
    // See invalidateStaleRegistration: a reused registration whose redirect
    // URIs no longer cover this flow's random-port callback would be rejected
    // at the authorization endpoint with an error only the browser ever sees.
    await provider.invalidateStaleRegistration(callbackServer.redirectUri);

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, {
        serverUrl,
        fetchFn: provider.createOAuthFetch(),
      });
      if (result !== 'REDIRECT') {
        // Tokens already valid (e.g. unexpired refresh, or a grant written
        // by another process). Tell needs-auth sessions to pick them up.
        await callbackServer.close();
        this.emit({
          type: 'tokens-saved',
          serverName,
          serverUrl: canonicalMcpOAuthResource(serverUrl),
        });
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error('OAuth provider did not capture an authorization URL');
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult['complete'] = async (opts = {}) => {
      if (settled) {
        throw new Error('OAuth flow already completed or cancelled');
      }
      try {
        const { code, state } = await callbackServer.waitForCode({
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error('OAuth state mismatch — possible CSRF; refusing token exchange');
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
          fetchFn: provider.createOAuthFetch(),
        });
        if (finalResult !== 'AUTHORIZED') {
          throw new Error(`OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`);
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  /**
   * Clear stored credentials for a server. Use `'all'` after the user
   * explicitly signs out; use `'tokens'` to force a re-auth while keeping
   * the registered DCR client.
   */
  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).clearCredentials(scope);
  }

  /**
   * Drop the cached provider for a credential. After an invalidation this
   * guarantees the next `beginAuthorization` starts from a clean in-memory
   * flow state (files are always re-read, so this is defensive).
   */
  forgetProvider(serverName: string, serverUrl: string | URL): void {
    this.providers.delete(mcpOAuthStoreKey(serverName, serverUrl));
  }

  private createProvider(
    serverName: string,
    serverUrl: string | URL,
    clientLabel?: string,
  ): McpOAuthClientProvider {
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    return new McpOAuthClientProvider({
      serverName,
      serverUrl,
      store: this.store,
      clientLabel: clientLabel ?? this.clientLabel,
      onTokensSaved: (tokens) => {
        this.emit({ type: 'tokens-saved', serverName, serverUrl: canonicalUrl });
        if (typeof tokens.obtained_at === 'number' && typeof tokens.expires_in === 'number') {
          this.scheduleRefresh(serverName, canonicalUrl, tokens.obtained_at + tokens.expires_in * 1000);
        }
      },
      onCredentialsInvalidated: (scope) => {
        if (scope === 'tokens' || scope === 'all') {
          this.cancelScheduledRefresh(serverName, canonicalUrl);
        }
        this.emit({ type: 'tokens-invalidated', serverName, serverUrl: canonicalUrl, scope });
      },
    });
  }

  private async refreshNow(serverName: string, serverUrl: string | URL): Promise<void> {
    const state = this.tokenState(serverName, serverUrl);
    if (!state.hasTokens || !state.hasRefreshToken) {
      throw new Error(`MCP server "${serverName}" has no refreshable OAuth grant`);
    }
    const provider = this.getProvider(serverName, serverUrl);
    provider.resetFlow();
    try {
      // The SDK refreshes whenever a refresh token exists, without checking
      // the access-token expiry — exactly what a proactive refresh wants. A
      // rejected refresh token falls through to the interactive branch and
      // comes back as REDIRECT, which this non-interactive path treats as
      // failure.
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== 'AUTHORIZED') {
        throw new Error('the stored OAuth grant requires an interactive login');
      }
    } finally {
      provider.resetFlow();
    }
  }

  private scheduleRefresh(serverName: string, serverUrl: string | URL, expiresAt: number): void {
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    const storeKey = mcpOAuthStoreKey(serverName, canonicalUrl);
    this.cancelScheduledRefresh(serverName, canonicalUrl);
    const delay = expiresAt - Date.now() - REFRESH_AHEAD_MS;
    // Only future refresh points are armed. A grant already past its
    // proactive point is left to the connect path (the transport's 401
    // refresh) — firing a network refresh immediately on boot/save is both
    // wasteful for dead servers and racy for short-lived embedders (tests).
    if (delay <= 0 || delay > MAX_TIMER_DELAY_MS) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(storeKey);
      void this.refresh(serverName, canonicalUrl).catch((error: unknown) => {
        this.emit({
          type: 'refresh-failed',
          serverName,
          serverUrl: canonicalUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    timer.unref();
    this.refreshTimers.set(storeKey, timer);
  }

  private cancelScheduledRefresh(serverName: string, serverUrl: string | URL): void {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const timer = this.refreshTimers.get(storeKey);
    if (timer !== undefined) clearTimeout(timer);
    this.refreshTimers.delete(storeKey);
  }

  private emit(event: McpOAuthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener faults must not break credential persistence.
      }
    }
  }
}

/** Thrown by `beginAuthorization` when stored tokens already satisfy the server. */
export class AlreadyAuthorizedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" is already authorized; no browser flow needed`);
    this.name = 'AlreadyAuthorizedError';
  }
}

function wrapAuthError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${prefix}: ${error.message}`);
    wrapped.cause = error;
    return wrapped;
  }
  return new Error(`${prefix}: ${String(error)}`);
}
