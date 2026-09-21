import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer } from './harness.js';

test('root serves the current index from a hidden checkout directory', async (t) => {
  const clientDir = mkdtempSync(path.join(tmpdir(), '.stripsearch-client-'));
  writeFileSync(path.join(clientDir, 'index.html'), '<main>first build</main>');
  const server = await startTestServer({ clientDir });
  t.after(async () => { await server.close(); rmSync(clientDir, { recursive: true }); });
  const first = await fetch(server.baseUrl);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /first build/);
  writeFileSync(path.join(clientDir, 'index.html'), '<main>next build</main>');
  assert.match(await (await fetch(server.baseUrl)).text(), /next build/);
});

test('closed native drawers have an explicit author-level display rule', () => {
  const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');
  // jsdom UA cascade cannot reproduce Safari display:flex overriding native dialog hiding.
  assert.match(css, /dialog:not\(\[open\]\)\s*\{\s*display:\s*none;/);
});
