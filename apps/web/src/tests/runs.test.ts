import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProvider, createFakeFactory } from './fakes.js';
import type { ProviderName } from '../shared/types.js';
import { startTestServer, waitFor } from './harness.js';

const githubBody = {
  question: 'example 的公开作品有哪些？',
  seedUrl: 'https://github.com/example',
  provider: 'github'
};

test('request validation, scope rejection and provider availability', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('runs@example.test');

  const tooLong = await server.client.json<{ error: { code: string } }>('/api/runs', {
    method: 'POST',
    json: { question: 'x'.repeat(600), seedUrl: 'https://github.com/example', provider: 'github' }
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'invalid_question');

  const badSeed = await server.client.json<{ error: { code: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '研究问题合法', seedUrl: 'javascript:alert(1)', provider: 'github' }
  });
  assert.equal(badSeed.status, 400);
  assert.equal(badSeed.body.error.code, 'invalid_seed_url');

  const disallowed = await server.client.json<{ error: { code: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '查一下他的家庭住址和手机号', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  assert.equal(disallowed.status, 422);
  assert.equal(disallowed.body.error.code, 'scope_disallowed');

  const exa = await server.client.json<{ error: { code: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '研究问题合法', seedUrl: null, provider: 'exa' }
  });
  assert.equal(exa.status, 409);
  assert.equal(exa.body.error.code, 'provider_unavailable');
});

test('idempotency uses the key only: same key+body is stable, new keys create new runs', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('idem@example.test');

  const first = await server.client.json<{ run: { runId: string }; idempotent: boolean }>('/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'key-1' },
    json: githubBody
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.idempotent, false);

  const replay = await server.client.json<{ run: { runId: string }; idempotent: boolean }>('/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'key-1' },
    json: githubBody
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.run.runId, first.body.run.runId);

  // A fresh key with the same input is an explicit NEW run.
  const freshKey = await server.client.json<{ run: { runId: string }; idempotent: boolean }>('/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'key-2' },
    json: githubBody
  });
  assert.equal(freshKey.status, 201);
  assert.equal(freshKey.body.idempotent, false);
  assert.notEqual(freshKey.body.run.runId, first.body.run.runId);

  // No key at all also means a new run.
  const noKey = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: githubBody
  });
  assert.equal(noKey.status, 201);
  assert.notEqual(noKey.body.run.runId, first.body.run.runId);

  // Re-using a key with a different input is a conflict.
  const conflict = await server.client.json<{ error: { code: string } }>('/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'key-1' },
    json: { ...githubBody, question: '另一个完全不同的问题' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

test('retry is repeatable without duplicates when the key is replayed', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('retry@example.test');

  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: githubBody
  });
  const parentId = created.body.run.runId;
  await waitFor(() => server.store.getRun(parentId)?.state === 'completed');

  const firstRetry = await server.client.json<{ run: { runId: string; retryOf: string | null } }>(
    `/api/runs/${parentId}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'retry-1' }, json: {} }
  );
  assert.equal(firstRetry.status, 201);
  assert.equal(firstRetry.body.run.retryOf, parentId);

  const replay = await server.client.json<{ run: { runId: string } }>(`/api/runs/${parentId}/retry`, {
    method: 'POST',
    headers: { 'idempotency-key': 'retry-1' },
    json: {}
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.run.runId, firstRetry.body.run.runId);

  // A second explicit retry with a new key is allowed and creates another run.
  const second = await server.client.json<{ run: { runId: string } }>(`/api/runs/${parentId}/retry`, {
    method: 'POST',
    headers: { 'idempotency-key': 'retry-2' },
    json: {}
  });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.run.runId, firstRetry.body.run.runId);
});

test('followup is bound to Exa and creates a linked child', async (t) => {
  const githubServer = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => githubServer.close());
  await githubServer.client.signUp('followup-github@example.test');
  const githubRun = await githubServer.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: githubBody
  });
  const githubFollowup = await githubServer.client.json<{ error: { code: string } }>(
    `/api/runs/${githubRun.body.run.runId}/followup`,
    { method: 'POST', json: { question: '他的公开资料里还有哪些项目？' } }
  );
  assert.equal(githubFollowup.status, 409);
  assert.equal(githubFollowup.body.error.code, 'followup_requires_exa');

  const exaServer = await startTestServer(
    { providerFactory: (name: ProviderName) => createFakeProvider({ name }) },
    { EXA_API_KEY: 'test-key' }
  );
  t.after(() => exaServer.close());
  await exaServer.client.signUp('followup-exa@example.test');
  const exaRun = await exaServer.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '网页检索示例问题', seedUrl: null, provider: 'exa' }
  });
  const parentId = exaRun.body.run.runId;
  await waitFor(() => exaServer.store.getRun(parentId)?.state === 'completed');

  const child = await exaServer.client.json<{ run: { runId: string; parentRunId: string | null } }>(
    `/api/runs/${parentId}/followup`,
    { method: 'POST', headers: { 'idempotency-key': 'follow-1' }, json: { question: '还有哪些公开项目？' } }
  );
  assert.equal(child.status, 201);
  assert.equal(child.body.run.parentRunId, parentId);
  assert.notEqual(child.body.run.runId, parentId);
});


test('replaying a deleted idempotent run never starts a new provider call', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('deleted-idem@example.test');
  const options = { method: 'POST', headers: { 'idempotency-key': 'deleted-1' }, json: githubBody };
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', options);
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'completed');
  assert.equal((await server.client.request(`/api/runs/${runId}`, { method: 'DELETE' })).status, 204);
  const replay = await server.client.json<{ error: { code: string } }>('/api/runs', options);
  assert.equal(replay.status, 410);
  assert.equal(replay.body.error.code, 'run_deleted');
  const history = await server.client.json<{ runs: unknown[] }>('/api/runs');
  assert.deepEqual(history.body.runs, []);
});
