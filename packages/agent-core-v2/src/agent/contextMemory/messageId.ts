/**
 * `contextMemory` message id helpers.
 *
 * Local message ids (`msg_<ulid>`) identify prompt messages: assigned at
 * enqueue time and persisted with the `context.append_message` record, so
 * undo can pair prompt-owned injections with their prompt by `id` across a
 * resume. The server layer's `ContextMessage → wire Message` projection
 * prefers this id and falls back to a transcript-index-derived id for
 * messages that carry none (v1-written records).
 * Provider-assigned ids live on the separate `providerMessageId` field and
 * never collide with this namespace.
 */

import { ulid } from 'ulid';

export function newMessageId(): string {
  return `msg_${ulid()}`;
}
