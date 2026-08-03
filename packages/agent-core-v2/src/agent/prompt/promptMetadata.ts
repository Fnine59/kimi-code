/**
 * `prompt` domain (L4) — v1-compatible prompt metadata helpers.
 *
 * Derives title and last-prompt text from prompt content, persists metadata
 * through `sessionMetadata`, and publishes live updates through `event`.
 * Applied by the `IAgentPromptService.enqueue` sink for every user-origin
 * prompt, and directly by the rpc skill / plugin-command paths, so every
 * entry surface keeps the same easy-title behavior.
 */

import type { IEventService } from '#/app/event/event';
import type { ContentPart } from '#/kosong/contract/message';
import type { ISessionMetadata, SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
  titleFromPromptMetadataText,
} from '#/agent/prompt/promptMetadataText';

import type { ActivateSkillPayload } from '#/agent/rpc/core-api';

export { promptMetadataTextFromContentParts, titleFromPromptMetadataText };

export function promptMetadataTextFromPayload(payload: {
  readonly input: readonly ContentPart[];
}): string | undefined {
  return promptMetadataTextFromContentParts(payload.input);
}

export function promptMetadataTextFromSkill(payload: ActivateSkillPayload): string | undefined {
  const args = payload.args?.trim();
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? `/${payload.name}` : `/${payload.name} ${args}`,
  );
}

export function promptMetadataTextFromPluginCommand(payload: {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
  );
}

export function isUntitled(title: string | undefined): boolean {
  return title === undefined || title.trim().length === 0 || title === 'New Session';
}

export interface PromptMetadataUpdateTarget {
  readonly metadata: ISessionMetadata;
  readonly eventService: IEventService;
  readonly sessionId: string;
}

export interface PromptMetadataPatch {
  readonly lastPrompt: string;
  readonly title?: string;
  readonly isCustomTitle?: boolean;
}

/**
 * Computes the metadata patch for a prompt text, or `undefined` when nothing
 * would change — so sinks and rpc callers racing the same prompt never
 * double-write or bump `updatedAt`.
 */
export function promptMetadataPatchFromText(
  current: Pick<SessionMeta, 'title' | 'isCustomTitle' | 'lastPrompt'>,
  text: string | undefined,
): PromptMetadataPatch | undefined {
  if (text === undefined) return undefined;
  const patch: { lastPrompt: string; title?: string; isCustomTitle?: boolean } = {
    lastPrompt: text,
  };
  if (!current.isCustomTitle && isUntitled(current.title)) {
    patch.title = titleFromPromptMetadataText(text);
    patch.isCustomTitle = false;
  }
  if (patch.title === undefined && patch.lastPrompt === current.lastPrompt) return undefined;
  return patch;
}

export async function applyPromptMetadataUpdate(
  target: PromptMetadataUpdateTarget,
  text: string | undefined,
): Promise<void> {
  const patch = promptMetadataPatchFromText(await target.metadata.read(), text);
  if (patch === undefined) return;
  await target.metadata.update(patch);
  target.eventService.publish({
    type: 'session.meta.updated',
    payload: {
      agentId: 'main',
      sessionId: target.sessionId,
      title: patch.title,
      patch: {
        title: patch.title,
        isCustomTitle: patch.isCustomTitle,
        lastPrompt: patch.lastPrompt,
      },
    },
  });
}
