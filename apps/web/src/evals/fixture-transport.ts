/**
 * Bounded offline transport for the runtime-v1 evaluator.
 *
 * It replays an in-memory response list in strict method+URL order, enforces
 * optional request-body fragments, optionally delays (aborting politely) and
 * records every call. Any request that does not match the frozen replay is both
 * thrown and recorded in `violations`, so a production adapter that swallows a
 * provider error can never hide an unexpected network attempt.
 */

import type { HttpRequestInit, HttpResponseLike, HttpTransport } from '../server/adapters/types.js';
import type { EvalReplayStep } from './schema.js';

export interface FixtureCall {
  method: string;
  url: string;
  body: string | null;
}

export type FixtureViolationKind = 'unexpected_request' | 'body_mismatch';

export interface FixtureViolation {
  kind: FixtureViolationKind;
  message: string;
  call: FixtureCall;
  expected: string | null;
}

export class FixtureViolationError extends Error {
  constructor(
    readonly kind: FixtureViolationKind,
    message: string
  ) {
    super(message);
    this.name = 'FixtureViolationError';
  }
}

function abortError(): Error {
  const error = new Error('The fixture transport operation was aborted');
  error.name = 'AbortError';
  return error;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function responseText(step: EvalReplayStep): string {
  if (step.raw_text !== undefined) return step.raw_text;
  if (step.json !== undefined) return JSON.stringify(step.json);
  return '';
}

function makeResponse(step: EvalReplayStep): HttpResponseLike {
  const text = responseText(step);
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  return {
    status: step.status,
    ok: step.status >= 200 && step.status < 300,
    redirected: step.redirected === true,
    headers: { get: () => null },
    body,
    text: async () => text
  };
}

export class FixtureTransport implements HttpTransport {
  readonly calls: FixtureCall[] = [];
  readonly violations: FixtureViolation[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly EvalReplayStep[]) {}

  get consumed(): number {
    return this.cursor;
  }

  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponseLike> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    const call: FixtureCall = { method, url, body };
    this.calls.push(call);

    const step = this.steps[this.cursor];
    if (!step || step.method !== method || step.url !== url) {
      const expected = step ? `${step.method} ${step.url}` : null;
      const message = step
        ? `unexpected request ${method} ${url}; expected ${expected}`
        : `unexpected request ${method} ${url}; no replay step remains`;
      this.violations.push({ kind: 'unexpected_request', message, call, expected });
      throw new FixtureViolationError('unexpected_request', message);
    }

    if (step.body_includes && step.body_includes.length > 0) {
      const haystack = body ?? '';
      const missing = step.body_includes.filter((fragment) => !haystack.includes(fragment));
      if (missing.length > 0) {
        const message = `request body for ${url} is missing ${missing.map((item) => JSON.stringify(item)).join(', ')}`;
        this.violations.push({ kind: 'body_mismatch', message, call, expected: `${method} ${url}` });
        throw new FixtureViolationError('body_mismatch', message);
      }
    }

    this.cursor += 1;
    if (step.delay_ms !== undefined && step.delay_ms > 0) {
      await delayWithAbort(step.delay_ms, init?.signal);
    }
    return makeResponse(step);
  }
}
