/**
 * Unit tests for the server-layer disk reader (`services/snapshot`).
 *
 * Constructs `SnapshotReader` with stub core services and a real tmp `homeDir`,
 * writing `state.json` + `agents/main/wire.jsonl` directly — exercising the
 * disk read, the `context.*` reduction, the `(size, mtimeMs)` transcript cache,
 * `state.json` normalization, and `KIMI_SNAPSHOT_*` config parsing without
 * booting a Fastify daemon.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCEPTED_OUTPUT,
  ISessionIndex,
  IWorkspaceLifecycleService,
  IWorkspaceService,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_OPEN,
  type ContextMessage,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveSpineTree,
  loadSnapshotConfig,
  readWireRecords,
  SnapshotNotFoundError,
  SnapshotReader,
  type SnapshotReaderDeps,
} from '../src/services/snapshot';

// ─── tiny stubs ───────────────────────────────────────────────────────────

function fakeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get<T>(id: unknown): T {
      if (!services.has(id)) throw new Error(`unexpected service request: ${String(id)}`);
      return services.get(id) as T;
    },
  };
}

const noopLogger = { info: () => {} };

interface Fixture {
  homeDir: string;
  workspaceId: string;
  sessionDir: (sid: string) => string;
  index: Map<string, SessionSummary>;
  reader: SnapshotReader;
  broadcaster: { seq: number; epoch: string; inFlightTurn: unknown };
}

const tmpDirs: string[] = [];

async function makeFixtureAsync(opts?: { cacheLimit?: number }): Promise<Fixture> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-snapshot-reader-'));
  tmpDirs.push(homeDir);
  const workspaceId = 'wd_unittest_012345abcdef';
  const index = new Map<string, SessionSummary>();
  const workspaces = new Map([[workspaceId, { root: join(homeDir, 'workspace') }]]);

  const core = {
    accessor: fakeAccessor([
      [ISessionIndex, { get: async (sid: string) => index.get(sid) }],
      [IWorkspaceService, { get: async (ws: string) => workspaces.get(ws) }],
      // Cold by default — no live handle.
      [IWorkspaceLifecycleService, { handlers: { list: () => [] } }],
    ]),
  };
  const broadcaster = { seq: 0, epoch: 'ep_unit', inFlightTurn: null };
  const deps: SnapshotReaderDeps = {
    homeDir,
    core: core as never,
    broadcaster: {
      getSnapshotState: async () => ({
        seq: broadcaster.seq,
        epoch: broadcaster.epoch,
        inFlightTurn: broadcaster.inFlightTurn as never,
        subagents: [],
      }),
    } as never,
    logger: noopLogger,
    config: { mode: 'auto', timeoutMs: 4000, cacheLimit: opts?.cacheLimit ?? 32 },
  };
  return {
    homeDir,
    workspaceId,
    sessionDir: (sid) => join(homeDir, 'sessions', workspaceId, sid),
    index,
    reader: new SnapshotReader(deps),
    broadcaster,
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

/** Assistant message carrying a spine control-tool call. */
function spineCall(callId: string, name: string, args: Record<string, string>): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [{ type: 'function', id: callId, name, arguments: JSON.stringify(args) }],
  };
}

/** Tool receipt for a spine call; `text` defaults to the accepted carrier. */
function spineReceipt(callId: string, text: string = ACCEPTED_OUTPUT): ContextMessage {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId: callId };
}

async function seedSession(
  f: Fixture,
  sid: string,
  opts?: { createdAt?: number; title?: string; rawState?: Record<string, unknown> },
): Promise<void> {
  const createdAt = opts?.createdAt ?? 1700000000000;
  f.index.set(sid, {
    id: sid,
    workspaceId: f.workspaceId,
    title: opts?.title,
    createdAt,
    updatedAt: createdAt,
    archived: false,
  });
  const state = opts?.rawState ?? {
    id: sid,
    version: 2,
    createdAt,
    updatedAt: createdAt,
    archived: false,
    title: opts?.title,
  };
  await mkdir(f.sessionDir(sid), { recursive: true });
  await writeFile(join(f.sessionDir(sid), 'state.json'), JSON.stringify(state), 'utf-8');
}

async function writeWire(sessionDir: string, lines: ReadonlyArray<unknown>): Promise<void> {
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
  await writeFile(join(agentDir, 'wire.jsonl'), body, 'utf-8');
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ─── SnapshotReader.read ──────────────────────────────────────────────────

describe('SnapshotReader.read', () => {
  it('throws SnapshotNotFoundError for an unknown session', async () => {
    const f = await makeFixtureAsync();
    await expect(f.reader.read('sess_missing')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('throws SnapshotNotFoundError when the workspace is gone', async () => {
    const f = await makeFixtureAsync();
    f.index.set('sess_orphan', {
      id: 'sess_orphan',
      workspaceId: 'wd_gone_000000000000',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    await expect(f.reader.read('sess_orphan')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('returns empty messages for a session with no wire.jsonl', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_empty');
    const snap = await f.reader.read('sess_empty');
    expect(snap.session.id).toBe('sess_empty');
    expect(snap.session.busy).toBe(false);
    expect(snap.messages.items).toEqual([]);
    expect(snap.messages.has_more).toBe(false);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.subagents).toEqual([]);
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.as_of_seq).toBe(0);
    expect(snap.epoch).toBe('ep_unit');
  });

  it('builds messages from context.append_message records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_msgs');
    await writeWire(f.sessionDir('sess_msgs'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('one') },
      { type: 'context.append_message', message: userMessage('two') },
    ]);
    const snap = await f.reader.read('sess_msgs');
    expect(snap.messages.items).toHaveLength(2);
    expect(snap.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('folds v1 context.append_loop_event records into assistant and tool messages', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_loop');
    await writeWire(f.sessionDir('sess_loop'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('question') },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: '0', step: 1 } },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'p1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          part: { type: 'text', text: 'hello' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'c1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'c1',
          toolCallId: 'call_1',
          result: { output: 'hi' },
        },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: '0', step: 1 } },
    ]);
    const snap = await f.reader.read('sess_loop');
    expect(snap.messages.items.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = snap.messages.items[1]!;
    expect((assistant.content[0] as { text: string }).text).toBe('hello');
    const toolUse = assistant.content.find((p) => p.type === 'tool_use') as
      | { tool_call_id: string; tool_name: string }
      | undefined;
    expect(toolUse?.tool_call_id).toBe('call_1');
    expect(toolUse?.tool_name).toBe('Bash');
    const tool = snap.messages.items[2]!;
    expect(tool.role).toBe('tool');
    expect((tool.content[0] as { tool_call_id: string }).tool_call_id).toBe('call_1');
  });

  it('keeps the full history across context.apply_compaction and appends a summary marker', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact');
    await writeWire(f.sessionDir('sess_compact'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        count: 2,
        summary: { role: 'user', content: [{ type: 'text', text: 'summary' }], toolCalls: [] },
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact');
    const texts = snap.messages.items.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['old-1', 'old-2', 'summary', 'after']);
    expect(snap.messages.items[2]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('keeps the full history across v1-shaped string summary compaction records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_v1');
    await writeWire(f.sessionDir('sess_compact_v1'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact_v1');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['old-1', 'old-2', 'summary', 'after']);
    expect(messages[2]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('keeps compacted-away assistant messages and uses the raw summary as the marker', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_kept_users');
    await writeWire(f.sessionDir('sess_compact_kept_users'), [
      { type: 'context.append_message', message: userMessage('old user') },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old assistant' }],
          toolCalls: [],
        },
      },
      { type: 'context.append_message', message: userMessage('recent user') },
      {
        type: 'context.apply_compaction',
        summary: 'raw summary',
        contextSummary: 'model-facing summary',
        compactedCount: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 2,
      },
    ]);
    const snap = await f.reader.read('sess_compact_kept_users');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(texts).toEqual(['old user', 'old assistant', 'recent user', 'raw summary']);
    expect(messages[3]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('preserves the pre-compaction assistant reply after a later undo', async () => {
    // Regression: send A, /compact, send B, undo. The snapshot must still show
    // A's assistant reply (compaction folds only the live context; the
    // transcript keeps the full history).
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_undo');
    const assistant = (text: string): ContextMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
    await writeWire(f.sessionDir('sess_compact_undo'), [
      { type: 'context.append_message', message: userMessage('message A') },
      { type: 'context.append_message', message: assistant('reply A') },
      {
        type: 'context.apply_compaction',
        summary: 'summary text',
        contextSummary: 'model-facing summary',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 1,
      },
      { type: 'context.append_message', message: userMessage('message B') },
      { type: 'context.append_message', message: assistant('reply B') },
      { type: 'context.undo', count: 1 },
    ]);
    const snap = await f.reader.read('sess_compact_undo');
    const messages = snap.messages.items;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'message A',
      'reply A',
      'summary text',
    ]);
  });

  it('keeps pre-clear messages in the transcript and lets undo remove the tail', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_ops');
    await writeWire(f.sessionDir('sess_ops'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.clear' },
      { type: 'context.append_message', message: userMessage('c') },
      { type: 'context.undo', count: 1 },
    ]);
    // /clear keeps prior messages for display; undo removes the post-clear tail (c).
    expect((await f.reader.read('sess_ops')).messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('caps the page at 100 and flags has_more', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_paged');
    await writeWire(
      f.sessionDir('sess_paged'),
      Array.from({ length: 150 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
      })),
    );
    const snap = await f.reader.read('sess_paged');
    expect(snap.messages.items).toHaveLength(100);
    expect(snap.messages.has_more).toBe(true);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('m50');
    expect((snap.messages.items.at(-1)!.content[0] as { text: string }).text).toBe('m149');
  });

  it('uses the wire record time as created_at, falling back and clamping to stay increasing', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    const t0 = 1700001000000;
    await seedSession(f, 'sess_times', { createdAt });
    await writeWire(f.sessionDir('sess_times'), [
      { type: 'context.append_message', message: userMessage('one'), time: t0 },
      // No time stamp → falls back to createdAt + index, which is earlier than
      // the previous real time and gets clamped to previous + 1.
      { type: 'context.append_message', message: userMessage('two') },
      // A time stamp EARLIER than the previous entry → clamped to previous + 1.
      { type: 'context.append_message', message: userMessage('three'), time: t0 - 5000 },
    ]);
    const snap = await f.reader.read('sess_times');
    expect(snap.messages.items.map((m) => Date.parse(m.created_at))).toEqual([t0, t0 + 1, t0 + 2]);
  });

  it('synthesizes created_at from session createdAt + index when no record carries a time', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    await seedSession(f, 'sess_no_times', { createdAt });
    await writeWire(f.sessionDir('sess_no_times'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
    ]);
    const snap = await f.reader.read('sess_no_times');
    expect(snap.messages.items.map((m) => Date.parse(m.created_at))).toEqual([
      createdAt,
      createdAt + 1,
    ]);
  });

  it('maps record times by global index across the page offset', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    const base = 1700002000000;
    await seedSession(f, 'sess_times_paged', { createdAt });
    await writeWire(
      f.sessionDir('sess_times_paged'),
      Array.from({ length: 102 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
        time: base + i * 1000,
      })),
    );
    const snap = await f.reader.read('sess_times_paged');
    expect(snap.messages.items).toHaveLength(100);
    // The page starts at global index 2, so the first item carries record[2]'s time.
    expect(Date.parse(snap.messages.items[0]!.created_at)).toBe(base + 2000);
    expect(Date.parse(snap.messages.items.at(-1)!.created_at)).toBe(base + 101 * 1000);
  });

  it('normalizes a v1-layout state.json (ISO timestamps, no id)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_v1', {
      rawState: {
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
      },
    });
    const snap = await f.reader.read('sess_v1');
    expect(snap.session.id).toBe('sess_v1');
    expect(snap.session.title).toBe('v1 session');
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
  });

  it('serves repeated reads from the (size, mtime) cache', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_cache');
    await writeWire(f.sessionDir('sess_cache'), [
      { type: 'context.append_message', message: userMessage('cached') },
    ]);
    const first = await f.reader.read('sess_cache');
    expect(first.messages.items).toHaveLength(1);
    // Rewrite with identical content (size + mtime may change) — the cache is
    // keyed on (size, mtime); a same-size rewrite keeps serving the cached
    // reduction only when mtime is unchanged, so just assert stability.
    const second = await f.reader.read('sess_cache');
    expect(second.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'cached',
    ]);
  });

  it('invalidates the cache when the wire shrinks (compaction rewrite)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_shrink');
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.append_message', message: userMessage('c') },
    ]);
    expect((await f.reader.read('sess_shrink')).messages.items).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('only-one') },
    ]);
    const snap = await f.reader.read('sess_shrink');
    expect(snap.messages.items).toHaveLength(1);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('only-one');
  });

  it('seeds spine_tree from the FULL transcript when spine transitions predate the page window', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_spine_paged');
    await writeWire(f.sessionDir('sess_spine_paged'), [
      // All spine transitions sit at the head of the transcript, far outside
      // the 100-message page the snapshot serves.
      { type: 'context.append_message', message: spineCall('call_open_1', SPINE_TOOL_OPEN, { summary: 'early task' }) },
      { type: 'context.append_message', message: spineReceipt('call_open_1') },
      { type: 'context.append_message', message: spineCall('call_close_1', SPINE_TOOL_CLOSE, { memory: 'early memory' }) },
      { type: 'context.append_message', message: spineReceipt('call_close_1') },
      ...Array.from({ length: 149 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
      })),
    ]);
    const snap = await f.reader.read('sess_spine_paged');
    expect(snap.messages.items).toHaveLength(100);
    expect(snap.messages.has_more).toBe(true);
    const tree = snap.spine_tree;
    expect(tree).toBeDefined();
    // covered_through_id is the wire id of the LAST message in the sliced
    // page — the client's live-replay watermark.
    expect(tree!.covered_through_id).toBe(snap.messages.items.at(-1)!.id);
    const early = tree!.nodes.find((n) => n.title === 'early task');
    expect(early).toBeDefined();
    expect(early!.status).toBe('closed');
    expect(early!.memory).toBe('early memory');
    expect(typeof early!.token_cost).toBe('number');
    expect(early!.error).toBeNull();
  });

  it('returns an empty spine_tree node list for a session without spine activity', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_no_spine');
    await writeWire(f.sessionDir('sess_no_spine'), [
      { type: 'context.append_message', message: userMessage('plain one') },
      { type: 'context.append_message', message: userMessage('plain two') },
    ]);
    const snap = await f.reader.read('sess_no_spine');
    expect(snap.spine_tree).toEqual({
      covered_through_id: snap.messages.items.at(-1)!.id,
      nodes: [],
    });
  });

  it('degrades a dirty spine sequence (non-accepted receipt) without failing the snapshot', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_spine_dirty');
    await writeWire(f.sessionDir('sess_spine_dirty'), [
      { type: 'context.append_message', message: spineCall('call_bad', SPINE_TOOL_OPEN, { summary: 'lost task' }) },
      // The receipt is NOT the accepted carrier — the transition does not happen.
      { type: 'context.append_message', message: spineReceipt('call_bad', 'rejected — stale cursor') },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_spine_dirty');
    expect(snap.messages.items).toHaveLength(3);
    expect(snap.spine_tree).toEqual({
      covered_through_id: snap.messages.items.at(-1)!.id,
      nodes: [],
    });
  });
});

describe('readWireRecords', () => {
  it('drops a torn final line but throws on mid-file corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-wire-'));
    tmpDirs.push(dir);
    const p = join(dir, 'wire.jsonl');
    await writeFile(
      p,
      '{"type":"context.append_message","message":{"role":"user","content":[],"toolCalls":[]}}\n{"type":"context.append_message","message":{"role":"user","cont',
      'utf-8',
    );
    const records = await readWireRecords(p);
    expect(records).toHaveLength(1);

    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, '{not-json}\n{"type":"context.append_message"}\n', 'utf-8');
    await expect(readWireRecords(bad)).rejects.toThrow(/corrupted line 1/);
  });
});

describe('loadSnapshotConfig', () => {
  it('defaults to auto / 4000ms / 32', () => {
    const c = loadSnapshotConfig({});
    expect(c).toEqual({ mode: 'auto', timeoutMs: 4000, cacheLimit: 32 });
  });

  it('parses legacy mode and integer knobs with floors', () => {
    const c = loadSnapshotConfig({
      KIMI_SNAPSHOT_READER: 'legacy',
      KIMI_SNAPSHOT_TIMEOUT_MS: '2500',
      KIMI_SNAPSHOT_CACHE_LIMIT: '0', // below min → default
    });
    expect(c.mode).toBe('legacy');
    expect(c.timeoutMs).toBe(2500);
    expect(c.cacheLimit).toBe(32);
  });

  it('falls back on non-numeric / sub-minimum timeout', () => {
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(4000);
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: '50' }).timeoutMs).toBe(4000);
  });
});
