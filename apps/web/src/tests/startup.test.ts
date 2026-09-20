import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the server exits nonzero when its port is already occupied', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const dir = mkdtempSync(path.join(tmpdir(), 'stripsearch-startup-'));
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: String(port),
        STRIPSEARCH_DATA_DIR: dir,
        STRIPSEARCH_PUBLIC_ORIGIN: `http://localhost:${port}`,
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      new Promise<number | null>((resolve) => child?.once('exit', (exitCode) => resolve(exitCode))),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 20_000); })
    ]);
    clearTimeout(timer);
    if (code === 'timeout') {
      child.kill('SIGKILL');
      assert.fail('server should have exited on EADDRINUSE');
    }
    assert.notEqual(code, 0);
  } finally {
    child?.kill('SIGKILL');
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
