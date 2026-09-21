import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory, deferred } from './fakes.js';
import { startTestServer, waitFor } from './harness.js';
import { Store } from '../server/store.js';

test('unfinished runs are retained as partial and marked interrupted after restart', async (t) => {
  const gate = deferred();
  const server = await startTestServer({ providerFactory: createFakeFactory({ hold: gate.promise }) });
  t.after(async () => {
    gate.resolve();
    await server.close();
  });
  await server.client.signUp('restart@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '重启测试问题', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'researching');
  await waitFor(() => server.store.listSources(runId).length === 1);
  const sourcesBefore = server.store.listSources(runId);

  // Simulate a process restart: a new Store over the same database recovers
  // unfinished work as partial without re-running paid provider calls.
  const restarted = new Store(server.boot.db);
  const recovered = restarted.recoverInterruptedRuns();
  assert.equal(recovered, 1);
  const afterRestart = restarted.getRun(runId);
  assert.equal(afterRestart?.state, 'partial');
  assert.equal(afterRestart?.interrupted, true);
  assert.equal(afterRestart?.errorCode, 'interrupted');
  assert.equal(restarted.listSources(runId).length, sourcesBefore.length);

  const eventTypes = restarted.listEvents(runId).map((event) => event.type);
  assert.ok(eventTypes.includes('interrupted'));

  // Idempotent recovery: a second pass changes nothing.
  assert.equal(restarted.recoverInterruptedRuns(), 0);

  // A late provider result still cannot overwrite the recovered partial run.
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const stillPartial = restarted.getRun(runId);
  assert.equal(stillPartial?.state, 'partial');
  assert.equal(restarted.listSources(runId).length, sourcesBefore.length);

  const snapshot = await server.client.json<{
    run: { state: string; interrupted: boolean; reviewCount: number };
    events: { type: string }[];
  }>(`/api/runs/${runId}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.run.state, 'partial');
  assert.equal(snapshot.body.run.interrupted, true);
  assert.ok(snapshot.body.events.some((event) => event.type === 'interrupted'));
});
