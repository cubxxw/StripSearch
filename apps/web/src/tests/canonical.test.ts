import assert from 'node:assert/strict';
import test from 'node:test';
import { countReviewItems, renderJson, renderMarkdown, reviewReason } from '../shared/canonical.js';
import { isPublicHttpsUrl, screenQuestion, validateQuestion, validateSeedUrl } from '../shared/validation.js';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView } from '../shared/types.js';

function sampleView(overrides: Partial<CanonicalView> = {}): CanonicalView {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_test',
    state: 'completed',
    revision: 2,
    question: 'example 做过什么？',
    seedUrl: 'https://github.com/example',
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    interrupted: false,
    stopReason: 'test',
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
        sourceKey: 'S1',
        url: 'https://github.com/example',
        title: 'example · GitHub 公开主页',
        kind: 'profile',
        publishedAt: null,
        retrievedAt: '2024-01-02T00:00:00.000Z',
        fetchStatus: 'ok',
        excerpt: '公开简介',
        excerptLocator: '公开简介',
        identityLabel: '种子账号',
        identityConfirmed: true,
        limits: [],
        excluded: false,
        excludedAt: null
      },
      {
        sourceKey: 'S2',
        url: 'https://github.com/example/repo',
        title: 'example/repo',
        kind: 'work',
        publishedAt: '2024-01-01T00:00:00.000Z',
        retrievedAt: '2024-01-02T00:00:00.000Z',
        fetchStatus: 'excluded',
        excerpt: '仓库简介',
        excerptLocator: '仓库简介',
        identityLabel: '种子账号的公开仓库',
        identityConfirmed: true,
        limits: ['仓库归属该账号。'],
        excluded: true,
        excludedAt: '2024-01-03T00:00:00.000Z'
      }
    ],
    observations: [
      {
        observationId: 'obs_1',
        statement: '仓库 repo 的公开简介。',
        kind: 'factual',
        sourceKeys: ['S2'],
        limitations: ['仅元数据。'],
        validity: 'review',
        reviewReason: 'S2 已撤下'
      }
    ],
    answer: [
      {
        id: 'works',
        heading: '做过什么',
        body: '公开仓库：',
        bullets: [
          {
            text: 'repo：一个公开仓库。',
            sourceKeys: ['S2'],
            kind: 'factual',
            validity: 'review',
            reviewReason: 'S2 已撤下'
          },
          {
            text: '账号公开了仓库。',
            sourceKeys: ['S1'],
            kind: 'factual',
            validity: 'valid',
            reviewReason: null
          }
        ]
      }
    ],
    limitations: ['未读取代码。'],
    usage: { provider: 'github', requests: 2, bytes: 100, elapsedMs: 5, measurement: 'observed' },
    reviewCount: 0,
    ...overrides
  };
}

test('markdown and JSON render from the same canonical view with invalidation markers', () => {
  const view = sampleView();
  const markdown = renderMarkdown(view);
  assert.ok(markdown.includes('# Example · 研究报告'));
  assert.ok(markdown.includes('https://github.com/example/repo'));
  assert.match(markdown, /\[待复核 · S2 已撤下\]/);
  assert.ok(markdown.includes('未读取代码。'));
  assert.equal(markdown.includes('[S2]'), true);

  const json = JSON.parse(renderJson(view)) as CanonicalView;
  assert.equal(json.runId, view.runId);
  assert.equal(json.answer[0]?.bullets[0]?.validity, 'review');
  assert.equal(json.sources[1]?.excluded, true);
});

test('review helpers compute dependency invalidation deterministically', () => {
  const excluded = new Set(['S2']);
  assert.equal(reviewReason(['S1', 'S2'], excluded), 'S2 已撤下');
  assert.equal(reviewReason(['S1'], excluded), null);
  const view = sampleView();
  assert.equal(countReviewItems(view.observations, view.answer), 2);
});

test('validation rejects private and non-https sources and clearly disallowed questions', () => {
  assert.equal(isPublicHttpsUrl('https://example.com/ok'), true);
  assert.equal(isPublicHttpsUrl('http://example.com'), false);
  assert.equal(isPublicHttpsUrl('data:text/html,hi'), false);
  assert.equal(isPublicHttpsUrl('https://10.0.0.1/x'), false);
  assert.equal(isPublicHttpsUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isPublicHttpsUrl('https://user:pass@example.com/x'), false);

  assert.equal(validateQuestion('').ok, false);
  assert.equal(validateQuestion('ab').ok, true);
  assert.equal(validateQuestion('x'.repeat(600)).ok, false);

  const missingHost = validateSeedUrl('https://');
  assert.equal(missingHost.ok, false);
  assert.equal(validateSeedUrl('https://example.com').ok, true);

  assert.equal(screenQuestion('他的家庭住址在哪里？').disallowed, true);
  assert.equal(screenQuestion('帮我查一下手机号和联系方式').disallowed, true);
  assert.equal(screenQuestion('揭露这个匿名账号的真实身份').disallowed, true);
  assert.equal(screenQuestion('他做过哪些公开项目？').disallowed, false);
});


test('Markdown treats upstream HTML and line breaks as source text', () => {
  const view = sampleView();
  view.sources[0]!.title = '<img src=x onerror=alert(1)>';
  view.sources[0]!.excerpt = 'safe\n<script>alert(1)</script> & text';
  view.sources[0]!.url = 'https://example.com/\n<script>alert(1)</script>';
  view.answer[0]!.bullets[0]!.text = '<iframe src=https://example.com>content</iframe>';
  const markdown = renderMarkdown(view);
  assert.doesNotMatch(markdown, /<img|<script|<iframe/);
  assert.match(markdown, /&lt;img/);
  assert.match(markdown, /&amp; text/);
  assert.match(markdown, /链接无效/);
  assert.equal(isPublicHttpsUrl('https://example.com/a\nb'), false);
  assert.equal(validateSeedUrl('https://example.com/a\tb').ok, false);
});
