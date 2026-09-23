import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView, SessionUser } from '../shared/types.js';
import type { ReviewCaseDetail, ReviewQueueItem } from '../shared/review.js';
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
const { state, review, selectRun, loadRuns, signOut, cancelRun, toggleExclusion, retryRun, sendFollowup, copyReport, renderAll } =
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

/* ---------------- review workbench session isolation ---------------- */

const REVIEW_PROGRESS = { total: 1, reviewed: 0, draft: 0, unreviewed: 1 };

function reviewItem(caseId: string): ReviewQueueItem {
  return {
    caseId,
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    badge: '合成练习 · 示例回答 · 待你判断',
    kind: 'practice',
    status: 'unreviewed',
    latestStatus: null,
    latestRevision: 0,
    sourceCount: 1,
    claimCount: 1,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z'
  };
}

function reviewDetail(caseId: string): ReviewCaseDetail {
  return {
    caseId,
    datasetVersion: 'behavior-v1',
    split: 'discovery',
    kind: 'practice',
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    asOf: '2026-03-02',
    badge: '合成练习 · 示例回答 · 待你判断',
    rubricVersion: 1,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    status: 'unreviewed',
    latestRevision: 0,
    latestStatus: null,
    sources: [{ sourceId: 'S1', title: '证据', text: '正文', locator: null }],
    candidates: [
      { blindLabel: 'A', claims: [{ claimId: 'K1', text: '候选甲' }] },
      { blindLabel: 'B', claims: [{ claimId: 'K2', text: '候选乙' }] }
    ],
    claimIds: ['K1', 'K2'],
    provenance: null
  };
}

function reviewRoutes(prefix: string, extra?: (url: string) => Response | null): (url: string) => Response {
  return (url: string) => {
    if (url.includes('/api/review/cases?') || url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem(`${prefix}case`)], progress: REVIEW_PROGRESS });
    }
    if (url.includes(`/api/review/cases/${prefix}case/history`)) {
      return jsonResponse({ history: [], revisions: [] });
    }
    if (url.includes(`/api/review/cases/${prefix}case`)) {
      return jsonResponse({ case: reviewDetail(`${prefix}case`), annotation: null, history: [] });
    }
    const other = extra?.(url);
    if (other) return other;
    return jsonResponse({});
  };
}

test('sign-out clears the previous account review queue and case', async () => {
  await freshUser('review-A');
  review.reset();
  route = reviewRoutes('a');
  await review.open('acase');
  assert.equal(review.state.caseId, 'acase');
  assert.equal(env.document.querySelector('#view-review .review-case') !== null, true);

  await signOut();
  assert.equal(state.user, null);
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.detail, null);
  assert.equal(review.state.queue.length, 0);
  assert.equal(env.document.querySelector('#view-review .review-case'), null);

  await freshUser('review-B');
  route = reviewRoutes('b');
  await review.open();
  assert.equal(review.state.caseId, 'bcase');
  assert.match(env.document.querySelector('#view-review')?.textContent ?? '', /案例 bcase/);
});

test('a late review load cannot repopulate state after account reset', async () => {
  await freshUser('review-C');
  review.reset();
  const gate = deferred<void>();
  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem('ccase')], progress: REVIEW_PROGRESS });
    }
    if (url.includes('/api/review/cases/ccase')) {
      return gate.promise.then(() =>
        jsonResponse({ case: reviewDetail('ccase'), annotation: null, history: [] })
      );
    }
    return jsonResponse({});
  };
  const pending = review.open('ccase');
  await settle();
  review.reset();
  gate.resolve();
  await pending;
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.detail, null);
  assert.equal(env.document.querySelector('#view-review .review-case'), null);
});

test('a failed sign-out preserves review state and unsaved work', async () => {
  await freshUser('review-D');
  review.reset();
  route = reviewRoutes('d', (url) => {
    if (url.includes('/api/auth/sign-out')) return jsonResponse({ message: 'nope' }, 500);
    return null;
  });
  await review.open('dcase');
  assert.equal(review.state.caseId, 'dcase');
  review.state.dirty = true;

  await signOut();
  assert.equal(state.user?.id, 'review-D');
  assert.equal(review.state.caseId, 'dcase');
  assert.equal(review.state.dirty, true);
});

test('a malformed encoded review hash does not throw or leak state', async () => {
  await freshUser('review-E');
  review.reset();
  route = () =>
    jsonResponse({ cases: [], progress: { total: 0, reviewed: 0, draft: 0, unreviewed: 0 } });
  env.window.location.hash = '#/review/%E0%A4%A';
  await settle();
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.queue.length, 0);
});

test('in-app navigation away from a dirty review asks and can be declined', async () => {
  await freshUser('review-H');
  review.reset();
  route = reviewRoutes('h');
  env.window.location.hash = '#/review/hcase';
  await settle();
  assert.equal(review.state.caseId, 'hcase');
  review.state.dirty = true;

  const originalConfirm = env.window.confirm;
  let asked = 0;
  env.window.confirm = () => {
    asked += 1;
    return false;
  };
  try {
    const before = env.window.location.hash;
    env.window.location.hash = '#/app';
    await settle();
    assert.equal(asked, 1);
    assert.equal(env.window.location.hash, before);
    assert.equal(review.state.caseId, 'hcase');
    assert.equal(review.state.dirty, true);
  } finally {
    env.window.confirm = originalConfirm;
  }
});

test('a stale 401 after account reset does not open sign-in for the new user', async () => {
  await freshUser('review-I');
  review.reset();
  const gate = deferred<Response>();
  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem('icase')], progress: REVIEW_PROGRESS });
    }
    if (url.includes('/api/review/cases/icase')) return gate.promise;
    return jsonResponse({});
  };
  const pending = review.open('icase');
  await settle();
  review.reset();
  await freshUser('review-J');

  const dialog = env.document.getElementById('auth-dialog');
  gate.resolve(jsonResponse({ error: { code: 'unauthorized', message: '请先登录。' } }, 401));
  await pending;
  await settle();
  assert.equal(review.state.caseId, null);
  assert.notEqual(dialog?.hasAttribute('open'), true);
});

test('an expired review session clears the previous account research state', async () => {
  await freshUser('review-K');
  review.reset();
  state.run = makeView('privateA');
  state.activeRunId = 'privateA';
  state.runs = [
    {
      runId: 'privateA',
      question: '问题 privateA',
      state: 'completed',
      provider: 'github',
      revision: 1,
      createdAt: '',
      updatedAt: '',
      sourceCount: 1,
      reviewCount: 0
    }
  ];
  state.messages = [{ role: 'user', label: '你', text: 'A 的追问' }];
  renderAll();

  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
    return jsonResponse({});
  };
  await review.open(null);
  await settle();

  assert.equal(state.run, null);
  assert.equal(state.activeRunId, null);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.messages, []);
  const appText = env.document.getElementById('view-app')?.textContent ?? '';
  assert.doesNotMatch(appText, /privateA/);
  assert.doesNotMatch(appText, /A 的追问/);
  assert.equal(env.document.getElementById('auth-dialog')?.hasAttribute('open'), true);
});

test('a direct auth-form account switch clears the previous research DOM immediately', async () => {
  await freshUser('review-L');
  const privateInputs = ['research-question', 'profile-url', 'chat-input', 'resume-seed'];
  for (const id of privateInputs) {
    (env.document.getElementById(id) as HTMLInputElement).value = `privateL unsent ${id}`;
  }
  state.run = makeView('privateL');
  state.activeRunId = 'privateL';
  state.runs = [
    {
      runId: 'privateL',
      question: '问题 privateL',
      state: 'completed',
      provider: 'github',
      revision: 1,
      createdAt: '',
      updatedAt: '',
      sourceCount: 1,
      reviewCount: 0
    }
  ];
  renderAll();
  assert.match(env.document.getElementById('view-app')?.textContent ?? '', /privateL/);

  const runsGate = deferred<void>();
  route = (url: string) => {
    if (url.includes('/api/auth/sign-in/email')) {
      return jsonResponse({ user: { id: 'review-M', email: 'm@example.test', name: 'review-M' } });
    }
    if (url.endsWith('/api/runs')) {
      return runsGate.promise.then(() => jsonResponse({ runs: [] }));
    }
    return jsonResponse({});
  };
  env.document.getElementById('open-auth')!.click();
  const email = env.document.getElementById('auth-email') as HTMLInputElement;
  const password = env.document.getElementById('auth-password') as HTMLInputElement;
  email.value = 'm@example.test';
  password.value = 'password-1234';
  const form = env.document.getElementById('auth-form') as HTMLFormElement;
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  // Runs list is still pending, but the previous account's DOM must be gone.
  assert.equal(state.user?.id, 'review-M');
  const appText = env.document.getElementById('view-app')?.textContent ?? '';
  assert.doesNotMatch(appText, /privateL/);
  for (const id of privateInputs) {
    assert.equal((env.document.getElementById(id) as HTMLInputElement).value, '', `${id} must clear on identity switch`);
  }
  runsGate.resolve();
  await settle();
});
