/**
 * Strict, dependency-free schema parsing for the runtime-v1 offline evaluation
 * dataset. Unknown fields and invalid types are rejected instead of being
 * silently ignored, so a malformed dataset can never be graded as a pass.
 */

import type { ClaimKind, ProviderName } from '../shared/types.js';

export type EvalMode = 'provider' | 'scope';
export type EvalSplit = 'discovery' | 'regression';
export type EvalExpectState = 'completed' | 'partial' | 'failed' | 'needs_input';
export type EvalIdentityStatus = 'resolved' | 'needs_input' | 'ambiguous';

const CLAIM_KINDS: readonly ClaimKind[] = ['factual', 'attributed_statement', 'page_statement', 'inference'];
const PROVIDERS: readonly ProviderName[] = ['github', 'exa'];
const SPLITS: readonly EvalSplit[] = ['discovery', 'regression'];
const MODES: readonly EvalMode[] = ['provider', 'scope'];
const EXPECT_STATES: readonly EvalExpectState[] = ['completed', 'partial', 'failed', 'needs_input'];
const IDENTITY_STATUSES: readonly EvalIdentityStatus[] = ['resolved', 'needs_input', 'ambiguous'];
const METHODS = ['GET', 'POST'] as const;
/** The only provider origins an offline replay may target. */
const REPLAY_HOSTS = new Set(['api.github.com', 'api.exa.ai']);

/** Strict bounds for the optional per-case provider configuration. */
export const EVAL_CONFIG_LIMITS = {
  timeoutMsMin: 1,
  timeoutMsMax: 120_000,
  maxBytesMin: 1,
  maxBytesMax: 8 * 1024 * 1024,
  delayMsMax: 120_000,
  maxRequests: 1_000
} as const;

export class EvalSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSchemaError';
  }
}

export interface EvalReplayStep {
  method: 'GET' | 'POST';
  url: string;
  status: number;
  json?: unknown;
  raw_text?: string;
  redirected?: boolean;
  delay_ms?: number;
  body_includes?: string[];
}

export interface EvalConfig {
  exa_configured?: boolean;
  timeout_ms?: number;
  max_bytes?: number;
}

export interface EvalSourceCount {
  min?: number;
  max?: number;
}

export interface EvalClaimKindExpectation {
  contains: string;
  kind: ClaimKind;
}

export interface EvalInput {
  question: string;
  seedUrl: string | null;
  provider: ProviderName | null;
}

export interface EvalExpectProvider {
  mode: 'provider';
  state: EvalExpectState;
  requests: number;
  error_code?: string;
  source_count?: EvalSourceCount;
  identity_status?: EvalIdentityStatus;
  include_urls?: string[];
  exclude_urls?: string[];
  include_text?: string[];
  exclude_text?: string[];
  claim_kinds?: EvalClaimKindExpectation[];
}

export interface EvalExpectScope {
  mode: 'scope';
  disallowed: boolean;
  requests: number;
}

export type EvalExpect = EvalExpectProvider | EvalExpectScope;

export interface EvalCase {
  case_id: string;
  dataset_version: string;
  title: string;
  family: string;
  split: EvalSplit;
  review_status: string;
  tags: string[];
  mode: EvalMode;
  input: EvalInput;
  replay: EvalReplayStep[];
  expect: EvalExpect;
  check_revocation: boolean;
  config: EvalConfig;
}

function fail(path: string, message: string): never {
  throw new EvalSchemaError(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  return value;
}

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!known.has(key)) fail(`${path}.${key}`, 'is not a known field');
  }
}

function requireString(value: unknown, path: string, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (options.min !== undefined && value.length < options.min) {
    fail(path, `must be at least ${options.min} character(s)`);
  }
  if (options.max !== undefined && value.length > options.max) {
    fail(path, `must be at most ${options.max} character(s)`);
  }
  return value;
}

function optionalString(value: unknown, path: string, options: { min?: number; max?: number } = {}): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path, options);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer');
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`, { min: 1, max: 4096 }));
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseInput(raw: unknown, mode: EvalMode, path: string): EvalInput {
  const object = requireObject(raw, path);
  assertKnownKeys(object, ['question', 'seedUrl', 'provider'], path);
  const question = requireString(object.question, `${path}.question`, { min: 1, max: 2000 });
  let seedUrl: string | null = null;
  if (object.seedUrl !== undefined && object.seedUrl !== null) {
    seedUrl = requireString(object.seedUrl, `${path}.seedUrl`, { min: 1, max: 2048 });
  }
  let provider: ProviderName | null = null;
  if (object.provider !== undefined) {
    provider = requireEnum(object.provider, PROVIDERS, `${path}.provider`);
  }
  if (mode === 'provider' && provider === null) fail(path, 'provider mode requires input.provider');
  return { question, seedUrl, provider };
}

function parseReplayStep(raw: unknown, path: string): EvalReplayStep {
  const object = requireObject(raw, path);
  assertKnownKeys(object, ['method', 'url', 'status', 'json', 'raw_text', 'redirected', 'delay_ms', 'body_includes'], path);
  const method = requireEnum(object.method, METHODS, `${path}.method`);
  const url = requireString(object.url, `${path}.url`, { min: 1, max: 2048 });
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`${path}.url`, 'must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:' || !REPLAY_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    fail(`${path}.url`, 'must target a fixed GitHub or Exa API endpoint over https');
  }
  const status = requireInteger(object.status, `${path}.status`, 100, 599);
  const hasJson = Object.prototype.hasOwnProperty.call(object, 'json');
  const hasRawText = Object.prototype.hasOwnProperty.call(object, 'raw_text');
  if (hasJson && hasRawText) fail(path, 'must not contain both json and raw_text');
  const step: EvalReplayStep = { method, url, status };
  if (hasJson) step.json = object.json;
  if (hasRawText) step.raw_text = requireString(object.raw_text, `${path}.raw_text`, { max: 8 * 1024 * 1024 });
  if (object.redirected !== undefined) step.redirected = requireBoolean(object.redirected, `${path}.redirected`);
  if (object.delay_ms !== undefined) {
    step.delay_ms = requireInteger(object.delay_ms, `${path}.delay_ms`, 0, EVAL_CONFIG_LIMITS.delayMsMax);
  }
  if (object.body_includes !== undefined) {
    step.body_includes = requireStringArray(object.body_includes, `${path}.body_includes`);
    if (step.body_includes.length === 0) fail(`${path}.body_includes`, 'must not be empty when present');
  }
  return step;
}

function parseSourceCount(raw: unknown, path: string): EvalSourceCount {
  const object = requireObject(raw, path);
  assertKnownKeys(object, ['min', 'max'], path);
  const min = object.min === undefined ? undefined : requireInteger(object.min, `${path}.min`, 0, 10_000);
  const max = object.max === undefined ? undefined : requireInteger(object.max, `${path}.max`, 0, 10_000);
  if (min === undefined && max === undefined) fail(path, 'must set min and/or max');
  if (min !== undefined && max !== undefined && min > max) fail(path, 'min must not exceed max');
  const result: EvalSourceCount = {};
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;
  return result;
}

function parseClaimKinds(raw: unknown, path: string): EvalClaimKindExpectation[] {
  if (!Array.isArray(raw)) fail(path, 'must be an array');
  if (raw.length === 0) fail(path, 'must contain at least one expectation');
  return raw.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const object = requireObject(entry, itemPath);
    assertKnownKeys(object, ['contains', 'kind'], itemPath);
    return {
      contains: requireString(object.contains, `${itemPath}.contains`, { min: 1, max: 4096 }),
      kind: requireEnum(object.kind, CLAIM_KINDS, `${itemPath}.kind`)
    };
  });
}

function parseProviderExpect(object: Record<string, unknown>, path: string): EvalExpectProvider {
  assertKnownKeys(
    object,
    ['state', 'requests', 'error_code', 'source_count', 'identity_status', 'include_urls', 'exclude_urls', 'include_text', 'exclude_text', 'claim_kinds'],
    path
  );
  const state = requireEnum(object.state, EXPECT_STATES, `${path}.state`);
  const requests = requireInteger(object.requests, `${path}.requests`, 0, EVAL_CONFIG_LIMITS.maxRequests);
  const expect: EvalExpectProvider = { mode: 'provider', state, requests };
  if (object.error_code !== undefined) {
    expect.error_code = requireString(object.error_code, `${path}.error_code`, { min: 1, max: 200 });
  }
  if (state === 'failed' && expect.error_code === undefined) {
    fail(path, 'failed state requires error_code');
  }
  if (state !== 'failed' && expect.error_code !== undefined) {
    fail(path, 'error_code is only graded for a failed state');
  }
  if (object.source_count !== undefined) expect.source_count = parseSourceCount(object.source_count, `${path}.source_count`);
  if (object.identity_status !== undefined) {
    expect.identity_status = requireEnum(object.identity_status, IDENTITY_STATUSES, `${path}.identity_status`);
  }
  if (object.include_urls !== undefined) expect.include_urls = requireStringArray(object.include_urls, `${path}.include_urls`);
  if (object.exclude_urls !== undefined) expect.exclude_urls = requireStringArray(object.exclude_urls, `${path}.exclude_urls`);
  if (object.include_text !== undefined) expect.include_text = requireStringArray(object.include_text, `${path}.include_text`);
  if (object.exclude_text !== undefined) expect.exclude_text = requireStringArray(object.exclude_text, `${path}.exclude_text`);
  if (object.claim_kinds !== undefined) expect.claim_kinds = parseClaimKinds(object.claim_kinds, `${path}.claim_kinds`);
  return expect;
}

function parseScopeExpect(object: Record<string, unknown>, path: string): EvalExpectScope {
  assertKnownKeys(object, ['disallowed', 'requests'], path);
  const disallowed = requireBoolean(object.disallowed, `${path}.disallowed`);
  const requests = requireInteger(object.requests, `${path}.requests`, 0, EVAL_CONFIG_LIMITS.maxRequests);
  if (requests !== 0) fail(path, 'scope mode must declare requests: 0; it never authorizes HTTP');
  return { mode: 'scope', disallowed, requests };
}

function parseExpect(raw: unknown, mode: EvalMode, path: string): EvalExpect {
  const object = requireObject(raw, path);
  return mode === 'scope' ? parseScopeExpect(object, path) : parseProviderExpect(object, path);
}

function parseConfig(raw: unknown, path: string): EvalConfig {
  const object = requireObject(raw, path);
  assertKnownKeys(object, ['exa_configured', 'timeout_ms', 'max_bytes'], path);
  const config: EvalConfig = {};
  if (object.exa_configured !== undefined) config.exa_configured = requireBoolean(object.exa_configured, `${path}.exa_configured`);
  if (object.timeout_ms !== undefined) {
    config.timeout_ms = requireInteger(object.timeout_ms, `${path}.timeout_ms`, EVAL_CONFIG_LIMITS.timeoutMsMin, EVAL_CONFIG_LIMITS.timeoutMsMax);
  }
  if (object.max_bytes !== undefined) {
    config.max_bytes = requireInteger(object.max_bytes, `${path}.max_bytes`, EVAL_CONFIG_LIMITS.maxBytesMin, EVAL_CONFIG_LIMITS.maxBytesMax);
  }
  return config;
}

/** Parse a single dataset line/object into a validated case. */
export function parseCase(raw: unknown, path = 'case'): EvalCase {
  const object = requireObject(raw, path);
  assertKnownKeys(
    object,
    ['case_id', 'dataset_version', 'title', 'family', 'split', 'review_status', 'tags', 'mode', 'input', 'replay', 'expect', 'check_revocation', 'config'],
    path
  );
  const caseId = requireString(object.case_id, `${path}.case_id`, { min: 1, max: 200 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseId)) {
    fail(`${path}.case_id`, 'must be a filesystem-safe identifier');
  }
  const datasetVersion = requireString(object.dataset_version, `${path}.dataset_version`, { min: 1, max: 100 });
  if (datasetVersion !== 'runtime-v1') fail(`${path}.dataset_version`, 'must be runtime-v1');
  const title = requireString(object.title, `${path}.title`, { min: 1, max: 500 });
  const family = requireString(object.family, `${path}.family`, { min: 1, max: 200 });
  const split = requireEnum(object.split, SPLITS, `${path}.split`);
  const reviewStatus = requireString(object.review_status, `${path}.review_status`, { min: 1, max: 100 });
  if (reviewStatus !== 'unreviewed') fail(`${path}.review_status`, 'v1 only supports unreviewed specs; human review needs provenance');
  const tags = requireStringArray(object.tags, `${path}.tags`);
  if (new Set(tags).size !== tags.length) fail(`${path}.tags`, 'must not contain duplicates');
  const mode = requireEnum(object.mode, MODES, `${path}.mode`);
  const input = parseInput(object.input, mode, `${path}.input`);
  if (!Array.isArray(object.replay)) fail(`${path}.replay`, 'must be an array');
  const replay = object.replay.map((step, index) => parseReplayStep(step, `${path}.replay[${index}]`));
  if (mode === 'scope' && replay.length > 0) {
    fail(`${path}.replay`, 'scope mode must not declare replay steps');
  }
  const expect = parseExpect(object.expect, mode, `${path}.expect`);
  const checkRevocation = object.check_revocation === undefined ? false : requireBoolean(object.check_revocation, `${path}.check_revocation`);
  if (checkRevocation && mode !== 'provider') {
    fail(`${path}.check_revocation`, 'is only supported for provider mode');
  }
  const config = object.config === undefined ? {} : parseConfig(object.config, `${path}.config`);
  return {
    case_id: caseId,
    dataset_version: datasetVersion,
    title,
    family,
    split,
    review_status: reviewStatus,
    tags,
    mode,
    input,
    replay,
    expect,
    check_revocation: checkRevocation,
    config
  };
}

export interface DatasetValidation {
  cases: EvalCase[];
  duplicates: string[];
  familyLeaks: string[];
}

/** Enforce dataset-wide rules: unique ids and one split per family. */
export function validateDataset(cases: EvalCase[]): DatasetValidation {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  const splitByFamily = new Map<string, EvalSplit>();
  const familyLeaks: string[] = [];
  cases.forEach((entry, index) => {
    const existing = seen.get(entry.case_id);
    if (existing !== undefined) duplicates.push(`duplicate case_id "${entry.case_id}" at positions ${existing} and ${index}`);
    else seen.set(entry.case_id, index);
    const knownSplit = splitByFamily.get(entry.family);
    if (knownSplit !== undefined && knownSplit !== entry.split) {
      familyLeaks.push(`family "${entry.family}" appears in both ${knownSplit} and ${entry.split}`);
    } else if (knownSplit === undefined) {
      splitByFamily.set(entry.family, entry.split);
    }
  });
  return { cases, duplicates, familyLeaks };
}

/** Parse JSONL text into validated cases; throws on any malformed line or dataset rule. */
export function parseDataset(text: string): EvalCase[] {
  const lines = text.split(/\r?\n/);
  const cases: EvalCase[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      fail(`line ${index + 1}`, 'is not valid JSON');
    }
    cases.push(parseCase(raw, `line ${index + 1}`));
  });
  if (cases.length === 0) fail('dataset', 'contains no cases');
  const validation = validateDataset(cases);
  if (validation.duplicates.length > 0) fail('dataset', validation.duplicates.join('; '));
  if (validation.familyLeaks.length > 0) fail('dataset', validation.familyLeaks.join('; '));
  return cases;
}
