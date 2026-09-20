import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory, deferred } from './fakes.js';
import { startTestServer, waitFor } from './harness.js';

test('SSE streams persistent ordered events and closes with done', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('sse@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: 'SSE 测试问题', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'completed');

  const response = await server.client.request(`/api/runs/${runId}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /event: stage/);
  assert.match(text, /event: source/);
  assert.match(text, /event: answer/);
  assert.match(text, /event: done/);

  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(ids.length > 3);
  for (let index = 1; index < ids.length; index += 1) {
    assert.ok((ids[index] ?? 0) > (ids[index - 1] ?? 0), 'event ids must be ordered');
  }

  // Reconnecting with ?after only replays newer events.
  const midpoint = ids[Math.floor(ids.length / 2)] ?? 0;
  const replay = await server.client.request(`/api/runs/${runId}/events?after=${midpoint}`);
  const replayText = await replay.text();
  const replayIds = [...replayText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(replayIds.length > 0);
  assert.ok(replayIds.every((id) => id > midpoint));
});

test('a revoked session closes the live event stream', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });
  await server.client.signUp('revoke@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '流式会话测试', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'researching');

  const streamPromise = server.client.request(`/api/runs/${runId}/events`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await server.client.signOut();
  server.store.addEvent(runId, 'state', { marker: 'AFTER_REVOCATION_MUST_NOT_STREAM' });

  const response = await streamPromise;
  const text = await response.text();
  assert.match(text, /event: done/);
  assert.match(text, /revoked/);
  assert.doesNotMatch(text, /AFTER_REVOCATION_MUST_NOT_STREAM/);
});
