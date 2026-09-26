import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createFakeFactory, sampleResult } from './fakes.js';
import { startTestServer, waitFor } from './harness.js';
import { renderReportHtml } from '../shared/report-html.js';
import { chromiumExecutable, renderReportPdf } from '../server/services/pdf.js';
import type { CanonicalView } from '../shared/types.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: { document: Document } } };

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const result = sampleResult();
  result.identity.displayName = '<img src="https://evil.invalid/a" onerror="alert(1)">研究者';
  result.sources[0]!.excerpt = '<script>fetch("https://evil.invalid")</script>公开资料';
  const server = await startTestServer({ providerFactory: createFakeFactory({ result }) });
  t.after(() => server.close());
  await server.client.signUp('report-export@example.test');
  const created = await server.client.json<{ run: CanonicalView }>('/api/runs', { json: { question: '研究合成账号', seedUrl: 'https://github.com/example', provider: 'github' } });
  const id = created.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'completed');
  return { server, id, view: server.store.buildCanonicalView(server.store.getRun(id)!) };
}

test('standalone HTML escapes source text and preserves report revision and evidence links', async t => {
  const { server, id, view } = await setup(t);
  const response = await server.client.request(`/api/runs/${id}/export?format=html&revision=${view.revision}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/html/);
  assert.equal(response.headers.get('x-report-revision'), String(view.revision));
  const document = new JSDOM(await response.text()).window.document;
  assert.equal(document.querySelectorAll('script,img,iframe,link').length, 0);
  assert.ok(document.body.textContent?.includes(view.identity.displayName));
  assert.ok(document.querySelector('#source-S1'));
  assert.equal(document.querySelector('a[href="#source-S2"]')?.textContent, '[S2]');
  assert.ok(document.querySelector('meta[http-equiv="Content-Security-Policy"]'));
});

test('export rejects stale revisions and withdrawn source claims remain marked for review', async t => {
  const { server, id, view } = await setup(t);
  const excluded = await server.client.json<{ run: CanonicalView }>(`/api/runs/${id}/sources/S2/exclude`, { json: { expectedRevision: view.revision } });
  assert.equal(excluded.status, 200);
  assert.equal((await server.client.request(`/api/runs/${id}/export?format=html&revision=${view.revision}`)).status, 409);
  const response = await server.client.request(`/api/runs/${id}/export?format=html&revision=${excluded.body.run.revision}`);
  const document = new JSDOM(await response.text()).window.document;
  assert.ok(document.querySelectorAll('.review').length > 0);
  assert.match(document.querySelector('#source-S2')?.textContent ?? '', /已撤下/);
  assert.equal((await server.client.request(`/api/runs/${id}/export?format=javascript`)).status, 400);
});

test('missing PDF renderer is a typed error, never an HTML file with a PDF name', async () => {
  const prior = process.env.CHROMIUM_EXECUTABLE_PATH;
  process.env.CHROMIUM_EXECUTABLE_PATH = '/nonexistent/stripsearch-chromium';
  try { await assert.rejects(renderReportPdf('<html></html>'), error => (error as { code?: string }).code === 'pdf_unavailable'); }
  finally { if (prior === undefined) delete process.env.CHROMIUM_EXECUTABLE_PATH; else process.env.CHROMIUM_EXECUTABLE_PATH = prior; }
});

test('available local Chromium produces a binary PDF from the same escaped snapshot', { skip: !chromiumExecutable() }, async t => {
  const { view } = await setup(t);
  const bytes = await renderReportPdf(renderReportHtml(view));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.byteLength > 1000);
});

test('PDF rejects evidence changes during rendering even when the run revision is unchanged', { skip: !chromiumExecutable() }, async t => {
  const { server, id, view } = await setup(t);
  const original = server.store.buildCanonicalView.bind(server.store);
  let armed = true;
  server.store.buildCanonicalView = run => {
    const snapshot = original(run);
    if (run.id === id && armed) {
      armed = false;
      // Inherited-source revocation can change a child snapshot without updating its own row.
      setTimeout(() => server.store.setSourceExcluded(id, 'S2', true), 0);
    }
    return snapshot;
  };
  const response = await server.client.request(`/api/runs/${id}/export?format=pdf&revision=${view.revision}`);
  assert.equal(server.store.getRun(id)?.revision, view.revision);
  assert.equal(response.status, 409);
});
