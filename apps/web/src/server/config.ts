import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_PORT = 4392;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host);
}

export interface AppConfig {
  host: '127.0.0.1' | 'localhost' | '::1';
  port: number;
  /** Canonical same-origin used by Better Auth and Origin checks. */
  origin: string;
  /** Every accepted loopback origin for this port. */
  allowedOrigins: string[];
  authSecret: string;
  authSecretSource: 'env' | 'file';
  dataDir: string;
  dbPath: string;
  githubToken: string | null;
  exaApiKey: string | null;
  nodeEnv: string;
  isTest: boolean;
}

function defaultDataDir(): string {
  return fileURLToPath(new URL('../../.data', import.meta.url));
}

function readOrCreateSecret(dataDir: string): { secret: string; source: 'file' } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // Best effort; the directory may live on a filesystem without POSIX modes.
  }
  const secretPath = path.join(dataDir, 'auth-secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        // Best effort only.
      }
      return { secret: existing, source: 'file' };
    }
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(secretPath, generated, { mode: 0o600 });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Best effort only.
  }
  return { secret: generated, source: 'file' };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawHost = (env.STRIPSEARCH_HOST ?? '127.0.0.1').trim();
  if (!isLoopbackHostname(rawHost)) {
    throw new Error(`STRIPSEARCH_HOST must be a loopback address, received "${rawHost}".`);
  }
  const host = rawHost.toLowerCase() as AppConfig['host'];

  const rawPort = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${rawPort}".`);
  }

  const nodeEnv = env.NODE_ENV ?? 'development';
  const isTest = nodeEnv === 'test' || env.STRIPSEARCH_TEST === '1';

  const dataDir = path.resolve(env.STRIPSEARCH_DATA_DIR ?? defaultDataDir());

  let authSecret: string;
  let authSecretSource: AppConfig['authSecretSource'];
  const envSecret = env.BETTER_AUTH_SECRET?.trim();
  if (envSecret) {
    if (envSecret.length < 32) {
      throw new Error('BETTER_AUTH_SECRET must be at least 32 characters.');
    }
    authSecret = envSecret;
    authSecretSource = 'env';
  } else {
    const created = readOrCreateSecret(dataDir);
    authSecret = created.secret;
    authSecretSource = created.source;
  }

  const origin = (env.STRIPSEARCH_PUBLIC_ORIGIN ?? `http://localhost:${port}`).trim();
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`STRIPSEARCH_PUBLIC_ORIGIN is not a valid URL: "${origin}".`);
  }
  if (parsedOrigin.protocol !== 'http:') {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must use http on loopback.');
  }
  if (parsedOrigin.username || parsedOrigin.password) {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must not contain credentials.');
  }
  if (!isLoopbackHostname(parsedOrigin.hostname)) {
    throw new Error(`STRIPSEARCH_PUBLIC_ORIGIN must stay on loopback, received "${origin}".`);
  }
  if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must be an origin without path, query or fragment.');
  }
  if (parsedOrigin.port !== String(port)) {
    throw new Error(
      `STRIPSEARCH_PUBLIC_ORIGIN port must match PORT (${port}), received "${origin}".`
    );
  }

  const allowedOrigins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`
  ];

  return {
    host,
    port,
    origin: parsedOrigin.origin,
    allowedOrigins,
    authSecret,
    authSecretSource,
    dataDir,
    dbPath: path.join(dataDir, 'stripsearch.sqlite'),
    githubToken: env.GITHUB_TOKEN?.trim() || null,
    exaApiKey: env.EXA_API_KEY?.trim() || null,
    nodeEnv,
    isTest
  };
}
