import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const clientBuildDir = fileURLToPath(new URL('../../dist/client', import.meta.url));

function readBuildFiles(dir: string): string {
  let combined = '';
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) combined += readBuildFiles(full);
    else combined += readFileSync(full, 'utf8');
  }
  return combined;
}

test(
  'client bundle never embeds provider keys or the auth secret',
  { skip: !existsSync(clientBuildDir) ? 'dist/client not built' : false },
  () => {
    const bundle = readBuildFiles(clientBuildDir);
    for (const marker of ['EXA_API_KEY', 'GITHUB_TOKEN', 'BETTER_AUTH_SECRET', 'auth-secret']) {
      assert.equal(bundle.includes(marker), false, `client bundle must not include ${marker}`);
    }
  }
);
