/**
 * Session-canonical media download route.
 *
 * Resolves the Session-scoped `ISessionMediaStore` through the workspace /
 * session lifecycle chain and streams canonical prompt media with browser
 * byte-range semantics. The global upload store is only a staging source;
 * this route remains readable after that transient file is released.
 */

import { Readable } from 'node:stream';

import { ISessionMediaStore } from '@moonshot-ai/agent-core-v2/agent/media/sessionMediaStore';
import { resumeSessionById } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/sessionLookup';
import type { Scope } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { z } from 'zod';

import { buildContentDisposition } from '../lib/contentDisposition';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope } from '../protocol/envelope';

interface SessionMediaRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: SessionMediaRequest, reply: SessionMediaReply) => unknown,
  ): unknown;
}

interface SessionMediaRequest {
  readonly id: string;
  readonly params: { readonly session_id: string; readonly file_id: string };
  readonly headers: Record<string, unknown>;
}

interface SessionMediaReply {
  type(mime: string): SessionMediaReply;
  header(name: string, value: string | number): SessionMediaReply;
  code(status: number): SessionMediaReply;
  send(payload: unknown): unknown;
}

const sessionMediaParamSchema = z.object({
  session_id: z.string().min(1),
  file_id: z.string().min(1),
});

export function registerSessionMediaRoutes(app: SessionMediaRouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/media/{file_id}',
      params: sessionMediaParamSchema,
      rawResponse: { 200: { type: 'string', format: 'binary' } },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
      },
      description: 'Download session-canonical prompt media by file ID',
      tags: ['files'],
    },
    async (req, reply) => {
      const r = reply as unknown as SessionMediaReply;
      const { session_id, file_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        return r
          .code(404)
          .send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session not found', req.id),
          ) as unknown as void;
      }
      const file = await session.accessor.get(ISessionMediaStore).open(file_id);
      if (file === undefined) {
        return r
          .code(404)
          .send(
            errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', req.id),
          ) as unknown as void;
      }

      r
        .type(file.mediaType)
        .header('content-disposition', buildContentDisposition(file.name, file.mediaType))
        .header('accept-ranges', 'bytes')
        .header('etag', `"${session_id}-${file_id}-${file.size}"`);

      const range = parseRangeHeader(pickHeader(req.headers, 'range'), file.size);
      if (range !== null) {
        return r
          .header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
          .header('content-length', range.length)
          .code(206)
          .send(
            Readable.from(file.stream({ start: range.start, end: range.end })),
          ) as unknown as void;
      }
      return r
        .header('content-length', file.size)
        .code(200)
        .send(Readable.from(file.stream())) as unknown as void;
    },
  );
  app.get(
    route.path,
    route.options,
    route.handler as unknown as Parameters<SessionMediaRouteHost['get']>[2],
  );
}
