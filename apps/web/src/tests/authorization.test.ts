import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory, deferred } from './fakes.js';
import { startTestServer, TestClient, waitFor } from './harness.js';
import type { RequestOptions } from './harness.js';

test('cross-account isolation, unauthenticated 401 and Origin 403', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });

  const userA = server.client;
  const userB = new TestClient(server.baseUrl, server.origin);
  assert.equal((await userA.signUp('a@example.test')).status, 200);
  assert.equal((await userB.signUp('b@example.test')).status, 200);

  const created = await userA.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: 'example 做过什么？', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  assert.equal(created.status, 201);
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'researching');

  // The owner can read the run.
  assert.equal((await userA.json(`/api/runs/${runId}`)).status, 200);

  const list = await userB.json<{ runs: unknown[] }>('/api/runs');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.runs, []);

  const otherRoutes: [string, RequestOptions][] = [
    [`/api/runs/${runId}`, { method: 'GET' }],
    [`/api/runs/${runId}/export?format=markdown`, { method: 'GET' }],
    [`/api/runs/${runId}/cancel`, { method: 'POST', body: '{}' }],
    [`/api/runs/${runId}/sources/S1/exclude`, { method: 'POST', body: '{"expectedRevision":1}' }],
    [`/api/runs/${runId}/retry`, { method: 'POST', body: '{}' }],
    [`/api/runs/${runId}/followup`, { method: 'POST', body: '{"question":"继续追问一下"}' }],
    [`/api/runs/${runId}`, { method: 'DELETE' }]
  ];
  for (const [path, init] of otherRoutes) {
    const response = await userB.request(path, init);
    assert.equal(response.status, 404, `${init.method} ${path} must hide other owners' runs`);
  }

  // SSE must also be owner-scoped before any stream is opened.
  const sse = await userB.request(`/api/runs/${runId}/events`);
  assert.equal(sse.status, 404);

  // Unauthenticated requests are rejected.
  const anonymous = new TestClient(server.baseUrl, server.origin);
  assert.equal((await anonymous.request('/api/runs')).status, 401);
  assert.equal(
    (
      await anonymous.request('/api/runs', {
        method: 'POST',
        json: { question: '匿名请求测试', seedUrl: 'https://github.com/example', provider: 'github' }
      })
    ).status,
    401
  );

  // Origin must match exactly; missing or foreign origins are 403.
  const noOrigin = await userA.request('/api/runs', {
    method: 'POST',
    origin: null,
    json: { question: '没有来源头的请求', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  assert.equal(noOrigin.status, 403);

  const foreign = await userA.request('/api/runs', {
    method: 'POST',
    origin: 'http://evil.test',
    json: { question: '跨站请求测试', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  assert.equal(foreign.status, 403);

  gate.resolve();
});
