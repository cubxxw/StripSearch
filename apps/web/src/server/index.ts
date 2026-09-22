import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTransport } from './adapters/types.js';
import type { HttpTransport, ProviderFactory } from './adapters/types.js';
import { createExaProvider } from './adapters/exa.js';
import { githubProvider } from './adapters/github.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { defaultClientDir, loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { migrateDatabase } from './db/migrate.js';
import { Runner } from './services/runner.js';
import { Store } from './store.js';
import type { DB } from './db/index.js';

export interface BootstrapOverrides {
  providerFactory?: ProviderFactory;
  transport?: HttpTransport;
  clientDir?: string;
}

export interface BootstrappedApp {
  config: AppConfig;
  db: DB;
  store: Store;
  runner: Runner;
  app: ReturnType<typeof createApp>;
  interrupted: number;
}

export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BootstrapOverrides = {}
): Promise<BootstrappedApp> {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  const auth = createAuth(db, config);
  await migrateDatabase(db, auth);
  const store = new Store(db);
  const interrupted = store.recoverInterruptedRuns();
  const providerFactory: ProviderFactory =
    overrides.providerFactory ??
    ((name) => (name === 'exa' ? createExaProvider(config.exaApiKey) : githubProvider));
  const runner = new Runner({
    store,
    config,
    providerFactory,
    transport: overrides.transport ?? defaultTransport
  });
  const clientDir = overrides.clientDir ?? defaultClientDir();
  const app = createApp({ config, store, auth, runner, clientDir });
  return { config, db, store, runner, app, interrupted };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

async function main(): Promise<void> {
  const { config, app, interrupted, runner } = await bootstrap();
  let failed = false;
  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      failed = true;
      console.error('[stripsearch] failed to listen:', error.message);
      process.exit(1);
    }
    console.log(`[stripsearch] http://${config.host}:${config.port} (origin ${config.origin})`);
    if (interrupted > 0) {
      console.log(`[stripsearch] marked ${interrupted} interrupted run(s) as partial`);
    }
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (failed) return;
    failed = true;
    console.error('[stripsearch] failed to listen:', error.message);
    process.exit(1);
  });
  const shutdown = (): void => {
    runner.stopAll();
    server.close();
    // Drop lingering SSE / keep-alive sockets so the process can exit promptly.
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error('[stripsearch] failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
