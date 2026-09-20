import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { setResponse } from 'better-call/node';
import { LIMITS } from '../../shared/limits.js';
import type { Auth } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { SessionUser } from '../../shared/types.js';
import { HttpError, scrubSecrets } from './errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SessionLocals {
  user: SessionUser;
  sessionId: string;
}

export function createAuthMiddleware(auth: Auth) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) {
        next(new HttpError(401, 'unauthorized', '请先登录。'));
        return;
      }
      const locals = res.locals as SessionLocals;
      locals.user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name
      };
      locals.sessionId = session.session.id;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Same-origin only: every application mutation must carry an Origin header that
 * exactly matches one of the fixed loopback origins. No permissive CORS.
 */
export function createOriginMiddleware(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
      next(new HttpError(403, 'origin_rejected', '请求来源不被信任。'));
      return;
    }
    next();
  };
}

/** Cap the auth body before Better Auth reads the raw stream. */
export function createAuthBodyLimitMiddleware(maxBytes: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const header = req.headers['content-length'];
    if (typeof header === 'string') {
      const length = Number(header);
      if (Number.isFinite(length) && length > maxBytes) {
        next(new HttpError(413, 'payload_too_large', '请求体过大。'));
        return;
      }
    }
    next();
  };
}

/**
 * Bounded Better Auth adapter. We read the raw stream with a hard byte cap
 * (including chunked requests without Content-Length) and then hand a buffered
 * Request to Better Auth, so an oversized body is a clean 413 instead of the
 * adapter's internal 500. `setResponse` still preserves Set-Cookie handling.
 */
export function createAuthNodeHandler(auth: Auth, config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = req as unknown as {
        method?: string;
        headers: Record<string, string | string[] | undefined>;
        originalUrl?: string;
        url?: string;
        destroy: () => void;
        [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
      };
      const method = raw.method ?? 'GET';
      let body: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD' && req.headers['content-type']) {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > LIMITS.authBodyBytes) {
          throw new HttpError(413, 'payload_too_large', '请求体过大。');
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let exceeded = false;
        for await (const chunk of req) {
          const buffer = chunk as Buffer;
          total += buffer.length;
          if (total > LIMITS.authBodyBytes) {
            exceeded = true;
            continue;
          }
          chunks.push(buffer);
        }
        if (exceeded) throw new HttpError(413, 'payload_too_large', '请求体过大。');
        body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      }
      const target = `${config.origin}${raw.originalUrl ?? raw.url ?? '/'}`;
      const request = new Request(target, {
        method,
        headers: req.headers as Record<string, string>,
        ...(body ? { body: body as unknown as Uint8Array, duplex: 'half' as const } : {})
      } as RequestInit);
      const response = await auth.handler(request);
      await setResponse(res, response);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    }
  };
}

/** Private API responses must never be cached. */
export function createNoStoreMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  };
}

export function requireUser(res: Response): SessionUser {
  const locals = res.locals as Partial<SessionLocals>;
  if (!locals.user) {
    throw new HttpError(401, 'unauthorized', '请先登录。');
  }
  return locals.user;
}

export function createErrorHandler(config: AppConfig) {
  const secrets = [config.authSecret, config.exaApiKey, config.githubToken];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: {
          code: error.code,
          message: scrubSecrets(error.message, secrets),
          details: error.details ?? null
        }
      });
      return;
    }
    const bodyErrorType = (error as { type?: unknown })?.type;
    if (bodyErrorType === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: '请求体过大。' } });
      return;
    }
    const name = error instanceof Error ? error.name : 'Error';
    const code = (error as { code?: unknown })?.code;
    const detail = error instanceof Error ? scrubSecrets(error.message, secrets) : '';
    console.error('[stripsearch] unhandled error', name, typeof code === 'string' ? code : '', detail);
    res.status(500).json({ error: { code: 'internal_error', message: '服务器内部错误。' } });
  };
}
