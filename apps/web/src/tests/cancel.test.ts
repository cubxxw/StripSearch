import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory, deferred } from './fakes.js';
import { startTestServer, waitFor } from './harness.js';

test('cancel wins over a late provider result', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });
  await server.client.signUp('cancel@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '取消测试问题', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'researching');
  await waitFor(() => server.store.listSources(runId).length === 1);

  const cancelled = await server.client.json<{ run: { state: string } }>(`/api/runs/${runId}/cancel`, {
    method: 'POST',
    json: {}
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.state, 'cancelled');

  // Late provider writes must not overwrite the cancelled run.
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = server.store.getRun(runId);
  assert.equal(after?.state, 'cancelled');
  assert.equal(server.store.listSources(runId).length, 1);
  assert.equal(server.store.getRun(runId)?.answer.length, 0);

  // Cancel is idempotent.
  const again = await server.client.json<{ run: { state: string } }>(`/api/runs/${runId}/cancel`, {
    method: 'POST',
    json: {}
  });
  assert.equal(again.body.run.state, 'cancelled');
});

test('deleted runs cannot be revived by a late provider result', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });
  await server.client.signUp('delete@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '删除测试问题', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'researching');

  const deleted = await server.client.request(`/api/runs/${runId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  gate.resolve();
  await waitFor(() => !server.boot.runner.isRunning(runId));
  assert.equal(server.store.getRun(runId), null);
  const snapshot = await server.client.json(`/api/runs/${runId}`);
  assert.equal(snapshot.status, 404);
});
