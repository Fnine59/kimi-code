/**
 * `contextMemory` domain — rebuilds display history from the wire journal.
 *
 * Supplies transcript consumers with full pre-compaction history and folded
 * context length while preserving undo/clear semantics. Scope-agnostic.
 *
 * Loop events and plain appends are reduced by the shared fold kernel
 * (`loopEventFold.ts`) over time-stamped entries, so the display view can
 * never drift from the live/replay fold; this reducer only adds the display
 * bookkeeping the kernel does not own — per-entry record times, `clearFloor`,
 * and `foldedLength` — plus the transcript-specific meaning of undo (splice
 * the tail, keep injections with their owner), clear (keep entries, move the
 * floor), and compaction (append the summary marker, keep the folded prefix).
 */

import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  selectRecentUserMessages,
} from './compactionHandoff';
import { isPromptOwnedInjection, isUndoAnchor } from './conversationTime';
import {
  appendMessageTo,
  applyLoopEventTo,
  type FoldEntryAdapter,
  type FoldFrame,
  type LoopRecordedEvent,
} from './loopEventFold';
import { EMPTY_FOLD, type ContextMessage } from './types';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
}

interface TranscriptEntry {
  readonly message: ContextMessage;
  readonly time?: number;
}

const entryAdapter: FoldEntryAdapter<TranscriptEntry> = {
  messageOf: (entry) => entry.message,
  withMessage: (entry, message) => ({ ...entry, message }),
};

export function reduceContextTranscript(records: Iterable<WireRecord>): ContextTranscript {
  const reducer = createContextTranscriptReducer();
  for (const record of records) reducer.add(record);
  return reducer.result();
}

export function createContextTranscriptReducer(): ContextTranscriptReducer {
  let frame: FoldFrame<TranscriptEntry> = { messages: [], fold: EMPTY_FOLD };
  let foldedLength = 0;
  let clearFloor = 0;

  const applyKernel = (next: FoldFrame<TranscriptEntry>): void => {
    foldedLength += next.messages.length - frame.messages.length;
    frame = next;
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    const entries = frame.messages.slice();
    let removedUserCount = 0;
    let removed = 0;
    for (let i = entries.length - 1; i >= clearFloor; i--) {
      const message = entries[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      entries.splice(i, 1);
      removed++;
      if (isUndoAnchor(message)) {
        removedUserCount++;
        if (removedUserCount >= count) {
          while (
            i > clearFloor &&
            isPromptOwnedInjection(entries[i - 1]!.message, message)
          ) {
            entries.splice(i - 1, 1);
            i--;
            removed++;
          }
          break;
        }
      }
    }
    foldedLength = Math.max(0, foldedLength - removed);
    frame = { messages: entries, fold: EMPTY_FOLD };
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message': {
        applyKernel(
          appendMessageTo(frame, {
            message: record['message'] as ContextMessage,
            time: record.time,
          }),
        );
        return;
      }
      case 'context.append_loop_event': {
        const time = record.time;
        applyKernel(
          applyLoopEventTo(
            frame,
            record['event'] as LoopRecordedEvent,
            entryAdapter,
            (message): TranscriptEntry => ({ message, time }),
          ),
        );
        return;
      }
      case 'context.apply_compaction': {
        const summary: ContextMessage = {
          role: 'user',
          content: [{ type: 'text', text: readCompactionSummaryText(record) }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        };
        frame = {
          messages: [...frame.messages, { message: summary, time: record.time }],
          fold: EMPTY_FOLD,
        };
        foldedLength = recoverFoldedLength(record, frame.messages, clearFloor, foldedLength);
        return;
      }
      case 'context.undo':
        applyUndo(record['count'] as number);
        return;
      case 'context.clear':
        clearFloor = frame.messages.length;
        foldedLength = 0;
        frame = { messages: frame.messages, fold: EMPTY_FOLD };
        return;
      default:
        return;
    }
  };

  return {
    add,
    result: () => ({
      entries: frame.messages.map((entry) => entry.message),
      times: frame.messages.map((entry) => entry.time),
      foldedLength,
    }),
  };
}

function recoverFoldedLength(
  record: WireRecord,
  transcript: readonly TranscriptEntry[],
  clearFloor: number,
  foldedLength: number,
): number {
  const keptUserMessageCount = readNumber(record, 'keptUserMessageCount');
  const keptHeadUserMessageCount = readNumber(record, 'keptHeadUserMessageCount');
  const compactedCount = readNumber(record, 'compactedCount');
  if (keptUserMessageCount !== undefined) {
    return keptUserMessageCount + (keptHeadUserMessageCount === undefined ? 1 : 2);
  }
  if (compactedCount !== undefined && compactedCount < foldedLength) {
    return 1 + (foldedLength - compactedCount);
  }
  const keptUserMessages = selectRecentUserMessages(
    collectCompactableUserMessages(transcript.slice(clearFloor).map((entry) => entry.message)),
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  );
  return keptUserMessages.length + 1;
}

function readCompactionSummaryText(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessageLike(summary)) return textOfParts(summary.content);
  return '';
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function textOfParts(content: ContextMessage['content']): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
