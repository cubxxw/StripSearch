import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'stripsearch-config-'));
}

test('config rejects non-loopback hosts and origins', () => {
  assert.throws(
    () => loadConfig({ STRIPSEARCH_HOST: '0.0.0.0', STRIPSEARCH_DATA_DIR: tempDir() }),
    /loopback/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        STRIPSEARCH_PUBLIC_ORIGIN: 'https://example.com'
      }),
    /http on loopback|loopback/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://localhost:4392/path'
      }),
    /without path/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://user:pass@localhost:4392'
      }),
    /credentials/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://localhost:4393'
      }),
    /port must match/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'https://localhost:4392'
      }),
    /http on loopback/
  );
  assert.throws(
    () => loadConfig({ STRIPSEARCH_DATA_DIR: tempDir(), PORT: '70000' }),
    /PORT/
  );
});

test('a local secret is generated once with mode 0600 and never defaults', () => {
  const dir = tempDir();
  try {
    const first = loadConfig({ STRIPSEARCH_DATA_DIR: dir, PORT: '4390' });
    assert.equal(first.authSecretSource, 'file');
    assert.ok(first.authSecret.length >= 32);
    const secretPath = path.join(dir, 'auth-secret');
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);

    const second = loadConfig({ STRIPSEARCH_DATA_DIR: dir, PORT: '4390' });
    assert.equal(second.authSecret, first.authSecret);
    assert.notEqual(first.authSecret, 'better-auth-secret-123456789');

    const withEnv = loadConfig({
      STRIPSEARCH_DATA_DIR: dir,
      BETTER_AUTH_SECRET: 'x'.repeat(40)
    });
    assert.equal(withEnv.authSecretSource, 'env');
    assert.equal(withEnv.authSecret, 'x'.repeat(40));

    assert.throws(
      () => loadConfig({ STRIPSEARCH_DATA_DIR: dir, BETTER_AUTH_SECRET: 'too-short' }),
      /at least 32/
    );

    assert.deepEqual(first.allowedOrigins, [
      'http://localhost:4390',
      'http://127.0.0.1:4390',
      'http://[::1]:4390'
    ]);
    assert.ok(first.dbPath.startsWith(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
