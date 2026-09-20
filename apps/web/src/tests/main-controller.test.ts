import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView, SessionUser } from '../shared/types.js';
import { installDom, installFetch, jsonResponse, textResponse } from './dom-env.js';
import { deferred } from './fakes.js';

const env = installDom();

function user(id: string): SessionUser {
  return { id, email: `${id}@example.test`, name: id };
}

function makeSource(sourceKey: string, excluded = false): CanonicalView['sources'][number] {
  return {
    sourceKey,
    url: `https://example.com/${sourceKey.toLowerCase()}`,
    title: `来源 ${sourceKey}`,
    kind: 'work',
    publishedAt: null,
    retrievedAt: '2024-01-01T00:00:00.000Z',
    fetchStatus: excluded ? 'excluded' : 'ok',
    excerpt: '短摘录',
    excerptLocator: '摘录',
    identityLabel: '未确认',
    identityConfirmed: false,
    limits: [],
    excluded,
    excludedAt: excluded ? '2024-01-02T00:00:00.000Z' : null
  };
}

function makeView(runId: string, overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    state: 'completed',
    revision: 1,
    question: `问题 ${runId}`,
    seedUrl: 'https://github.com/example',
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    interrupted: false,
    stopReason: null,
    identity: {
      displayName: runId,
      handle: null,
      profileUrl: null,
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [makeSource('S1')],
    observations: [],
    answer: [
      {
        id: 'facts',
        heading: '查到的事实',
        body: '',
        bullets: [{ text: '事实一', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }]
      }
    ],
    limitations: [],
    usage: { provider: 'github', requests: 1, bytes: 1, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

type RouteHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: RouteHandler = () => jsonResponse({});
installFetch((url, init) => route(url, init));

const main = await import('../client/main.js');
const { state, selectRun, loadRuns, signOut, cancelRun, toggleExclusion, retryRun, sendFollowup, copyReport, renderAll } =
  main.__test;

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function freshUser(id: string): Promise<void> {
  state.user = user(id);
  state.run = null;
  state.runs = [];
  state.messages = [];
  state.activeRunId = null;
  renderAll();
}

function stubRun(runId: string): void {
  route = (url) => {
    if (url.includes(`/api/runs/${runId}?`)) {
      return jsonResponse({ run: makeView(runId), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
}

test('a late selection cannot replace a newer one', async () => {
  await freshUser('u-select');
  const gateA = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA?')) {
      return gateA.promise.then(() => jsonResponse({ run: makeView('runA'), events: [], latestSeq: 0 }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingA = selectRun('runA');
  await settle();
  await selectRun('runB');
  assert.equal(state.run?.runId, 'runB');
  gateA.resolve();
  await pendingA;
  assert.equal(state.run?.runId, 'runB');
});

test('a pending list cannot repopulate after logout', async () => {
  await freshUser('u-list');
  const gate = deferred<void>();
  route = (url) => {
    if (url.endsWith('/api/runs')) {
      return gate.promise.then(() =>
        jsonResponse({ runs: [{ runId: 'runA', question: 'q', state: 'completed', provider: 'github', revision: 1, createdAt: '', updatedAt: '', sourceCount: 1, reviewCount: 0 }] })
      );
    }
    return jsonResponse({});
  };
  const pending = loadRuns();
  state.user = null;
  gate.resolve();
  await pending;
  assert.equal(state.runs.length, 0);
});

test('cancel and retry responses for an abandoned run are ignored', async () => {
  await freshUser('u-cancel');
  state.run = makeView('runA');
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA/cancel')) {
      return gate.promise.then(() => jsonResponse({ run: makeView('runA', { state: 'cancelled' }) }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingCancel = cancelRun();
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pendingCancel;
  assert.equal(state.run?.runId, 'runB');

  const retryGate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runB/retry')) {
      return retryGate.promise.then(() => jsonResponse({ run: makeView('child') }));
    }
    if (url.includes('/api/runs/runC?')) {
      return jsonResponse({ run: makeView('runC'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingRetry = retryRun();
  await settle();
  await selectRun('runC');
  retryGate.resolve();
  await pendingRetry;
  assert.equal(state.run?.runId, 'runC');
});

test('clipboard is not written for a run the user already left', async () => {
  await freshUser('u-copy');
  state.run = makeView('runA');
  env.clipboardWrites.length = 0;
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/export')) return gate.promise.then(() => textResponse('# report'));
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pending = copyReport();
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pending;
  assert.equal(env.clipboardWrites.length, 0);
});

test('a failed sign-out keeps the session and surfaces an error', async () => {
  await freshUser('u-signout');
  route = (url) => {
    if (url.includes('/api/auth/sign-out')) return jsonResponse({ message: 'nope' }, 500);
    return jsonResponse({});
  };
  await signOut();
  assert.equal(state.user?.id, 'u-signout');
  assert.match(env.document.getElementById('toast')?.textContent ?? '', /退出失败/);
});

test('restore keeps focus on the source action inside the open drawer', async () => {
  await freshUser('u-focus');
  state.run = makeView('runA', { sources: [makeSource('S1', true)] });
  state.selectedSourceKey = 'S1';
  renderAll();
  (env.window.matchMedia as unknown as (q: string) => { matches: boolean }) = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }) as unknown as MediaQueryList;
  const drawer = env.document.getElementById('source-drawer') as HTMLDialogElement;
  drawer.showModal();
  route = (url) => {
    if (url.includes('/sources/S1/restore')) {
      return jsonResponse({ run: makeView('runA', { sources: [makeSource('S1', false)] }), changed: true });
    }
    return jsonResponse({});
  };
  await toggleExclusion('S1', false);
  const active = env.document.activeElement as HTMLElement | null;
  assert.ok(active, 'an element should have focus after restore');
  assert.ok(active.closest('#source-drawer'), 'focus must stay inside the open drawer');
  assert.equal(active.classList.contains('button'), true);
});

test('a followup response for an abandoned run is ignored', async () => {
  await freshUser('u-followup');
  state.run = makeView('runA', { provider: 'exa' });
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA/followup')) {
      return gate.promise.then(() => jsonResponse({ run: makeView('child', { provider: 'exa' }) }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB', { provider: 'exa' }), events: [], latestSeq: 0 });
    }
    if (url.endsWith('/api/runs')) return jsonResponse({ runs: [] });
    return jsonResponse({});
  };
  const pending = sendFollowup('还有哪些项目？');
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pending;
  assert.equal(state.run?.runId, 'runB');
  assert.equal(state.messages.filter((message) => message.label === '子研究').length, 0);
});

test('stubRun keeps a completed run selected without opening a stream', async () => {
  await freshUser('u-stub');
  stubRun('runA');
  await selectRun('runA');
  assert.equal(state.run?.runId, 'runA');
  assert.equal(state.streamState, 'idle');
});
