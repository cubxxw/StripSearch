import { Router } from 'express';
import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { LIMITS } from '../../shared/limits.js';
import { isTerminalState } from '../../shared/types.js';
import type { ProviderName } from '../../shared/types.js';
import { renderJson, renderMarkdown } from '../../shared/canonical.js';
import {
  extractGitHubHandle,
  isPublicHttpsUrl,
  normalizeQuestion,
  screenQuestion,
  validateQuestion,
  validateSeedUrl
} from '../../shared/validation.js';
import type { Auth } from '../auth.js';
import { HttpError } from '../http/errors.js';
import { requireUser } from '../http/middleware.js';
import type { Runner } from '../services/runner.js';
import type { RunRecord, Store } from '../store.js';
import { fingerprintInput, normalizeProvider } from '../util/fingerprint.js';

export interface RunRouteDeps {
  store: Store;
  runner: Runner;
  auth: Auth;
  exaConfigured: boolean;
}

function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function readIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 128);
}

function optionalString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

type IdempotencyLookup = { run: RunRecord } | { conflict: true } | null;

/**
 * Only the SAME idempotency key with the SAME normalized request returns an
 * existing run. A missing key always creates a new run, and a reused key with a
 * different request is a conflict.
 */
function lookupIdempotent(
  store: Store,
  ownerId: string,
  key: string | null,
  fingerprint: string
): IdempotencyLookup {
  if (!key) return null;
  const existing = store.findIdempotencyKey(ownerId, key);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) return { conflict: true };
  const run = store.getRunForOwner(existing.runId, ownerId);
  if (!run) throw new HttpError(410, 'run_deleted', '该研究已删除。请新建研究后重试。');
  return { run };
}

export function registerRunRoutes(router: Router, deps: RunRouteDeps): void {
  const { store, runner, auth, exaConfigured } = deps;

  router.post('/runs', (req: Request, res: Response) => {
    const user = requireUser(res);
    const body = readBody(req);
    const question = normalizeQuestion(body.question);
    const questionCheck = validateQuestion(question);
    if (!questionCheck.ok) {
      throw new HttpError(400, 'invalid_question', questionCheck.error ?? '研究问题无效。');
    }
    const seedCheck = validateSeedUrl(body.seedUrl ?? null);
    if (!seedCheck.ok) {
      throw new HttpError(400, 'invalid_seed_url', seedCheck.error ?? '主页链接无效。');
    }
    const seedUrl = seedCheck.url;
    const provider: ProviderName = normalizeProvider(body.provider);
    const parentRunId = optionalString(body.parentRunId, 120);
    const retryOf = optionalString(body.retryOf, 120);
    const followup = body.followup === true;

    const screen = screenQuestion(question, seedUrl ?? '');
    if (screen.disallowed) {
      throw new HttpError(422, 'scope_disallowed', screen.reason ?? '该请求不在可处理范围内。');
    }
    if (provider === 'exa') {
      if (!exaConfigured) {
        throw new HttpError(
          409,
          'provider_unavailable',
          'Exa 未配置。请让服务端配置 Exa，或改用 GitHub 公开账号。'
        );
      }
      if (seedUrl && !isPublicHttpsUrl(seedUrl)) {
        throw new HttpError(400, 'invalid_seed_url', 'Exa 的种子主页必须是可公开访问的 HTTPS 链接。');
      }
    }
    if (parentRunId && !store.getRunForOwner(parentRunId, user.id)) {
      throw new HttpError(404, 'parent_not_found', '未找到父研究。');
    }
    if (retryOf && !store.getRunForOwner(retryOf, user.id)) {
      throw new HttpError(404, 'retry_source_not_found', '未找到要重试的研究。');
    }

    const fingerprint = fingerprintInput({ question, seedUrl, provider, parentRunId, retryOf, followup });
    const idempotencyKey = readIdempotencyKey(req);
    const idempotent = lookupIdempotent(store, user.id, idempotencyKey, fingerprint);
    if (idempotent && 'conflict' in idempotent) {
      throw new HttpError(409, 'idempotency_conflict', '幂等键与请求内容不一致，请使用新的键。');
    }
    if (idempotent && 'run' in idempotent) {
      res.json({ run: store.buildCanonicalView(idempotent.run), idempotent: true });
      return;
    }

    const gate = runner.checkStartAllowed(user.id);
    if (!gate.allowed) {
      throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
    }

    const run = store.insertRun({
      ownerId: user.id,
      question,
      seedUrl,
      provider,
      parentRunId,
      retryOf,
      followup,
      idempotencyKey,
      bodyFingerprint: fingerprint
    });
    if (idempotencyKey) store.recordIdempotencyKey(user.id, idempotencyKey, fingerprint, run.id);
    store.addEvent(run.id, 'state', { state: 'queued' });
    runner.recordStart(user.id);
    runner.enqueue(run.id);
    res.status(201).json({ run: store.buildCanonicalView(run), idempotent: false });
  });

  router.get('/runs', (_req: Request, res: Response) => {
    const user = requireUser(res);
    const runs = store.listRunsForOwner(user.id).map((run) => store.summarize(run));
    res.json({ runs });
  });

  router.get('/runs/:id', (req: Request, res: Response) => {
    const user = requireUser(res);
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    const since = Number(req.query.since ?? 0);
    const includeEvents = req.query.events !== '0';
    const after = Number.isFinite(since) && since > 0 ? since : 0;
    res.json({
      run: store.buildCanonicalView(run),
      events: includeEvents ? store.listEvents(run.id, after, 500) : [],
      latestSeq: store.latestSeq(run.id)
    });
  });

  router.get('/runs/:id/events', (req: Request, res: Response) => {
    const user = requireUser(res);
    const runId = String(req.params.id);
    const run = store.getRunForOwner(runId, user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    const ownerId = run.ownerId;

    const lastEventHeader = req.header('last-event-id');
    const queryAfter = Number(req.query.after ?? 0);
    let after = Number(lastEventHeader ?? (Number.isFinite(queryAfter) ? queryAfter : 0));
    if (!Number.isFinite(after) || after < 0) after = 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.flushHeaders?.();

    let closed = false;
    let checking = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const send = (event: { seq: number; type: string; payload: unknown }): void => {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    };
    const flush = (): void => {
      const events = store.listEvents(runId, after, 500);
      for (const event of events) {
        send(event);
        after = event.seq;
      }
    };

    const finish = (state: string, includePending = true): void => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
      if (includePending) flush();
      res.write(`event: done\ndata: ${JSON.stringify({ state })}\n\n`);
      res.end();
    };

    flush();
    const current = store.getRun(runId);
    if (!current || isTerminalState(current.state)) {
      finish(current?.state ?? 'deleted');
      return;
    }

    poll = setInterval(() => {
      if (closed || checking) return;
      checking = true;
      void (async () => {
        try {
          // Re-check ownership and session validity while streaming so a
          // revoked or expired session stops receiving events.
          const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
          if (closed) return;
          if (!session?.user || session.user.id !== ownerId) {
            finish('revoked', false);
            return;
          }
          const latest = store.getRun(runId);
          if (!latest) {
            finish('deleted', false);
            return;
          }
          flush();
          if (isTerminalState(latest.state)) finish(latest.state);
        } catch {
          finish('error', false);
        } finally {
          checking = false;
        }
      })();
    }, LIMITS.ssePollIntervalMs);
    heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, LIMITS.sseHeartbeatMs);
    req.on('close', () => {
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
    });
  });

  router.post('/runs/:id/cancel', (req: Request, res: Response) => {
    const user = requireUser(res);
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    runner.cancel(run.id);
    const updated = store.getRun(run.id);
    res.json({ run: updated ? store.buildCanonicalView(updated) : null });
  });

  router.post('/runs/:id/resume', (req: Request, res: Response) => {
    const user = requireUser(res);
    const body = readBody(req);
    const seedCheck = validateSeedUrl(body.seedUrl ?? null);
    if (!seedCheck.ok || !seedCheck.url) {
      throw new HttpError(400, 'invalid_seed_url', seedCheck.error ?? '请提供主页链接。');
    }
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (run.state !== 'needs_input') {
      throw new HttpError(409, 'run_not_waiting', '该研究不在等待补充信息状态。');
    }
    if (run.provider === 'github' && !extractGitHubHandle(seedCheck.url)) {
      throw new HttpError(
        400,
        'invalid_seed_url',
        'GitHub 来源需要 https://github.com/<用户名> 形式的主页链接。'
      );
    }
    if (run.provider === 'exa' && !isPublicHttpsUrl(seedCheck.url)) {
      throw new HttpError(400, 'invalid_seed_url', 'Exa 的种子主页必须是可公开访问的 HTTPS 链接。');
    }
    const screen = screenQuestion(seedCheck.url);
    if (screen.disallowed) {
      throw new HttpError(422, 'scope_disallowed', screen.reason ?? '该请求不在可处理范围内。');
    }
    const gate = runner.checkStartAllowed(user.id);
    if (!gate.allowed) {
      throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
    }
    const result = runner.resume(run.id, user.id, seedCheck.url);
    if (result === 'not_found') throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (result === 'conflict') {
      throw new HttpError(409, 'run_not_waiting', '该研究不在等待补充信息状态。');
    }
    runner.recordStart(user.id);
    res.json({ run: store.buildCanonicalView(result) });
  });

  router.post('/runs/:id/retry', (req: Request, res: Response) => {
    const user = requireUser(res);
    const parent = store.getRunForOwner(String(req.params.id), user.id);
    if (!parent) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (!isTerminalState(parent.state)) {
      throw new HttpError(409, 'run_active', '研究仍在进行，不能重试。');
    }
    if (parent.provider === 'exa' && !exaConfigured) {
      throw new HttpError(409, 'provider_unavailable', 'Exa 未配置，无法重试。');
    }
    const fingerprint = fingerprintInput({
      question: parent.question,
      seedUrl: parent.seedUrl,
      provider: parent.provider,
      parentRunId: parent.parentRunId,
      retryOf: parent.id,
      followup: false
    });
    const idempotencyKey = readIdempotencyKey(req);
    const idempotent = lookupIdempotent(store, user.id, idempotencyKey, fingerprint);
    if (idempotent && 'conflict' in idempotent) {
      throw new HttpError(409, 'idempotency_conflict', '幂等键与请求内容不一致，请使用新的键。');
    }
    if (idempotent && 'run' in idempotent) {
      res.json({ run: store.buildCanonicalView(idempotent.run), idempotent: true });
      return;
    }
    const gate = runner.checkStartAllowed(user.id);
    if (!gate.allowed) throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
    const run = store.insertRun({
      ownerId: user.id,
      question: parent.question,
      seedUrl: parent.seedUrl,
      provider: parent.provider,
      parentRunId: parent.parentRunId,
      retryOf: parent.id,
      followup: false,
      idempotencyKey,
      bodyFingerprint: fingerprint
    });
    if (idempotencyKey) store.recordIdempotencyKey(user.id, idempotencyKey, fingerprint, run.id);
    store.addEvent(run.id, 'state', { state: 'queued', retryOf: parent.id });
    runner.recordStart(user.id);
    runner.enqueue(run.id);
    res.status(201).json({ run: store.buildCanonicalView(run), idempotent: false });
  });

  router.post('/runs/:id/followup', (req: Request, res: Response) => {
    const user = requireUser(res);
    const parent = store.getRunForOwner(String(req.params.id), user.id);
    if (!parent) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (parent.provider !== 'exa') {
      throw new HttpError(
        409,
        'followup_requires_exa',
        'GitHub 来源只整理账号与仓库元数据，追问需要配置 Exa；可以改用 Exa 重新研究。'
      );
    }
    if (!exaConfigured) {
      throw new HttpError(409, 'provider_unavailable', 'Exa 未配置，无法发起追问。');
    }
    const body = readBody(req);
    const question = normalizeQuestion(body.question);
    const questionCheck = validateQuestion(question);
    if (!questionCheck.ok) {
      throw new HttpError(400, 'invalid_question', questionCheck.error ?? '追问内容无效。');
    }
    const screen = screenQuestion(question);
    if (screen.disallowed) {
      throw new HttpError(422, 'scope_disallowed', screen.reason ?? '该请求不在可处理范围内。');
    }
    const fingerprint = fingerprintInput({
      question,
      seedUrl: parent.seedUrl,
      provider: parent.provider,
      parentRunId: parent.id,
      retryOf: null,
      followup: true
    });
    const idempotencyKey = readIdempotencyKey(req);
    const idempotent = lookupIdempotent(store, user.id, idempotencyKey, fingerprint);
    if (idempotent && 'conflict' in idempotent) {
      throw new HttpError(409, 'idempotency_conflict', '幂等键与请求内容不一致，请使用新的键。');
    }
    if (idempotent && 'run' in idempotent) {
      res.json({ run: store.buildCanonicalView(idempotent.run), idempotent: true });
      return;
    }
    const gate = runner.checkStartAllowed(user.id);
    if (!gate.allowed) throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
    const run = store.insertRun({
      ownerId: user.id,
      question,
      seedUrl: parent.seedUrl,
      provider: parent.provider,
      parentRunId: parent.id,
      retryOf: null,
      followup: true,
      idempotencyKey,
      bodyFingerprint: fingerprint
    });
    if (idempotencyKey) store.recordIdempotencyKey(user.id, idempotencyKey, fingerprint, run.id);
    store.addEvent(run.id, 'state', { state: 'queued', parentRunId: parent.id });
    runner.recordStart(user.id);
    runner.enqueue(run.id);
    res.status(201).json({ run: store.buildCanonicalView(run), idempotent: false });
  });

  router.delete('/runs/:id', (req: Request, res: Response) => {
    const user = requireUser(res);
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    // Abort the in-flight job before deleting so no late write can race it.
    runner.abort(run.id);
    store.deleteRun(run.id);
    res.status(204).end();
  });

  router.get('/runs/:id/export', (req: Request, res: Response) => {
    const user = requireUser(res);
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    const format = req.query.format === 'json' ? 'json' : 'markdown';
    const view = store.buildCanonicalView(run);
    if (format === 'json') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="stripsearch-${run.id}.json"`);
      res.send(renderJson(view));
      return;
    }
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="stripsearch-${run.id}.md"`);
    res.send(renderMarkdown(view));
  });

  const setExclusion = (exclude: boolean) => (req: Request, res: Response) => {
    const user = requireUser(res);
    const run = store.getRunForOwner(String(req.params.id), user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    const body = readBody(req);
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== run.revision) {
      throw new HttpError(409, 'stale_revision', '报告已更新，请刷新后重试。');
    }
    const sourceKey = String(req.params.sourceKey);
    const source = store.getSource(run.id, sourceKey);
    if (!source) throw new HttpError(404, 'source_not_found', '未找到该来源。');
    let changed = false;
    if (source.excluded !== exclude) {
      store.setSourceExcluded(run.id, sourceKey, exclude);
      store.updateRun(run.id, { revision: run.revision + 1 });
      store.addEvent(run.id, 'revision', { revision: run.revision + 1, sourceKey, excluded: exclude });
      changed = true;
    }
    const updated = store.getRun(run.id);
    if (!updated) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    res.json({ run: store.buildCanonicalView(updated), changed });
  };

  router.post('/runs/:id/sources/:sourceKey/exclude', setExclusion(true));
  router.post('/runs/:id/sources/:sourceKey/restore', setExclusion(false));
}
