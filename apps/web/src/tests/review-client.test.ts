import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { ApiError } from '../client/api.js';
import { createReviewWorkbench } from '../client/review.js';
import type { ReviewApi } from '../client/review.js';
import type {
  ReviewAnnotationSaveInput,
  ReviewAnnotationView,
  ReviewCaseDetail,
  ReviewCaseResponse,
  ReviewInsights,
  ReviewQueueItem
} from '../shared/review.js';

const env = installDom();

function detailFor(caseId: string, overrides: Partial<ReviewCaseDetail> = {}): ReviewCaseDetail {
  const base: ReviewCaseDetail = {
    caseId,
    datasetVersion: 'behavior-v1',
    split: 'discovery',
    kind: 'practice',
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    asOf: '2026-03-02',
    badge: '合成练习 · 人工编写候选 · 待你判断',
    rubricVersion: 1,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    status: 'unreviewed',
    latestRevision: 0,
    latestStatus: null,
    sources: [
      {
        sourceId: 'S1',
        title: '证据标题 <i>',
        text: '正文 <img src=x onerror="window.__xss=1">',
        locator: '第 1 段'
      }
    ],
    candidates: [
      {
        blindLabel: 'A',
        claims: [
          { claimId: `${caseId}-K1`, text: '候选甲 <script>window.__xss=2</script>' },
          { claimId: `${caseId}-K2`, text: '候选甲论断二' }
        ]
      },
      { blindLabel: 'B', claims: [{ claimId: `${caseId}-K3`, text: '候选乙论断一' }] }
    ],
    claimIds: [`${caseId}-K1`, `${caseId}-K2`, `${caseId}-K3`],
    provenance: null
  };
  return { ...base, ...overrides };
}

function queueFor(caseIds: string[]): ReviewQueueItem[] {
  return caseIds.map((caseId, index) => ({
    caseId,
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    badge: '合成练习 · 人工编写候选 · 待你判断',
    kind: 'practice',
    status: 'unreviewed',
    latestStatus: null,
    latestRevision: 0,
    sourceCount: 1,
    claimCount: 3,
    createdAt: `2026-03-0${index + 1}T00:00:00.000Z`,
    updatedAt: `2026-03-0${index + 1}T00:00:00.000Z`
  }));
}

interface Harness {
  root: HTMLElement;
  queue: ReviewQueueItem[];
  saves: { caseId: string; input: ReviewAnnotationSaveInput }[];
  toasts: { message: string; tone?: 'info' | 'error' }[];
  api: ReviewApi;
  saveHandler: (caseId: string, input: ReviewAnnotationSaveInput) => Promise<{
    annotation: ReviewAnnotationView;
    acknowledgment: string;
  }>;
  workbench: ReturnType<typeof createReviewWorkbench>;
}

function annotationView(input: ReviewAnnotationSaveInput, caseId: string): ReviewAnnotationView {
  return {
    annotationId: 'ann_1',
    revision: input.expectedRevision + 1,
    status: input.status,
    actorPseudonymousId: 'rev_0123456789abcdef',
    caseHash: 'a'.repeat(64),
    rubricVersion: 1,
    decisions: input.decisions,
    preference: input.preference,
    rationale: input.rationale,
    reasonTags: input.reasonTags,
    rubric: input.rubric,
    createdAt: '2026-03-02T00:00:00.000Z'
  };
}

function harness(caseIds: string[], options: { details?: Record<string, ReviewCaseDetail> } = {}): Harness {
  const root = env.document.createElement('div');
  env.document.body.appendChild(root);
  const queue = queueFor(caseIds);
  const details = options.details ?? {};
  const state: Harness = {
    root,
    queue,
    saves: [],
    toasts: [],
    api: null as never,
    saveHandler: async (caseId, input) => ({ annotation: annotationView(input, caseId), acknowledgment: '已保存' }),
    workbench: null as never
  };
  const api: ReviewApi = {
    seedReviewCases: async () => ({ inserted: 0, total: caseIds.length, badge: '' }),
    listReviewCases: async () => ({
      cases: state.queue,
      progress: { total: state.queue.length, reviewed: 0, draft: 0, unreviewed: state.queue.length }
    }),
    createReviewCase: async () => state.queue[0]!,
    getReviewCase: async (caseId) => ({
      case: details[caseId] ?? detailFor(caseId),
      annotation: null,
      history: []
    }),
    getReviewHistory: async () => ({
      history: [
        {
          revision: 1,
          status: 'submitted' as const,
          createdAt: '2026-03-02T00:00:00.000Z',
          actorPseudonymousId: 'rev_0123456789abcdef'
        }
      ],
      revisions: [
        {
          annotationId: 'ann_hist_1',
          revision: 1,
          status: 'submitted' as const,
          actorPseudonymousId: 'rev_0123456789abcdef',
          caseHash: 'a'.repeat(64),
          rubricVersion: 1,
          decisions: [{ claimId: 'case_1-K1', label: 'contradicted' as const, evidenceIds: ['S1'], note: '旧说明' }],
          preference: 'b' as const,
          rationale: '历史理由',
          reasonTags: ['citations' as const],
          rubric: { referenceAnswer: '历史参考', mustInclude: ['旧要点'], mustAvoid: [] },
          createdAt: '2026-03-02T00:00:00.000Z'
        }
      ]
    }),
    saveReviewAnnotation: async (caseId, input) => {
      state.saves.push({ caseId, input });
      return state.saveHandler(caseId, input);
    },
    deleteReviewCase: async () => undefined,
    getReviewInsights: async () => ({
      generatedFrom: 'submitted-latest-revisions-only',
      note: '这些判断用于形成评估标准，尚未运行模型对照。',
      caseCounts: { total: 1, reviewed: 1, draft: 0, unreviewed: 0 },
      factualLabels: { supported: 0, contradicted: 0, insufficient: 1, unassessable: 0 },
      preferenceCounts: { a: 0, b: 0, tie: 1, neither: 0, undecidable: 0 },
      reasonTagCounts: {
        factuality: 0,
        citations: 0,
        coverage: 0,
        counterevidence: 0,
        uncertainty: 0,
        readability: 0
      }
    }),
    exportReview: async () => '{}',
    listResearchTasks: async () => ({ tasks: [], note: '' }),
    getResearchTask: async () => {
      throw new Error('research detail not used in this harness');
    },
    createResearchTask: async () => {
      throw new Error('research import not used in this harness');
    }
  };
  state.api = api;
  state.workbench = createReviewWorkbench({
    api,
    root,
    onToast: (message, tone) => {
      state.toasts.push({ message, tone });
    },
    onNavigate: (caseId) => {
      state.workbench.state.caseId = caseId;
    }
  });
  return state;
}

async function tick(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function query<T extends Element = HTMLElement>(root: HTMLElement, selector: string): T | null {
  return root.querySelector<T>(selector);
}

test('review editor renders upstream text as escaped text, never markup', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  assert.equal(query(h.root, 'img'), null);
  assert.equal(query(h.root, 'script'), null);
  assert.ok(h.root.textContent?.includes('<img src=x onerror='));
  assert.ok(h.root.textContent?.includes('<script>window.__xss=2</script>'));
  assert.equal((env.window as unknown as { __xss?: number }).__xss, undefined);
});

test('a fresh case has no default label, preference or evidence selection', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  assert.equal(h.root.querySelectorAll('input[data-role="claim-label"]:checked').length, 0);
  assert.equal(h.root.querySelectorAll('input[data-role="preference"]:checked').length, 0);
  assert.equal(h.root.querySelectorAll('input[data-role="evidence"]:checked').length, 0);
  assert.equal(h.root.querySelectorAll('input[data-role="reason-tag"]:checked').length, 0);
  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.equal(rationale?.value, '');
});

test('a failed save keeps the typed draft and surfaces an error', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');

  const firstClaim = h.root.querySelector<HTMLElement>('[data-claim-id="case_1-K1"]');
  assert.ok(firstClaim);
  const label = firstClaim.querySelector<HTMLInputElement>('input[data-role="claim-label"][value="insufficient"]');
  assert.ok(label);
  label.checked = true;
  label.dispatchEvent(new env.window.Event('change', { bubbles: true }));

  const note = firstClaim.querySelector<HTMLInputElement>('[data-role="claim-note"]');
  assert.ok(note);
  note.value = '保留的草稿说明';
  note.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '保留的理由草稿';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  h.saveHandler = async () => {
    throw new ApiError(500, 'internal_error', '服务器内部错误。');
  };
  await h.workbench.saveCurrent('draft', false);
  await tick();

  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0]!.input.rationale, '保留的理由草稿');
  const error = query(h.root, '[data-role="error"]');
  assert.ok((error?.textContent ?? '').length > 0);
  // The DOM and the in-memory draft both keep the user's work.
  assert.equal(query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]')?.value, '保留的理由草稿');
  assert.equal(query<HTMLInputElement>(h.root, '[data-role="claim-note"]')?.value, '保留的草稿说明');
  assert.equal(
    h.workbench.state.draft?.decisions.get('case_1-K1')?.note,
    '保留的草稿说明'
  );
});

test('save and next acknowledges only after the response and advances the case', async () => {
  const h = harness(['case_1', 'case_2']);
  await h.workbench.open('case_1');
  const detail = h.workbench.state.detail!;
  const draft = h.workbench.state.draft!;
  for (const claimId of detail.claimIds) {
    draft.decisions.set(claimId, { label: 'insufficient', evidenceIds: [], note: '' });
  }
  draft.preference = 'tie';
  draft.rationale = '提交理由';

  let resolveSave!: (value: { annotation: ReviewAnnotationView; acknowledgment: string }) => void;
  const gate = new Promise<{ annotation: ReviewAnnotationView; acknowledgment: string }>((resolve) => {
    resolveSave = resolve;
  });
  h.saveHandler = async () => gate;

  const pending = h.workbench.saveCurrent('submitted', true);
  await tick();
  const status = query(h.root, '[data-role="status"]');
  assert.notEqual(status?.textContent, '已保存');
  assert.equal(status?.textContent, '正在保存…');

  const input = h.saves[0]!.input;
  resolveSave({ annotation: annotationView(input, 'case_1'), acknowledgment: '已保存' });
  await pending;
  await tick();

  assert.equal(query(h.root, '[data-role="status"]')?.textContent, '已保存');
  assert.equal(h.workbench.state.caseId, 'case_2');
  assert.equal(
    h.workbench.state.queue.find((item) => item.caseId === 'case_1')?.status,
    'reviewed'
  );
  assert.equal(h.workbench.state.progress.reviewed, 1);
});

test('client-side validation blocks an incomplete submission before any request', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  await h.workbench.saveCurrent('submitted', true);
  await tick();
  assert.equal(h.saves.length, 0);
  assert.match(query(h.root, '[data-role="error"]')?.textContent ?? '', /每个论断|偏好|理由/);
});

test('Ctrl/Cmd + Enter saves and next while plain Enter is left to the input', async () => {
  const h = harness(['case_1', 'case_2']);
  await h.workbench.open('case_1');
  const detail = h.workbench.state.detail!;
  const draft = h.workbench.state.draft!;
  for (const claimId of detail.claimIds) {
    draft.decisions.set(claimId, { label: 'insufficient', evidenceIds: [], note: '' });
  }
  draft.preference = 'tie';
  draft.rationale = '快捷键理由';

  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);

  const plain = new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  rationale.dispatchEvent(plain);
  await tick();
  assert.equal(h.saves.length, 0);

  const combo = new env.window.KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  rationale.dispatchEvent(combo);
  await tick();
  assert.equal(combo.defaultPrevented, true);
  assert.equal(h.saves.length, 1);
  assert.equal(h.workbench.state.caseId, 'case_2');
});

test('queue search and status filters change the visible list', async () => {
  const h = harness(['case_1', 'case_2']);
  h.queue[0]!.title = '独特标题甲';
  h.queue[1]!.title = '另一个案例';
  h.queue[1]!.status = 'draft';
  await h.workbench.open('case_1');

  const search = query<HTMLInputElement>(h.root, '[data-role="search"]');
  assert.ok(search);
  search.value = '独特';
  search.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.root.querySelectorAll('.review-queue-item').length, 1);

  search.value = '';
  search.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  const draftFilter = h.root.querySelector<HTMLButtonElement>('[data-filter="draft"]');
  assert.ok(draftFilter);
  draftFilter.click();
  assert.equal(h.root.querySelectorAll('.review-queue-item').length, 1);
  assert.match(h.root.querySelector('.review-queue-item')?.textContent ?? '', /另一个案例/);
});

test('reset clears the previous session queue and editor', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  assert.equal(h.root.querySelectorAll('.review-queue-item').length, 1);
  h.workbench.reset();
  assert.equal(h.workbench.state.queue.length, 0);
  assert.equal(h.workbench.state.detail, null);
  assert.equal(h.workbench.state.draft, null);
  assert.equal(h.root.querySelectorAll('.review-queue-item').length, 0);
  assert.equal(h.root.textContent?.includes('案例 case_1'), false);
});

test('submitted history and provenance reveal after a finalized review', async () => {
  const detail = detailFor('case_1');
  const root = env.document.createElement('div');
  env.document.body.appendChild(root);
  const reviewed: ReviewCaseDetail = {
    ...detail,
    status: 'reviewed',
    latestRevision: 1,
    latestStatus: 'submitted',
    provenance: [
      { blindLabel: 'A', candidateId: 'c1', origin: '人工编写 A', model: null, notes: null },
      { blindLabel: 'B', candidateId: 'c2', origin: '人工编写 B', model: null, notes: null }
    ]
  };
  const api = {
    seedReviewCases: async () => ({ inserted: 0, total: 1, badge: '' }),
    listReviewCases: async () => ({
      cases: queueFor(['case_1']),
      progress: { total: 1, reviewed: 1, draft: 0, unreviewed: 0 }
    }),
    createReviewCase: async () => queueFor(['case_1'])[0]!,
    getReviewCase: async () => ({
      case: reviewed,
      annotation: {
        annotationId: 'ann_1',
        revision: 1,
        status: 'submitted' as const,
        actorPseudonymousId: 'rev_1',
        caseHash: 'a'.repeat(64),
        rubricVersion: 1,
        decisions: [],
        preference: 'tie' as const,
        rationale: '理由',
        reasonTags: [],
        rubric: { referenceAnswer: '', mustInclude: [], mustAvoid: [] },
        createdAt: '2026-03-02T00:00:00.000Z'
      },
      history: [{ revision: 1, status: 'submitted' as const, createdAt: '2026-03-02T00:00:00.000Z', actorPseudonymousId: 'rev_1' }]
    }),
    getReviewHistory: async () => ({
      history: [{ revision: 1, status: 'submitted' as const, createdAt: '2026-03-02T00:00:00.000Z', actorPseudonymousId: 'rev_1' }],
      revisions: [
        {
          annotationId: 'ann_1',
          revision: 1,
          status: 'submitted' as const,
          actorPseudonymousId: 'rev_1',
          caseHash: 'a'.repeat(64),
          rubricVersion: 1,
          decisions: [{ claimId: 'case_1-K1', label: 'insufficient' as const, evidenceIds: [], note: null }],
          preference: 'tie' as const,
          rationale: '历史理由',
          reasonTags: [],
          rubric: { referenceAnswer: '历史参考', mustInclude: [], mustAvoid: [] },
          createdAt: '2026-03-02T00:00:00.000Z'
        }
      ]
    }),
    saveReviewAnnotation: async () => {
      throw new Error('not used');
    },
    deleteReviewCase: async () => undefined,
    getReviewInsights: async () => ({
      generatedFrom: 'submitted-latest-revisions-only' as const,
      note: '',
      caseCounts: { total: 1, reviewed: 1, draft: 0, unreviewed: 0 },
      factualLabels: { supported: 0, contradicted: 0, insufficient: 0, unassessable: 0 },
      preferenceCounts: { a: 0, b: 0, tie: 1, neither: 0, undecidable: 0 },
      reasonTagCounts: {
        factuality: 0,
        citations: 0,
        coverage: 0,
        counterevidence: 0,
        uncertainty: 0,
        readability: 0
      }
    }),
    exportReview: async () => '',
    listResearchTasks: async () => ({ tasks: [], note: '' }),
    getResearchTask: async () => {
      throw new Error('research detail not used in this harness');
    },
    createResearchTask: async () => {
      throw new Error('research import not used in this harness');
    }
  } satisfies ReviewApi;
  const workbench = createReviewWorkbench({ api, root, onToast: () => undefined });
  await workbench.open('case_1');
  assert.match(root.textContent ?? '', /人工编写 A/);
  assert.match(root.textContent ?? '', /历史版本/);
});

test('unsaved changes are tracked and cleared after a successful save', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  assert.equal(h.workbench.hasUnsavedChanges(), false);

  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '未保存的理由';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.hasUnsavedChanges(), true);

  const detail = h.workbench.state.detail!;
  const draft = h.workbench.state.draft!;
  for (const claimId of detail.claimIds) {
    draft.decisions.set(claimId, { label: 'insufficient', evidenceIds: [], note: '' });
  }
  await h.workbench.saveCurrent('draft', false);
  await tick();
  assert.equal(h.workbench.hasUnsavedChanges(), false);
});

test('new-case dialog content counts as unsaved work', async () => {
  const h = harness([]);
  await h.workbench.open(null);
  const button = h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]');
  assert.ok(button);
  button.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '未提交的问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.hasUnsavedChanges(), true);
});

test('history inspection shows old labels and rubric read-only', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  const toggle = h.root.querySelector<HTMLElement>('[data-role="history-toggle"]');
  assert.ok(toggle);
  toggle.click();
  await tick();
  assert.match(h.root.textContent ?? '', /历史理由/);
  assert.match(h.root.textContent ?? '', /历史参考/);
  assert.match(h.root.textContent ?? '', /矛盾/);
  assert.match(h.root.textContent ?? '', /旧说明/);
});

test('phase two shows both candidate texts above the preference choices', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  const summary = h.root.querySelector('.review-candidate-summary');
  assert.ok(summary);
  assert.match(summary.textContent ?? '', /候选甲/);
  assert.match(summary.textContent ?? '', /候选乙论断一/);
});

/* ---------------- delayed-response data-loss regressions ---------------- */

function completeDraft(h: Harness, caseId: string): void {
  const detail = h.workbench.state.detail!;
  const draft = h.workbench.state.draft!;
  assert.equal(detail.caseId, caseId);
  for (const claimId of detail.claimIds) {
    draft.decisions.set(claimId, { label: 'insufficient', evidenceIds: [], note: '' });
  }
  draft.preference = 'tie';
  draft.rationale = '初始理由';
}

test('edits typed while a save is pending are preserved and do not auto-advance', async () => {
  const h = harness(['case_1', 'case_2']);
  await h.workbench.open('case_1');
  completeDraft(h, 'case_1');

  let resolveSave!: (value: { annotation: ReviewAnnotationView; acknowledgment: string }) => void;
  const gate = new Promise<{ annotation: ReviewAnnotationView; acknowledgment: string }>((resolve) => {
    resolveSave = resolve;
  });
  h.saveHandler = async () => gate;

  const pending = h.workbench.saveCurrent('draft', true);
  await tick();

  // The reviewer keeps typing while the request is in flight.
  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '保存期间的修改';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.state.dirty, true);

  const firstInput = h.saves[0]!.input;
  resolveSave({ annotation: annotationView(firstInput, 'case_1'), acknowledgment: '已保存' });
  await pending;
  await tick();

  // Newer edits survive, no auto-next, and the revision still advances.
  assert.equal(h.workbench.state.caseId, 'case_1');
  assert.equal(h.workbench.state.dirty, true);
  assert.match(query(h.root, '[data-role="status"]')?.textContent ?? '', /新修改/);
  assert.equal(h.workbench.state.annotation?.revision, 1);
  assert.equal(h.workbench.state.draft?.rationale, '保存期间的修改');

  // A follow-up save uses the advanced revision and clears the new edits.
  h.saveHandler = async (caseId, input) => ({ annotation: annotationView(input, caseId), acknowledgment: '已保存' });
  await h.workbench.saveCurrent('draft', false);
  await tick();
  assert.equal(h.saves[1]!.input.expectedRevision, 1);
  assert.equal(h.saves[1]!.input.rationale, '保存期间的修改');
  assert.equal(h.workbench.state.dirty, false);
});

test('a late export response after reset does not download or toast', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  let resolveExport!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    resolveExport = resolve;
  });
  h.api.exportReview = async () => gate;

  const exportButton = h.root.querySelector<HTMLButtonElement>('[data-action="export-json"]');
  assert.ok(exportButton);
  exportButton.click();
  await tick();
  h.workbench.reset();
  resolveExport('{"records":[]}');
  await tick(8);
  assert.deepEqual(h.toasts, []);
});

test('a late insights response after reset does not open the summary or toast', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  let resolveInsights!: (value: ReviewInsights) => void;
  const gate = new Promise<ReviewInsights>((resolve) => {
    resolveInsights = resolve;
  });
  h.api.getReviewInsights = async () => gate;

  const button = h.root.querySelector<HTMLButtonElement>('[data-action="insights"]');
  assert.ok(button);
  button.click();
  await tick();
  h.workbench.reset();
  resolveInsights({
    generatedFrom: 'submitted-latest-revisions-only',
    note: '',
    caseCounts: { total: 1, reviewed: 1, draft: 0, unreviewed: 0 },
    factualLabels: { supported: 0, contradicted: 0, insufficient: 1, unassessable: 0 },
    preferenceCounts: { a: 0, b: 0, tie: 1, neither: 0, undecidable: 0 },
    reasonTagCounts: {
      factuality: 0,
      citations: 0,
      coverage: 0,
      counterevidence: 0,
      uncertainty: 0,
      readability: 0
    }
  });
  await tick(8);
  assert.equal(h.workbench.state.insights, null);
  assert.equal(h.workbench.state.insightsOpen, false);
  assert.deepEqual(h.toasts, []);
});

test('a late create-case response after reset does not touch the new session', async () => {
  const h = harness([]);
  await h.workbench.open(null);
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '未提交的问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  let resolveCreate!: (value: ReviewQueueItem) => void;
  const gate = new Promise<ReviewQueueItem>((resolve) => {
    resolveCreate = resolve;
  });
  h.api.createReviewCase = async () => gate;
  const form = h.root.querySelector<HTMLFormElement>('.review-new-modal form');
  assert.ok(form);
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  h.workbench.reset();
  resolveCreate(queueFor(['late'])[0]!);
  await tick(8);
  assert.equal(h.workbench.state.detail, null);
  assert.deepEqual(h.toasts, []);
});

test('a late seed response after reset does not toast or refresh', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  let resolveSeed!: (value: { inserted: number; total: number; badge: string }) => void;
  const gate = new Promise<{ inserted: number; total: number; badge: string }>((resolve) => {
    resolveSeed = resolve;
  });
  h.api.seedReviewCases = async () => gate;

  h.root.querySelector<HTMLButtonElement>('[data-action="seed"]')!.click();
  await tick();
  h.workbench.reset();
  resolveSeed({ inserted: 10, total: 10, badge: '' });
  await tick(8);
  assert.deepEqual(h.toasts, []);
});

test('refresh() refuses to discard unsaved edits when the reviewer declines', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '未保存';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  const originalConfirm = env.window.confirm;
  let asked = false;
  env.window.confirm = () => {
    asked = true;
    return false;
  };
  try {
    await h.workbench.refresh();
    assert.equal(asked, true);
    assert.equal(h.workbench.state.dirty, true);
    assert.equal(query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]')?.value, '未保存');
  } finally {
    env.window.confirm = originalConfirm;
  }
});

test('closing the new-case dialog with content asks before discarding', async () => {
  const h = harness([]);
  await h.workbench.open(null);
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '草稿问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  const dialog = h.root.querySelector<HTMLDialogElement>('.review-new-modal');
  assert.ok(dialog);
  assert.equal(dialog.open, true);

  const originalConfirm = env.window.confirm;
  try {
    env.window.confirm = () => false;
    h.root.querySelector<HTMLButtonElement>('[data-action="close-new-case"]')!.click();
    assert.equal(dialog.open, true);

    const cancelEvent = new env.window.Event('cancel', { bubbles: true, cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    assert.equal(cancelEvent.defaultPrevented, true);

    env.window.confirm = () => true;
    h.root.querySelector<HTMLButtonElement>('[data-action="close-new-case"]')!.click();
    assert.equal(dialog.open, false);
  } finally {
    env.window.confirm = originalConfirm;
  }
});

test('a successful save does not clear dirty state from an open new-case form', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  completeDraft(h, 'case_1');

  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '另一个草稿问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.hasUnsavedChanges(), true);

  await h.workbench.saveCurrent('draft', false);
  await tick();
  assert.equal(h.workbench.state.dirty, false);
  // The editor is clean, but the new-case form still holds unsaved work.
  assert.equal(h.workbench.hasUnsavedChanges(), true);
});

test('reset drops stale new-case form values from the unsaved-work check', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '会话 A 的草稿问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.hasUnsavedChanges(), true);

  h.workbench.reset();
  assert.equal(h.workbench.hasUnsavedChanges(), false);
});

/* ---------------- P1 regressions from parent review ---------------- */

test('edits typed while the post-save detail refresh is pending are preserved', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  completeDraft(h, 'case_1');

  let resolveDetail!: (value: ReviewCaseResponse) => void;
  const gate = new Promise<ReviewCaseResponse>((resolve) => {
    resolveDetail = resolve;
  });
  h.api.getReviewCase = async () => gate;
  h.saveHandler = async (caseId, input) => ({ annotation: annotationView(input, caseId), acknowledgment: '已保存' });

  const pending = h.workbench.saveCurrent('submitted', false);
  await tick();
  // The PUT has resolved; the post-save detail GET is still pending.
  assert.equal(h.saves.length, 1);
  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '刷新期间的新理由';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.state.dirty, true);

  resolveDetail({
    case: detailFor('case_1', { status: 'reviewed', latestStatus: 'submitted', latestRevision: 1 }),
    annotation: null,
    history: []
  });
  await pending;
  await tick();

  // The newer edit survives the refresh and the case stays dirty.
  assert.equal(h.workbench.state.draft?.rationale, '刷新期间的新理由');
  assert.equal(h.workbench.state.dirty, true);
  assert.equal(query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]')?.value, '刷新期间的新理由');
});

test('creating a case while the current review is dirty does not silently switch', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  const rationale = query<HTMLTextAreaElement>(h.root, '[data-role="rationale"]');
  assert.ok(rationale);
  rationale.value = '未保存的当前理由';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.equal(h.workbench.state.dirty, true);

  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]');
  assert.ok(question);
  question.value = '新案例问题？';
  question.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  const sourceTitle = h.root.querySelector<HTMLInputElement>('[data-source-field="title"]');
  const sourceText = h.root.querySelector<HTMLTextAreaElement>('[data-source-field="text"]');
  const candidateA = h.root.querySelector<HTMLTextAreaElement>('[data-field="candidate-a"]');
  const candidateB = h.root.querySelector<HTMLTextAreaElement>('[data-field="candidate-b"]');
  assert.ok(sourceTitle && sourceText && candidateA && candidateB);
  sourceTitle.value = '证据标题';
  sourceText.value = '证据正文';
  candidateA.value = '候选甲一条';
  candidateB.value = '候选乙一条';
  // Dialog input is tracked separately and must not be treated as an editor edit.
  assert.equal(h.workbench.state.dirty, true);

  const form = h.root.querySelector<HTMLFormElement>('.review-new-modal form');
  assert.ok(form);
  const originalConfirm = env.window.confirm;
  env.window.confirm = () => false;
  try {
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(10);
    assert.equal(h.workbench.state.caseId, 'case_1');
    assert.equal(h.workbench.state.dirty, true);
    assert.equal(h.workbench.state.draft?.rationale, '未保存的当前理由');
    assert.match(h.toasts.at(-1)?.message ?? '', /当前案例的未保存输入仍保留/);
  } finally {
    env.window.confirm = originalConfirm;
  }
});

test('modal fields have accessible labels and a submitted badge drops 待你判断', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const modalFields = h.root.querySelectorAll<HTMLElement>('.review-new-modal .field');
  assert.ok(modalFields.length > 0);
  for (const field of modalFields) {
    const label = field.querySelector('label');
    const control = field.querySelector<HTMLElement>('input, textarea, select');
    assert.ok(label, 'field needs a label');
    assert.ok(control, 'field needs a control');
    assert.ok(control.id.length > 0, 'control needs an id');
    assert.equal(label.getAttribute('for'), control.id);
  }

  const reviewed = detailFor('case_1', { status: 'reviewed', latestStatus: 'submitted', latestRevision: 1 });
  const h2 = harness(['case_1'], { details: { case_1: reviewed } });
  await h2.workbench.open('case_1');
  const badge = h2.root.querySelector('.review-badge');
  assert.match(badge?.textContent ?? '', /已提交/);
  assert.doesNotMatch(badge?.textContent ?? '', /待你判断/);
});

test('new-case controls lock during a pending POST and restore on failure', async () => {
  const h = harness(['case_1']);
  await h.workbench.open('case_1');
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  const question = h.root.querySelector<HTMLTextAreaElement>('[data-field="question"]')!;
  const sourceTitle = h.root.querySelector<HTMLInputElement>('[data-source-field="title"]')!;
  const sourceText = h.root.querySelector<HTMLTextAreaElement>('[data-source-field="text"]')!;
  const candidateA = h.root.querySelector<HTMLTextAreaElement>('[data-field="candidate-a"]')!;
  const candidateB = h.root.querySelector<HTMLTextAreaElement>('[data-field="candidate-b"]')!;
  question.value = '问题？';
  sourceTitle.value = '标题';
  sourceText.value = '正文';
  candidateA.value = '甲';
  candidateB.value = '乙';

  let rejectCreate!: (error: Error) => void;
  const gate = new Promise<ReviewQueueItem>((_, reject) => {
    rejectCreate = reject;
  });
  h.api.createReviewCase = async () => gate;
  const dialog = h.root.querySelector<HTMLDialogElement>('.review-new-modal')!;
  const form = h.root.querySelector<HTMLFormElement>('.review-new-modal form')!;
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const controls = dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
    'input, textarea, select, button'
  );
  assert.ok(controls.length > 0);
  for (const control of controls) assert.equal(control.disabled, true, 'controls locked while POST pending');

  const cancelEvent = new env.window.Event('cancel', { bubbles: true, cancelable: true });
  dialog.dispatchEvent(cancelEvent);
  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(dialog.open, true);

  rejectCreate(new ApiError(500, 'internal_error', '失败'));
  await tick(8);
  assert.equal(dialog.open, true);
  assert.equal(question.value, '问题？');
  assert.equal(sourceTitle.value, '标题');
  assert.equal(question.disabled, false);
  assert.equal(h.root.querySelector<HTMLButtonElement>('.review-new-modal button[type="submit"]')?.disabled, false);
});

test('new judgments in a previously clean editor survive the post-create queue refresh', async () => {
  const h = harness(['case_1', 'case_2']);
  await h.workbench.open('case_1');
  h.root.querySelector<HTMLButtonElement>('[data-action="new-case"]')!.click();
  for (const [selector, value] of [
    ['[data-field="question"]', '新问题？'],
    ['[data-source-field="title"]', '标题'],
    ['[data-source-field="text"]', '材料'],
    ['[data-field="candidate-a"]', '甲'],
    ['[data-field="candidate-b"]', '乙']
  ]) {
    h.root.querySelector<HTMLInputElement>(selector!)!.value = value!;
  }
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const list = h.api.listReviewCases;
  h.api.listReviewCases = async () => { await queueGate; return list(); };
  h.api.createReviewCase = async () => h.queue[1]!;
  h.root.querySelector<HTMLFormElement>('.review-new-modal form')!
    .dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(h.workbench.state.dirty, false);
  assert.equal(h.root.querySelector<HTMLDialogElement>('.review-new-modal')!.open, false);
  const rationale = h.root.querySelector<HTMLTextAreaElement>('[data-role="rationale"]')!;
  rationale.value = '创建后继续输入的判断';
  rationale.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  releaseQueue();
  await tick(8);
  assert.equal(h.workbench.state.caseId, 'case_1');
  assert.equal(h.workbench.state.dirty, true);
  assert.equal(h.workbench.state.draft?.rationale, '创建后继续输入的判断');
});
