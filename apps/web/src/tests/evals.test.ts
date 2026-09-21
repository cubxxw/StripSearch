/**
 * Tests for the runtime-v1 offline evaluator itself.
 *
 * These tests prove that invalid adapter output, vacuous output, unexpected
 * requests and malformed datasets are caught, that the real adapters are driven
 * through the fixture transport, and that the CLI reports honest exit codes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FixtureTransport, FixtureViolationError } from '../evals/fixture-transport.js';
import { containsRawHtml, gradeCase } from '../evals/grade.js';
import type { CaseActual } from '../evals/grade.js';
import { verifyReportConsistency } from '../evals/report.js';
import type { EvalReport } from '../evals/report.js';
import { findRepoRoot, runCli, runEval } from '../evals/runner.js';
import { EvalSchemaError, parseCase, parseDataset } from '../evals/schema.js';
import type { EvalCase } from '../evals/schema.js';
import { githubProvider } from '../server/adapters/github.js';
import type { ProviderContext } from '../server/adapters/types.js';
import type { ProviderResult } from '../shared/types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDir, '..', '..');
const smokePath = path.join(webRoot, 'src', 'evals', 'fixtures', 'smoke.jsonl');
const repoRoot = findRepoRoot();

function rawCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case_id: 'test-1',
    dataset_version: 'runtime-v1',
    title: '测试用例',
    family: 'test-family',
    split: 'discovery',
    review_status: 'unreviewed',
    tags: ['test'],
    mode: 'provider',
    input: { question: '公开问题', seedUrl: 'https://github.com/example', provider: 'github' },
    replay: [],
    expect: { state: 'completed', requests: 0 },
    ...overrides
  };
}

function baseCase(overrides: Record<string, unknown> = {}): EvalCase {
  return parseCase(rawCase(overrides));
}

function sampleResult(overrides: Partial<ProviderResult> = {}): ProviderResult {
  const base: ProviderResult = {
    state: 'completed',
    identity: {
      displayName: 'Example',
      handle: 'example',
      profileUrl: 'https://github.com/example',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [
      {
        key: 'S1',
        url: 'https://github.com/example',
        title: '主页',
        kind: 'profile',
        publishedAt: null,
        excerpt: '简介',
        excerptLocator: '简介',
        identityLabel: '种子账号',
        identityConfirmed: true,
        fetchStatus: 'ok',
        limits: []
      },
      {
        key: 'S2',
        url: 'https://github.com/example/repo',
        title: '仓库',
        kind: 'work',
        publishedAt: null,
        excerpt: '描述',
        excerptLocator: '简介',
        identityLabel: '仓库',
        identityConfirmed: true,
        fetchStatus: 'ok',
        limits: []
      }
    ],
    observations: [
      { statement: '公开资料中的公司：Example Lab', kind: 'attributed_statement', sourceKeys: ['S1'], limitations: [] },
      { statement: '仓库 repo 的公开简介为描述。', kind: 'factual', sourceKeys: ['S2'], limitations: [] }
    ],
    answer: [
      {
        id: 'identity',
        heading: '这个人是谁',
        body: 'body',
        bullets: [{ text: '公开资料中的公司：Example Lab', sourceKeys: ['S1'], kind: 'attributed_statement' }]
      },
      {
        id: 'works',
        heading: '做过什么',
        body: 'body',
        bullets: [{ text: 'repo：描述', sourceKeys: ['S2'], kind: 'factual' }]
      }
    ],
    limitations: ['限制'],
    usage: { requests: 2, bytes: 100 },
    stopReason: 'test'
  };
  return { ...base, ...overrides };
}

function makeActual(overrides: Partial<CaseActual> = {}): CaseActual {
  return {
    state: 'completed',
    errorCode: null,
    result: sampleResult(),
    canonical: null,
    markdown: null,
    scopeDisallowed: null,
    scopeReason: null,
    calls: [],
    violations: [],
    unconsumedReplay: 0,
    networkAttempts: [],
    revocation: null,
    roundTripFailures: [],
    providerCalls: 2,
    ...overrides
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('eval schema rejects unknown fields and invalid types', () => {
  assert.throws(() => baseCase({ unknown_field: 1 }), EvalSchemaError);
  assert.throws(() => baseCase({ input: { question: 'q', seedUrl: null, provider: 'nope' } }), EvalSchemaError);
  assert.throws(() => baseCase({ expect: { state: 'completed', requests: '2' } }), EvalSchemaError);
  assert.throws(() => baseCase({ expect: { state: 'failed', requests: 1 } }), EvalSchemaError);
  assert.throws(() => baseCase({ config: { timeout_ms: 0 } }), EvalSchemaError);
  assert.throws(() => baseCase({ config: { max_bytes: -1 } }), EvalSchemaError);
  assert.throws(() => baseCase({ replay: [{ method: 'PETITION', url: 'https://api.github.com/x', status: 200 }] }), EvalSchemaError);
  assert.throws(
    () => baseCase({ replay: [{ method: 'GET', url: 'https://api.github.com/x', status: 200, json: {}, raw_text: 'x' }] }),
    EvalSchemaError
  );
  assert.throws(() => baseCase({ replay: [{ method: 'GET', url: 'https://evil.test/x', status: 200 }] }), EvalSchemaError);
  assert.throws(
    () => baseCase({ mode: 'scope', input: { question: 'q' }, replay: [], expect: { disallowed: true, requests: 1 } }),
    EvalSchemaError
  );
  assert.throws(() => baseCase({ mode: 'scope', input: { question: 'q' }, replay: [{ method: 'GET', url: 'https://api.github.com/x', status: 200 }], expect: { disallowed: true, requests: 0 } }), EvalSchemaError);
  assert.throws(() => baseCase({ expect: { state: 'completed', requests: 1, source_count: { min: 3, max: 1 } } }), EvalSchemaError);
  assert.throws(() => baseCase({ expect: { state: 'completed', requests: 0, error_code: 'ignored' } }), EvalSchemaError);
  assert.throws(() => baseCase({ case_id: '../collision' }), EvalSchemaError);
  assert.throws(() => baseCase({ dataset_version: 'unknown-version' }), EvalSchemaError);
  assert.throws(() => baseCase({ review_status: 'human-reviewed' }), EvalSchemaError);
  assert.throws(() => baseCase({ tags: ['citation', 'citation'] }), EvalSchemaError);
});

test('eval dataset rejects duplicate cases and split family leakage', () => {
  const line = JSON.stringify(rawCase());
  assert.equal(parseDataset(line).length, 1);
  assert.throws(() => parseDataset([line, line].join('\n')), EvalSchemaError);
  const leaked = JSON.stringify(rawCase({ case_id: 'test-2', family: 'test-family', split: 'regression' }));
  assert.throws(() => parseDataset([line, leaked].join('\n')), EvalSchemaError);
  assert.throws(() => parseDataset('   \n'), EvalSchemaError);
});

test('fixture transport records unexpected requests and body mismatches', async () => {
  const replay = [{ method: 'GET' as const, url: 'https://api.github.com/users/example', status: 200, json: { login: 'example' } }];
  const transport = new FixtureTransport(replay);
  const first = await transport.fetch('https://api.github.com/users/example', { method: 'GET' });
  assert.equal(first.status, 200);
  await assert.rejects(() => transport.fetch('https://example.com/evil', { method: 'GET' }), FixtureViolationError);
  assert.equal(transport.violations.length, 1);
  assert.equal(transport.violations[0]?.kind, 'unexpected_request');

  const bodyReplay = [
    { method: 'POST' as const, url: 'https://api.exa.ai/search', status: 200, json: {}, body_includes: ['needle'] }
  ];
  const bodyTransport = new FixtureTransport(bodyReplay);
  await assert.rejects(
    () => bodyTransport.fetch('https://api.exa.ai/search', { method: 'POST', body: 'haystack' }),
    FixtureViolationError
  );
  assert.equal(bodyTransport.violations[0]?.kind, 'body_mismatch');
  await bodyTransport.fetch('https://api.exa.ai/search', { method: 'POST', body: 'a needle b' });
  assert.equal(bodyTransport.remaining, 0);
});

test('an unexpected request swallowed by a production adapter is still a hard failure', async () => {
  const replay = [
    {
      method: 'GET' as const,
      url: 'https://api.github.com/users/example',
      status: 200,
      json: { login: 'example', html_url: 'https://github.com/example' }
    }
  ];
  const transport = new FixtureTransport(replay);
  const context: ProviderContext = {
    transport,
    signal: new AbortController().signal,
    report: { stage: () => undefined, source: () => undefined },
    githubToken: null,
    exaApiKey: null,
    timeoutMs: 500,
    maxBytes: 65536
  };
  // The repos request is not in the replay; githubProvider catches the provider
  // error and still returns a partial result.
  const result = await githubProvider.run(
    { question: 'q', seedUrl: 'https://github.com/example', provider: 'github' },
    context
  );
  assert.equal(result.state, 'partial');
  assert.equal(transport.violations.length, 1);

  const evalCase = baseCase({ expect: { state: 'partial', requests: 2 } });
  const grade = gradeCase(
    evalCase,
    makeActual({
      state: 'partial',
      result,
      calls: transport.calls,
      violations: transport.violations,
      unconsumedReplay: transport.remaining,
      providerCalls: transport.calls.length
    })
  );
  assert.equal(grade.hardFailure, true);
  assert.equal(grade.passed, false);
  assert.ok(grade.failures.some((failure) => failure.includes('hard_failure:unexpected_request')));
});

test('grading catches identity mismatch, missing citations, wrong claim kinds and empty output', () => {
  const mismatchCase = baseCase({ expect: { state: 'completed', requests: 2, identity_status: 'resolved' } });
  const mismatchGrade = gradeCase(
    mismatchCase,
    makeActual({ result: sampleResult({ identity: { ...sampleResult().identity, status: 'ambiguous' } }) })
  );
  assert.equal(mismatchGrade.passed, false);
  assert.ok(mismatchGrade.failures.some((failure) => failure.includes('identity_status')));

  const plainCase = baseCase({ expect: { state: 'completed', requests: 2 } });
  const orphanResult = sampleResult({
    observations: [{ statement: '孤立断言', kind: 'factual', sourceKeys: ['S99'], limitations: [] }]
  });
  const orphanGrade = gradeCase(plainCase, makeActual({ result: orphanResult }));
  assert.equal(orphanGrade.passed, false);
  assert.ok(orphanGrade.failures.some((failure) => failure.includes('missing source key S99')));

  const kindCase = baseCase({
    expect: { state: 'completed', requests: 2, claim_kinds: [{ contains: '公司', kind: 'attributed_statement' }] }
  });
  const kindResult = sampleResult({
    observations: [],
    answer: [
      {
        id: 'a',
        heading: 'h',
        body: 'b',
        bullets: [
          { text: '公司：正确自述', sourceKeys: ['S1'], kind: 'attributed_statement' },
          { text: '公司：被升级为事实', sourceKeys: ['S2'], kind: 'factual' }
        ]
      }
    ]
  });
  const kindGrade = gradeCase(kindCase, makeActual({ result: kindResult }));
  assert.equal(kindGrade.passed, false);
  assert.ok(kindGrade.failures.some((failure) => failure.includes('expected attributed_statement')));

  const emptyCase = baseCase({
    expect: { state: 'completed', requests: 0, source_count: { min: 1 }, include_text: ['anything'] }
  });
  const emptyGrade = gradeCase(emptyCase, makeActual({ result: sampleResult({ sources: [], observations: [], answer: [] }), providerCalls: 0 }));
  assert.equal(emptyGrade.passed, false);
  assert.ok(emptyGrade.failures.some((failure) => failure.includes('empty_output')));
  assert.ok(emptyGrade.failures.some((failure) => failure.includes('source_count')));
  assert.ok(emptyGrade.failures.some((failure) => failure.includes('include_text')));
});

test('grading accepts needs_input identity without a provider result', () => {
  const ok = baseCase({ expect: { state: 'needs_input', requests: 0, identity_status: 'needs_input' } });
  const okGrade = gradeCase(ok, makeActual({ state: 'needs_input', result: null, providerCalls: 0 }));
  assert.equal(okGrade.passed, true, okGrade.failures.join('; '));

  const wrong = baseCase({ expect: { state: 'needs_input', requests: 0, identity_status: 'resolved' } });
  const wrongGrade = gradeCase(wrong, makeActual({ state: 'needs_input', result: null, providerCalls: 0 }));
  assert.equal(wrongGrade.passed, false);
  assert.ok(wrongGrade.failures.some((failure) => failure.includes('identity_status')));
});

test('grading rejects raw HTML in the markdown export and blocked network attempts', () => {
  assert.equal(containsRawHtml('# ok\n> quote\n'), false);
  assert.equal(containsRawHtml('<script>alert(1)</script>'), true);

  const evalCase = baseCase({ expect: { state: 'completed', requests: 2 } });
  const htmlGrade = gradeCase(evalCase, makeActual({ markdown: '# hi\n<script>alert(1)</script>\n' }));
  assert.equal(htmlGrade.passed, false);
  assert.ok(htmlGrade.failures.some((failure) => failure.includes('raw HTML')));

  const networkGrade = gradeCase(evalCase, makeActual({ networkAttempts: ['https://example.com/evil'] }));
  assert.equal(networkGrade.hardFailure, true);
  assert.equal(networkGrade.passed, false);
  assert.ok(networkGrade.failures.some((failure) => failure.includes('hard_failure:network_attempt')));
});

test('scope grading requires zero HTTP and matches the disallowed verdict', () => {
  const scopeCase = baseCase({
    mode: 'scope',
    input: { question: 'q', seedUrl: null },
    replay: [],
    expect: { disallowed: true, requests: 0 }
  });
  const allowed = makeActual({ state: 'disallowed', result: null, scopeDisallowed: true, providerCalls: 0 });
  assert.equal(gradeCase(scopeCase, allowed).passed, true);
  const calledHttp = makeActual({
    state: 'disallowed',
    result: null,
    scopeDisallowed: true,
    providerCalls: 1,
    calls: [{ method: 'GET', url: 'https://x.test', body: null }]
  });
  assert.equal(gradeCase(scopeCase, calledHttp).passed, false);
  const wrongVerdict = makeActual({ state: 'allowed', result: null, scopeDisallowed: false, providerCalls: 0 });
  assert.equal(gradeCase(scopeCase, wrongVerdict).passed, false);
});

test('revocation failures are surfaced by the grader', () => {
  const evalCase = baseCase({ expect: { state: 'completed', requests: 2 }, check_revocation: true });
  const grade = gradeCase(
    evalCase,
    makeActual({
      revocation: {
        note: 'x',
        referencedSourceKey: null,
        before: null,
        excluded: null,
        restored: null,
        failures: ['revocation: no referenced source is available to exclude']
      }
    })
  );
  assert.equal(grade.passed, false);
  assert.ok(grade.failures.some((failure) => failure.includes('revocation:')));
});

test('runEval passes the synthetic smoke fixture and records honest metrics', async () => {
  const outputDir = tempDir('stripsearch-eval-smoke-');
  try {
    const { report, exitCode } = await runEval({
      datasetPath: smokePath,
      datasetDisplayPath: 'apps/web/src/evals/fixtures/smoke.jsonl',
      outputDir,
      repoRoot
    });
    assert.equal(exitCode, 0);
    assert.equal(report.type, 'offline_provider_contract');
    assert.equal(report.summary.started, 5);
    assert.equal(report.summary.passed, 5);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.hardFailures, 0);
    assert.equal(report.summary.modelCalls, 0);
    assert.equal(report.summary.networkCalls, 0);
    assert.equal(report.summary.passRate.value, 1);
    assert.ok(report.notEvaluated.some((entry) => entry.includes('semantic_entailment')));
    assert.ok(existsSync(path.join(outputDir, 'report.json')));
    assert.ok(existsSync(path.join(outputDir, 'report.md')));
    assert.deepEqual(verifyReportConsistency(report), []);

    const github = report.cases.find((entry) => entry.caseId === 'fx-gh-001');
    assert.equal(github?.revocation?.excluded?.excluded, true);
    assert.equal(github?.revocation?.excluded?.affectedValidity.every((value) => value === 'review'), true);
    assert.equal(github?.revocation?.restored?.excluded, false);
    assert.equal(github?.revocation?.restored?.reviewCount, 0);

    const tampered = JSON.parse(JSON.stringify(report)) as EvalReport;
    tampered.summary.passed += 1;
    assert.ok(verifyReportConsistency(tampered).some((failure) => failure.includes('summary')));

    const tamperedCase = JSON.parse(JSON.stringify(report)) as EvalReport;
    const target = tamperedCase.cases[0];
    assert.ok(target);
    target.failures = ['tampered'];
    tamperedCase.summary.failed = 1;
    assert.ok(verifyReportConsistency(tamperedCase).some((failure) => failure.includes('contradicts')));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('Exa replay is configured by default and unusual tags retain honest counters', async () => {
  const dir = tempDir('stripsearch-eval-default-');
  try {
    const lines = readFileSync(smokePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const exa = lines.find((entry) => entry.case_id === 'fx-exa-002');
    assert.ok(exa);
    delete exa.config;
    exa.tags = ['__proto__', 'constructor'];
    const datasetPath = path.join(dir, 'default.jsonl');
    writeFileSync(datasetPath, JSON.stringify(exa) + '\n');
    const { report, exitCode } = await runEval({ datasetPath, datasetDisplayPath: 'default.jsonl', outputDir: path.join(dir, 'out'), repoRoot });
    assert.equal(exitCode, 0, report.cases[0]?.failures.join('; '));
    assert.equal(report.summary.fixtureProviderCalls, 2);
    for (const tag of ['__proto__', 'constructor']) assert.deepEqual(report.byTag[tag], { started: 1, passed: 1 });
    assert.deepEqual(verifyReportConsistency(report), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner blocks a real global fetch attempt even when adapter code catches it', async () => {
  const dir = tempDir('stripsearch-eval-network-');
  const originalRun = githubProvider.run;
  const originalFetch = globalThis.fetch;
  let escaped = 0;
  globalThis.fetch = (() => { escaped += 1; throw new Error('fetch escaped the offline guard'); }) as typeof fetch;
  githubProvider.run = async function (input, context) {
    try { await globalThis.fetch('https://must-never-connect.invalid/'); } catch { /* simulate a swallowed regression */ }
    return originalRun.call(this, input, context);
  };
  try {
    const { report, exitCode } = await runEval({ datasetPath: smokePath, datasetDisplayPath: 'smoke.jsonl', outputDir: dir, repoRoot });
    assert.equal(escaped, 0, 'the underlying fetch must never run');
    assert.equal(exitCode, 1);
    assert.equal(report.summary.hardFailures, 1);
    const github = report.cases.find((entry) => entry.caseId === 'fx-gh-001');
    assert.equal(report.summary.networkCalls, 0);
    assert.equal(report.summary.blockedNetworkAttempts, 1);
    assert.equal(github?.actual.state, 'completed');
    assert.equal(github?.passed, false);
    assert.ok(github?.failures.some((entry) => entry.includes('hard_failure:network_attempt')));
  } finally {
    githubProvider.run = originalRun;
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runEval replays provider failures, redirects and timeouts without network', async () => {
  const dir = tempDir('stripsearch-eval-replay-');
  try {
    const cases: Record<string, unknown>[] = [
      {
        case_id: 't-timeout',
        config: { timeout_ms: 20 },
        replay: [{ method: 'GET', url: 'https://api.github.com/users/example', status: 200, delay_ms: 200, json: { login: 'example' } }],
        expect: { state: 'failed', requests: 1, error_code: 'provider_timeout' }
      },
      {
        case_id: 't-redirect',
        replay: [{ method: 'GET', url: 'https://api.github.com/users/example', status: 302, redirected: true, json: {} }],
        expect: { state: 'failed', requests: 1, error_code: 'provider_redirect' }
      },
      {
        case_id: 't-badjson',
        replay: [{ method: 'GET', url: 'https://api.github.com/users/example', status: 200, raw_text: 'not json' }],
        expect: { state: 'failed', requests: 1, error_code: 'provider_bad_response' }
      },
      {
        case_id: 't-needs',
        input: { question: '没有主页的问题', seedUrl: null, provider: 'github' },
        replay: [],
        expect: { state: 'needs_input', requests: 0, identity_status: 'needs_input' }
      },
      {
        case_id: 't-mismatch',
        replay: [
          {
            method: 'GET',
            url: 'https://api.github.com/users/example',
            status: 200,
            json: { login: 'someone-else', html_url: 'https://github.com/someone-else' }
          }
        ],
        expect: { state: 'failed', requests: 1, error_code: 'provider_bad_response' }
      },
      {
        case_id: 't-oversized',
        config: { max_bytes: 64 },
        replay: [
          { method: 'GET', url: 'https://api.github.com/users/example', status: 200, json: { login: 'example', pad: 'x'.repeat(500) } }
        ],
        expect: { state: 'failed', requests: 1, error_code: 'provider_response_too_large' }
      },
      {
        case_id: 't-partial',
        replay: [
          { method: 'GET', url: 'https://api.github.com/users/example', status: 200, json: { login: 'example', html_url: 'https://github.com/example' } },
          {
            method: 'GET',
            url: 'https://api.github.com/users/example/repos?per_page=30&sort=updated&direction=desc&type=owner',
            status: 500,
            json: { message: 'boom' }
          }
        ],
        expect: { state: 'partial', requests: 2 }
      },
      {
        case_id: 't-body',
        input: { question: '检索合成作者', seedUrl: null, provider: 'exa' },
        config: { exa_configured: true },
        replay: [
          {
            method: 'POST',
            url: 'https://api.exa.ai/search',
            status: 200,
            body_includes: ['NEVER_PRESENT'],
            json: { results: [] }
          }
        ],
        expect: { state: 'failed', requests: 1, error_code: 'provider_error' }
      }
    ].map((entry) => rawCase(entry));

    const datasetPath = path.join(dir, 'replay.jsonl');
    writeFileSync(datasetPath, `${cases.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const { report, exitCode } = await runEval({
      datasetPath,
      datasetDisplayPath: 'replay.jsonl',
      outputDir: path.join(dir, 'out'),
      repoRoot
    });

    assert.equal(report.summary.hardFailures, 1);
    assert.equal(exitCode, 1);
    assert.equal(report.summary.networkCalls, 0);
    const byId = new Map(report.cases.map((entry) => [entry.caseId, entry]));
    for (const id of ['t-timeout', 't-redirect', 't-badjson', 't-needs', 't-mismatch', 't-oversized', 't-partial']) {
      const entry = byId.get(id);
      assert.ok(entry, `missing case ${id}`);
      assert.equal(entry.passed, true, `${id}: ${entry.failures.join('; ')}`);
    }
    const body = byId.get('t-body');
    assert.equal(body?.passed, false);
    assert.equal(body?.hardFailure, true);
    assert.ok(body?.failures.some((failure) => failure.includes('hard_failure:body_mismatch')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runEval filters by split and rejects an empty split', async () => {
  const dir = tempDir('stripsearch-eval-split-');
  const outputDir = path.join(dir, 'out');
  try {
    const { report } = await runEval({
      datasetPath: smokePath,
      datasetDisplayPath: 'smoke.jsonl',
      outputDir,
      split: 'regression',
      repoRoot
    });
    assert.equal(report.cases.length, 2);
    assert.ok(report.cases.every((entry) => entry.split === 'regression'));

    const discoveryOnlyPath = path.join(dir, 'discovery-only.jsonl');
    writeFileSync(discoveryOnlyPath, `${JSON.stringify(rawCase({ case_id: 'only-discovery', split: 'discovery' }))}\n`, 'utf8');
    await assert.rejects(
      runEval({ datasetPath: discoveryOnlyPath, datasetDisplayPath: 'discovery-only.jsonl', outputDir, split: 'regression', repoRoot }),
      (error: unknown) => error instanceof Error && error.message.includes('no cases match')
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli reports non-zero exit codes for failing and invalid datasets', async () => {
  const dir = tempDir('stripsearch-eval-cli-');
  try {
    const failingCase = rawCase({
      case_id: 'failing-1',
      input: { question: '检索合成作者', seedUrl: null, provider: 'exa' },
      replay: [],
      expect: { state: 'completed', requests: 0 }
    });
    const failingPath = path.join(dir, 'failing.jsonl');
    writeFileSync(failingPath, `${JSON.stringify(failingCase)}\n`, 'utf8');
    const failingOut = path.join(dir, 'out-failing');
    const failingCode = await runCli(['--dataset', failingPath, '--output', failingOut]);
    assert.equal(failingCode, 1);
    const report = JSON.parse(readFileSync(path.join(failingOut, 'report.json'), 'utf8')) as EvalReport;
    assert.equal(report.summary.failed, 1);
    assert.equal(report.cases[0]?.passed, false);

    const invalidPath = path.join(dir, 'invalid.jsonl');
    writeFileSync(invalidPath, `${JSON.stringify(rawCase({ unexpected: true }))}\n`, 'utf8');
    assert.equal(await runCli(['--dataset', invalidPath, '--output', path.join(dir, 'out-invalid')]), 2);
    assert.equal(await runCli(['--dataset', failingPath, '--split', 'nope']), 2);
    assert.equal(await runCli(['--dataset', path.join(dir, 'missing.jsonl')]), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the eval CLI entry exits non-zero when a case fails', () => {
  const dir = tempDir('stripsearch-eval-entry-');
  try {
    const failingCase = rawCase({
      case_id: 'entry-failing',
      input: { question: '检索合成作者', seedUrl: null, provider: 'exa' },
      replay: [],
      expect: { state: 'completed', requests: 0 }
    });
    const datasetPath = path.join(dir, 'entry.jsonl');
    writeFileSync(datasetPath, `${JSON.stringify(failingCase)}\n`, 'utf8');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/evals/run.ts', '--dataset', datasetPath, '--output', path.join(dir, 'out')],
      { cwd: webRoot, encoding: 'utf8' }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.ok(existsSync(path.join(dir, 'out', 'report.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
