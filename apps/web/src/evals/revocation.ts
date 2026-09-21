/**
 * Runtime-v1 revocation check.
 *
 * This is a Store/presentation check, not a browser behaviour check: it drives
 * the real production Store and canonical renderers, excludes the first source
 * a claim depends on, verifies the dependent claims become review-pending and
 * the rendered export says so, then restores the source and verifies the
 * dependency heals. Evidence is captured before and after every mutation.
 */

import { createHash } from 'node:crypto';
import type { CanonicalView, ProviderResult, Validity } from '../shared/types.js';
import type { Store } from '../server/store.js';
import type { RunRecord } from '../server/store.js';
import { renderJson, renderMarkdown } from '../shared/canonical.js';

export interface RevocationEvidence {
  revision: number;
  excluded: boolean;
  fetchStatus: string | null;
  reviewCount: number;
  affectedClaimCount: number;
  affectedValidity: Validity[];
  markdownHasReviewMarker: boolean;
  markdownContainsSourceKey: boolean;
  markdownDigest: string;
  jsonDigest: string;
}

export interface RevocationReport {
  note: string;
  referencedSourceKey: string | null;
  before: RevocationEvidence | null;
  excluded: RevocationEvidence | null;
  restored: RevocationEvidence | null;
  failures: string[];
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function claimsReferencing(view: CanonicalView, sourceKey: string): { kind: string; validity: Validity }[] {
  const affected: { kind: string; validity: Validity }[] = [];
  for (const observation of view.observations) {
    if (observation.sourceKeys.includes(sourceKey)) affected.push({ kind: observation.kind, validity: observation.validity });
  }
  for (const section of view.answer) {
    for (const bullet of section.bullets) {
      if (bullet.sourceKeys.includes(sourceKey)) affected.push({ kind: bullet.kind, validity: bullet.validity });
    }
  }
  return affected;
}

function evidence(view: CanonicalView, sourceKey: string): RevocationEvidence {
  const markdown = renderMarkdown(view);
  const json = renderJson(view);
  const source = view.sources.find((entry) => entry.sourceKey === sourceKey) ?? null;
  const affected = claimsReferencing(view, sourceKey);
  return {
    revision: view.revision,
    excluded: source?.excluded ?? false,
    fetchStatus: source?.fetchStatus ?? null,
    reviewCount: view.reviewCount,
    affectedClaimCount: affected.length,
    affectedValidity: affected.map((entry) => entry.validity),
    markdownHasReviewMarker: markdown.includes('待复核'),
    markdownContainsSourceKey: markdown.includes(sourceKey),
    markdownDigest: digest(markdown),
    jsonDigest: digest(json)
  };
}

/** First source (in result order) that any claim actually references. */
export function firstReferencedSourceKey(result: ProviderResult): string | null {
  const referenced = new Set<string>();
  for (const observation of result.observations) {
    for (const key of observation.sourceKeys) referenced.add(key);
  }
  for (const section of result.answer) {
    for (const bullet of section.bullets) {
      for (const key of bullet.sourceKeys) referenced.add(key);
    }
  }
  for (const source of result.sources) {
    if (referenced.has(source.key)) return source.key;
  }
  return null;
}

function checkExcluded(view: CanonicalView, sourceKey: string, failures: string[]): void {
  const source = view.sources.find((entry) => entry.sourceKey === sourceKey);
  if (!source) {
    failures.push(`revocation: excluded source ${sourceKey} disappeared from the view`);
    return;
  }
  if (!source.excluded) failures.push(`revocation: source ${sourceKey} was not marked excluded`);
  if (source.fetchStatus !== 'excluded') failures.push(`revocation: source ${sourceKey} fetch status is ${source.fetchStatus}`);
  const affected = claimsReferencing(view, sourceKey);
  if (affected.length === 0) failures.push(`revocation: no claim references excluded source ${sourceKey}`);
  if (!affected.every((entry) => entry.validity === 'review')) {
    failures.push(`revocation: not every dependent claim became review after excluding ${sourceKey}`);
  }
  const markdown = renderMarkdown(view);
  if (!markdown.includes('待复核')) failures.push('revocation: markdown export did not mark dependent claims');
  const parsed = JSON.parse(renderJson(view)) as CanonicalView;
  const parsedSource = parsed.sources.find((entry) => entry.sourceKey === sourceKey);
  if (!parsedSource?.excluded) failures.push('revocation: json export did not mark the source excluded');
  for (const observation of parsed.observations) {
    if (observation.sourceKeys.includes(sourceKey) && observation.validity !== 'review') {
      failures.push('revocation: json export kept a dependent observation valid');
      break;
    }
  }
}

function checkRestored(view: CanonicalView, sourceKey: string, before: RevocationEvidence, restored: RevocationEvidence, failures: string[]): void {
  const source = view.sources.find((entry) => entry.sourceKey === sourceKey);
  if (!source) {
    failures.push(`revocation: restored source ${sourceKey} disappeared from the view`);
    return;
  }
  if (source.excluded) failures.push(`revocation: source ${sourceKey} is still excluded after restore`);
  if (source.fetchStatus === 'excluded') failures.push(`revocation: source ${sourceKey} still reports excluded after restore`);
  const affected = claimsReferencing(view, sourceKey);
  if (!affected.every((entry) => entry.validity === 'valid')) {
    failures.push(`revocation: dependent claims did not return to valid after restoring ${sourceKey}`);
  }
  if (restored.reviewCount !== before.reviewCount) {
    failures.push(`revocation: review count after restore is ${restored.reviewCount}, expected ${before.reviewCount}`);
  }
  const markdown = renderMarkdown(view);
  if (markdown.includes('待复核')) failures.push('revocation: markdown still marks review-pending claims after restore');
}

/**
 * Runs the exclusion → restore lifecycle against the persisted run. The caller
 * must already have persisted `result` and exported the pre-change canonical
 * view; this function mutates only that isolated eval database.
 */
export function runRevocationCheck(store: Store, run: RunRecord, result: ProviderResult): RevocationReport {
  const failures: string[] = [];
  const referencedSourceKey = firstReferencedSourceKey(result);
  const report: RevocationReport = {
    note: 'Store/presentation check of exclusion and dependency invalidation, not browser behaviour.',
    referencedSourceKey,
    before: null,
    excluded: null,
    restored: null,
    failures
  };
  if (!referencedSourceKey) {
    failures.push('revocation: no referenced source is available to exclude');
    return report;
  }

  const beforeView = store.buildCanonicalView(run);
  report.before = evidence(beforeView, referencedSourceKey);

  const excludeRevision = run.revision;
  store.setSourceExcluded(run.id, referencedSourceKey, true);
  store.updateRun(run.id, { revision: excludeRevision + 1 });
  const excludedRun = store.getRun(run.id);
  if (!excludedRun) {
    failures.push('revocation: run disappeared after exclusion');
    return report;
  }
  if (excludedRun.revision <= excludeRevision) failures.push('revocation: revision did not advance after exclusion');
  const excludedView = store.buildCanonicalView(excludedRun);
  report.excluded = evidence(excludedView, referencedSourceKey);
  checkExcluded(excludedView, referencedSourceKey, failures);

  const restoreRevision = excludedRun.revision;
  store.setSourceExcluded(run.id, referencedSourceKey, false);
  store.updateRun(run.id, { revision: restoreRevision + 1 });
  const restoredRun = store.getRun(run.id);
  if (!restoredRun) {
    failures.push('revocation: run disappeared after restore');
    return report;
  }
  if (restoredRun.revision <= restoreRevision) failures.push('revocation: revision did not advance after restore');
  const restoredView = store.buildCanonicalView(restoredRun);
  const restoredEvidence = evidence(restoredView, referencedSourceKey);
  report.restored = restoredEvidence;
  if (report.before) checkRestored(restoredView, referencedSourceKey, report.before, restoredEvidence, failures);

  return report;
}
