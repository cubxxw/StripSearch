import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freePort, waitFor } from './harness.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const compiledEntry = path.join(appRoot, 'dist', 'server', 'index.js');
const builtClient = path.join(appRoot, 'dist', 'client');
const builtIndex = path.join(builtClient, 'index.html');
const built = existsSync(compiledEntry) && existsSync(builtIndex);

test(
  'compiled dist/server/index.js serves the real built client (not a dist/dist path)',
  { skip: built ? false : 'run `npm --prefix apps/web run build` first' },
  async (t) => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'stripsearch-compiled-'));
    const child = spawn(process.execPath, [compiledEntry], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: String(port),
        STRIPSEARCH_DATA_DIR: dataDir,
        STRIPSEARCH_PUBLIC_ORIGIN: `http://localhost:${port}`,
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    t.after(() => {
      child.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitFor(
        async () => {
          try {
            const health = await fetch(`${baseUrl}/api/health`);
            return health.ok;
          } catch {
            return false;
          }
        },
        20_000,
        100
      );
    } catch {
      throw new Error(`compiled server did not start; stderr: ${stderr}`);
    }

    const response = await fetch(`${baseUrl}/`);
    assert.equal(
      response.status,
      200,
      'compiled start must serve the built index, not the 503 "not built" placeholder'
    );
    const html = await response.text();
    assert.equal(html, readFileSync(builtIndex, 'utf8'));

    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1] ?? '');
    assert.ok(assetPaths.length >= 2, 'built index must reference at least one JS and one CSS asset');
    for (const assetPath of assetPaths) {
      const asset = await fetch(`${baseUrl}${assetPath}`);
      assert.equal(asset.status, 200, `${assetPath} must be served from dist/client`);
      assert.equal(
        await asset.text(),
        readFileSync(path.join(builtClient, assetPath.replace(/^\//, '')), 'utf8')
      );
    }
  }
);
