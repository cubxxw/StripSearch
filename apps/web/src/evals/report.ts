/**
 * Runtime-v1 report writers. The report always keeps failures, timeouts and
 * hard failures in the denominator and never reduces the run to a single score.
 */

import type { CanonicalView } from '../shared/types.js';
import type { EvalCase, EvalExpect, EvalSplit } from './schema.js';
import type { CaseActual, CaseGrade } from './grade.js';
import type { RevocationReport } from './revocation.js';
import type { FixtureCall, FixtureViolation } from './fixture-transport.js';

export const REPORT_TYPE = 'offline_provider_contract';
export const REPORT_SCHEMA_VERSION = 'eval-report/v1';

export const NOT_EVALUATED: string[] = [
  'semantic_entailment: N/A — reference keys existing is not citation entailment',
  'real_source_coverage: N/A — fixtures are replayed, not fetched',
  'model_accuracy: N/A — no model judge and no paid calls in this track',
  'cost: N/A — no paid provider call was made, so spend is unknown rather than zero'
];

export interface CaseResult {
  case: EvalCase;
  actual: CaseActual;
  grade: CaseGrade;
  canonical: CanonicalView | null;
  markdown: string | null;
  canonicalJson: string | null;
}

export interface ReportSourceMeta {
  datasetPath: string;
  datasetSha256: string;
  splitFilter: EvalSplit | null;
  commit: string | null;
  dirty: boolean | null;
  dirtyPaths: number | null;
  nodeVersion: string;
}

export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface Counter {
  started: number;
  passed: number;
}

export interface ReportSummary {
  started: number;
  passed: number;
  failed: number;
  hardFailures: number;
  unreviewed: number;
  passRate: Ratio;
  modelCalls: number;
  networkCalls: number;
  blockedNetworkAttempts: number;
  fixtureProviderCalls: number;
}

export interface CaseReport {
  caseId: string;
  title: string;
  family: string;
  split: EvalSplit;
  tags: string[];
  mode: EvalCase['mode'];
  provider: string;
  reviewStatus: string;
  expected: EvalExpect;
  actual: {
    state: CaseActual['state'];
    errorCode: string | null;
    identityStatus: string | null;
    sourceCount: number | null;
    requestCount: number;
    disallowed: boolean | null;
    unconsumedReplay: number;
    networkAttempts: number;
  };
  passed: boolean;
  hardFailure: boolean;
  failures: string[];
  calls: FixtureCall[];
  violations: FixtureViolation[];
  revocation: RevocationReport | null;
  roundTripFailures: string[];
  canonical: CanonicalView | null;
}

export interface EvalReport {
  type: typeof REPORT_TYPE;
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  durationMs: number;
  source: ReportSourceMeta;
  summary: ReportSummary;
  bySplit: Record<string, Counter>;
  byTag: Record<string, Counter>;
  byProvider: Record<string, Counter>;
  notEvaluated: string[];
  cases: CaseReport[];
}

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function providerOf(evalCase: EvalCase): string {
  return evalCase.mode === 'scope' ? 'scope' : evalCase.input.provider ?? 'unknown';
}

export interface Aggregates {
  summary: ReportSummary;
  bySplit: Record<string, Counter>;
  byTag: Record<string, Counter>;
  byProvider: Record<string, Counter>;
}

export function computeAggregates(results: CaseResult[]): Aggregates {
  const bySplit: Record<string, Counter> = Object.create(null) as Record<string, Counter>;
  const byTag: Record<string, Counter> = Object.create(null) as Record<string, Counter>;
  const byProvider: Record<string, Counter> = Object.create(null) as Record<string, Counter>;
  let passed = 0;
  let hardFailures = 0;
  let unreviewed = 0;
  let fixtureProviderCalls = 0;
  let blockedNetworkAttempts = 0;

  const bump = (bucket: Record<string, Counter>, key: string, ok: boolean): void => {
    const current = bucket[key] ?? { started: 0, passed: 0 };
    current.started += 1;
    if (ok) current.passed += 1;
    bucket[key] = current;
  };

  for (const result of results) {
    const ok = result.grade.passed;
    if (ok) passed += 1;
    if (result.grade.hardFailure) hardFailures += 1;
    if (result.case.review_status === 'unreviewed') unreviewed += 1;
    fixtureProviderCalls += result.actual.providerCalls;
    blockedNetworkAttempts += result.actual.networkAttempts.length;
    bump(bySplit, result.case.split, ok);
    for (const tag of result.case.tags) bump(byTag, tag, ok);
    bump(byProvider, providerOf(result.case), ok);
  }

  const started = results.length;
  return {
    summary: {
      started,
      passed,
      failed: started - passed,
      hardFailures,
      unreviewed,
      passRate: ratio(passed, started),
      modelCalls: 0,
      networkCalls: 0,
      blockedNetworkAttempts,
      fixtureProviderCalls
    },
    bySplit,
    byTag,
    byProvider
  };
}

function caseReport(result: CaseResult): CaseReport {
  const { case: evalCase, actual, grade } = result;
  const provider = providerOf(evalCase);
  const identityStatus = actual.result?.identity.status ?? (actual.state === 'needs_input' ? 'needs_input' : null);
  const sourceCount = actual.result ? actual.result.sources.length : null;
  return {
    caseId: evalCase.case_id,
    title: evalCase.title,
    family: evalCase.family,
    split: evalCase.split,
    tags: evalCase.tags,
    mode: evalCase.mode,
    provider,
    reviewStatus: evalCase.review_status,
    expected: evalCase.expect,
    actual: {
      state: actual.state,
      errorCode: actual.errorCode,
      identityStatus,
      sourceCount,
      requestCount: actual.providerCalls,
      disallowed: actual.scopeDisallowed,
      unconsumedReplay: actual.unconsumedReplay,
      networkAttempts: actual.networkAttempts.length
    },
    passed: grade.passed,
    hardFailure: grade.hardFailure,
    failures: grade.failures,
    calls: actual.calls,
    violations: actual.violations,
    revocation: actual.revocation,
    roundTripFailures: actual.roundTripFailures,
    canonical: result.canonical
  };
}

export function buildReport(results: CaseResult[], meta: {
  generatedAt: string;
  durationMs: number;
  source: ReportSourceMeta;
}): EvalReport {
  const aggregates = computeAggregates(results);
  return {
    type: REPORT_TYPE,
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    durationMs: meta.durationMs,
    source: meta.source,
    summary: aggregates.summary,
    bySplit: aggregates.bySplit,
    byTag: aggregates.byTag,
    byProvider: aggregates.byProvider,
    notEvaluated: NOT_EVALUATED,
    cases: results.map(caseReport)
  };
}

/**
 * Recompute the aggregates from the per-case rows and check internal
 * consistency. A tampered report (for example a summary that claims more passes
 * than the case rows) is rejected.
 */
export function verifyReportConsistency(report: EvalReport): string[] {
  const failures: string[] = [];
  const recomputed = computeAggregates(
    report.cases.map((entry) => ({
      case: {
        case_id: entry.caseId,
        dataset_version: '',
        title: entry.title,
        family: entry.family,
        split: entry.split,
        review_status: entry.reviewStatus,
        tags: entry.tags,
        mode: entry.mode,
        input: { question: '', seedUrl: null, provider: entry.provider === 'scope' ? null : (entry.provider as 'github' | 'exa') },
        replay: [],
        expect: entry.expected,
        check_revocation: false,
        config: {}
      } satisfies EvalCase,
      actual: { providerCalls: entry.actual.requestCount, networkAttempts: new Array(entry.actual.networkAttempts).fill('x') } as CaseActual,
      grade: { passed: entry.passed, hardFailure: entry.hardFailure, failures: entry.failures },
      canonical: null,
      markdown: null,
      canonicalJson: null
    }))
  );
  if (JSON.stringify(recomputed.summary) !== JSON.stringify(report.summary)) {
    failures.push('report: summary does not match per-case rows');
  }
  if (JSON.stringify(recomputed.bySplit) !== JSON.stringify(report.bySplit)) {
    failures.push('report: bySplit counts do not match per-case rows');
  }
  if (JSON.stringify(recomputed.byTag) !== JSON.stringify(report.byTag)) {
    failures.push('report: byTag counts do not match per-case rows');
  }
  if (JSON.stringify(recomputed.byProvider) !== JSON.stringify(report.byProvider)) {
    failures.push('report: byProvider counts do not match per-case rows');
  }
  for (const entry of report.cases) {
    if (entry.passed !== (entry.failures.length === 0)) {
      failures.push(`report: case ${entry.caseId} pass flag contradicts its failure list`);
    }
    if (entry.passed && entry.hardFailure) {
      failures.push(`report: case ${entry.caseId} is marked passed while hard-failed`);
    }
  }
  return failures;
}

function countTable(title: string, buckets: Record<string, Counter>): string[] {
  const lines: string[] = [`### ${title}`, '', '| key | started | passed |', '| --- | ---: | ---: |'];
  const keys = Object.keys(buckets).sort();
  if (keys.length === 0) lines.push('| (none) | 0 | 0 |');
  for (const key of keys) {
    const bucket = buckets[key];
    if (!bucket) continue;
    lines.push(`| ${key} | ${bucket.started} | ${bucket.passed} |`);
  }
  lines.push('');
  return lines;
}

export function renderReportMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Runtime evaluation v1 · ${report.type}`);
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 运行耗时：${report.durationMs} ms`);
  lines.push(`- 数据集：${report.source.datasetPath}`);
  lines.push(`- 数据集 SHA256：${report.source.datasetSha256}`);
  lines.push(`- split 过滤：${report.source.splitFilter ?? '（全部）'}`);
  lines.push(`- 代码 commit：${report.source.commit ?? '未知'}${report.source.dirty === null ? '' : report.source.dirty ? `（dirty，${report.source.dirtyPaths ?? '?'} 个变更）` : '（clean）'}`);
  lines.push(`- Node：${report.source.nodeVersion}`);
  lines.push('');
  lines.push('> 这是离线 provider 契约回放，不是真实检索或人物事实准确率。');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  const rate = report.summary.passRate.value === null ? 'N/A' : `${(report.summary.passRate.value * 100).toFixed(1)}%`;
  lines.push(`- 启动 / 通过 / 失败：${report.summary.started} / ${report.summary.passed} / ${report.summary.failed}`);
  lines.push(`- 硬失败：${report.summary.hardFailures}`);
  lines.push(`- 未评审：${report.summary.unreviewed}`);
  lines.push(`- 通过率：${rate}（${report.summary.passRate.numerator}/${report.summary.passRate.denominator}）`);
  lines.push(`- 模型调用：${report.summary.modelCalls}`);
  lines.push(`- 外网调用：${report.summary.networkCalls}`);
  lines.push(`- 拦截的出网企图：${report.summary.blockedNetworkAttempts}`);
  lines.push(`- 模拟 provider 调用：${report.summary.fixtureProviderCalls}`);
  lines.push('');
  lines.push(...countTable('按 split', report.bySplit));
  lines.push(...countTable('按 tag', report.byTag));
  lines.push(...countTable('按 provider', report.byProvider));
  lines.push('## 未评估 / N/A');
  lines.push('');
  for (const item of report.notEvaluated) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## 个案');
  lines.push('');
  for (const entry of report.cases) {
    lines.push(`### ${entry.caseId} · ${entry.title}`);
    lines.push('');
    lines.push(`- mode/provider：${entry.mode} / ${entry.provider}`);
    lines.push(`- family/split：${entry.family} / ${entry.split}`);
    lines.push(`- tags：${entry.tags.length > 0 ? entry.tags.join('、') : '（无）'}`);
    lines.push(`- review_status：${entry.reviewStatus}`);
    lines.push(`- 期望状态：${entry.expected.mode === 'provider' ? entry.expected.state : `disallowed=${entry.expected.disallowed}`}`);
    lines.push(`- 实际状态：${entry.actual.state}${entry.actual.errorCode ? ` (${entry.actual.errorCode})` : ''}`);
    lines.push(`- 请求数：期望 ${entry.expected.requests} / 实际 ${entry.actual.requestCount}`);
    lines.push(`- 结果：${entry.passed ? '✅ 通过' : '❌ 失败'}${entry.hardFailure ? ' · 硬失败' : ''}`);
    if (entry.failures.length > 0) {
      lines.push('- 失败原因：');
      for (const failure of entry.failures) lines.push(`  - ${failure}`);
    }
    if (entry.revocation) {
      lines.push(`- 撤销检查：${entry.revocation.failures.length === 0 ? '通过' : '失败'}（来源 ${entry.revocation.referencedSourceKey ?? '无'}）`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
