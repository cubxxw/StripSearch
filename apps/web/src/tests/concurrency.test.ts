import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory, deferred } from './fakes.js';
import { startTestServer, TestClient, waitFor } from './harness.js';

async function signUpUser(server: Awaited<ReturnType<typeof startTestServer>>, email: string): Promise<TestClient> {
  const client = new TestClient(server.baseUrl, server.origin);
  const response = await client.signUp(email);
  assert.equal(response.status, 200);
  return client;
}

test('global concurrency is bounded at 3 and per-user concurrency is 1', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });

  const clients: TestClient[] = [];
  for (let index = 0; index < 5; index += 1) {
    clients.push(await signUpUser(server, `concurrency-${index}@example.test`));
  }
  const runIds: string[] = [];
  for (const [index, client] of clients.entries()) {
    const created = await client.json<{ run: { runId: string } }>('/api/runs', {
      method: 'POST',
      json: {
        question: `并发测试问题 ${index}`,
        seedUrl: `https://github.com/example${index}`,
        provider: 'github'
      }
    });
    assert.equal(created.status, 201);
    runIds.push(created.body.run.runId);
  }

  await waitFor(() => server.store.countByState('researching') === 3);
  assert.equal(server.store.countByState('researching'), 3);
  assert.equal(server.store.countByState('queued'), 2);

  // One user cannot occupy a second slot while their first run is active.
  const created = await clients[0]!.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '同一个用户的第二个问题', seedUrl: 'https://github.com/example0', provider: 'github' }
  });
  assert.equal(created.status, 201);
  const secondRunId = created.body.run.runId;
  assert.equal(server.store.getRun(secondRunId)?.state, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(server.store.getRun(secondRunId)?.state, 'queued');
  assert.ok(server.store.countByState('researching') <= 3);

  gate.resolve();
  await waitFor(
    () => [...runIds, secondRunId].every((id) => server.store.getRun(id)?.state === 'completed'),
    8000
  );
});

test('start rate limit returns 429 after the window quota', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });
  const client = await signUpUser(server, 'rate@example.test');

  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    const response = await client.json('/api/runs', {
      method: 'POST',
      json: {
        question: `限流测试问题 ${index}`,
        seedUrl: `https://github.com/rate${index}`,
        provider: 'github'
      }
    });
    statuses.push(response.status);
  }
  assert.equal(statuses.filter((status) => status === 201).length, 10);
  assert.equal(statuses[10], 429);
});
