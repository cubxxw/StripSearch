/**
 * Persist a provider result through the real production Store and export the
 * canonical view with the real renderers. Databases live in a fresh temporary
 * directory rooted at TMPDIR and are closed and removed by the caller.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCoreSchema, openDatabase, type DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import type { RunRecord } from '../server/store.js';
import type { CanonicalView, ProviderName, ProviderResult } from '../shared/types.js';
import { renderJson, renderMarkdown } from '../shared/canonical.js';

export interface EvalStore {
  db: DB;
  store: Store;
  dir: string;
}

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

/** Create an isolated SQLite database under TMPDIR for one evaluator run. */
export function openEvalStore(): EvalStore {
  const dir = mkdtempSync(path.join(tempBase(), 'stripsearch-evals-'));
  const db = openDatabase(path.join(dir, 'evals.sqlite'));
  applyCoreSchema(db);
  return { db, store: new Store(db), dir };
}

export function closeEvalStore(evalStore: EvalStore): void {
  try {
    evalStore.db.close();
  } finally {
    rmSync(evalStore.dir, { recursive: true, force: true });
  }
}

export interface PersistMeta {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
}

/** Write a provider result as a completed run and return the stored record. */
export function persistResult(store: Store, result: ProviderResult, meta: PersistMeta): RunRecord {
  const run = store.insertRun({
    ownerId: 'eval-runner',
    question: meta.question,
    seedUrl: meta.seedUrl,
    provider: meta.provider,
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'runtime-eval'
  });
  store.replaceSources(run.id, result.sources);
  store.clearObservations(run.id);
  result.observations.forEach((observation, index) => store.addObservation(run.id, observation, index));
  store.updateRun(run.id, {
    identity_json: JSON.stringify(result.identity),
    answer_json: JSON.stringify(result.answer),
    limitations_json: JSON.stringify(result.limitations),
    usage_json: JSON.stringify({
      provider: meta.provider,
      requests: result.usage.requests,
      bytes: result.usage.bytes,
      elapsedMs: null,
      measurement: 'observed'
    }),
    state: result.state,
    stop_reason: result.stopReason,
    revision: 1
  });
  const updated = store.getRun(run.id);
  if (!updated) throw new Error('failed to persist the provider result for evaluation');
  return updated;
}

export interface CanonicalExport {
  run: RunRecord;
  view: CanonicalView;
  markdown: string;
  json: string;
}

export function exportCanonical(store: Store, run: RunRecord): CanonicalExport {
  const view = store.buildCanonicalView(run);
  return { run, view, markdown: renderMarkdown(view), json: renderJson(view) };
}

/**
 * Verify the Store/renderer round trip preserves the adapter output. A failure
 * here means the exported artifact does not represent the graded result.
 */
export function roundTripFailures(result: ProviderResult, view: CanonicalView): string[] {
  const failures: string[] = [];
  if (view.state !== result.state) failures.push(`round_trip: state ${view.state} != result ${result.state}`);
  if (view.identity.status !== result.identity.status) {
    failures.push(`round_trip: identity status ${view.identity.status} != result ${result.identity.status}`);
  }
  if (view.sources.length !== result.sources.length) {
    failures.push(`round_trip: source count ${view.sources.length} != result ${result.sources.length}`);
  }
  const viewSources = new Map(view.sources.map((source) => [source.sourceKey, source] as const));
  for (const source of result.sources) {
    const stored = viewSources.get(source.key);
    if (!stored) {
      failures.push(`round_trip: source ${source.key} missing from canonical view`);
      continue;
    }
    if (stored.url !== source.url) failures.push(`round_trip: source ${source.key} url changed`);
    if (stored.kind !== source.kind) failures.push(`round_trip: source ${source.key} kind changed`);
    if (stored.excluded) failures.push(`round_trip: source ${source.key} unexpectedly excluded`);
  }
  const viewObservations = view.observations;
  if (viewObservations.length !== result.observations.length) {
    failures.push(`round_trip: observation count ${viewObservations.length} != result ${result.observations.length}`);
  }
  result.observations.forEach((observation, index) => {
    const stored = viewObservations[index];
    if (!stored) return;
    if (stored.statement !== observation.statement) failures.push(`round_trip: observation ${index} statement changed`);
    if (stored.kind !== observation.kind) failures.push(`round_trip: observation ${index} kind changed`);
    if (stored.sourceKeys.join(',') !== observation.sourceKeys.join(',')) {
      failures.push(`round_trip: observation ${index} source keys changed`);
    }
  });
  const viewSections = view.answer;
  if (viewSections.length !== result.answer.length) {
    failures.push(`round_trip: answer section count ${viewSections.length} != result ${result.answer.length}`);
  }
  result.answer.forEach((section, sectionIndex) => {
    const storedSection = viewSections[sectionIndex];
    if (!storedSection) return;
    if (storedSection.id !== section.id) failures.push(`round_trip: section ${sectionIndex} id changed`);
    if (storedSection.bullets.length !== section.bullets.length) {
      failures.push(`round_trip: section ${section.id} bullet count changed`);
    }
    section.bullets.forEach((bullet, bulletIndex) => {
      const storedBullet = storedSection.bullets[bulletIndex];
      if (!storedBullet) return;
      if (storedBullet.text !== bullet.text) failures.push(`round_trip: section ${section.id} bullet ${bulletIndex} text changed`);
      if (storedBullet.kind !== bullet.kind) failures.push(`round_trip: section ${section.id} bullet ${bulletIndex} kind changed`);
      if (storedBullet.sourceKeys.join(',') !== bullet.sourceKeys.join(',')) {
        failures.push(`round_trip: section ${section.id} bullet ${bulletIndex} source keys changed`);
      }
      if (storedBullet.validity !== 'valid') failures.push(`round_trip: section ${section.id} bullet ${bulletIndex} not valid before revocation`);
    });
  });
  return failures;
}
