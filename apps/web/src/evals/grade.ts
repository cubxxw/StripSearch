/**
 * Independent grading for runtime-v1 cases.
 *
 * Grading only reads the adapter output and the recorded fixture calls. It never
 * receives the dataset expectation inside a production adapter, and it never
 * turns a missing or empty result into a vacuous pass.
 */

import type { CanonicalView, ClaimKind, ProviderResult } from '../shared/types.js';
import type { EvalCase, EvalExpectProvider, EvalExpectScope } from './schema.js';
import type { FixtureCall, FixtureViolation } from './fixture-transport.js';
import type { RevocationReport } from './revocation.js';

export interface CaseActual {
  state: 'completed' | 'partial' | 'failed' | 'needs_input' | 'disallowed' | 'allowed';
  errorCode: string | null;
  result: ProviderResult | null;
  canonical: CanonicalView | null;
  markdown: string | null;
  scopeDisallowed: boolean | null;
  scopeReason: string | null;
  calls: FixtureCall[];
  violations: FixtureViolation[];
  unconsumedReplay: number;
  networkAttempts: string[];
  revocation: RevocationReport | null;
  roundTripFailures: string[];
  providerCalls: number;
}

export interface CaseGrade {
  passed: boolean;
  hardFailure: boolean;
  failures: string[];
}

interface ClaimLike {
  text: string;
  kind: ClaimKind;
  sourceKeys: string[];
}

function resultClaims(result: ProviderResult): ClaimLike[] {
  const claims: ClaimLike[] = result.observations.map((observation) => ({
    text: observation.statement,
    kind: observation.kind,
    sourceKeys: observation.sourceKeys
  }));
  for (const section of result.answer) {
    for (const bullet of section.bullets) {
      claims.push({ text: bullet.text, kind: bullet.kind, sourceKeys: bullet.sourceKeys });
    }
  }
  return claims;
}

function resultUrls(result: ProviderResult): string[] {
  const urls = new Set<string>(result.sources.map((source) => source.url));
  if (result.identity.profileUrl) urls.add(result.identity.profileUrl);
  // Also catch URLs echoed into claim text so an injected URL cannot hide in a
  // bullet that never became a source.
  for (const match of resultText(result).match(/https?:\/\/[^\s"'`<>()[\]{}，。；、（）]+/g) ?? []) {
    urls.add(match.replace(/[.,;:!?]+$/, ''));
  }
  return [...urls];
}

function resultText(result: ProviderResult): string {
  const parts: string[] = [];
  parts.push(result.identity.displayName, result.identity.handle ?? '', result.identity.profileUrl ?? '', result.identity.note ?? '');
  for (const candidate of result.identity.candidates) parts.push(candidate.label, candidate.detail);
  for (const source of result.sources) {
    parts.push(source.key, source.url, source.title, source.excerpt ?? '', source.excerptLocator ?? '', source.identityLabel);
    parts.push(...source.limits);
  }
  for (const observation of result.observations) {
    parts.push(observation.statement, ...observation.limitations);
  }
  for (const section of result.answer) {
    parts.push(section.id, section.heading, section.body);
    for (const bullet of section.bullets) parts.push(bullet.text);
  }
  parts.push(...result.limitations, result.stopReason);
  return parts.join('\n');
}

/** Raw HTML that would execute if a Markdown export is rendered as HTML. */
export function containsRawHtml(markdown: string): boolean {
  return /<[a-zA-Z!/][^>]*>/.test(markdown);
}

/** Deterministic output-contract checks applied to every provider result. */
export function fixedOutputChecks(result: ProviderResult, markdown: string | null, failures: string[]): void {
  const keySet = new Set(result.sources.map((source) => source.key));
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  for (const source of result.sources) {
    if (seenKeys.has(source.key)) failures.push(`fixed: duplicate source key ${source.key}`);
    seenKeys.add(source.key);
    if (seenUrls.has(source.url)) failures.push(`fixed: duplicate source url ${source.url}`);
    seenUrls.add(source.url);
  }
  for (const claim of resultClaims(result)) {
    for (const key of claim.sourceKeys) {
      if (!keySet.has(key)) failures.push(`fixed: claim references missing source key ${key}`);
    }
    if (claim.kind === 'factual' && claim.sourceKeys.length === 0) {
      failures.push(`fixed: factual claim has no reference: ${claim.text.slice(0, 80)}`);
    }
  }
  if (markdown !== null && containsRawHtml(markdown)) {
    failures.push('fixed: markdown export contains raw HTML');
  }
}

function gradeProvider(expect: EvalExpectProvider, actual: CaseActual, failures: string[]): void {
  if (actual.state !== expect.state) failures.push(`state: expected ${expect.state}, got ${actual.state}`);
  if (actual.providerCalls !== expect.requests) {
    failures.push(`requests: expected ${expect.requests}, got ${actual.providerCalls}`);
  }
  if (expect.state === 'failed' && actual.errorCode !== expect.error_code) {
    failures.push(`error_code: expected ${expect.error_code}, got ${actual.errorCode ?? 'null'}`);
  }

  const result = actual.result;
  const identityStatus = result?.identity.status ?? (actual.state === 'needs_input' ? 'needs_input' : null);
  if (expect.identity_status && identityStatus !== expect.identity_status) {
    failures.push(`identity_status: expected ${expect.identity_status}, got ${identityStatus ?? 'none'}`);
  }
  if (!result) {
    if (expect.state === 'completed' || expect.state === 'partial') {
      failures.push('missing_output: no adapter result was produced');
    }
    const needsOutput =
      expect.source_count !== undefined ||
      (expect.include_urls?.length ?? 0) > 0 ||
      (expect.include_text?.length ?? 0) > 0 ||
      (expect.claim_kinds?.length ?? 0) > 0;
    if (needsOutput) failures.push('missing_output: expectations require output that does not exist');
    return;
  }

  fixedOutputChecks(result, actual.markdown, failures);

  if (expect.source_count) {
    const count = result.sources.length;
    if (expect.source_count.min !== undefined && count < expect.source_count.min) {
      failures.push(`source_count: expected at least ${expect.source_count.min}, got ${count}`);
    }
    if (expect.source_count.max !== undefined && count > expect.source_count.max) {
      failures.push(`source_count: expected at most ${expect.source_count.max}, got ${count}`);
    }
  }
  const urls = resultUrls(result);
  for (const url of expect.include_urls ?? []) {
    if (!urls.includes(url)) failures.push(`include_urls: missing ${url}`);
  }
  for (const url of expect.exclude_urls ?? []) {
    if (urls.includes(url)) failures.push(`exclude_urls: unexpected ${url}`);
  }
  const text = resultText(result);
  for (const fragment of expect.include_text ?? []) {
    if (!text.includes(fragment)) failures.push(`include_text: missing ${JSON.stringify(fragment)}`);
  }
  for (const fragment of expect.exclude_text ?? []) {
    if (text.includes(fragment)) failures.push(`exclude_text: unexpected ${JSON.stringify(fragment)}`);
  }
  const claims = resultClaims(result);
  for (const rule of expect.claim_kinds ?? []) {
    const matches = claims.filter((claim) => claim.text.includes(rule.contains));
    if (matches.length === 0) {
      failures.push(`claim_kinds: no claim contains ${JSON.stringify(rule.contains)}`);
      continue;
    }
    for (const match of matches) {
      if (match.kind !== rule.kind) {
        failures.push(`claim_kinds: claim ${JSON.stringify(rule.contains)} has kind ${match.kind}, expected ${rule.kind}`);
      }
    }
  }
  if (expect.state === 'completed' && (result.sources.length === 0 || claims.length === 0)) {
    failures.push('empty_output: completed state produced no sources or claims');
  }
}

function gradeScope(expect: EvalExpectScope, actual: CaseActual, failures: string[]): void {
  if (actual.providerCalls !== expect.requests) {
    failures.push(`requests: expected ${expect.requests}, got ${actual.providerCalls}`);
  }
  if (actual.calls.length !== 0) {
    failures.push(`scope_http: scope mode must not call HTTP, recorded ${actual.calls.length}`);
  }
  if (actual.scopeDisallowed !== expect.disallowed) {
    failures.push(`disallowed: expected ${expect.disallowed}, got ${actual.scopeDisallowed}`);
  }
}

export function gradeCase(evalCase: EvalCase, actual: CaseActual): CaseGrade {
  const failures: string[] = [];
  let hardFailure = false;

  for (const violation of actual.violations) {
    hardFailure = true;
    failures.push(`hard_failure:${violation.kind}: ${violation.message}`);
  }
  for (const url of actual.networkAttempts) {
    hardFailure = true;
    failures.push(`hard_failure:network_attempt: blocked non-fixture request to ${url}`);
  }
  if (actual.unconsumedReplay > 0) {
    failures.push(`replay_mismatch: ${actual.unconsumedReplay} replay response(s) were never consumed`);
  }
  failures.push(...actual.roundTripFailures);

  if (evalCase.expect.mode === 'scope') {
    gradeScope(evalCase.expect, actual, failures);
  } else {
    gradeProvider(evalCase.expect, actual, failures);
    if (evalCase.check_revocation) {
      if (!actual.revocation) {
        failures.push('revocation: check requested but not executed');
      } else {
        failures.push(...actual.revocation.failures);
      }
    }
  }

  return { passed: failures.length === 0, hardFailure, failures };
}
