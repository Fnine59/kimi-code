/**
 * Scenario: session-shared Todo state, including undo restoration.
 * Responsibility: SessionTodoService exposes the main wire state and emits observable changes.
 * Wiring: lightweight lifecycle/agent fakes with real event-bus behavior.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test -- test/session/todo/sessionTodo.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IInstantiationService } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { createHooks } from '#/hooks';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { makeLifecycleStub } from '../agentLifecycle/stubs';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { readTodoItems, type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { parseBooleanEnv } from '#/_base/utils/env';
import { IFlagService } from '#/app/flag/flag';
import type { FlagId } from '#/app/flag/flagRegistry';
import { SPINE_FLAG_ENV, SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IWireService, type WireHooks } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

// Mirrors `FlagService` env resolution for the spine flag: the real service
// reads the env through bootstrap on every `enabled` call, so stubbing the env
// mid-test flips the gate exactly as in production.
function makeFlagsStub(): IFlagService {
  const enabled = (id: FlagId) =>
    id === SPINE_FLAG_ID && parseBooleanEnv(process.env[SPINE_FLAG_ENV]) === true;
  return { _serviceBrand: undefined, enabled } as unknown as IFlagService;
}

interface RecordedTodoSet {
  readonly todos: readonly TodoItem[];
}

interface FakeAgentOptions {
  /** What the tool policy stub answers for `isToolActive`. */
  readonly toolActive?: boolean;
  /** History returned by the context memory stub. */
  readonly history?: readonly ContextMessage[];
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly registeredTools: string[];
  readonly registeredVariants: string[];
  readonly reminderProviders: Map<string, () => string | undefined>;
  readonly appended: RecordedTodoSet[];
  readonly eventBus: EventBusService;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
}

function makeFakeAgent(agentId: string, options: FakeAgentOptions = {}): FakeAgent {
  const { toolActive = false, history = [] } = options;
  const registeredTools: string[] = [];
  const registeredVariants: string[] = [];
  const reminderProviders = new Map<string, () => string | undefined>();
  const appended: RecordedTodoSet[] = [];
  const eventBus = new EventBusService();

  let todoState: readonly TodoItem[] = [];

  const registryStub = {
    _serviceBrand: undefined,
    register: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      return toDisposable(() => {});
    },
    list: () => [],
    resolve: () => undefined,
    hooks: {},
  };

  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string, provider?: () => string | undefined) => {
      registeredVariants.push(variant);
      if (provider !== undefined) reminderProviders.set(variant, provider);
      return toDisposable(() => {});
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => history,
  };

  const toolPolicyStub = {
    _serviceBrand: undefined,
    isToolActive: () => toolActive,
  };

  const restore = async (records: readonly WireRecord[]): Promise<void> => {
    for (const record of records) {
      if (record.type === 'tools.update_store' && record['key'] === 'todo') {
        todoState = readTodoItems(record['value']);
      }
    }
  };

  const wireStub: IWireService = {
    _serviceBrand: undefined,
    hooks: createHooks<WireHooks, keyof WireHooks>(['onDidRestore']),
    dispatch: (...ops: unknown[]) => {
      for (const raw of ops) {
        const op = raw as { type: string; payload: unknown };
        const payload = op.payload;
        const record =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : { payload };
        appended.push({ type: op.type, ...record } as unknown as RecordedTodoSet);
        if (op.type === 'tools.update_store' && record['key'] === 'todo') {
          todoState = readTodoItems(record['value']);
        }
      }
    },
    restore: async () => {},
    flush: async () => {},
    getModel: () => ({ current: todoState, checkpoints: [] }),
    subscribe: () => toDisposable(() => {}),
  } as unknown as IWireService;

  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return registryStub as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IInstantiationService) return instantiationStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentToolPolicyService) return toolPolicyStub as unknown as T;
      if (id === IEventBus) return eventBus as unknown as T;
      if (id === IWireService) return wireStub as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };

  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor,
    dispose: () => {},
  };

  return {
    handle,
    registeredTools,
    registeredVariants,
    reminderProviders,
    appended,
    eventBus,
    restore,
  };
}


describe('SessionTodoService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts empty and updates the list on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    expect(service.getTodos()).toEqual([]);

    const next: TodoItem[] = [
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'in_progress' },
    ];
    service.setTodos(next);
    expect(service.getTodos()).toEqual(next);

    service.clear();
    expect(service.getTodos()).toEqual([]);
  });

  it('fires onDidChange after each setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    const seen: Array<readonly TodoItem[]> = [];
    const d = service.onDidChange((todos) => seen.push(todos));
    service.setTodos([{ title: 'x', status: 'pending' }]);
    service.setTodos([{ title: 'y', status: 'done' }]);
    d.dispose();

    expect(seen).toEqual([
      [{ title: 'x', status: 'pending' }],
      [{ title: 'y', status: 'done' }],
    ]);
  });

  it('fires the restored list once when undo changes the main wire state', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());
    service.setTodos([{ title: 'doomed', status: 'in_progress' }]);

    const seen: Array<readonly TodoItem[]> = [];
    const subscription = service.onDidChange((todos) => seen.push(todos));
    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'kept', status: 'pending' }] },
    ]);
    main.eventBus.publish({ type: 'context.undone', turns: 1 });
    main.eventBus.publish({ type: 'context.undone', turns: 1 });
    subscription.dispose();

    expect(seen).toEqual([[{ title: 'kept', status: 'pending' }]]);
  });

  it('appends a tools.update_store record to the main agent wire on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    service.setTodos([{ title: 'persist me', status: 'in_progress' }]);

    expect(main.appended).toEqual([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'persist me', status: 'in_progress' }],
      },
    ]);
  });

  it('does not append to the wire when the main agent is absent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());
    // Should not throw even without a main agent. With no main wire there is
    // no source of truth to read from, so the list stays empty.
    expect(() => service.setTodos([{ title: 'x', status: 'pending' }])).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('binds the stale-todo reminder into every created agent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());
    void service;

    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    lifecycle.fireCreate(main.handle);
    lifecycle.fireCreate(sub.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
  });

  it('routes todo reads and writes only through the main agent', () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const lifecycle = makeLifecycleStub([main.handle, sub.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    service.setTodos([{ title: 'main only', status: 'pending' }]);

    expect(main.appended).toHaveLength(1);
    expect(sub.appended).toHaveLength(0);
    expect(service.getTodos()).toEqual([{ title: 'main only', status: 'pending' }]);
  });

  it('rebuilds the list when a todo tools.update_store record is replayed', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'restored', status: 'done' }] },
    ]);

    expect(service.getTodos()).toEqual([{ title: 'restored', status: 'done' }]);
  });

  it('disposes per-agent bindings when the agent is disposed', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());
    const main = makeFakeAgent('main');
    lifecycle.fireCreate(main.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(() => lifecycle.fireDispose('main')).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('satisfies the ISessionTodoService contract', () => {
    const lifecycle = makeLifecycleStub();
    const service: ISessionTodoService = new SessionTodoService(lifecycle.service, makeFlagsStub());
    expect(typeof service.getTodos).toBe('function');
    expect(typeof service.setTodos).toBe('function');
    expect(typeof service.clear).toBe('function');
    expect(typeof service.onDidChange).toBe('function');
  });

  it('silences the stale-todo reminder while spine is enabled', () => {
    // Stale by the reminder's own rules: well over ten assistant turns since
    // the last TodoList write and since the last reminder.
    const history = Array.from({ length: 12 }, () => ({
      role: 'assistant',
      content: [],
      toolCalls: [],
    })) as unknown as ContextMessage[];
    const main = makeFakeAgent('main', { toolActive: true, history });
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());
    service.setTodos([{ title: 'still open', status: 'in_progress' }]);
    const reminder = main.reminderProviders.get(TODO_LIST_REMINDER_VARIANT);
    expect(reminder).toBeDefined();

    // Baseline: with the flat list tool active, the nudge fires.
    vi.stubEnv(SPINE_FLAG_ENV, '0');
    expect(reminder!()).toBeDefined();

    // With spine on the tool is gone, so the nudge must stay silent instead of
    // prodding the model toward a tracker it can no longer see.
    vi.stubEnv(SPINE_FLAG_ENV, '1');
    expect(reminder!()).toBeUndefined();
  });

  it('cleans malformed items from a replayed todo tools.update_store record', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    await main.restore([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
          { title: 'bad status', status: 'wip' },
        ],
      } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([{ title: 'valid', status: 'done' }]);
  });

  it('treats a non-array todo tools.update_store value as an empty list on replay', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service, makeFlagsStub());

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: 'not-an-array' } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([]);
  });
});
