import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { ApiError } from '../client/api.js';
import { createReviewWorkbench } from '../client/review.js';
import type { ReviewApi } from '../client/review.js';
import {
  RESEARCH_MODEL_INPUT_VERSION,
  researchModelInput,
  researchSpecExport,
  researchTaskSpec
} from '../shared/research-task.js';
import type {
  ResearchTaskInput,
  ResearchTaskListItem,
  ResearchTaskView
} from '../shared/research-task.js';

const env = installDom();

const CRITERIA_MARKER = 'EVAL_CRITERIA_MARKER';
const OBSERVATION_MARKER = 'OBSERVATION_MARKER provisional starting point';
const FAILURE_MARKER = 'FAILURE_MARKER typical failure';
const LIST_NOTE = '研究任务仅为评估规范：尚未运行模型，人工判断为空白。';

function researchTaskFor(taskId: string, title = '人物甲研究任务'): ResearchTaskView {
  return {
    taskId,
    externalId: `ext-${taskId}`,
    datasetVersion: 'private-research-2026q3',
    title,
    split: 'discovery',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
    executionStatus: 'not_run',
    reviewStatus: 'unreviewed',
    modelOutputs: [],
    humanLabels: null,
    input: {
      prompt: 'PROMPT_TEXT 研究这位公开创作者的公开经历与作品。',
      identitySeedUrls: ['https://example.org/person-alpha']
    },
    commonChecks: Array.from({ length: 6 }, (_, index) => ({
      id: `c${index + 1}`,
      focus: `${CRITERIA_MARKER} common ${index + 1}`,
      lookFor: `${CRITERIA_MARKER} look common ${index + 1}`
    })),
    personChecks: Array.from({ length: 4 }, (_, index) => ({
      id: `p${index + 1}`,
      focus: `${CRITERIA_MARKER} person ${index + 1}`,
      lookFor: `${CRITERIA_MARKER} look person ${index + 1}`
    })),
    observedStartingPoint: OBSERVATION_MARKER,
    typicalFailure: FAILURE_MARKER,
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled'
  };
}

function itemFor(view: ResearchTaskView): ResearchTaskListItem {
  return {
    taskId: view.taskId,
    externalId: view.externalId,
    datasetVersion: view.datasetVersion,
    title: view.title,
    split: 'discovery',
    contentHash: view.contentHash,
    createdAt: view.createdAt,
    executionStatus: 'not_run',
    reviewStatus: 'unreviewed',
    modelOutputCount: 0,
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled'
  };
}

function importSpec(externalId: string, title: string): ResearchTaskInput {
  const spec = researchTaskSpec(researchTaskFor(`tmp-${externalId}`));
  return { ...spec, externalId, title };
}

interface Harness {
  root: HTMLElement;
  tasks: ResearchTaskListItem[];
  details: Record<string, ResearchTaskView>;
  imports: ResearchTaskInput[];
  toasts: { message: string; tone?: 'info' | 'error' }[];
  api: ReviewApi;
  workbench: ReturnType<typeof createReviewWorkbench>;
  importHandler: (input: ResearchTaskInput) => Promise<{ task: ResearchTaskView; created: boolean }>;
  listHandler: () => Promise<{ tasks: ResearchTaskListItem[]; note: string }>;
  detailHandler: (taskId: string) => Promise<ResearchTaskView>;
}

function harness(seedTasks: ResearchTaskView[] = []): Harness {
  const root = env.document.createElement('div');
  env.document.body.appendChild(root);
  const state: Harness = {
    root,
    tasks: seedTasks.map(itemFor),
    details: Object.fromEntries(seedTasks.map((view) => [view.taskId, view])),
    imports: [],
    toasts: [],
    api: null as never,
    workbench: null as never,
    listHandler: async () => ({ tasks: state.tasks, note: LIST_NOTE }),
    detailHandler: async (taskId) => {
      const found = state.details[taskId];
      if (!found) throw new ApiError(404, 'research_task_not_found', '未找到该研究任务。');
      return found;
    },
    importHandler: async (input) => defaultImport(state, input)
  };
  const api: ReviewApi = {
    seedReviewCases: async () => ({ inserted: 0, total: 0, badge: '' }),
    listReviewCases: async () => ({
      cases: [],
      progress: { total: 0, reviewed: 0, draft: 0, unreviewed: 0 }
    }),
    createReviewCase: async () => {
      throw new Error('not used');
    },
    getReviewCase: async () => {
      throw new Error('not used');
    },
    getReviewHistory: async () => ({ history: [], revisions: [] }),
    saveReviewAnnotation: async () => {
      throw new Error('not used');
    },
    deleteReviewCase: async () => undefined,
    getReviewInsights: async () => {
      throw new Error('not used');
    },
    exportReview: async () => '',
    listResearchTasks: () => state.listHandler(),
    getResearchTask: (taskId) => state.detailHandler(taskId),
    createResearchTask: async (input) => {
      state.imports.push(input);
      return state.importHandler(input);
    }
  };
  state.api = api;
  state.workbench = createReviewWorkbench({
    api,
    root,
    onToast: (message, tone) => {
      state.toasts.push({ message, tone });
    }
  });
  return state;
}

/** Server-side behaviour stand-in: only a real import mutates the list. */
function defaultImport(
  state: Harness,
  input: ResearchTaskInput
): { task: ResearchTaskView; created: boolean } {
  const view: ResearchTaskView = {
    taskId: `rtask_imported_${state.imports.length}`,
    contentHash: 'b'.repeat(64),
    createdAt: '2026-09-23T01:00:00.000Z',
    split: 'discovery',
    executionStatus: 'not_run',
    reviewStatus: 'unreviewed',
    modelOutputs: [],
    humanLabels: null,
    ...input
  };
  state.tasks.push(itemFor(view));
  state.details[view.taskId] = view;
  return { task: view, created: true };
}

async function tick(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function query<T extends Element = HTMLElement>(root: HTMLElement, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function importDialog(root: HTMLElement): HTMLDialogElement {
  const dialog = query<HTMLDialogElement>(root, '.review-import-modal');
  assert.ok(dialog, 'import dialog must exist');
  return dialog;
}

function importTextarea(root: HTMLElement): HTMLTextAreaElement {
  const textarea = query<HTMLTextAreaElement>(root, '[data-field="research-json"]');
  assert.ok(textarea, 'import textarea must exist');
  return textarea;
}

function submitImport(root: HTMLElement): void {
  const form = query<HTMLFormElement>(root, '.review-import-modal form');
  assert.ok(form, 'import form must exist');
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
}

test('an empty library invites import and never posts while merely browsing', async () => {
  const h = harness();
  await h.workbench.open(null);
  assert.match(h.root.textContent ?? '', /研究案例库为空/);
  assert.match(h.root.textContent ?? '', /导入研究案例/);
  assert.ok(query(h.root, '[data-action="research-import"]'));
  assert.equal(h.root.querySelectorAll('.review-research-item').length, 0);
  // Legacy answer-pair work stays accessible under its own label.
  assert.match(h.root.textContent ?? '', /回答对照评审（两候选）/);
  // GET-equivalent browsing must not create anything.
  assert.equal(h.imports.length, 0);
});

test('selecting a task shows prompt, seeds, checks, provisional observation and fixed statuses', async () => {
  const h = harness([researchTaskFor('rtask_1')]);
  await h.workbench.open(null);
  assert.equal(h.root.querySelectorAll('.review-research-item').length, 1);
  assert.match(h.root.textContent ?? '', /人物甲研究任务/);

  h.root
    .querySelector<HTMLButtonElement>('[data-research-task-id="rtask_1"]')!
    .click();
  await tick();

  assert.equal(h.workbench.state.researchDetail?.taskId, 'rtask_1');
  const text = h.root.textContent ?? '';
  assert.match(text, /待运行 · 未评审/);
  assert.match(text, /PROMPT_TEXT/);
  assert.match(text, /共同评估检查（6 条/);
  assert.match(text, /人物评估检查（4 条/);
  assert.match(text, /观察起点（暂定）/);
  assert.match(text, /OBSERVATION_MARKER/);
  assert.match(text, /FAILURE_MARKER/);
  assert.match(text, /不完整（incomplete）/);
  assert.match(text, /未系统抽样（not_systematically_sampled）/);
  assert.match(text, /待运行（not_run）/);
  assert.match(text, /未评审（unreviewed）/);
  assert.match(text, /0 条（尚无运行）/);
  assert.match(text, /人工判断/);

  const seedLink = query<HTMLAnchorElement>(h.root, '.review-seed-links a');
  assert.ok(seedLink);
  assert.equal(seedLink.getAttribute('href'), 'https://example.org/person-alpha');
  assert.match(seedLink.getAttribute('rel') ?? '', /noopener/);

  // No human judgment control exists, and nothing can be pre-checked.
  const section = h.root.querySelector('[data-role="research-library"]')!;
  assert.equal(section.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(section.querySelectorAll('input[type="radio"]').length, 0);
  assert.equal(h.root.querySelectorAll('input:checked').length, 0);

  assert.ok(query(h.root, '[data-action="export-model-input"]'));
  assert.ok(query(h.root, '[data-action="export-spec"]'));
});

test('a failed task detail can be retried without duplicate in-flight or loaded requests', async () => {
  const task = researchTaskFor('rtask_retry');
  const h = harness([task]);
  let calls = 0;
  let completeRetry!: (value: ResearchTaskView) => void;
  h.detailHandler = async () => {
    calls += 1;
    if (calls === 1) throw new ApiError(503, 'unavailable', '暂时无法读取。');
    return new Promise<ResearchTaskView>((resolve) => { completeRetry = resolve; });
  };
  await h.workbench.open(null);
  const clickTask = () => query<HTMLButtonElement>(h.root, '[data-research-task-id="rtask_retry"]')!.click();
  clickTask();
  await tick();
  assert.equal(calls, 1);
  assert.equal(Boolean(h.workbench.state.researchDetail), false);
  assert.match(h.toasts.at(-1)?.message ?? '', /暂时无法读取/);

  clickTask();
  assert.equal(calls, 2, 'the same task must allow retry after a failed request');
  clickTask();
  assert.equal(calls, 2, 'a pending retry must not be duplicated');
  completeRetry(task);
  await tick();
  assert.equal(h.workbench.state.researchDetail?.taskId, task.taskId);
  clickTask();
  assert.equal(calls, 2, 'loaded task details should remain cached');
});

test('the import dialog posts real specs and only reports true successes', async () => {
  const h = harness();
  await h.workbench.open(null);
  query<HTMLButtonElement>(h.root, '[data-action="research-import"]')!.click();
  const dialog = importDialog(h.root);
  assert.equal(dialog.open, true);

  const spec = importSpec('import-ok', '导入后的任务');
  const textarea = importTextarea(h.root);
  textarea.value = JSON.stringify(spec);
  submitImport(h.root);
  await tick(10);

  assert.equal(h.imports.length, 1);
  assert.deepEqual(h.imports[0], spec);
  assert.equal(h.workbench.state.researchTasks.length, 1);
  assert.match(h.root.textContent ?? '', /导入后的任务/);
  assert.match(h.toasts.at(-1)?.message ?? '', /已导入 1 个研究案例/);
  assert.equal(dialog.open, false);
  assert.equal(h.workbench.hasUnsavedChanges(), false);
});

test('import failures surface the server error and never fake success', async () => {
  const h = harness();
  await h.workbench.open(null);
  query<HTMLButtonElement>(h.root, '[data-action="research-import"]')!.click();
  const dialog = importDialog(h.root);
  const textarea = importTextarea(h.root);
  const spec = importSpec('conflict-task', '冲突任务');
  textarea.value = JSON.stringify(spec);

  h.importHandler = async () => {
    throw new ApiError(
      409,
      'research_task_conflict',
      '相同 externalId + datasetVersion 已存在内容不同的研究任务，不覆盖既有快照。'
    );
  };
  submitImport(h.root);
  await tick(10);

  const error = query<HTMLElement>(h.root, '[data-role="research-import-error"]');
  assert.match(error?.textContent ?? '', /成功 0 条，失败 1 条/);
  assert.match(error?.textContent ?? '', /已存在内容不同的研究任务/);
  assert.equal(
    h.toasts.some((toast) => /已导入/.test(toast.message)),
    false,
    'a failed import must not toast success'
  );
  assert.equal(h.workbench.state.researchTasks.length, 0);
  assert.equal(dialog.open, true, 'dialog stays open with the entered JSON kept');
  assert.equal(textarea.value, JSON.stringify(spec));
  assert.equal(h.workbench.hasUnsavedChanges(), true);
});

test('malformed or empty import input is rejected before any API call', async () => {
  const h = harness();
  await h.workbench.open(null);
  query<HTMLButtonElement>(h.root, '[data-action="research-import"]')!.click();

  const textarea = importTextarea(h.root);
  textarea.value = '';
  submitImport(h.root);
  await tick();
  assert.match(query<HTMLElement>(h.root, '[data-role="research-import-error"]')?.textContent ?? '', /请先选择/);

  textarea.value = '{oops';
  submitImport(h.root);
  await tick();
  assert.match(
    query<HTMLElement>(h.root, '[data-role="research-import-error"]')?.textContent ?? '',
    /JSON 解析失败/
  );
  assert.equal(h.imports.length, 0);

  // An array payload is submitted item by item through the real API.
  textarea.value = JSON.stringify([importSpec('multi-1', '多任务一'), importSpec('multi-2', '多任务二')]);
  submitImport(h.root);
  await tick(10);
  assert.equal(h.imports.length, 2);
  assert.match(h.toasts.at(-1)?.message ?? '', /已导入 2 个研究案例/);
});

test('a partially failing batch reports exact counts and keeps both sides honest', async () => {
  const h = harness();
  await h.workbench.open(null);
  query<HTMLButtonElement>(h.root, '[data-action="research-import"]')!.click();
  const textarea = importTextarea(h.root);
  textarea.value = JSON.stringify([
    importSpec('batch-ok', '批量成功'),
    importSpec('batch-fail', '批量失败')
  ]);

  let calls = 0;
  const okHandler = h.importHandler;
  h.importHandler = async (input) => {
    calls += 1;
    if (calls === 2) throw new ApiError(500, 'internal_error', '服务器内部错误。');
    return okHandler(input);
  };

  submitImport(h.root);
  await tick(10);

  const error = query<HTMLElement>(h.root, '[data-role="research-import-error"]');
  assert.match(error?.textContent ?? '', /成功 1 条，失败 1 条/);
  assert.match(error?.textContent ?? '', /服务器内部错误/);
  assert.equal(
    h.toasts.some((toast) => /已导入/.test(toast.message)),
    false,
    'partial batches must not toast full success'
  );
  // The one real import is visible; the failed one is not invented.
  assert.equal(h.workbench.state.researchTasks.length, 1);
  const library = h.root.querySelector('[data-role="research-library"]')!;
  assert.match(library.textContent ?? '', /批量成功/);
  assert.doesNotMatch(library.textContent ?? '', /批量失败/);
});

test('model-input export excludes every evaluator criterion by construction', () => {
  const view = researchTaskFor('rtask_export');
  const modelInput = researchModelInput(view);
  const text = JSON.stringify(modelInput);

  assert.equal(modelInput.schemaVersion, RESEARCH_MODEL_INPUT_VERSION);
  assert.equal(modelInput.caseId, view.taskId);
  assert.equal(modelInput.externalId, view.externalId);
  assert.ok(text.includes(view.input.prompt));
  assert.ok(text.includes(view.input.identitySeedUrls[0]!));
  assert.ok(!text.includes(CRITERIA_MARKER), 'checks must not leak into model input');
  assert.ok(!text.includes(OBSERVATION_MARKER), 'observation must not leak into model input');
  assert.ok(!text.includes(FAILURE_MARKER), 'failure note must not leak into model input');
  assert.equal('commonChecks' in modelInput, false);
  assert.equal('personChecks' in modelInput, false);
  assert.equal('observedStartingPoint' in modelInput, false);
  assert.equal('typicalFailure' in modelInput, false);

  // The evaluator full specification is exported separately and does include them.
  const specText = JSON.stringify(researchSpecExport(view));
  assert.ok(specText.includes(CRITERIA_MARKER));
  assert.ok(specText.includes(OBSERVATION_MARKER));
  assert.ok(specText.includes(FAILURE_MARKER));
  assert.ok(specText.includes(view.contentHash));
});

test('reload refetches the persisted library from the API', async () => {
  const h = harness([researchTaskFor('rtask_keep', '持久任务')]);
  await h.workbench.open(null);
  assert.match(h.root.textContent ?? '', /持久任务/);

  // Account switch / reload drops the cache; the next open reads the API again.
  h.workbench.reset();
  assert.equal(h.workbench.state.researchTasks.length, 0);
  assert.equal(h.root.textContent?.includes('持久任务'), false);

  await h.workbench.open(null);
  assert.equal(h.workbench.state.researchLoaded, true);
  assert.equal(h.workbench.state.researchTasks.length, 1);
  assert.match(h.root.textContent ?? '', /持久任务/);
  assert.match(h.root.textContent ?? '', /待运行 · 未评审/);
});

test('a late list response after an account switch cannot repopulate the DOM', async () => {
  const h = harness([researchTaskFor('rtask_late')]);
  await h.workbench.open(null);
  assert.match(h.root.textContent ?? '', /人物甲研究任务/);

  let resolveList!: (value: { tasks: ResearchTaskListItem[]; note: string }) => void;
  const gate = new Promise<{ tasks: ResearchTaskListItem[]; note: string }>((resolve) => {
    resolveList = resolve;
  });
  h.listHandler = () => gate;
  query<HTMLButtonElement>(h.root, '[data-action="research-refresh"]')!.click();
  await tick();

  h.workbench.reset();
  resolveList({ tasks: [itemFor(researchTaskFor('rtask_other', '他人任务'))], note: LIST_NOTE });
  await tick(10);

  assert.equal(h.workbench.state.researchTasks.length, 0);
  assert.equal(h.root.textContent?.includes('他人任务'), false);
  assert.deepEqual(h.toasts, []);
});

test('a late detail response after an account switch cannot render private criteria', async () => {
  const h = harness([researchTaskFor('rtask_detail')]);
  await h.workbench.open(null);

  let resolveDetail!: (value: ResearchTaskView) => void;
  const gate = new Promise<ResearchTaskView>((resolve) => {
    resolveDetail = resolve;
  });
  h.detailHandler = () => gate;
  h.root.querySelector<HTMLButtonElement>('[data-research-task-id="rtask_detail"]')!.click();
  await tick();

  h.workbench.reset();
  resolveDetail(researchTaskFor('rtask_detail'));
  await tick(10);

  assert.equal(h.workbench.state.researchDetail, null);
  assert.equal(h.workbench.state.researchTaskId, null);
  assert.equal(h.root.textContent?.includes(CRITERIA_MARKER), false);
  assert.deepEqual(h.toasts, []);
});

test('a failed list read shows an error instead of pretending the library is empty', async () => {
  const h = harness();
  await h.workbench.open(null);
  h.listHandler = async () => {
    throw new ApiError(500, 'internal_error', '服务器内部错误。');
  };
  query<HTMLButtonElement>(h.root, '[data-action="research-refresh"]')!.click();
  await tick(10);
  assert.equal(h.toasts.at(-1)?.tone, 'error');
  assert.match(h.toasts.at(-1)?.message ?? '', /服务器内部错误/);
});


test('an account switch interrupts a pending successful batch before its next POST', async () => {
  const h = harness();
  await h.workbench.open(null);
  query<HTMLButtonElement>(h.root, '[data-action="research-import"]')!.click();
  importTextarea(h.root).value = JSON.stringify([importSpec('first', 'first'), importSpec('second', 'second')]);
  let resolveImport!: (value: { task: ResearchTaskView; created: boolean }) => void;
  h.importHandler = () => new Promise((resolve) => { resolveImport = resolve; });
  submitImport(h.root);
  await tick();
  assert.equal(h.imports.length, 1);
  h.workbench.reset();
  await h.workbench.open(null);
  resolveImport({ task: researchTaskFor('old-private-task'), created: true });
  await tick(10);
  assert.equal(h.imports.length, 1, 'must not send old private batch to the newly signed-in account');
  assert.equal(h.workbench.state.researchTasks.length, 0);
  assert.equal(h.toasts.some((toast) => /已导入/.test(toast.message)), false);
});
