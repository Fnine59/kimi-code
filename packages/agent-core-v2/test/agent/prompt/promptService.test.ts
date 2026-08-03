/**
 * Scenario: per-agent prompt scheduling and launch-failure settlement.
 *
 * Exercises `IAgentPromptService` through DI with controlled context, loop,
 * wire, compaction, and tool-execution collaborators.
 * Run: `pnpm exec vitest run packages/agent-core-v2/test/agent/prompt/promptService.test.ts`.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IWireService } from '#/wire/wire';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function stubSessionMetadata(initial?: Partial<SessionMeta>) {
  let data: SessionMeta = { id: 'session-1', createdAt: 0, updatedAt: 0, archived: false, ...initial };
  const update = vi.fn(async (patch: Partial<SessionMeta>) => {
    data = { ...data, ...patch, updatedAt: Date.now() };
  });
  const service = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None,
    read: () => Promise.resolve(data),
    update,
    setTitle: async (title: string) => { data = { ...data, title, isCustomTitle: true }; },
    setArchived: async (archived: boolean) => { data = { ...data, archived }; },
    registerAgent: () => Promise.resolve(),
  } as unknown as ISessionMetadata;
  return { service, update, read: () => data };
}

function stubEventService() {
  return {
    _serviceBrand: undefined,
    onDidPublish: Event.None,
    publish: vi.fn(),
    subscribe: () => ({ dispose: () => {} }),
  } as unknown as IEventService;
}

function harness(metaInitial?: Partial<SessionMeta>) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks({ pendingTurnResult: true });
  const fullCompaction = {
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(['onWillCompact']),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService;
  const sessionMeta = stubSessionMetadata(metaInitial);
  const eventService = stubEventService();
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.defineInstance(IWireService, stubWire());
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.defineInstance(ISessionContext, makeSessionContext({
        sessionId: 'session-1',
        workspaceId: 'ws',
        sessionDir: '/tmp/session-1',
        sessionScope: 'sessions/session-1',
        cwd: '/tmp',
      }));
      reg.defineInstance(ISessionMetadata, sessionMeta.service);
      reg.defineInstance(IEventService, eventService);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.define(IAgentPromptService, AgentPromptService);
    }
  });
  return { prompt: ix.get(IAgentPromptService), loop, context, fullCompaction, sessionMeta, eventService };
}

describe('AgentPromptService', () => {
  it('assigns stable identity and launches an idle prompt', async () => {
    const { prompt } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
  });

  it('keeps later prompts in FIFO order while active', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const first = await prompt.enqueue({ message: message('one') });
    const second = await prompt.enqueue({ message: message('two') });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('atomically rejects steer when any id is not pending', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('one') });
    await expect(prompt.steer([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([queued.id]);
  });

  it('steers selected prompts in FIFO order', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: message('one') });
    const two = await prompt.enqueue({ message: message('two') });
    const handles = await prompt.steer([two.id, one.id]);
    expect(handles.map((item) => item.id)).toEqual([one.id, two.id]);
    loop.drainNextBatch(context);
  });

  it('aborts pending prompts and settles completion', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const handle = await prompt.enqueue({ message: message('queued') });
    expect(prompt.abort(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(prompt.list().pending).toEqual([]);
  });

  it('keeps injections outside the prompt queue', async () => {
    const { prompt } = harness();
    await prompt.inject({ ...message('system'), origin: { kind: 'injection', variant: 'test' } });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('settles blocked prompts', async () => {
    const { prompt } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
  });

  it('settles the prompt as failed when the loop throws on launch', async () => {
    const { prompt, loop } = harness();
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Cannot launch a new turn while another turn is active');
    });
    const handle = await prompt.enqueue({ id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
    const { prompt, context, loop } = harness();
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const handle = await prompt.enqueue({
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;
    loop.drainNextBatch(context);

    const appended = context.get();
    expect(appended).toHaveLength(1);
    const parts = appended[0]!.content;
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('image/avif');
  });

  it('gates steered prompt images too', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const appended = context.get();
    const parts = appended.flatMap((entry) => entry.content);
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes('image/avif')),
    ).toBe(true);
  });
});

describe('AgentPromptService session metadata sink', () => {
  it('writes title and lastPrompt for the first user prompt', async () => {
    const { prompt, sessionMeta } = harness();
    await prompt.enqueue({ message: message('hello world') });
    expect(sessionMeta.update).toHaveBeenCalledTimes(1);
    expect(sessionMeta.read()).toMatchObject({
      title: 'hello world',
      isCustomTitle: false,
      lastPrompt: 'hello world',
    });
  });

  it('dedupes repeated identical prompt text', async () => {
    const { prompt, sessionMeta } = harness();
    await prompt.enqueue({ message: message('same text') });
    await prompt.enqueue({ message: message('same text') });
    expect(sessionMeta.update).toHaveBeenCalledTimes(1);
  });

  it('skips metadata writes for non-user origins', async () => {
    const { prompt, sessionMeta } = harness();
    await prompt.enqueue({
      message: { ...message('subagent task'), origin: { kind: 'system_trigger', name: 'subagent' } },
    });
    expect(sessionMeta.update).not.toHaveBeenCalled();
  });

  it('updates lastPrompt while preserving a custom title', async () => {
    const { prompt, sessionMeta } = harness({ title: 'My Session', isCustomTitle: true });
    await prompt.enqueue({ message: message('next question') });
    expect(sessionMeta.update).toHaveBeenCalledTimes(1);
    expect(sessionMeta.update.mock.calls[0]?.[0]).not.toHaveProperty('title');
    expect(sessionMeta.read()).toMatchObject({
      title: 'My Session',
      isCustomTitle: true,
      lastPrompt: 'next question',
    });
  });
});
