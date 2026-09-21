import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeFactory } from './fakes.js';
import { startTestServer, waitFor } from './harness.js';

interface Snapshot {
  run: {
    runId: string;
    revision: number;
    reviewCount: number;
    sources: { sourceKey: string; url: string; excluded: boolean }[];
    answer: { id: string; bullets: { text: string; sourceKeys: string[]; validity: string; reviewReason: string | null }[] }[];
  };
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  await server.client.signUp('revision@example.test');
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', {
    method: 'POST',
    json: { question: '撤回测试问题', seedUrl: 'https://github.com/example', provider: 'github' }
  });
  const runId = created.body.run.runId;
  await waitFor(() => server.store.getRun(runId)?.state === 'completed');
  const snapshot = await server.client.json<Snapshot>(`/api/runs/${runId}`);
  return { server, runId, snapshot: snapshot.body };
}

test('excluding a source invalidates dependent evidence and keeps export in sync', async (t) => {
  const { server, runId, snapshot } = await setup(t);
  assert.equal(snapshot.run.reviewCount, 0);
  const revision = snapshot.run.revision;

  const excluded = await server.client.json<Snapshot>(`/api/runs/${runId}/sources/S2/exclude`, {
    method: 'POST',
    json: { expectedRevision: revision }
  });
  assert.equal(excluded.status, 200);
  assert.equal(excluded.body.run.sources.find((source) => source.sourceKey === 'S2')?.excluded, true);
  const worksBullets = excluded.body.run.answer.find((section) => section.id === 'works')?.bullets ?? [];
  assert.ok(worksBullets.length > 0);
  assert.ok(worksBullets.every((bullet) => bullet.validity === 'review'));
  assert.equal(worksBullets[0]?.reviewReason, 'S2 已撤下');
  assert.ok(excluded.body.run.reviewCount > 0);

  // The identity section only depends on S1 and stays valid.
  const identityBullets = excluded.body.run.answer.find((section) => section.id === 'identity')?.bullets ?? [];
  assert.ok(identityBullets.every((bullet) => bullet.validity === 'valid'));

  // A stale expected revision is rejected.
  const stale = await server.client.json<{ error: { code: string } }>(`/api/runs/${runId}/sources/S2/restore`, {
    method: 'POST',
    json: { expectedRevision: revision }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_revision');

  // Markdown and JSON exports come from the same invalidated view.
  const markdown = await server.client.request(`/api/runs/${runId}/export?format=markdown`);
  const markdownText = await markdown.text();
  assert.match(markdownText, /\[待复核 · S2 已撤下\]/);
  assert.ok(markdownText.includes('https://github.com/example/repo'));

  const json = await server.client.request(`/api/runs/${runId}/export?format=json`);
  const jsonView = JSON.parse(await json.text()) as Snapshot['run'];
  const jsonWorks = jsonView.answer.find((section) => section.id === 'works')?.bullets ?? [];
  assert.ok(jsonWorks.every((bullet) => bullet.validity === 'review'));
  assert.equal(jsonView.reviewCount, excluded.body.run.reviewCount);
  assert.deepEqual(
    jsonView.sources.map((source) => source.url).sort(),
    excluded.body.run.sources.map((source) => source.url).sort()
  );

  // Restoring with the current revision recovers the original validity.
  const restored = await server.client.json<Snapshot>(`/api/runs/${runId}/sources/S2/restore`, {
    method: 'POST',
    json: { expectedRevision: excluded.body.run.revision }
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.run.reviewCount, 0);
  const restoredWorks = restored.body.run.answer.find((section) => section.id === 'works')?.bullets ?? [];
  assert.ok(restoredWorks.every((bullet) => bullet.validity === 'valid'));

  const missing = await server.client.json<{ error: { code: string } }>(`/api/runs/${runId}/sources/S9/exclude`, {
    method: 'POST',
    json: { expectedRevision: restored.body.run.revision }
  });
  assert.equal(missing.status, 404);
});
