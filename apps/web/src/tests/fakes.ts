import { NeedsInputError } from '../shared/types.js';
import type { ProviderResult, ProviderName, RunInput, SourceDraft } from '../shared/types.js';
import type { ProviderContext, ProviderFactory, ResearchProvider } from '../server/adapters/types.js';

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function sampleResult(overrides: Partial<ProviderResult> = {}): ProviderResult {
  const sources: SourceDraft[] = [
    {
      key: 'S1',
      url: 'https://github.com/example',
      title: 'example · GitHub 公开主页',
      kind: 'profile',
      publishedAt: null,
      excerpt: '公开简介：示例研究者。',
      excerptLocator: '公开简介',
      identityLabel: '种子账号',
      identityConfirmed: true,
      fetchStatus: 'ok',
      limits: ['资料由账号本人维护。']
    },
    {
      key: 'S2',
      url: 'https://github.com/example/repo',
      title: 'example/repo',
      kind: 'work',
      publishedAt: '2024-01-01T00:00:00Z',
      excerpt: '一个公开仓库。',
      excerptLocator: '仓库简介',
      identityLabel: '种子账号的公开仓库',
      identityConfirmed: true,
      fetchStatus: 'ok',
      limits: ['仓库归属该账号。']
    }
  ];
  const result: ProviderResult = {
    state: 'completed',
    identity: {
      displayName: 'Example',
      handle: 'example',
      profileUrl: 'https://github.com/example',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources,
    observations: [
      {
        statement: '示例账号的公开主页显示姓名为 Example。',
        kind: 'attributed_statement',
        sourceKeys: ['S1'],
        limitations: ['本人自述。']
      },
      {
        statement: '仓库 repo 的公开简介为一个公开仓库。',
        kind: 'factual',
        sourceKeys: ['S2'],
        limitations: ['仅读取元数据。']
      }
    ],
    answer: [
      {
        id: 'identity',
        heading: '这个人是谁',
        body: '以下信息来自公开资料。',
        bullets: [
          { text: '公开姓名为 Example。', sourceKeys: ['S1'], kind: 'attributed_statement' }
        ]
      },
      {
        id: 'works',
        heading: '做过什么',
        body: '公开仓库：',
        bullets: [
          { text: 'repo：一个公开仓库。', sourceKeys: ['S2'], kind: 'factual' }
        ]
      },
      {
        id: 'facts',
        heading: '查到的事实',
        body: '可直接核对的事实。',
        bullets: [{ text: '账号公开了至少一个仓库。', sourceKeys: ['S2'], kind: 'factual' }]
      },
      {
        id: 'explanations',
        heading: '可能的解释',
        body: '以下为解释。',
        bullets: [{ text: '可能持续维护该仓库。', sourceKeys: ['S2'], kind: 'inference' }]
      },
      {
        id: 'unknowns',
        heading: '还不确定',
        body: '无法确认。',
        bullets: [{ text: '未读取代码。', sourceKeys: [], kind: 'inference' }]
      }
    ],
    limitations: ['示例限制：未读取代码。'],
    usage: { requests: 2, bytes: 256 },
    stopReason: 'fake_provider'
  };
  return { ...result, ...overrides };
}

export interface FakeProviderOptions {
  name?: ProviderName;
  result?: ProviderResult;
  hold?: Promise<void>;
  holdFactory?: () => Promise<void>;
  error?: Error;
  needsInput?: boolean;
  onStarted?: () => void;
}

export function createFakeProvider(options: FakeProviderOptions = {}): ResearchProvider {
  const result = options.result ?? sampleResult();
  return {
    name: options.name ?? 'github',
    available: true,
    async run(_input: RunInput, context: ProviderContext): Promise<ProviderResult> {
      options.onStarted?.();
      if (options.needsInput) throw new NeedsInputError('请补充主页链接。');
      if (options.error) throw options.error;
      context.report.stage(0, 2, 'stage-0', '读取公开资料', 'active');
      const first = result.sources[0];
      if (first) context.report.source(first);
      context.report.stage(0, 2, 'stage-0', '读取公开资料', 'done');
      const hold = options.holdFactory ? options.holdFactory() : options.hold;
      if (hold) await hold;
      context.report.stage(1, 2, 'stage-1', '整理结论', 'active');
      const second = result.sources[1];
      if (second) context.report.source(second);
      return result;
    }
  };
}

export function createFakeFactory(options: FakeProviderOptions = {}): ProviderFactory {
  return (name: ProviderName) => createFakeProvider({ ...options, name });
}
