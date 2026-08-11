/**
 * `media` domain — prompt-intake normalization of daemon file references.
 *
 * Every daemon reference entering a session's context gets its bytes
 * materialized at the session-canonical location through the session media
 * store (`ISessionMediaStore`) and carries that absolute path, so the
 * persisted reference always points into the session's own `media/` dir —
 * whichever edge (REST prompt route, SDK prompt, steer, …) the message
 * arrived through. When the canonical write fails, the session media store
 * places the bytes in its shared-cache fallback — a read-only session dir must
 * not reject a submittable prompt — with the extension derived like the
 * canonical copy's: hint path, then upload name, then MIME.
 *
 * Intake rewrites only the reference itself; no `<image|video path="…">`
 * tag is authored — the reference's `?path=` makes the part self-contained,
 * and the request-time resolver synthesizes the degrade tag when needed.
 * Normalization is idempotent (a reference already carrying the canonical
 * path passes through untouched) and best effort (an unreadable upload keeps
 * its original reference; the request-time resolver degrades it instead).
 * Reads the referenced bytes through the `file` domain (`IFileService`).
 * Pure orchestration; no scoped service of its own.
 */

import type { IFileService } from '#/app/file/fileService';
import { abortable } from '#/_base/utils/abort';
import type { ContentPart } from '#/kosong/contract/message';

import {
  buildDaemonFileUrl,
  daemonFileRefFromPart,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';

export interface PromptMediaIntakeDeps {
  readonly files: IFileService;
  readonly mediaStore: ISessionMediaStore;
  readonly signal?: AbortSignal;
}

export async function materializePromptDaemonRefs(
  content: readonly ContentPart[],
  deps: PromptMediaIntakeDeps,
): Promise<readonly ContentPart[]> {
  if (!content.some((part) => daemonFileRefFromPart(part) !== undefined)) return content;

  const out: ContentPart[] = [];
  let changed = false;
  for (const part of content) {
    deps.signal?.throwIfAborted();
    const daemonPart = daemonFileRefFromPart(part);
    if (daemonPart === undefined) {
      out.push(part);
      continue;
    }
    const path = await materializeRef(deps, daemonPart.ref.fileId, daemonPart.ref.path).catch(
      (_error: unknown) => {
        deps.signal?.throwIfAborted();
        return undefined;
      },
    );
    if (path === undefined || path === daemonPart.ref.path) {
      out.push(part);
      continue;
    }
    out.push(rewriteRefPath(part, daemonPart.ref.fileId, path));
    changed = true;
  }
  return changed ? out : content;
}

async function materializeRef(
  deps: PromptMediaIntakeDeps,
  fileId: string,
  hintPath: string | undefined,
): Promise<string | undefined> {
  const file =
    deps.signal === undefined
      ? await deps.files.get(fileId)
      : await abortable(deps.files.get(fileId), deps.signal);
  const input = {
    fileId,
    size: file.meta.size,
    name: file.meta.name,
    mimeType: file.meta.media_type,
    hintPath,
  };
  try {
    const path = await deps.mediaStore.materialize({
      ...input,
      stream: () => file.stream(),
      signal: deps.signal,
    });
    if (path !== undefined) return path;
  } catch {
    deps.signal?.throwIfAborted();
  }
  return deps.mediaStore.materializeFallback({
    ...input,
    stream: () => file.stream(),
    signal: deps.signal,
  });
}

function rewriteRefPath(part: ContentPart, fileId: string, path: string): ContentPart {
  const url = buildDaemonFileUrl(fileId, path);
  if (part.type === 'image_url') return { ...part, imageUrl: { ...part.imageUrl, url } };
  if (part.type === 'video_url') return { ...part, videoUrl: { ...part.videoUrl, url } };
  return part;
}
