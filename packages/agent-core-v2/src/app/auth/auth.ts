/**
 * `auth` domain (cross-cutting) — app-scope OAuth + auth summary contracts.
 *
 * Defines the public contracts of authentication: the `AuthStatus` model, the
 * `IOAuthService` used to drive device-code login / logout / flow inspection,
 * to resolve a per-provider `BearerTokenProvider`, and to refresh a managed
 * OAuth provider's server-side model configuration, the `IOAuthToolkit`
 * device-code client that `IOAuthService` delegates the OAuth protocol to, and
 * the `IAuthSummaryService` used to summarize auth state and provide the
 * prompt auth-readiness gate. App-scoped — shared across the application.
 */

import type {
  AuthManagedUserInfoResult,
  AuthManagedUsageResult,
  BearerTokenProvider,
  KimiOAuthLoginOptions,
  KimiOAuthLoginResult,
  KimiOAuthLogoutResult,
  KimiOAuthTokenRef,
  KimiRegion,
} from '@moonshot-ai/kimi-code-oauth';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';

import type { OAuthRef } from '#/kosong/provider/provider';

import { AuthErrors } from './errors';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from './oauthProtocol';

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

export interface OAuthLoginOptions {
  /**
   * Explicit region choice from the login UI. Maps to the region profile's
   * OAuth/API hosts (including for 'cn', so switching back overrides a
   * persisted overseas login); yields to `KIMI_CODE_OAUTH_HOST` /
   * `KIMI_CODE_BASE_URL` env overrides.
   */
  readonly region?: KimiRegion;
}

export interface IOAuthService {
  readonly _serviceBrand: undefined;

  startLogin(provider?: string, options?: OAuthLoginOptions): Promise<OAuthFlowStart>;
  getFlow(provider?: string): OAuthFlowSnapshot | undefined;
  cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
  logout(provider?: string): Promise<OAuthLogoutResponse>;
  status(provider?: string): Promise<AuthStatus>;
  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
  getManagedUsage(provider?: string): Promise<AuthManagedUsageResult>;
  getManagedUserInfo(provider?: string): Promise<AuthManagedUserInfoResult>;
  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined;
  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined>;
  /**
   * Resolve the client's region (env override → persisted login → install
   * marker → 'cn'). Hosts that must ignore the install marker set
   * `KIMI_CODE_REGION_MARKER=off` (e.g. the desktop app's embedded server).
   */
  getRegion(): KimiRegion;
}

export const IOAuthService: ServiceIdentifier<IOAuthService> =
  createDecorator<IOAuthService>('oauthService');

export interface IOAuthToolkit {
  readonly _serviceBrand: undefined;

  login(providerName?: string, options?: KimiOAuthLoginOptions): Promise<KimiOAuthLoginResult>;
  logout(providerName?: string, oauthRef?: KimiOAuthTokenRef): Promise<KimiOAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): Promise<string | undefined>;
  tokenProvider(providerName?: string, oauthRef?: KimiOAuthTokenRef): BearerTokenProvider;
  getManagedUsage(
    providerName?: string,
    options?: { readonly oauthRef?: KimiOAuthTokenRef; readonly baseUrl?: string },
  ): Promise<AuthManagedUsageResult>;
  getManagedUserInfo(
    providerName?: string,
    options?: { readonly oauthRef?: KimiOAuthTokenRef; readonly baseUrl?: string },
  ): Promise<AuthManagedUserInfoResult>;
}

export const IOAuthToolkit: ServiceIdentifier<IOAuthToolkit> =
  createDecorator<IOAuthToolkit>('oauthToolkit');

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  summarize(): Promise<readonly AuthStatus[]>;
  ensureReady(modelOverride?: string): Promise<void>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');

export class AuthProvisioningRequiredError extends Error2 {
  constructor() {
    super(
      AuthErrors.codes.AUTH_PROVISIONING_REQUIRED,
      'no provider configured; complete onboarding via /login or the providers endpoint',
      { name: 'AuthProvisioningRequiredError' },
    );
  }
}

export class AuthTokenMissingError extends Error2 {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      AuthErrors.codes.AUTH_TOKEN_MISSING,
      `provider ${providerId} has no credential configured`,
      { details: { provider_id: providerId }, name: 'AuthTokenMissingError' },
    );
    this.providerId = providerId;
  }
}

export class AuthModelNotResolvedError extends Error2 {
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;

  constructor(modelId: string | undefined, providerId?: string) {
    const details: Record<string, unknown> = {};
    if (modelId !== undefined) details['model_id'] = modelId;
    if (providerId !== undefined) details['provider_id'] = providerId;
    super(
      AuthErrors.codes.AUTH_MODEL_NOT_RESOLVED,
      modelId === undefined
        ? 'no default model configured'
        : `model ${modelId} does not resolve to a configured provider`,
      {
        details: Object.keys(details).length === 0 ? undefined : details,
        name: 'AuthModelNotResolvedError',
      },
    );
    this.modelId = modelId;
    this.providerId = providerId;
  }
}
