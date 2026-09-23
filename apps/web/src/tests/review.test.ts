import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, TestClient } from './harness.js';
import type { TestServer } from './harness.js';
import { buildUserContent } from '../server/review-store.js';
import { PRACTICE_CASES } from '../server/review-seed.js';
import type {
  ClaimLabel,
  ReviewCaseResponse,
  ReviewCaseSnapshot,
  ReviewExportEnvelope,
  ReviewExportRecord,
  ReviewInsights,
  ReviewQueueItem,
  ReviewSource
} from '../shared/review.js';

/** Independent re-implementation used to prove the exported hash is reproducible. */
function stableStringifyIndependent(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringifyIndependent).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyIndependent(item)}`);
  return `{${entries.join(',')}}`;
}

function independentHash(payload: ReviewCaseSnapshot): string {
  return createHash('sha256').update(stableStringifyIndependent(payload)).digest('hex');
}

interface QueueBody {
  cases: ReviewQueueItem[];
  progress: { total: number; reviewed: number; draft: number; unreviewed: number };
}

interface SaveResponse {
  annotation?: {
    revision: number;
    status: string;
    actorPseudonymousId: string;
    decisions: { claimId: string; label: ClaimLabel | null; evidenceIds: string[] }[];
    rubric: { referenceAnswer: string; mustInclude: string[]; mustAvoid: string[] };
  };
  acknowledgment?: string;
  error?: { code?: string; message?: string; details?: { issues?: { code: string }[] } };
}

function caseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: '这是测试问题吗？',
    title: '测试案例',
    asOf: '2026-03-02',
    sources: [
      { title: '证据一', text: '证据正文一', locator: '第 1 段' },
      { title: '证据二', text: '证据正文二', locator: null }
    ],
    candidates: [
      { response: '候选甲论断一\n候选甲论断二', origin: 'secret-origin-alpha', model: 'model-x' },
      { response: '候选乙论断一', origin: 'secret-origin-beta', model: null }
    ],
    ...overrides
  };
}

async function createCase(client: TestClient, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await client.json<{ case: ReviewQueueItem }>('/api/review/cases', {
    method: 'POST',
    json: caseInput(overrides)
  });
  assert.equal(created.status, 201);
  return created.body.case.caseId;
}

async function getCase(client: TestClient, caseId: string): Promise<ReviewCaseResponse> {
  const result = await client.json<ReviewCaseResponse>(`/api/review/cases/${caseId}`);
  assert.equal(result.status, 200);
  return result.body;
}

function completeDecisions(
  detail: ReviewCaseResponse['case'],
  label: ClaimLabel = 'insufficient'
): { claimId: string; label: ClaimLabel; evidenceIds: string[]; note: string | null }[] {
  return detail.claimIds.map((claimId) => ({ claimId, label, evidenceIds: [], note: null }));
}

async function save(
  client: TestClient,
  caseId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: SaveResponse }> {
  return client.json<SaveResponse>(`/api/review/cases/${caseId}/annotation`, {
    method: 'PUT',
    json: body
  });
}

function draftPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedRevision: 0,
    status: 'draft',
    decisions: [],
    preference: null,
    rationale: null,
    reasonTags: [],
    rubric: { referenceAnswer: '', mustInclude: [], mustAvoid: [] },
    ...overrides
  };
}

// These tests share one server and account to stay well inside Better Auth's
// per-IP sign-up limiter. Aggregates that must be exact use their own server.
let shared: TestServer;
test.before(async () => {
  shared = await startTestServer({});
  assert.equal((await shared.client.signUp('shared-owner@example.test')).status, 200);
});
test.after(async () => {
  await shared.close();
});

let isolatedCounter = 0;

async function isolatedServer(t: { after: (fn: () => Promise<void>) => void }): Promise<TestServer> {
  isolatedCounter += 1;
  const server = await startTestServer({});
  assert.equal((await server.client.signUp(`isolated-${isolatedCounter}@example.test`)).status, 200);
  t.after(async () => server.close());
  return server;
}

test('review API enforces auth, Origin and owner scoping', async () => {
  const userB = new TestClient(shared.baseUrl, shared.origin);
  assert.equal((await userB.signUp('review-b@example.test')).status, 200);

  const anonymous = new TestClient(shared.baseUrl, shared.origin);
  assert.equal((await anonymous.request('/api/review/cases')).status, 401);
  assert.equal((await anonymous.request('/api/review/insights')).status, 401);

  // GET must never seed practice cases.
  const freshQueue = await userB.json<QueueBody>('/api/review/cases');
  assert.equal(freshQueue.body.progress.total, 0);

  const caseId = await createCase(shared.client);

  const noOrigin = await shared.client.request('/api/review/cases', {
    method: 'POST',
    origin: null,
    json: caseInput()
  });
  assert.equal(noOrigin.status, 403);
  const foreign = await shared.client.request(`/api/review/cases/${caseId}/annotation`, {
    method: 'PUT',
    origin: 'http://evil.test',
    json: draftPayload()
  });
  assert.equal(foreign.status, 403);

  // Another owner sees nothing and cannot touch the case.
  assert.equal((await userB.request(`/api/review/cases/${caseId}`)).status, 404);
  assert.equal((await userB.request(`/api/review/cases/${caseId}/history`)).status, 404);
  assert.equal((await userB.request(`/api/review/cases/${caseId}/annotation`, { method: 'PUT', json: draftPayload() })).status, 404);
  assert.equal((await userB.request(`/api/review/cases/${caseId}`, { method: 'DELETE' })).status, 404);
  const otherQueue = await userB.json<QueueBody>('/api/review/cases');
  assert.deepEqual(otherQueue.body.cases, []);
});

test('seeding ten practice cases is explicit and idempotent', async () => {
  const before = await shared.client.json<QueueBody>('/api/review/cases');
  const totalBefore = before.body.progress.total;

  const first = await shared.client.json<{ inserted: number; total: number; badge: string }>(
    '/api/review/seed',
    { method: 'POST', json: {} }
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.inserted, 10);
  // `total` counts practice cases only, so it stays 10 regardless of user cases.
  assert.equal(first.body.total, 10);
  assert.match(first.body.badge, /合成练习/);

  const second = await shared.client.json<{ inserted: number; total: number }>('/api/review/seed', {
    method: 'POST',
    json: {}
  });
  assert.equal(second.body.inserted, 0);
  assert.equal(second.body.total, 10);

  const queue = await shared.client.json<QueueBody>('/api/review/cases');
  const practice = queue.body.cases.filter((item) => item.kind === 'practice');
  assert.equal(practice.length, 10);
  assert.ok(queue.body.progress.total >= totalBefore + 10);
});

test('pre-submit reads hide candidate origin metadata and never expose hidden gold', async () => {
  const caseId = await createCase(shared.client);

  const listRaw = await (await shared.client.request('/api/review/cases')).text();
  assert.doesNotMatch(listRaw, /secret-origin-alpha/);
  assert.doesNotMatch(listRaw, /model-x/);

  const readRaw = await (await shared.client.request(`/api/review/cases/${caseId}`)).text();
  assert.doesNotMatch(readRaw, /secret-origin-alpha/);
  assert.doesNotMatch(readRaw, /model-x/);
  assert.doesNotMatch(readRaw, /required_assertions/);
  assert.doesNotMatch(readRaw, /forbidden_assertions/);
  assert.doesNotMatch(readRaw, /"gold"/);

  const detail = await getCase(shared.client, caseId);
  assert.equal(detail.case.provenance, null);
  assert.equal(detail.case.candidates.length, 2);

  const payload = {
    ...draftPayload({ status: 'submitted' }),
    expectedRevision: 0,
    status: 'submitted',
    decisions: completeDecisions(detail.case),
    preference: 'tie',
    rationale: '两者证据覆盖相近。',
    reasonTags: ['coverage']
  };
  assert.equal((await save(shared.client, caseId, payload)).status, 200);
  const revealed = await getCase(shared.client, caseId);
  assert.ok(revealed.case.provenance);
  const origins = revealed.case.provenance!.map((item) => item.origin);
  assert.ok(origins.includes('secret-origin-alpha'));
  assert.ok(origins.includes('secret-origin-beta'));
});

test('blind mapping is stable across refresh and server restart', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stripsearch-review-restart-'));
  const server = await startTestServer({}, {}, { dataDir, preserveData: true });
  let caseId = '';
  let firstMapping = '';
  let firstHash = '';
  try {
    assert.equal((await server.client.signUp('restart@example.test')).status, 200);
    caseId = await createCase(server.client);
    const first = await getCase(server.client, caseId);
    firstMapping = first.case.candidates[0]!.claims.map((claim) => claim.text).join('|');
    firstHash = first.case.contentHash;

    const refresh = await getCase(server.client, caseId);
    assert.equal(refresh.case.candidates[0]!.claims.map((claim) => claim.text).join('|'), firstMapping);
    assert.equal(refresh.case.contentHash, firstHash);

    const draft = await save(server.client, caseId, {
      ...draftPayload(),
      decisions: [{ claimId: first.case.claimIds[0]!, label: 'supported', evidenceIds: ['S1'], note: '草稿' }],
      rubric: { referenceAnswer: '参考', mustInclude: ['要点'], mustAvoid: [] }
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.acknowledgment, '已保存');
  } finally {
    await server.close();
  }

  const restarted = await startTestServer({}, {}, { dataDir });
  t.after(async () => {
    await restarted.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal((await restarted.client.signIn('restart@example.test')).status, 200);
  const after = await getCase(restarted.client, caseId);
  assert.equal(after.case.candidates[0]!.claims.map((claim) => claim.text).join('|'), firstMapping);
  assert.equal(after.case.contentHash, firstHash);
  assert.equal(after.annotation?.revision, 1);
  assert.equal(after.annotation?.status, 'draft');
  assert.equal(after.annotation?.rubric.mustInclude[0], '要点');
  assert.equal(after.history.length, 1);
});

test('stale expectedRevision is rejected with 409 and revisions append', async () => {
  const caseId = await createCase(shared.client);
  const first = await save(shared.client, caseId, draftPayload());
  assert.equal(first.status, 200);
  assert.equal(first.body.annotation?.revision, 1);

  const stale = await save(shared.client, caseId, draftPayload());
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error?.code, 'stale_revision');

  const second = await save(shared.client, caseId, draftPayload({ expectedRevision: 1 }));
  assert.equal(second.status, 200);
  assert.equal(second.body.annotation?.revision, 2);

  const history = await shared.client.json<{ history: { revision: number }[] }>(
    `/api/review/cases/${caseId}/history`
  );
  assert.deepEqual(history.body.history.map((entry) => entry.revision), [2, 1]);
});

test('annotation validation rejects forged IDs and incomplete submissions', async () => {
  const caseId = await createCase(shared.client);
  const detail = await getCase(shared.client, caseId);
  const claimId = detail.case.claimIds[0]!;

  const forgedEvidence = await save(
    shared.client,
    caseId,
    draftPayload({
      decisions: [{ claimId, label: 'supported', evidenceIds: ['S999'], note: null }]
    })
  );
  assert.equal(forgedEvidence.status, 400);
  assert.equal(forgedEvidence.body.error?.code, 'invalid_annotation');

  const forgedClaim = await save(
    shared.client,
    caseId,
    draftPayload({
      decisions: [{ claimId: 'not-a-claim', label: 'insufficient', evidenceIds: [], note: null }]
    })
  );
  assert.equal(forgedClaim.status, 400);

  const missingEvidence = await save(
    shared.client,
    caseId,
    draftPayload({
      decisions: [{ claimId, label: 'supported', evidenceIds: [], note: null }]
    })
  );
  assert.equal(missingEvidence.status, 400);
  assert.ok(
    missingEvidence.body.error?.details?.issues?.some((issue) => issue.code === 'evidence_required')
  );

  // Draft may stay incomplete.
  const draft = await save(
    shared.client,
    caseId,
    draftPayload({
      decisions: [{ claimId, label: 'insufficient', evidenceIds: [], note: null }]
    })
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.body.annotation?.status, 'draft');

  const incompleteSubmit = await save(
    shared.client,
    caseId,
    draftPayload({
      expectedRevision: 1,
      status: 'submitted',
      decisions: [{ claimId, label: 'insufficient', evidenceIds: [], note: null }]
    })
  );
  assert.equal(incompleteSubmit.status, 400);

  const noPreference = await save(
    shared.client,
    caseId,
    draftPayload({
      expectedRevision: 1,
      status: 'submitted',
      decisions: completeDecisions(detail.case),
      rationale: '有理由'
    })
  );
  assert.equal(noPreference.status, 400);

  const noRationale = await save(
    shared.client,
    caseId,
    draftPayload({
      expectedRevision: 1,
      status: 'submitted',
      decisions: completeDecisions(detail.case),
      preference: 'tie',
      rationale: ''
    })
  );
  assert.equal(noRationale.status, 400);

  const complete = await save(
    shared.client,
    caseId,
    draftPayload({
      expectedRevision: 1,
      status: 'submitted',
      decisions: completeDecisions(detail.case),
      preference: 'tie',
      rationale: '理由完整'
    })
  );
  assert.equal(complete.status, 200);
  assert.equal(complete.body.annotation?.status, 'submitted');
});

test('insights count only submitted latest revisions without double counting', async (t) => {
  const server = await isolatedServer(t);
  const caseId = await createCase(server.client);
  const detail = await getCase(server.client, caseId);
  const claims = detail.case.claimIds;

  const draft = await save(server.client, caseId, {
    ...draftPayload(),
    decisions: claims.map((claimId) => ({ claimId, label: 'supported', evidenceIds: ['S1'], note: null })),
    preference: 'a',
    rationale: '草稿理由',
    reasonTags: ['factuality']
  });
  assert.equal(draft.status, 200);

  const submitted = await save(server.client, caseId, {
    ...draftPayload({ expectedRevision: 1 }),
    status: 'submitted',
    decisions: completeDecisions(detail.case, 'insufficient'),
    preference: 'tie',
    rationale: '提交理由',
    reasonTags: ['coverage', 'uncertainty']
  });
  assert.equal(submitted.status, 200);

  const insights = await server.client.json<{ insights: ReviewInsights }>('/api/review/insights');
  const value = insights.body.insights;
  assert.equal(value.generatedFrom, 'submitted-latest-revisions-only');
  assert.match(value.note, /尚未运行模型对照/);
  assert.equal(value.caseCounts.total, 1);
  assert.equal(value.caseCounts.reviewed, 1);
  assert.equal(value.factualLabels.insufficient, claims.length);
  assert.equal(value.factualLabels.supported, 0);
  assert.equal(value.preferenceCounts.tie, 1);
  assert.equal(value.preferenceCounts.a, 0);
  assert.equal(value.reasonTagCounts.coverage, 1);
  assert.equal(value.reasonTagCounts.factuality, 0);
});

test('deleting a case cascades its private reviews', async () => {
  const caseId = await createCase(shared.client);
  const detail = await getCase(shared.client, caseId);
  const saved = await save(shared.client, caseId, {
    ...draftPayload({ status: 'submitted' }),
    expectedRevision: 0,
    status: 'submitted',
    decisions: completeDecisions(detail.case),
    preference: 'neither',
    rationale: '删除测试'
  });
  assert.equal(saved.status, 200);

  assert.equal((await shared.client.request(`/api/review/cases/${caseId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await shared.client.request(`/api/review/cases/${caseId}`)).status, 404);
  const queue = await shared.client.json<QueueBody>('/api/review/cases');
  assert.equal(queue.body.cases.some((item) => item.caseId === caseId), false);
  assert.equal((await shared.client.request(`/api/review/cases/${caseId}/history`)).status, 404);
});

test('export carries provenance, latest annotation, history and eligibility', async (t) => {
  const server = await isolatedServer(t);
  const submittedId = await createCase(server.client, { title: '已提交案例' });
  const submitted = await getCase(server.client, submittedId);
  await save(server.client, submittedId, draftPayload());
  await save(server.client, submittedId, {
    ...draftPayload({ expectedRevision: 1 }),
    status: 'submitted',
    decisions: completeDecisions(submitted.case, 'insufficient'),
    preference: 'b',
    rationale: '提交记录',
    reasonTags: ['citations'],
    rubric: { referenceAnswer: '应这样回答', mustInclude: ['要点一'], mustAvoid: ['禁止一'] }
  });

  const draftId = await createCase(server.client, { title: '草稿案例' });
  const draftDetail = await getCase(server.client, draftId);
  await save(server.client, draftId, {
    ...draftPayload(),
    decisions: completeDecisions(draftDetail.case)
  });

  const all = await server.client.json<ReviewExportEnvelope>('/api/review/export?format=json&filter=all');
  assert.equal(all.status, 200);
  assert.equal(all.body.schemaVersion, 'stripsearch/annotation-export/v1');
  assert.equal(all.body.filter, 'all');
  assert.equal(all.body.reviewer.humanSingleReview, true);
  assert.match(all.body.reviewer.pseudonymousId, /^rev_/);
  assert.equal(all.body.records.length, 2);

  const submittedRecord = all.body.records.find((record) => record.case.caseId === submittedId);
  assert.ok(submittedRecord);
  assert.equal(submittedRecord.eligibility.accepted, true);
  assert.equal(submittedRecord.case.split, 'discovery');
  assert.equal(submittedRecord.case.contentHash.length, 64);
  assert.equal(submittedRecord.case.provenance.length, 2);
  assert.ok(submittedRecord.case.provenance.some((item) => item.origin === 'secret-origin-alpha'));
  assert.equal(submittedRecord.annotation?.status, 'submitted');
  assert.equal(submittedRecord.annotation?.preference, 'b');
  assert.equal(submittedRecord.history.length, 2);
  assert.deepEqual(submittedRecord.history.map((entry) => entry.revision), [1, 2]);
  assert.equal(submittedRecord.annotation?.rubric.referenceAnswer, '应这样回答');
  assert.equal(submittedRecord.annotation?.caseHash, submittedRecord.case.contentHash);
  // Complete append-only revisions are exported, not just metadata history.
  assert.equal(submittedRecord.revisions.length, 2);
  assert.equal(submittedRecord.revisions[0]?.status, 'draft');
  assert.equal(submittedRecord.revisions[1]?.status, 'submitted');
  assert.ok(Array.isArray(submittedRecord.revisions[0]?.decisions));
  assert.equal(submittedRecord.revisions[0]?.rubric.referenceAnswer, '');
  // The exported hash payload reproduces contentHash without guessing order.
  assert.equal(submittedRecord.case.hash.algorithm, 'sha256');
  assert.equal(
    independentHash(submittedRecord.case.hash.payload),
    submittedRecord.case.contentHash
  );

  const draftRecord = all.body.records.find((record) => record.case.caseId === draftId);
  assert.ok(draftRecord);
  assert.equal(draftRecord.eligibility.accepted, false);
  assert.match(draftRecord.eligibility.reason, /不得作为已接受标签/);

  const reviewedOnly = await server.client.json<ReviewExportEnvelope>(
    '/api/review/export?format=json&filter=reviewed'
  );
  assert.equal(reviewedOnly.body.records.length, 1);
  assert.equal(reviewedOnly.body.records[0]!.case.caseId, submittedId);

  const rawJsonl = await (await server.client.request('/api/review/export?format=jsonl&filter=all')).text();
  const lines = rawJsonl.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line) as ReviewExportRecord;
    assert.ok(parsed.case.caseId);
    assert.ok(parsed.reviewer.pseudonymousId);
  }
});

test('case creation validates required fields and bounds', async () => {
  const noSources = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({ sources: [] })
  });
  assert.equal(noSources.status, 400);

  const oneCandidate = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({ candidates: [{ response: '只有一条' }] })
  });
  assert.equal(oneCandidate.status, 400);

  const emptyCandidate = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({ candidates: [{ response: '有内容' }, { response: '  ' }] })
  });
  assert.equal(emptyCandidate.status, 400);

  const tooManyClaims = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({
      candidates: [
        { response: Array.from({ length: 13 }, (_, index) => `论断 ${index}`).join('\n') },
        { response: '一条' }
      ]
    })
  });
  assert.equal(tooManyClaims.status, 400);
});

test('draft save restores on reload and does not pre-label new cases', async () => {
  const queue = await shared.client.json<QueueBody>('/api/review/cases');
  const practice = queue.body.cases.filter((item) => item.kind === 'practice');
  assert.ok(practice.length > 0);
  const caseId = practice[0]!.caseId;
  const detail = await getCase(shared.client, caseId);

  assert.equal(detail.annotation, null);
  assert.equal(detail.case.status, 'unreviewed');
  assert.ok(detail.case.claimIds.length > 0);

  const saved = await save(shared.client, caseId, {
    ...draftPayload(),
    decisions: [{ claimId: detail.case.claimIds[0]!, label: 'contradicted', evidenceIds: ['S1'], note: '半完成' }],
    preference: 'a',
    reasonTags: ['counterevidence']
  });
  assert.equal(saved.status, 200);

  const reloaded = await getCase(shared.client, caseId);
  assert.equal(reloaded.annotation?.status, 'draft');
  assert.equal(reloaded.case.status, 'draft');
  const first = reloaded.annotation?.decisions.find((item) => item.claimId === detail.case.claimIds[0]);
  assert.equal(first?.label, 'contradicted');
  assert.deepEqual(first?.evidenceIds, ['S1']);
  // Unjudged claims are not stored as pre-labeled values.
  assert.equal(reloaded.annotation?.decisions.length, 1);
  assert.ok(reloaded.case.claimIds.length > (reloaded.annotation?.decisions.length ?? 0));
});

test('owner-scoped pseudonym is derived and body identity is ignored', async () => {
  const caseId = await createCase(shared.client);
  const detail = await getCase(shared.client, caseId);
  const saved = await save(shared.client, caseId, {
    ...draftPayload(),
    decisions: completeDecisions(detail.case),
    preference: 'tie',
    rationale: '身份测试',
    actorId: 'forged-reviewer',
    ownerId: 'forged-owner'
  });
  assert.equal(saved.status, 200);
  const pseudonym = saved.body.annotation?.actorPseudonymousId ?? '';
  assert.match(pseudonym, /^rev_[0-9a-f]{16}$/);
  assert.notEqual(pseudonym, 'forged-reviewer');

  const history = await shared.client.json<{ revisions: { actorPseudonymousId: string }[] }>(
    `/api/review/cases/${caseId}/history`
  );
  assert.equal(history.body.revisions[0]?.actorPseudonymousId, pseudonym);
});

test('sources are assigned bounded stable IDs and candidate order is persisted', async () => {
  const caseId = await createCase(shared.client);
  const detail = await getCase(shared.client, caseId);
  const ids = detail.case.sources.map((source: ReviewSource) => source.sourceId);
  assert.deepEqual(ids, ['S1', 'S2']);
  assert.equal(detail.case.claimIds.length, 3);
  assert.equal(new Set(detail.case.claimIds).size, 3);
  const firstRead = JSON.stringify(detail.case.candidates);
  const secondRead = JSON.stringify((await getCase(shared.client, caseId)).case.candidates);
  assert.equal(firstRead, secondRead);
});

test('prototype keys and wrong typed values are rejected, not coerced', async () => {
  const caseId = await createCase(shared.client);
  const detail = await getCase(shared.client, caseId);

  const prototypeLabel = await save(shared.client, caseId, draftPayload({
    decisions: [{ claimId: detail.case.claimIds[0]!, label: 'toString', evidenceIds: [], note: null }]
  }));
  assert.equal(prototypeLabel.status, 400);
  assert.equal(prototypeLabel.body.error?.code, 'invalid_annotation');

  const prototypePreference = await save(shared.client, caseId, draftPayload({ preference: 'constructor' }));
  assert.equal(prototypePreference.status, 400);

  const prototypeTag = await save(shared.client, caseId, draftPayload({ reasonTags: ['constructor'] }));
  assert.equal(prototypeTag.status, 400);

  const prototypeHasOwnProperty = await save(shared.client, caseId, draftPayload({ reasonTags: ['hasOwnProperty'] }));
  assert.equal(prototypeHasOwnProperty.status, 400);

  const mixedEvidence = await save(shared.client, caseId, draftPayload({
    decisions: [{ claimId: detail.case.claimIds[0]!, label: 'insufficient', evidenceIds: ['S1', 42], note: null }]
  }));
  assert.equal(mixedEvidence.status, 400);
  assert.match(mixedEvidence.body.error?.message ?? '', /evidenceIds/);

  const objectLabel = await save(shared.client, caseId, draftPayload({
    decisions: [{ claimId: detail.case.claimIds[0]!, label: { toString: 'supported' }, evidenceIds: [], note: null }]
  }));
  assert.equal(objectLabel.status, 400);
});

test('expectedRevision requires a non-negative safe integer number', async () => {
  const caseId = await createCase(shared.client);
  for (const value of [null, '0', true, 1.5, -1, Number.MAX_SAFE_INTEGER + 2, undefined] as const) {
    const result = await save(shared.client, caseId, draftPayload({ expectedRevision: value }));
    assert.equal(result.status, 400, `expectedRevision ${String(value)} must be rejected`);
    assert.equal(result.body.error?.code, 'invalid_annotation');
  }
  const zero = await save(shared.client, caseId, draftPayload({ expectedRevision: 0 }));
  assert.equal(zero.status, 200);
});

test('overlong text and oversized rubric lists are rejected, not truncated', async () => {
  const caseId = await createCase(shared.client);

  const longRationale = await save(shared.client, caseId, draftPayload({
    rationale: 'x'.repeat(1300)
  }));
  assert.equal(longRationale.status, 400);
  assert.match(longRationale.body.error?.message ?? '', /判断理由/);

  const longReference = await save(shared.client, caseId, draftPayload({
    rubric: { referenceAnswer: 'y'.repeat(2100), mustInclude: [], mustAvoid: [] }
  }));
  assert.equal(longReference.status, 400);
  assert.match(longReference.body.error?.message ?? '', /参考答案/);

  const tooManyInclude = await save(shared.client, caseId, draftPayload({
    rubric: { referenceAnswer: '', mustInclude: Array.from({ length: 21 }, (_, index) => `项 ${index}`), mustAvoid: [] }
  }));
  assert.equal(tooManyInclude.status, 400);
  assert.match(tooManyInclude.body.error?.message ?? '', /必须包含/);

  const longNote = await save(shared.client, caseId, draftPayload({
    decisions: [{ claimId: (await getCase(shared.client, caseId)).case.claimIds[0]!, label: 'insufficient', evidenceIds: [], note: 'z'.repeat(700) }]
  }));
  assert.equal(longNote.status, 400);

  const longTitle = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({ title: 't'.repeat(200) })
  });
  assert.equal(longTitle.status, 400);

  const partialSource = await shared.client.json<Record<string, unknown>>('/api/review/cases', {
    method: 'POST',
    json: caseInput({
      sources: [{ title: '只有标题', text: '' }, { title: '完整', text: '正文' }]
    })
  });
  assert.equal(partialSource.status, 400);
  assert.match((partialSource.body.error as { message?: string } | undefined)?.message ?? '', /不完整/);
});

test('export keeps more than 50 revisions complete and the hash is reproducible', async (t) => {
  const server = await isolatedServer(t);
  const caseId = await createCase(server.client, { title: '长历史案例' });
  const detail = await getCase(server.client, caseId);
  const claimId = detail.case.claimIds[0]!;

  for (let revision = 0; revision < 55; revision += 1) {
    const result = await save(server.client, caseId, draftPayload({
      expectedRevision: revision,
      decisions: [{ claimId, label: 'insufficient', evidenceIds: [], note: `note-${revision + 1}` }]
    }));
    assert.equal(result.status, 200, `revision ${revision + 1} must save`);
  }

  const history = await server.client.json<{ revisions: unknown[] }>(
    `/api/review/cases/${caseId}/history`
  );
  assert.equal(history.body.revisions.length, 55);

  const exported = await server.client.json<ReviewExportEnvelope>(
    '/api/review/export?format=json&filter=all'
  );
  assert.equal(exported.body.records.length, 1);
  const record = exported.body.records[0]!;
  assert.equal(record.revisions.length, 55);
  assert.equal(record.history.length, 55);
  assert.equal(record.revisions[0]?.decisions[0]?.note, 'note-1');
  assert.equal(record.revisions[54]?.decisions[0]?.note, 'note-55');
  assert.equal(record.annotation?.revision, 55);
  assert.equal(record.annotation?.caseHash, record.case.contentHash);
  assert.equal(independentHash(record.case.hash.payload), record.case.contentHash);
  assert.equal(record.case.hash.contentHash, record.case.contentHash);
});

test('seed respects the per-owner case cap instead of silently overfilling', async (t) => {
  const server = await isolatedServer(t);
  const session = await server.client.json<{ user: { id: string } }>('/api/auth/get-session');
  const ownerId = session.body.user.id;
  const sources: ReviewSource[] = [{ sourceId: 'S1', title: 't', text: 'x', locator: null }];
  const candidateSet = buildUserContent(sources, [
    { origin: null, model: null, notes: null, claims: ['a'] },
    { origin: null, model: null, notes: null, claims: ['b'] }
  ]);
  for (let index = 0; index < 195; index += 1) {
    server.boot.reviewStore.insertCase({
      ownerId,
      seedKey: null,
      datasetVersion: 'user-authored-v1',
      kind: 'user',
      title: `填充 ${index}`,
      question: '填充问题？',
      asOf: null,
      badge: '',
      sources,
      candidateSet
    });
  }
  const result = server.boot.reviewStore.seedForOwner(ownerId, PRACTICE_CASES, 'badge');
  assert.equal(result.inserted, 5);
  assert.equal(result.capped, true);
  assert.equal(server.boot.reviewStore.countCasesForOwner(ownerId), 200);
});
