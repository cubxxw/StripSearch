import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXA_API_ORIGIN,
  buildExaResult,
  createExaProvider,
  dedupeExaResults,
  extractAnswerPayload,
  parseExaResult
} from '../server/adapters/exa.js';
import type { HttpResponseLike, HttpTransport, ProviderContext } from '../server/adapters/types.js';
import { ProviderError } from '../server/adapters/types.js';

function bodyStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: bodyStream(text),
    text: async () => text
  };
}

interface FakeTransport extends HttpTransport {
  calls: { url: string; body: unknown }[];
}

function fakeTransport(handler: (url: string) => HttpResponseLike): FakeTransport {
  const calls: { url: string; body: unknown }[] = [];
  return {
    calls,
    async fetch(url, init) {
      let parsed: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          parsed = JSON.parse(init.body);
        } catch {
          parsed = init.body;
        }
      }
      calls.push({ url, body: parsed });
      return handler(url);
    }
  };
}

function context(transport: HttpTransport, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    transport,
    signal: new AbortController().signal,
    report: { stage: () => undefined, source: () => undefined },
    githubToken: null,
    exaApiKey: 'test-key',
    timeoutMs: 500,
    maxBytes: 64 * 1024,
    ...overrides
  };
}

const input = { question: '研究问题', seedUrl: 'https://seed.example.com/page', provider: 'exa' as const };

test('parseExaResult drops non-public URLs and bounds excerpts', () => {
  assert.equal(parseExaResult({ url: 'javascript:alert(1)', title: 'x' }), null);
  assert.equal(parseExaResult({ url: 'http://example.com', title: 'x' }), null);
  assert.equal(parseExaResult({ url: 'https://localhost/x', title: 'x' }), null);
  const parsed = parseExaResult({ url: 'https://example.com/x', title: 'Title', text: 'y'.repeat(3000) });
  assert.ok(parsed);
  assert.ok((parsed.excerpt ?? '').length <= 1201);
});

test('exa provider grounds both calls with the seed and keeps source events consistent', async () => {
  const reported: unknown[] = [];
  const transport = fakeTransport((url) => {
    if (url.endsWith('/search')) {
      return jsonResponse(200, {
        results: [
          { url: 'https://a.example.com/1', title: 'A', text: 'A excerpt', publishedDate: '2024-01-01' },
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'https://a.example.com/1', title: 'A duplicate', text: 'dup' },
          { url: 'https://b.example.com/2', title: 'B', text: 'B excerpt' }
        ]
      });
    }
    return jsonResponse(200, {
      answer: '整理后的回答，引用 A。',
      citations: [
        { url: 'https://a.example.com/1', title: 'A', text: 'citation excerpt' },
        { url: 'https://b.example.com/2', title: 'B', text: 'citation excerpt' }
      ]
    });
  });
  const provider = createExaProvider('test-key');
  const result = await provider.run(input, {
    ...context(transport),
    report: { stage: () => undefined, source: (source) => reported.push(source) }
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(
    transport.calls.map((call) => call.url),
    [`${EXA_API_ORIGIN}/search`, `${EXA_API_ORIGIN}/answer`]
  );
  const searchBody = transport.calls[0]?.body as Record<string, unknown> | undefined;
  assert.equal(searchBody?.numResults, 6);
  assert.match(String(searchBody?.query), /seed\.example\.com/);
  const answerBody = transport.calls[1]?.body as Record<string, unknown> | undefined;
  assert.match(String(answerBody?.query), /seed\.example\.com/);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://a.example.com/1', 'https://b.example.com/2']);
  assert.deepEqual(JSON.parse(JSON.stringify(reported)), JSON.parse(JSON.stringify(result.sources)));
  assert.equal(JSON.stringify(result).includes('javascript:'), false);
});

test('a single invalid or missing citation omits the generated answer', async () => {
  for (const citations of [
    [{ url: 'https://a.example.com/1' }, { url: 'not-a-url' }],
    []
  ]) {
    const transport = fakeTransport((url) => {
      if (url.endsWith('/search')) {
        return jsonResponse(200, { results: [{ url: 'https://a.example.com/1', title: 'A', text: 'excerpt' }] });
      }
      return jsonResponse(200, { answer: '不应采用的回答。', citations });
    });
    const result = await createExaProvider('test-key').run(input, context(transport));
    assert.equal(result.state, 'partial');
    assert.equal(result.answer.find((section) => section.id === 'synthesis')?.bullets.length, 0);
    assert.ok(result.limitations.some((limit) => limit.includes('整理结果')));
  }
});

test('too many citations drop the generated answer instead of adding unlimited sources', async () => {
  const citations = Array.from({ length: 13 }, (_, index) => ({ url: `https://extra.example.com/${index}` }));
  const transport = fakeTransport((url) => {
    if (url.endsWith('/search')) {
      return jsonResponse(200, { results: [{ url: 'https://a.example.com/1', title: 'A', text: 'excerpt' }] });
    }
    return jsonResponse(200, { answer: '引用过多。', citations });
  });
  const result = await createExaProvider('test-key').run(input, context(transport));
  assert.equal(result.state, 'partial');
  assert.equal(result.answer.find((section) => section.id === 'synthesis')?.bullets.length, 0);
});

test('duplicate and unconfirmed results stay distinct from generated summaries', async () => {
  const transport = fakeTransport((url) => {
    if (url.endsWith('/search')) {
      return jsonResponse(200, {
        results: [
          { url: 'https://dup.example.com/x', title: 'Dup', text: 'excerpt' },
          { url: 'https://dup.example.com/x', title: 'Dup again', text: 'excerpt' },
          { url: 'https://notext.example.com/y', title: 'No text' }
        ]
      });
    }
    return jsonResponse(200, { answer: '摘要。', citations: [{ url: 'https://dup.example.com/x' }] });
  });
  const result = await createExaProvider('test-key').run(input, context(transport));
  assert.equal(dedupeExaResults([
    { url: 'a', title: '', excerpt: null, author: null, publishedDate: null },
    { url: 'a', title: '', excerpt: null, author: null, publishedDate: null }
  ]).length, 1);
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((source) => source.identityConfirmed === false));
  assert.equal(result.identity.status, 'ambiguous');
  assert.equal(result.identity.handle, null);

  const excerptSection = result.answer.find((section) => section.id === 'excerpts');
  const noTextBullet = excerptSection?.bullets.find((bullet) => bullet.sourceKeys[0] === 'S2');
  assert.ok(noTextBullet);
  assert.equal(noTextBullet.kind, 'inference');
  assert.match(noTextBullet.text, /未返回短摘录/);
  const withText = excerptSection?.bullets.find((bullet) => bullet.sourceKeys[0] === 'S1');
  assert.equal(withText?.kind, 'page_statement');
});

test('exa provider rejects private seeds before any call', async () => {
  const transport = fakeTransport(() => jsonResponse(200, { results: [] }));
  await assert.rejects(
    createExaProvider('test-key').run({ ...input, seedUrl: 'http://localhost/x' }, context(transport)),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'provider_bad_response');
      return true;
    }
  );
  assert.equal(transport.calls.length, 0);
});

test('exa provider is unavailable without a key and maps provider errors', async () => {
  const provider = createExaProvider(null);
  assert.equal(provider.available, false);
  await assert.rejects(
    provider.run(input, context(fakeTransport(() => jsonResponse(200, {})), { exaApiKey: null })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'provider_unavailable');
      return true;
    }
  );

  for (const [status, code] of [
    [401, 'provider_forbidden'],
    [429, 'provider_rate_limited'],
    [500, 'provider_error']
  ] as const) {
    const failing = fakeTransport(() => jsonResponse(status, { error: 'nope' }));
    await assert.rejects(provider.run(input, context(failing)), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test('extractAnswerPayload reports invalid citation counts', () => {
  const payload = extractAnswerPayload({
    answer: 42,
    citations: [{ url: 'https://ok.example.com' }, { url: 'data:text/html,x' }]
  });
  assert.equal(payload.answer, null);
  assert.equal(payload.rawCitationCount, 2);
  assert.equal(payload.invalidCitationCount, 1);
  assert.deepEqual(payload.citations.map((citation) => citation.url), ['https://ok.example.com/']);
});

test('buildExaResult keeps the seed account confirmed only on exact match', () => {
  const results = [
    { url: 'https://seed.example.com/page', title: 'Seed', excerpt: 'seed', author: null, publishedDate: null },
    { url: 'https://other.example.com', title: 'Other', excerpt: null, author: null, publishedDate: null }
  ];
  const withSeed = buildExaResult('https://seed.example.com/page', results, 'answer', ['https://seed.example.com/page'], {
    requests: 2,
    bytes: 10
  });
  assert.equal(withSeed.sources[0]?.identityConfirmed, true);
  assert.equal(withSeed.sources[1]?.identityConfirmed, false);
  assert.equal(withSeed.identity.status, 'resolved');
  assert.deepEqual(
    withSeed.answer.map((section) => section.heading),
    ['这个人是谁', '来源摘录', '整理结果', '待核实']
  );

  const withoutSeed = buildExaResult(null, results, 'answer', ['https://seed.example.com/page'], {
    requests: 2,
    bytes: 10
  });
  assert.equal(withoutSeed.identity.status, 'ambiguous');
  assert.ok(withoutSeed.sources.every((source) => source.identityConfirmed === false));
});
