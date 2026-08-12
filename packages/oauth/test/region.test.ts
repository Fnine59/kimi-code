import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from '#/constants';
import { DEFAULT_KIMI_CODE_BASE_URL } from '#/managed-usage';
import {
  KIMI_REGION_MARKER_FILENAME,
  KIMI_REGION_PROFILES,
  kimiRegionLoginHosts,
  kimiRegionProfile,
  kimiRegionSchema,
  resolveKimiRegion,
} from '#/region';

import { createTempWorkDir, type TempDirHandle } from './helpers';

describe('KIMI_REGION_PROFILES', () => {
  it('keeps the cn profile aligned with the shared defaults', () => {
    expect(KIMI_REGION_PROFILES.cn.oauthHost).toBe(DEFAULT_KIMI_CODE_OAUTH_HOST);
    expect(KIMI_REGION_PROFILES.cn.baseUrl).toBe(DEFAULT_KIMI_CODE_BASE_URL);
  });

  it('kimiRegionProfile returns the requested profile', () => {
    expect(kimiRegionProfile('overseas').oauthHost).toBe('https://auth.kimi.ai');
    expect(kimiRegionProfile('cn')).toBe(KIMI_REGION_PROFILES.cn);
  });
});

describe('resolveKimiRegion', () => {
  let workDir: TempDirHandle | undefined;

  afterEach(async () => {
    await workDir?.cleanup();
    workDir = undefined;
  });

  async function markerDir(contents?: string): Promise<string> {
    workDir = await createTempWorkDir();
    if (contents !== undefined) {
      await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), contents, 'utf-8');
    }
    return workDir.path;
  }

  it('defaults to cn when nothing points anywhere', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir() })).toBe('cn');
  });

  it('resolves a known env oauth host, KIMI_CODE_OAUTH_HOST first', () => {
    expect(resolveKimiRegion({ env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'overseas',
    );
    expect(resolveKimiRegion({ env: { KIMI_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'overseas',
    );
    expect(
      resolveKimiRegion({
        env: {
          KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com',
          KIMI_OAUTH_HOST: 'https://auth.kimi.ai',
        },
      }),
    ).toBe('cn');
  });

  it('treats an unknown env host as a custom environment and falls back to cn', async () => {
    // ...even when the persisted login or marker says otherwise: the custom
    // env overrides every endpoint anyway.
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.internal.example.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: await markerDir('overseas\n'),
      }),
    ).toBe('cn');
  });

  it('resolves the persisted login host, tolerating trailing slashes', () => {
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.ai/' })).toBe(
      'overseas',
    );
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.com' })).toBe('cn');
  });

  it('ignores an unrecognized persisted host and continues down the chain', async () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.legacy.example.com',
        homeDir: await markerDir('overseas'),
      }),
    ).toBe('overseas');
  });

  it('reads the install-channel marker when nothing else decides', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('overseas\n') })).toBe('overseas');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('  cn  ') })).toBe('cn');
  });

  it('ignores a malformed or missing marker', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('global') })).toBe('cn');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('') })).toBe('cn');
  });

  it('skips the marker entirely when readMarker is false', async () => {
    expect(
      resolveKimiRegion({ env: {}, homeDir: await markerDir('overseas'), readMarker: false }),
    ).toBe('cn');
  });

  it('honors KIMI_CODE_HOME when homeDir is not passed explicitly', async () => {
    const dir = await markerDir('overseas');
    expect(resolveKimiRegion({ env: { KIMI_CODE_HOME: dir } })).toBe('overseas');
  });

  it('env beats persisted login beats marker', async () => {
    const dir = await markerDir('overseas');
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('cn');
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('overseas');
  });
});

describe('kimiRegionLoginHosts', () => {
  it('returns both profile hosts, cn included (explicit beats stale config)', () => {
    expect(kimiRegionLoginHosts('cn', {})).toEqual({
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(kimiRegionLoginHosts('overseas', {})).toEqual({
      oauthHost: 'https://auth.kimi.ai',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
  });

  it('yields to env overrides', () => {
    expect(kimiRegionLoginHosts('overseas', { KIMI_CODE_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(kimiRegionLoginHosts('overseas', { KIMI_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(
      kimiRegionLoginHosts('overseas', { KIMI_CODE_BASE_URL: 'https://api.x.com/coding/v1' }),
    ).toBe(undefined);
  });
});

describe('kimiRegionSchema', () => {
  it('parses valid regions and rejects others', () => {
    expect(kimiRegionSchema.parse('cn')).toBe('cn');
    expect(kimiRegionSchema.parse('overseas')).toBe('overseas');
    expect(kimiRegionSchema.safeParse('global').success).toBe(false);
  });
});
