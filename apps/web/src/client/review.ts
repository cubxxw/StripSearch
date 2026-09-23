import { ApiError } from './api.js';
import { clear, formatDateTime, make, setText } from './dom.js';
import {
  CLAIM_LABELS,
  CLAIM_LABEL_ORDER,
  PREFERENCE_LABELS,
  PREFERENCE_ORDER,
  QUEUE_STATUS_LABELS,
  REASON_TAG_LABELS,
  REASON_TAG_ORDER,
  validateAnnotationShape
} from '../shared/review.js';
import { researchModelInput, researchSpecExport } from '../shared/research-task.js';
import type {
  ResearchTaskInput,
  ResearchTaskListItem,
  ResearchTaskView
} from '../shared/research-task.js';
import type {
  ClaimLabel,
  Preference,
  QueueStatus,
  ReasonTag,
  ReviewAnnotationView,
  ReviewCaseDetail,
  ReviewCaseResponse,
  ReviewDecision,
  ReviewHistoryEntry,
  ReviewInsights,
  ReviewProgress,
  ReviewQueueItem
} from '../shared/review.js';
import { LIMITS } from '../shared/limits.js';

export interface ReviewApi {
  seedReviewCases(): Promise<{ inserted: number; total: number; capped?: boolean; badge: string }>;
  listReviewCases(): Promise<{ cases: ReviewQueueItem[]; progress: ReviewProgress }>;
  createReviewCase(input: {
    title?: string;
    question: string;
    asOf?: string | null;
    sources: { title: string; text: string; locator?: string | null }[];
    candidates: {
      response: string;
      origin?: string | null;
      model?: string | null;
      notes?: string | null;
    }[];
  }): Promise<ReviewQueueItem>;
  getReviewCase(caseId: string): Promise<ReviewCaseResponse>;
  getReviewHistory(
    caseId: string
  ): Promise<{ history: ReviewHistoryEntry[]; revisions: ReviewAnnotationView[] }>;
  saveReviewAnnotation(
    caseId: string,
    input: {
      expectedRevision: number;
      status: 'draft' | 'submitted';
      decisions: ReviewDecision[];
      preference: Preference | null;
      rationale: string | null;
      reasonTags: ReasonTag[];
      rubric: { referenceAnswer: string; mustInclude: string[]; mustAvoid: string[] };
    }
  ): Promise<{ annotation: ReviewAnnotationView; acknowledgment: string }>;
  deleteReviewCase(caseId: string): Promise<void>;
  getReviewInsights(): Promise<ReviewInsights>;
  exportReview(format: 'json' | 'jsonl', filter: 'all' | 'reviewed'): Promise<string>;
  listResearchTasks(): Promise<{ tasks: ResearchTaskListItem[]; note: string }>;
  getResearchTask(taskId: string): Promise<ResearchTaskView>;
  createResearchTask(input: ResearchTaskInput): Promise<{ task: ResearchTaskView; created: boolean }>;
}

export interface ReviewWorkbenchDeps {
  api: ReviewApi;
  root: HTMLElement;
  onToast: (message: string, tone?: 'info' | 'error') => void;
  onNavigate?: (caseId: string | null) => void;
  onUnauthorized?: () => void;
}

interface DraftDecision {
  label: ClaimLabel | null;
  evidenceIds: string[];
  note: string;
}

interface DraftState {
  decisions: Map<string, DraftDecision>;
  preference: Preference | null;
  rationale: string;
  reasonTags: Set<ReasonTag>;
  referenceAnswer: string;
  mustIncludeRaw: string;
  mustAvoidRaw: string;
}

export interface ReviewWorkbenchState {
  queue: ReviewQueueItem[];
  progress: ReviewProgress;
  filter: 'all' | QueueStatus;
  search: string;
  caseId: string | null;
  detail: ReviewCaseDetail | null;
  annotation: ReviewAnnotationView | null;
  history: ReviewHistoryEntry[];
  historyRevisions: ReviewAnnotationView[] | null;
  historyLoading: boolean;
  draft: DraftState | null;
  insights: ReviewInsights | null;
  insightsOpen: boolean;
  busy: boolean;
  dirty: boolean;
  newCaseBusy: boolean;
  /** Candidate-free research task library (separate from answer pairs). */
  researchTasks: ResearchTaskListItem[];
  researchNote: string;
  researchLoaded: boolean;
  researchTaskId: string | null;
  researchDetail: ResearchTaskView | null;
  researchLoading: boolean;
  researchImportBusy: boolean;
}

export interface ReviewWorkbench {
  readonly state: ReviewWorkbenchState;
  open(caseId?: string | null): Promise<void>;
  refresh(): Promise<void>;
  selectCase(caseId: string): Promise<void>;
  saveCurrent(status: 'draft' | 'submitted', andNext: boolean): Promise<void>;
  hasUnsavedChanges(): boolean;
  reset(): void;
  destroy(): void;
}

const EMPTY_PROGRESS: ReviewProgress = { total: 0, reviewed: 0, draft: 0, unreviewed: 0 };
const RUBRIC_MAX_LINES = 20;

function allLines(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function draftFrom(detail: ReviewCaseDetail, annotation: ReviewAnnotationView | null): DraftState {
  const decisions = new Map<string, DraftDecision>();
  for (const claimId of detail.claimIds) {
    const saved = annotation?.decisions.find((decision) => decision.claimId === claimId);
    decisions.set(claimId, {
      label: saved?.label ?? null,
      evidenceIds: saved ? [...saved.evidenceIds] : [],
      note: saved?.note ?? ''
    });
  }
  return {
    decisions,
    preference: annotation?.preference ?? null,
    rationale: annotation?.rationale ?? '',
    reasonTags: new Set(annotation?.reasonTags ?? []),
    referenceAnswer: annotation?.rubric.referenceAnswer ?? '',
    mustIncludeRaw: (annotation?.rubric.mustInclude ?? []).join('\n'),
    mustAvoidRaw: (annotation?.rubric.mustAvoid ?? []).join('\n')
  };
}

export function createReviewWorkbench(deps: ReviewWorkbenchDeps): ReviewWorkbench {
  const state: ReviewWorkbenchState = {
    queue: [],
    progress: { ...EMPTY_PROGRESS },
    filter: 'all',
    search: '',
    caseId: null,
    detail: null,
    annotation: null,
    history: [],
    historyRevisions: null,
    historyLoading: false,
    draft: null,
    insights: null,
    insightsOpen: false,
    busy: false,
    dirty: false,
    newCaseBusy: false,
    researchTasks: [],
    researchNote: '',
    researchLoaded: false,
    researchTaskId: null,
    researchDetail: null,
    researchLoading: false,
    researchImportBusy: false
  };

  let mounted = false;
  let queueLoaded = false;
  let queueToken = 0;
  let loadToken = 0;
  let researchListToken = 0;
  let researchTaskToken = 0;
  let sessionGeneration = 0;
  let editGeneration = 0;
  let busyGeneration = 0;
  let destroyed = false;
  let beforeUnload: ((event: BeforeUnloadEvent) => void) | null = null;

  function isStaleSession(generation: number): boolean {
    return destroyed || generation !== sessionGeneration;
  }

  /** Begin a new case/session context: stale async work must not touch it. */
  function resetBusy(): void {
    busyGeneration += 1;
    state.busy = false;
  }

  const refs: {
    queue: HTMLElement;
    progress: HTMLElement;
    editor: HTMLElement;
    status: HTMLElement;
    error: HTMLElement;
    insights: HTMLElement;
    search: HTMLInputElement;
    filters: HTMLElement;
    dialog: HTMLDialogElement;
    dialogError: HTMLElement;
    dialogSubmit: HTMLButtonElement;
    sourceRows: HTMLElement;
    exportFilter: HTMLSelectElement;
    researchSection: HTMLElement;
    researchQueue: HTMLElement;
    researchDetail: HTMLElement;
    researchNote: HTMLElement;
    researchImportDialog: HTMLDialogElement;
    researchImportError: HTMLElement;
    researchImportSubmit: HTMLButtonElement;
    researchImportTextarea: HTMLTextAreaElement;
  } = {} as never;

  function setStatus(message: string): void {
    setText(refs.status, message);
  }

  function setError(message: string): void {
    setText(refs.error, message);
    if (message) refs.error.focus?.();
  }

  function clearError(): void {
    setText(refs.error, '');
  }

  function handleUnauthorized(error: unknown, generation: number): boolean {
    if (error instanceof ApiError && error.status === 401 && !isStaleSession(generation)) {
      deps.onUnauthorized?.();
      return true;
    }
    return false;
  }

  function visibleQueue(): ReviewQueueItem[] {
    const query = state.search.trim().toLowerCase();
    return state.queue.filter((item) => {
      if (state.filter !== 'all' && item.status !== state.filter) return false;
      if (!query) return true;
      return (
        item.title.toLowerCase().includes(query) || item.question.toLowerCase().includes(query)
      );
    });
  }

  /* ---------------- shell ---------------- */

  function mount(): void {
    if (mounted) return;
    mounted = true;
    clear(deps.root);
    const shell = make('div', { className: 'review-shell' });

    const head = make('header', { className: 'review-head container' });
    const headText = make('div', { className: 'review-head-text' });
    headText.appendChild(make('h1', { text: '评估工作台' }));
    headText.appendChild(
      make('p', {
        className: 'review-subtitle',
        text: '先准备研究案例，再评审研究结果。'
      })
    );
    headText.appendChild(
      make('p', {
        className: 'helper',
        text: '从完整人物研究开始，结合具体作品和互动来判断。'
      })
    );
    const headActions = make('div', { className: 'review-head-actions' });
    headActions.appendChild(
      make('button', {
        className: 'button primary',
        text: '载入 10 个练习案例',
        attrs: { type: 'button', 'data-action': 'seed' }
      })
    );
    headActions.appendChild(
      make('button', {
        className: 'button',
        text: '新建案例',
        attrs: { type: 'button', 'data-action': 'new-case' }
      })
    );
    headActions.appendChild(
      make('button', {
        className: 'button',
        text: '汇总',
        attrs: { type: 'button', 'data-action': 'insights', 'aria-expanded': 'false' }
      })
    );
    const exportFilter = make('select', {
      className: 'review-export-filter',
      attrs: { 'aria-label': '导出范围', 'data-role': 'export-filter' }
    }) as HTMLSelectElement;
    exportFilter.appendChild(make('option', { text: '导出：全部记录', attrs: { value: 'all' } }));
    exportFilter.appendChild(make('option', { text: '导出：仅已提交', attrs: { value: 'reviewed' } }));
    headActions.appendChild(exportFilter);
    headActions.appendChild(
      make('button', {
        className: 'button',
        text: '导出 JSON',
        attrs: { type: 'button', 'data-action': 'export-json' }
      })
    );
    headActions.appendChild(
      make('button', {
        className: 'button',
        text: '导出 JSONL',
        attrs: { type: 'button', 'data-action': 'export-jsonl' }
      })
    );
    head.appendChild(headText);

    shell.appendChild(head);

    const status = make('p', {
      className: 'review-status container',
      attrs: { role: 'status', 'aria-live': 'polite', 'data-role': 'status' }
    });
    shell.appendChild(status);

    const error = make('p', {
      className: 'review-error container',
      attrs: { role: 'alert', 'aria-live': 'assertive', tabindex: '-1', 'data-role': 'error' }
    });
    shell.appendChild(error);

    // Candidate-free research task library first, the legacy answer-pair work
    // grouped under its own label below it.
    const research = buildResearchSection();
    shell.appendChild(research.element);
    const answerHead = make('div', { className: 'review-section-head container' });
    answerHead.appendChild(make('h2', { text: '回答对照评审（两候选）' }));
    answerHead.appendChild(
      make('p', {
        className: 'helper',
        text: '已有两份研究回答时，在这里核查证据并比较质量。'
      })
    );
    answerHead.appendChild(headActions);
    answerHead.appendChild(make('p', { className: 'helper', text: '这里的导出包含回答来源和判断历史；草稿与已提交记录分开标记。' }));
    shell.appendChild(answerHead);

    const body = make('div', { className: 'review-body container' });
    const queuePanel = make('section', {
      className: 'review-queue-panel',
      attrs: { 'aria-label': '案例队列' }
    });
    const progress = make('p', { className: 'review-progress', attrs: { 'data-role': 'progress' } });
    const toolbar = make('div', { className: 'review-toolbar' });
    const search = make('input', {
      className: 'review-search',
      attrs: {
        type: 'search',
        placeholder: '搜索标题或问题',
        'aria-label': '搜索案例',
        'data-role': 'search'
      }
    }) as HTMLInputElement;
    const filters = make('div', {
      className: 'review-filters',
      attrs: { role: 'group', 'aria-label': '状态筛选' }
    });
    const filterOptions: { value: 'all' | QueueStatus; label: string }[] = [
      { value: 'all', label: '全部' },
      { value: 'unreviewed', label: '未评审' },
      { value: 'draft', label: '草稿' },
      { value: 'reviewed', label: '已提交' }
    ];
    for (const option of filterOptions) {
      filters.appendChild(
        make('button', {
          className: 'filter',
          text: option.label,
          attrs: {
            type: 'button',
            'data-filter': option.value,
            'aria-pressed': option.value === 'all' ? 'true' : 'false'
          }
        })
      );
    }
    toolbar.appendChild(search);
    toolbar.appendChild(filters);
    const queueList = make('ul', { className: 'review-queue', attrs: { 'data-role': 'queue' } });
    queuePanel.appendChild(progress);
    queuePanel.appendChild(toolbar);
    queuePanel.appendChild(queueList);

    const editor = make('section', {
      className: 'review-editor',
      attrs: { 'aria-label': '评审编辑器', 'data-role': 'editor' }
    });

    body.appendChild(queuePanel);
    body.appendChild(editor);
    shell.appendChild(body);

    const insights = make('section', {
      className: 'review-insights container',
      attrs: { 'data-role': 'insights', 'aria-label': '汇总', hidden: true }
    });
    shell.appendChild(insights);

    const dialog = buildNewCaseDialog();
    shell.appendChild(dialog.element);
    const researchDialog = buildResearchImportDialog();
    shell.appendChild(researchDialog.element);

    deps.root.appendChild(shell);

    refs.queue = queueList;
    refs.progress = progress;
    refs.editor = editor;
    refs.status = status;
    refs.error = error;
    refs.insights = insights;
    refs.search = search;
    refs.filters = filters;
    refs.dialog = dialog.element;
    refs.dialogError = dialog.error;
    refs.dialogSubmit = dialog.submit;
    refs.sourceRows = dialog.sourceRows;
    refs.exportFilter = exportFilter;
    refs.researchSection = research.element;
    refs.researchQueue = research.queue;
    refs.researchDetail = research.detail;
    refs.researchNote = research.note;
    refs.researchImportDialog = researchDialog.element;
    refs.researchImportError = researchDialog.error;
    refs.researchImportSubmit = researchDialog.submit;
    refs.researchImportTextarea = researchDialog.textarea;

    search.addEventListener('input', () => {
      state.search = search.value;
      renderQueue();
    });
    filters.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-filter]');
      if (!target) return;
      state.filter = (target.dataset.filter as 'all' | QueueStatus) ?? 'all';
      for (const button of filters.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
        button.setAttribute('aria-pressed', button === target ? 'true' : 'false');
      }
      renderQueue();
    });

    if (beforeUnload === null) {
      beforeUnload = (event: BeforeUnloadEvent) => {
        if (hasUnsavedChanges()) {
          event.preventDefault();
          event.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', beforeUnload);
    }

    wireDelegatedEvents(shell, dialog, researchDialog);
    renderAll();
  }

  interface NewCaseDialog {
    element: HTMLDialogElement;
    error: HTMLElement;
    submit: HTMLButtonElement;
    sourceRows: HTMLElement;
    form: HTMLFormElement;
  }

  function buildNewCaseDialog(): NewCaseDialog {
    const element = make('dialog', {
      className: 'modal review-new-modal',
      attrs: { 'aria-label': '新建标注案例' }
    }) as HTMLDialogElement;
    const form = make('form', { className: 'review-new-form' });
    form.appendChild(make('h2', { text: '新建标注案例' }));
    form.appendChild(
      make('p', {
        className: 'helper',
        text: '候选回答每行一条结论。创建后随机排列 A/B，提交判断后可查看回答来源。'
      })
    );

    form.appendChild(field('标题（可选）', make('input', { attrs: { type: 'text', maxlength: '120', 'data-field': 'title' } })));
    form.appendChild(
      field(
        '问题（必填）',
        make('textarea', {
          attrs: { rows: '2', maxlength: '500', 'data-field': 'question', 'aria-label': '问题' }
        })
      )
    );
    form.appendChild(
      field(
        '时间（可选，如 2026-03-02）',
        make('input', { attrs: { type: 'text', maxlength: '40', 'data-field': 'as-of' } })
      )
    );

    const sourcesFieldset = make('fieldset', { className: 'review-source-editor' });
    sourcesFieldset.appendChild(make('legend', { text: '证据' }));
    const sourceRows = make('div', { className: 'review-source-rows' });
    sourcesFieldset.appendChild(sourceRows);
    sourcesFieldset.appendChild(
      make('button', {
        className: 'button',
        text: '添加证据',
        attrs: { type: 'button', 'data-action': 'add-source' }
      })
    );
    form.appendChild(sourcesFieldset);
    addSourceRow(sourceRows);

    form.appendChild(
      field(
        '候选 A（每行一条论断）',
        make('textarea', {
          attrs: { rows: '3', maxlength: '4000', 'data-field': 'candidate-a', 'aria-label': '候选 A 回答' }
        })
      )
    );
    form.appendChild(
      field(
        '候选 B（每行一条论断）',
        make('textarea', {
          attrs: { rows: '3', maxlength: '4000', 'data-field': 'candidate-b', 'aria-label': '候选 B 回答' }
        })
      )
    );
    const metaFields = make('div', { className: 'review-meta-fields' });
    metaFields.appendChild(
      field(
        '候选 A 来源 / 模型（可选，提交前隐藏）',
        make('input', { attrs: { type: 'text', maxlength: '80', 'data-field': 'origin-a' } })
      )
    );
    metaFields.appendChild(
      field(
        '候选 B 来源 / 模型（可选，提交前隐藏）',
        make('input', { attrs: { type: 'text', maxlength: '80', 'data-field': 'origin-b' } })
      )
    );
    form.appendChild(metaFields);

    const error = make('p', { className: 'error-text', attrs: { role: 'alert', 'data-role': 'dialog-error' } });
    form.appendChild(error);
    const submit = make('button', {
      className: 'button primary',
      text: '创建案例',
      attrs: { type: 'submit' }
    }) as HTMLButtonElement;
    form.appendChild(submit);
    form.appendChild(
      make('button', {
        className: 'button ghost',
        text: '取消',
        attrs: { type: 'button', 'data-action': 'close-new-case' }
      })
    );
    element.appendChild(form);
    return { element, error, submit, sourceRows, form };
  }

  let fieldIdCounter = 0;

  function field(labelText: string, control: HTMLElement): HTMLElement {
    const wrapper = make('div', { className: 'field' });
    fieldIdCounter += 1;
    const id = control.id || `review-field-${fieldIdCounter}`;
    control.id = id;
    const label = make('label', { text: labelText });
    label.setAttribute('for', id);
    wrapper.appendChild(label);
    wrapper.appendChild(control);
    return wrapper;
  }

  function addSourceRow(container: HTMLElement): void {
    if (container.querySelectorAll('.review-source-row').length >= LIMITS.reviewMaxSources) return;
    const row = make('div', { className: 'review-source-row' });
    row.appendChild(
      make('input', {
        attrs: { type: 'text', placeholder: '标题', maxlength: '160', 'data-source-field': 'title', 'aria-label': '证据标题' }
      })
    );
    row.appendChild(
      make('textarea', {
        attrs: { placeholder: '证据正文', rows: '2', maxlength: '1200', 'data-source-field': 'text', 'aria-label': '证据正文' }
      })
    );
    row.appendChild(
      make('input', {
        attrs: { type: 'text', placeholder: '定位（可选）', maxlength: '160', 'data-source-field': 'locator', 'aria-label': '证据定位' }
      })
    );
    row.appendChild(
      make('button', {
        className: 'button ghost',
        text: '移除',
        attrs: { type: 'button', 'data-action': 'remove-source' }
      })
    );
    container.appendChild(row);
  }

  /* ---------------- research task library (candidate-free) ---------------- */

  interface ResearchSection {
    element: HTMLElement;
    queue: HTMLElement;
    detail: HTMLElement;
    note: HTMLElement;
  }

  function buildResearchSection(): ResearchSection {
    const element = make('section', {
      className: 'review-research container',
      attrs: { 'aria-label': '综合人物研究案例', 'data-role': 'research-library' }
    });
    const head = make('div', { className: 'review-research-head' });
    const headText = make('div', { className: 'review-research-head-text' });
    headText.appendChild(make('h2', { text: '综合人物研究案例' }));
    headText.appendChild(
      make('p', {
        className: 'helper',
        text: '围绕一个人做综合细致的研究。以下是待运行案例和拟定标准，还没有模型回答或人工评分。'
      })
    );
    const note = make('p', { className: 'review-research-note', attrs: { 'data-role': 'research-note' } });
    headText.appendChild(note);
    head.appendChild(headText);
    const actions = make('div', { className: 'review-research-actions' });
    actions.appendChild(
      make('button', {
        className: 'button primary',
        text: '导入研究案例',
        attrs: { type: 'button', 'data-action': 'research-import' }
      })
    );
    actions.appendChild(
      make('button', {
        className: 'button',
        text: '刷新列表',
        attrs: { type: 'button', 'data-action': 'research-refresh' }
      })
    );
    head.appendChild(actions);
    element.appendChild(head);

    const layout = make('div', { className: 'review-research-layout' });
    const queue = make('ul', {
      className: 'review-research-queue',
      attrs: { 'data-role': 'research-queue', 'aria-label': '研究案例列表' }
    });
    const detail = make('div', {
      className: 'review-research-detail',
      attrs: { 'data-role': 'research-detail', 'aria-label': '研究案例详情' }
    });
    layout.appendChild(queue);
    layout.appendChild(detail);
    element.appendChild(layout);
    return { element, queue, detail, note };
  }

  interface ResearchImportDialog {
    element: HTMLDialogElement;
    error: HTMLElement;
    submit: HTMLButtonElement;
    form: HTMLFormElement;
    textarea: HTMLTextAreaElement;
    file: HTMLInputElement;
  }

  function buildResearchImportDialog(): ResearchImportDialog {
    const element = make('dialog', {
      className: 'modal review-import-modal',
      attrs: { 'aria-label': '导入研究案例' }
    }) as HTMLDialogElement;
    const form = make('form', { className: 'review-import-form' });
    form.appendChild(make('h2', { text: '导入研究案例' }));
    form.appendChild(
      make('p', {
        className: 'helper',
        text: '选择案例 JSON 文件，或粘贴一个案例或一组案例。重复导入相同内容不会新增记录。'
      })
    );

    const file = make('input', {
      attrs: { type: 'file', accept: '.json,application/json', 'data-field': 'research-file' }
    }) as HTMLInputElement;
    form.appendChild(field('JSON 文件（可选，读入下方）', file));

    const textarea = make('textarea', {
      attrs: { rows: '10', 'data-field': 'research-json', 'aria-label': '研究案例 JSON' }
    }) as HTMLTextAreaElement;
    form.appendChild(field('JSON 内容', textarea));

    file.addEventListener('change', () => {
      const selected = file.files?.[0];
      if (!selected) return;
      const reader = new FileReader();
      reader.onload = () => {
        textarea.value = String(reader.result ?? '');
      };
      reader.readAsText(selected);
    });

    const error = make('p', {
      className: 'error-text',
      attrs: { role: 'alert', 'data-role': 'research-import-error' }
    });
    form.appendChild(error);
    const submit = make('button', {
      className: 'button primary',
      text: '导入',
      attrs: { type: 'submit' }
    }) as HTMLButtonElement;
    form.appendChild(submit);
    form.appendChild(
      make('button', {
        className: 'button ghost',
        text: '取消',
        attrs: { type: 'button', 'data-action': 'close-research-import' }
      })
    );
    element.appendChild(form);
    return { element, error, submit, form, textarea, file };
  }

  /* ---------------- delegated events ---------------- */

  function wireDelegatedEvents(
    shell: HTMLElement,
    dialog: NewCaseDialog,
    researchDialog: ResearchImportDialog
  ): void {
    shell.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionEl = target.closest<HTMLElement>('[data-action]');
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === 'add-source') addSourceRow(dialog.sourceRows);
        else if (action === 'remove-source') {
          const row = actionEl.closest('.review-source-row');
          const rows = dialog.sourceRows.querySelectorAll('.review-source-row');
          if (row && rows.length > 1) row.remove();
        } else if (action === 'close-new-case') {
          if (state.newCaseBusy) return;
          if (!newCaseHasContent() || window.confirm('新建案例尚未提交，关闭会丢失已填写内容。确定关闭吗？')) {
            dialog.element.close();
          }
        }
        else if (action === 'seed') void seedPractice();
        else if (action === 'new-case') openNewCaseDialog();
        else if (action === 'research-import') openResearchImport();
        else if (action === 'research-refresh') void refreshResearch({ force: true });
        else if (action === 'close-research-import') {
          if (state.researchImportBusy) return;
          if (!researchImportHasContent() || window.confirm('导入内容尚未提交，关闭会丢失已填写内容。确定关闭吗？')) {
            researchDialog.element.close();
          }
        } else if (action === 'export-model-input') exportResearchModelInput();
        else if (action === 'export-spec') exportResearchSpec();
        else if (action === 'insights') void toggleInsights();
        else if (action === 'export-json') void exportData('json');
        else if (action === 'export-jsonl') void exportData('jsonl');
        else if (action === 'save-draft') void saveCurrent('draft', false);
        else if (action === 'save-next') void saveCurrent('submitted', true);
        else if (action === 'prev') navigateRelative(-1);
        else if (action === 'next') navigateRelative(1);
        else if (action === 'delete') void deleteCurrent();
        else if (action === 'history-load') void ensureHistory();
        return;
      }
      const historyToggle = target.closest<HTMLElement>('[data-role="history-toggle"]');
      if (historyToggle) {
        if (!state.historyRevisions && !state.historyLoading) void ensureHistory();
        return;
      }
      const queueItem = target.closest<HTMLElement>('[data-case-id]');
      if (queueItem?.dataset.caseId && queueItem.classList.contains('review-queue-item')) {
        if (queueItem.dataset.caseId !== state.caseId) navigateTo(queueItem.dataset.caseId);
        return;
      }
      const researchItem = target.closest<HTMLElement>('[data-research-task-id]');
      if (
        researchItem?.dataset.researchTaskId &&
        researchItem.classList.contains('review-research-item')
      ) {
        if (researchItem.dataset.researchTaskId !== state.researchTaskId) {
          void selectResearchTask(researchItem.dataset.researchTaskId);
        }
      }
    });

    shell.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target) return;
      if (target.closest('.review-editor')) {
        state.dirty = true;
        editGeneration += 1;
      }
      const role = target.dataset.role;
      if (role === 'claim-label') {
        const card = target.closest<HTMLElement>('[data-claim-id]');
        const claimId = card?.dataset.claimId;
        if (!claimId || !state.draft) return;
        const decision = state.draft.decisions.get(claimId);
        if (!decision) return;
        decision.label = (target.dataset.label as ClaimLabel | undefined) ?? null;
        applyLabelState(card, decision.label);
        updateEditorProgress();
      } else if (role === 'preference') {
        if (state.draft) state.draft.preference = (target.value as Preference) || null;
      } else if (role === 'evidence') {
        const card = target.closest<HTMLElement>('[data-claim-id]');
        const claimId = card?.dataset.claimId;
        if (!claimId || !state.draft) return;
        const decision = state.draft.decisions.get(claimId);
        if (!decision) return;
        const sourceId = target.value;
        if (target.checked) {
          if (!decision.evidenceIds.includes(sourceId)) decision.evidenceIds.push(sourceId);
        } else {
          decision.evidenceIds = decision.evidenceIds.filter((id) => id !== sourceId);
        }
      } else if (role === 'reason-tag') {
        if (!state.draft) return;
        if (target.checked) state.draft.reasonTags.add(target.value as ReasonTag);
        else state.draft.reasonTags.delete(target.value as ReasonTag);
      }
    });

    shell.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (target?.closest('.review-editor')) {
        state.dirty = true;
        editGeneration += 1;
      }
      if (!target || !state.draft) return;
      const role = target.dataset.role;
      if (role === 'rationale') state.draft.rationale = target.value;
      else if (role === 'reference') state.draft.referenceAnswer = target.value;
      else if (role === 'must-include') state.draft.mustIncludeRaw = target.value;
      else if (role === 'must-avoid') state.draft.mustAvoidRaw = target.value;
      else if (role === 'claim-note') {
        const card = target.closest<HTMLElement>('[data-claim-id]');
        const claimId = card?.dataset.claimId;
        if (!claimId) return;
        const decision = state.draft.decisions.get(claimId);
        if (decision) decision.note = target.value;
      }
    });

    shell.addEventListener('keydown', (event) => {
      if (event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void saveCurrent('submitted', true);
      }
    });

    dialog.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitNewCase();
    });
    researchDialog.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void importResearchTasks(researchDialog);
    });
    researchDialog.element.addEventListener('cancel', (event) => {
      if (state.researchImportBusy) {
        event.preventDefault();
        return;
      }
      if (researchImportHasContent() && !window.confirm('导入内容尚未提交，关闭会丢失已填写内容。确定关闭吗？')) {
        event.preventDefault();
      }
    });
    dialog.element.addEventListener('cancel', (event) => {
      if (state.newCaseBusy) {
        event.preventDefault();
        return;
      }
      if (newCaseHasContent() && !window.confirm('新建案例尚未提交，关闭会丢失已填写内容。确定关闭吗？')) {
        event.preventDefault();
      }
    });
  }

  function applyLabelState(card: HTMLElement | null, label: ClaimLabel | null): void {
    if (!card) return;
    const requires = label === 'supported' || label === 'contradicted';
    card.dataset.label = label ?? '';
    const hint = card.querySelector<HTMLElement>('[data-role="evidence-hint"]');
    if (hint) setText(hint, requires ? '必须选择至少一条证据' : '可选证据');
  }

  function updateEditorProgress(): void {
    const detail = state.detail;
    const draft = state.draft;
    const element = refs.editor.querySelector<HTMLElement>('[data-role="editor-progress"]');
    if (!element || !detail || !draft) return;
    const counts: Record<ClaimLabel, number> = {
      supported: 0,
      contradicted: 0,
      insufficient: 0,
      unassessable: 0
    };
    let labeled = 0;
    for (const claimId of detail.claimIds) {
      const decision = draft.decisions.get(claimId);
      if (decision?.label) {
        labeled += 1;
        counts[decision.label] += 1;
      }
    }
    setText(
      element,
      `已标注 ${labeled} / ${detail.claimIds.length} · 支持 ${counts.supported} · 矛盾 ${counts.contradicted} · 证据不足 ${counts.insufficient} · 无法判断 ${counts.unassessable}`
    );
  }

  /* ---------------- rendering ---------------- */

  function renderAll(): void {
    renderQueue();
    renderEditor();
    renderResearch();
  }

  function renderQueue(): void {
    const visible = visibleQueue();
    clear(refs.queue);
    refs.progress.textContent = `已提交 ${state.progress.reviewed} / 共 ${state.progress.total}（草稿 ${state.progress.draft} · 未评审 ${state.progress.unreviewed}）`;
    if (state.queue.length === 0) {
      refs.queue.appendChild(
        make('li', {
          className: 'review-empty',
          text: '还没有标注案例。点击「载入 10 个练习案例」开始。'
        })
      );
      return;
    }
    if (visible.length === 0) {
      refs.queue.appendChild(make('li', { className: 'review-empty', text: '没有匹配当前筛选的案例。' }));
      return;
    }
    for (const item of visible) {
      const li = make('li', {});
      const button = make('button', {
        className: 'review-queue-item',
        attrs: {
          type: 'button',
          'data-case-id': item.caseId,
          'aria-current': item.caseId === state.caseId ? 'true' : 'false'
        }
      });
      button.appendChild(make('span', { className: 'review-queue-title', text: item.title }));
      const meta = make('span', { className: 'review-queue-meta' });
      meta.appendChild(
        make('span', {
          className: 'review-status-badge',
          text: QUEUE_STATUS_LABELS[item.status],
          attrs: { 'data-status': item.status }
        })
      );
      if (item.kind === 'practice') {
        meta.appendChild(make('span', { className: 'mono', text: '合成练习' }));
      }
      meta.appendChild(make('span', { className: 'mono', text: `${item.sourceCount} 证据 · ${item.claimCount} 论断` }));
      button.appendChild(meta);
      button.appendChild(make('span', { className: 'review-queue-question', text: item.question }));
      li.appendChild(button);
      refs.queue.appendChild(li);
    }
  }

  /* ---------------- research task library rendering ---------------- */

  function renderResearch(): void {
    if (!mounted) return;
    setText(refs.researchNote, state.researchNote);
    renderResearchList();
    renderResearchDetail();
  }

  function renderResearchList(): void {
    const queue = refs.researchQueue;
    if (!queue) return;
    clear(queue);
    if (state.researchTasks.length === 0) {
      queue.appendChild(
        make('li', {
          className: 'review-empty',
          text: '研究案例库为空。点击「导入研究案例」，粘贴 JSON 或选择文件导入任务规范。'
        })
      );
      return;
    }
    for (const item of state.researchTasks) {
      const li = make('li', {});
      const button = make('button', {
        className: 'review-research-item',
        attrs: {
          type: 'button',
          'data-research-task-id': item.taskId,
          'aria-current': item.taskId === state.researchTaskId ? 'true' : 'false'
        }
      });
      button.appendChild(make('span', { className: 'review-queue-title', text: item.title }));
      const meta = make('span', { className: 'review-queue-meta' });
      meta.appendChild(
        make('span', {
          className: 'review-status-badge',
          text: '待运行 · 未评审',
          attrs: { 'data-status': 'unreviewed' }
        })
      );
      meta.appendChild(make('span', { className: 'mono', text: '模型输出 0 条' }));
      button.appendChild(meta);
      li.appendChild(button);
      queue.appendChild(li);
    }
  }

  function researchBlock(title: string, helper?: string): { section: HTMLElement; body: HTMLElement } {
    const section = make('section', { className: 'review-research-block' });
    section.appendChild(make('h3', { text: title }));
    if (helper) section.appendChild(make('p', { className: 'helper', text: helper }));
    const body = make('div', { className: 'review-research-block-body' });
    section.appendChild(body);
    return { section, body };
  }

  function renderCheckList(checks: { id: string; focus: string; lookFor: string }[]): HTMLElement {
    const list = make('ol', { className: 'review-check-list' });
    for (const check of checks) {
      const item = make('li', { className: 'review-check', attrs: { 'data-check-id': check.id } });
      const head = make('div', { className: 'review-check-head' });
      head.appendChild(make('strong', { text: check.focus }));
      item.appendChild(head);
      item.appendChild(make('p', { className: 'review-check-look', text: check.lookFor }));
      list.appendChild(item);
    }
    return list;
  }

  function renderResearchDetail(): void {
    const pane = refs.researchDetail;
    if (!pane) return;
    clear(pane);
    if (state.researchLoading) {
      pane.appendChild(make('p', { className: 'helper', text: '正在载入研究案例…' }));
      return;
    }
    const task = state.researchDetail;
    if (!task) {
      pane.appendChild(
        make('p', {
          className: 'review-placeholder',
          text:
            state.researchTasks.length === 0
              ? '还没有研究案例。导入的任务规范会在这里展示，不会触发任何模型运行。'
              : '从左侧选择一个研究案例，查看问题、种子链接与评估检查。'
        })
      );
      return;
    }

    const article = make('article', {
      className: 'review-research-case',
      attrs: { 'data-research-task-id': task.taskId }
    });
    const header = make('header', { className: 'review-case-head' });
    const titleRow = make('div', { className: 'review-case-title-row' });
    titleRow.appendChild(make('span', { className: 'review-badge', text: '研究任务规范 · 未运行' }));
    titleRow.appendChild(
      make('span', {
        className: 'review-status-badge',
        text: '待运行 · 未评审',
        attrs: { 'data-status': 'unreviewed' }
      })
    );
    header.appendChild(titleRow);
    header.appendChild(make('h2', { text: task.title }));
    header.appendChild(
      make('p', {
        className: 'helper',
        text: '模型输出 0 条 · 人工判断尚未填写'
      })
    );
    header.appendChild(
      make('p', {
        className: 'helper',
        text: '先用下面的问题做研究；检查点留给评审使用，不放进研究提示词。'
      })
    );
    article.appendChild(header);

    const prompt = researchBlock('研究问题');
    prompt.body.appendChild(make('p', { className: 'review-question', text: task.input.prompt }));
    article.appendChild(prompt.section);

    const seeds = researchBlock('身份参考主页');
    const seedList = make('ul', { className: 'review-seed-links' });
    for (const url of task.input.identitySeedUrls) {
      const item = make('li', {});
      // Only validated http(s) values become links; everything else is text.
      if (/^https?:\/\//i.test(url)) {
        item.appendChild(
          make('a', {
            text: url,
            attrs: { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }
          })
        );
      } else {
        item.appendChild(make('span', { text: url }));
      }
      seedList.appendChild(item);
    }
    seeds.body.appendChild(seedList);
    article.appendChild(seeds.section);

    const common = researchBlock(
      `共同评估检查（${task.commonChecks.length} 条）`,
      '回答对照时逐条核对；未评审前不会自动打分。'
    );
    common.body.appendChild(renderCheckList(task.commonChecks));
    const commonDetails = make('details', { className: 'review-research-common' });
    commonDetails.appendChild(make('summary', { text: `共同评估检查（${task.commonChecks.length} 条）` }));
    common.section.querySelector('h3')?.remove();
    commonDetails.appendChild(common.section);

    const person = researchBlock(
      `人物评估检查（${task.personChecks.length} 条）`,
      '结合此人的作品、表达和实际互动逐项核对。'
    );
    person.body.appendChild(renderCheckList(task.personChecks));
    article.appendChild(person.section);
    article.appendChild(commonDetails);

    const observation = researchBlock('观察起点（暂定）', '这是选样起点，后续材料可以修正它。');
    observation.body.appendChild(make('p', { text: task.observedStartingPoint }));
    article.appendChild(observation.section);

    const failure = researchBlock('常见失败', '评估时对照这条失败模式，而不是当作已发生的结论。');
    failure.body.appendChild(make('p', { text: task.typicalFailure }));
    article.appendChild(failure.section);

    const gaps = researchBlock('材料缺口');
    gaps.body.appendChild(make('p', { text: '完整人物资料尚未补齐；公开互动尚未系统抽样。材料不足的检查项需要单独记录，不能当作通过。' }));
    article.appendChild(gaps.section);
    const status = researchBlock('状态与版本信息');
    const techList = make('dl', {});
    const techPairs: [string, string][] = [
      ['执行状态', '待运行（not_run）'],
      ['评审状态', '未评审（unreviewed）'],
      ['模型输出', '0 条（尚无运行）'],
      ['人工判断', '空白（无自动勾选）'],
      ['来源包状态', '不完整（incomplete）'],
      ['交互样本', '未系统抽样（not_systematically_sampled）'],
      ['分片', task.split],
      ['任务 ID', task.taskId],
      ['外部 ID', task.externalId],
      ['内容哈希', task.contentHash],
      ['创建时间', formatDateTime(task.createdAt)]
    ];
    for (const [key, value] of techPairs) {
      const group = make('div', {});
      group.appendChild(make('dt', { text: key }));
      group.appendChild(make('dd', { className: 'mono', text: value }));
      techList.appendChild(group);
    }
    status.body.appendChild(techList);
    const records = make('details', { className: 'review-research-records' });
    records.appendChild(make('summary', { text: '查看状态与版本记录' }));
    records.appendChild(status.section);
    article.appendChild(records);

    const actions = make('footer', { className: 'review-editor-actions' });
    actions.appendChild(
      make('button', {
        className: 'button primary',
        text: '导出研究输入',
        attrs: { type: 'button', 'data-action': 'export-model-input' }
      })
    );
    actions.appendChild(
      make('button', {
        className: 'button',
        text: '导出评审标准',
        attrs: { type: 'button', 'data-action': 'export-spec' }
      })
    );
    actions.appendChild(
      make('p', {
        className: 'helper',
        text: '模型输入只含 case ID、问题与种子链接，不含任何评估检查；完整规范仅供评估方使用。'
      })
    );
    article.insertBefore(actions, prompt.section);

    pane.appendChild(article);
  }

  function renderEditor(): void {
    clear(refs.editor);
    const detail = state.detail;
    if (!detail) {
      refs.editor.appendChild(
        make('p', {
          className: 'review-placeholder',
          text: '从左侧选择一个案例，或先载入练习案例。'
        })
      );
      return;
    }
    const article = make('article', { className: 'review-case', attrs: { 'data-case-id': detail.caseId } });

    const header = make('header', { className: 'review-case-head' });
    const titleRow = make('div', { className: 'review-case-title-row' });
    const badgeText =
      detail.status === 'reviewed' && detail.badge.includes('待你判断')
        ? detail.badge.replace('待你判断', '已提交')
        : detail.badge;
    titleRow.appendChild(make('span', { className: 'review-badge', text: badgeText }));
    titleRow.appendChild(
      make('span', {
        className: 'review-status-badge',
        text: QUEUE_STATUS_LABELS[detail.status],
        attrs: { 'data-status': detail.status }
      })
    );
    header.appendChild(titleRow);
    header.appendChild(make('h2', { text: detail.title }));
    header.appendChild(make('p', { className: 'review-question', text: detail.question }));
    const metaParts = [detail.asOf ? `时间 ${detail.asOf}` : null, detail.latestRevision > 0 ? `已保存 v${detail.latestRevision}` : '尚无版本'].filter(
      (part): part is string => Boolean(part)
    );
    header.appendChild(make('p', { className: 'helper', text: metaParts.join(' · ') }));
    header.appendChild(
      make('p', {
        className: 'helper',
        text: detail.provenance
          ? '回答来源见下方「来源与判断历史」。'
          : '回答来源匿名；提交本条判断后可在下方查看。'
      })
    );
    article.appendChild(header);

    article.appendChild(renderEditorBar());
    article.appendChild(renderPhaseOne(detail));
    article.appendChild(renderPhaseTwo(detail));
    article.appendChild(renderHistory(detail));
    article.appendChild(renderCaseMeta(detail));
    article.appendChild(renderEditorActions());

    refs.editor.appendChild(article);
    updateEditorProgress();
    renderHistorySection();
  }

  function renderEditorBar(): HTMLElement {
    const bar = make('div', {
      className: 'review-editor-bar',
      attrs: { role: 'group', 'aria-label': '评审操作' }
    });
    bar.appendChild(
      make('span', {
        className: 'review-progress-summary',
        attrs: { 'data-role': 'editor-progress', 'aria-live': 'polite' }
      })
    );
    const actions = make('div', { className: 'review-editor-bar-actions' });
    actions.appendChild(
      make('button', {
        className: 'button',
        text: '保存草稿',
        attrs: { type: 'button', 'data-action': 'save-draft' }
      })
    );
    actions.appendChild(
      make('button', {
        className: 'button primary',
        text: '保存并下一题',
        attrs: { type: 'button', 'data-action': 'save-next' }
      })
    );
    bar.appendChild(actions);
    return bar;
  }

  function renderPhaseOne(detail: ReviewCaseDetail): HTMLElement {
    const phase = make('section', { className: 'review-phase' });
    const heading = make('h3', {});
    heading.appendChild(make('span', { className: 'phase-num', text: '1' }));
    heading.appendChild(document.createTextNode(' 证据与论断正确性'));
    phase.appendChild(heading);
    phase.appendChild(
      make('p', {
        className: 'helper',
        text: '证据不足：材料不够，但问题本身可判定；无法判断：问题本身或来源无法评估。支持 / 矛盾必须至少选一条证据。'
      })
    );

    const layout = make('div', { className: 'review-phase1' });
    const evidencePanel = make('section', {
      className: 'review-evidence',
      attrs: { 'aria-label': '证据面板' }
    });
    evidencePanel.appendChild(make('h4', { text: '证据' }));
    const sourceList = make('ul', { className: 'review-source-list' });
    for (const source of detail.sources) {
      const li = make('li', { className: 'review-source', attrs: { 'data-source-id': source.sourceId } });
      const sourceHead = make('div', { className: 'review-source-head' });
      sourceHead.appendChild(make('span', { className: 'source-code mono', text: source.sourceId }));
      sourceHead.appendChild(make('strong', { text: source.title }));
      li.appendChild(sourceHead);
      if (source.locator) {
        li.appendChild(make('span', { className: 'review-locator mono', text: source.locator }));
      }
      li.appendChild(make('p', { className: 'review-source-text', text: source.text }));
      sourceList.appendChild(li);
    }
    evidencePanel.appendChild(sourceList);
    layout.appendChild(evidencePanel);

    const candidatesPanel = make('section', {
      className: 'review-candidates',
      attrs: { 'aria-label': '候选论断' }
    });
    for (const candidate of detail.candidates) {
      const block = make('div', { className: 'review-candidate', attrs: { 'data-blind-label': candidate.blindLabel } });
      block.appendChild(make('h4', { text: `候选 ${candidate.blindLabel}` }));
      for (const claim of candidate.claims) {
        block.appendChild(renderClaim(detail, candidate.blindLabel, claim.claimId, claim.text));
      }
      candidatesPanel.appendChild(block);
    }
    layout.appendChild(candidatesPanel);
    phase.appendChild(layout);
    return phase;
  }

  function renderClaim(
    detail: ReviewCaseDetail,
    blindLabel: string,
    claimId: string,
    text: string
  ): HTMLElement {
    const decision = state.draft?.decisions.get(claimId);
    const card = make('div', {
      className: 'review-claim',
      attrs: { 'data-claim-id': claimId, 'data-blind-label': blindLabel }
    });
    card.appendChild(make('p', { className: 'review-claim-text', text }));

    const labelGroup = make('fieldset', { className: 'review-label-group' });
    labelGroup.appendChild(make('legend', { text: '判断' }));
    for (const label of CLAIM_LABEL_ORDER) {
      const id = `label-${claimId}-${label}`;
      const option = make('label', { className: 'review-choice', attrs: { for: id } });
      option.appendChild(
        make('input', {
          attrs: {
            type: 'radio',
            id,
            name: `label-${claimId}`,
            value: label,
            'data-role': 'claim-label',
            'data-label': label,
            ...(decision?.label === label ? { checked: true } : {})
          }
        })
      );
      option.appendChild(make('span', { text: CLAIM_LABELS[label] }));
      labelGroup.appendChild(option);
    }
    card.appendChild(labelGroup);

    const evidenceGroup = make('fieldset', { className: 'review-evidence-picker' });
    evidenceGroup.appendChild(make('legend', { text: '证据' }));
    evidenceGroup.appendChild(
      make('span', {
        className: 'helper',
        text: '选择支持或矛盾必须至少一条证据。',
        attrs: { 'data-role': 'evidence-hint' }
      })
    );
    for (const source of detail.sources) {
      const id = `ev-${claimId}-${source.sourceId}`;
      const option = make('label', { className: 'review-choice', attrs: { for: id } });
      option.appendChild(
        make('input', {
          attrs: {
            type: 'checkbox',
            id,
            value: source.sourceId,
            'data-role': 'evidence',
            ...(decision?.evidenceIds.includes(source.sourceId) ? { checked: true } : {})
          }
        })
      );
      option.appendChild(make('span', { className: 'mono', text: source.sourceId }));
      option.appendChild(make('span', { text: source.title }));
      evidenceGroup.appendChild(option);
    }
    card.appendChild(evidenceGroup);

    const noteId = `note-${claimId}`;
    const noteField = make('div', { className: 'field review-note' });
    noteField.appendChild(make('label', { text: '说明（可选）', attrs: { for: noteId } }));
    noteField.appendChild(
      make('input', {
        attrs: {
          type: 'text',
          id: noteId,
          maxlength: '600',
          value: decision?.note ?? '',
          'data-role': 'claim-note'
        }
      })
    );
    card.appendChild(noteField);
    applyLabelState(card, decision?.label ?? null);
    return card;
  }

  function renderPhaseTwo(detail: ReviewCaseDetail): HTMLElement {
    const phase = make('section', { className: 'review-phase' });
    const heading = make('h3', {});
    heading.appendChild(make('span', { className: 'phase-num', text: '2' }));
    heading.appendChild(document.createTextNode(' 盲选偏好与人工标准'));
    phase.appendChild(heading);

    // Compact side-by-side full candidate text so preference can be decided
    // without scrolling back through every claim form.
    const summary = make('div', {
      className: 'review-candidate-summary',
      attrs: { role: 'group', 'aria-label': '候选全文对照' }
    });
    for (const candidate of detail.candidates) {
      const column = make('section', { className: 'review-candidate-summary-col' });
      column.appendChild(make('h4', { text: `候选 ${candidate.blindLabel}` }));
      const list = make('ol', {});
      for (const claim of candidate.claims) {
        list.appendChild(make('li', { text: claim.text }));
      }
      column.appendChild(list);
      summary.appendChild(column);
    }
    phase.appendChild(summary);

    const preference = make('fieldset', { className: 'review-preference' });
    preference.appendChild(make('legend', { text: '哪个候选更好？' }));
    for (const value of PREFERENCE_ORDER) {
      const id = `preference-${value}`;
      const option = make('label', { className: 'review-choice', attrs: { for: id } });
      option.appendChild(
        make('input', {
          attrs: {
            type: 'radio',
            id,
            name: 'review-preference',
            value,
            'data-role': 'preference',
            ...(state.draft?.preference === value ? { checked: true } : {})
          }
        })
      );
      option.appendChild(make('span', { text: PREFERENCE_LABELS[value] }));
      preference.appendChild(option);
    }
    phase.appendChild(preference);

    const reasons = make('fieldset', { className: 'review-reasons' });
    reasons.appendChild(make('legend', { text: '理由标签（可多选）' }));
    for (const tag of REASON_TAG_ORDER) {
      const id = `reason-${tag}`;
      const option = make('label', { className: 'review-choice', attrs: { for: id } });
      option.appendChild(
        make('input', {
          attrs: {
            type: 'checkbox',
            id,
            value: tag,
            'data-role': 'reason-tag',
            ...(state.draft?.reasonTags.has(tag) ? { checked: true } : {})
          }
        })
      );
      option.appendChild(make('span', { text: REASON_TAG_LABELS[tag] }));
      reasons.appendChild(option);
    }
    phase.appendChild(reasons);

    const rationaleField = make('div', { className: 'field' });
    rationaleField.appendChild(make('label', { text: '判断理由（提交必填）' }));
    rationaleField.appendChild(
      make('textarea', {
        attrs: { rows: '3', maxlength: '1200', 'data-role': 'rationale', 'aria-label': '判断理由' },
        text: state.draft?.rationale ?? ''
      })
    );
    phase.appendChild(rationaleField);

    const rubric = make('fieldset', { className: 'review-rubric' });
    rubric.appendChild(make('legend', { text: '你的参考标准（人工评分标准，可编辑）' }));
    rubric.appendChild(textareaField('参考答案', 'reference', state.draft?.referenceAnswer ?? '', 2000));
    rubric.appendChild(textareaField('必须包含（每行一条）', 'must-include', state.draft?.mustIncludeRaw ?? '', 1200));
    rubric.appendChild(textareaField('必须避免（每行一条）', 'must-avoid', state.draft?.mustAvoidRaw ?? '', 1200));
    phase.appendChild(rubric);
    return phase;
  }

  function textareaField(label: string, role: string, value: string, maxlength: number): HTMLElement {
    const wrapper = make('div', { className: 'field' });
    fieldIdCounter += 1;
    const id = `review-field-${fieldIdCounter}`;
    const labelEl = make('label', { text: label });
    labelEl.setAttribute('for', id);
    wrapper.appendChild(labelEl);
    const textarea = make('textarea', {
      attrs: { id, rows: '2', maxlength: String(maxlength), 'data-role': role, 'aria-label': label }
    }) as HTMLTextAreaElement;
    textarea.value = value;
    wrapper.appendChild(textarea);
    return wrapper;
  }

  function renderHistory(detail: ReviewCaseDetail): HTMLElement {
    const details = make('details', { className: 'review-history' });
    details.appendChild(
      make('summary', {
        text: `历史版本（${state.history.length}）`,
        attrs: { 'data-role': 'history-toggle', 'data-action': 'history-load' }
      })
    );
    details.appendChild(make('div', { attrs: { 'data-role': 'history-body' } }));
    void detail;
    return details;
  }

  /** Technical snapshot and candidate origin live below history, not in the header. */
  function renderCaseMeta(detail: ReviewCaseDetail): HTMLElement {
    const details = make('details', { className: 'review-case-tech' });
    details.appendChild(make('summary', { text: '来源与判断历史（技术信息）' }));
    const body = make('div', {});
    if (detail.provenance) {
      const prov = make('div', { className: 'review-provenance' });
      prov.appendChild(make('strong', { text: '候选来源（提交后显示）' }));
      const list = make('ul', {});
      for (const item of detail.provenance) {
        list.appendChild(
          make('li', {
            text: `${item.blindLabel}：来源 ${item.origin ?? '未标注'}${item.model ? ` · 模型 ${item.model}` : ''}${item.notes ? ` · ${item.notes}` : ''}`
          })
        );
      }
      prov.appendChild(list);
      body.appendChild(prov);
    } else {
      body.appendChild(make('p', { className: 'helper', text: '候选来源在提交本条判断后才显示。' }));
    }
    const techList = make('dl', {});
    const techPairs: [string, string][] = [
      ['案例 ID', detail.caseId],
      ['数据集', detail.datasetVersion],
      ['分片', detail.split],
      ['rubric 版本', String(detail.rubricVersion)],
      ['内容哈希', detail.contentHash]
    ];
    for (const [key, value] of techPairs) {
      const group = make('div', {});
      group.appendChild(make('dt', { text: key }));
      group.appendChild(make('dd', { className: 'mono', text: value }));
      techList.appendChild(group);
    }
    body.appendChild(techList);
    details.appendChild(body);
    return details;
  }

  function renderHistorySection(): void {
    const body = refs.editor.querySelector<HTMLElement>('[data-role="history-body"]');
    if (!body) return;
    clear(body);
    if (state.historyLoading) {
      body.appendChild(make('p', { className: 'helper', text: '正在载入历史版本…' }));
      return;
    }
    if (!state.historyRevisions) {
      body.appendChild(
        make('p', { className: 'helper', text: '展开后载入历史版本，可只读查看旧标签与 rubric。' })
      );
      return;
    }
    if (state.historyRevisions.length === 0) {
      body.appendChild(make('p', { className: 'helper', text: '尚无历史记录。' }));
      return;
    }
    const claimText = new Map<string, string>();
    for (const candidate of state.detail?.candidates ?? []) {
      for (const claim of candidate.claims) claimText.set(claim.claimId, claim.text);
    }
    const list = make('div', { className: 'review-history-revisions' });
    for (const revision of [...state.historyRevisions].reverse()) {
      const item = make('details', { className: 'review-history-revision' });
      item.appendChild(
        make('summary', {
          text: `v${revision.revision} · ${revision.status === 'submitted' ? '已提交' : '草稿'} · ${formatDateTime(revision.createdAt)} · ${revision.actorPseudonymousId}`
        })
      );
      const content = make('div', { className: 'review-history-content' });
      const decisions = make('ul', {});
      for (const decision of revision.decisions) {
        const label = decision.label ? CLAIM_LABELS[decision.label] : '未判断';
        const text = claimText.get(decision.claimId) ?? decision.claimId;
        decisions.appendChild(
          make('li', {
            text: `${text} — ${label}${decision.evidenceIds.length > 0 ? `（证据 ${decision.evidenceIds.join('、')}）` : ''}${decision.note ? ` · ${decision.note}` : ''}`
          })
        );
      }
      content.appendChild(make('p', { className: 'helper', text: '论断判断' }));
      content.appendChild(decisions);
      content.appendChild(
        make('p', {
          className: 'helper',
          text: `偏好：${revision.preference ? PREFERENCE_LABELS[revision.preference] : '未选择'} · 理由：${revision.rationale || '（空）'} · 理由标签：${
            revision.reasonTags.length > 0 ? revision.reasonTags.map((tag) => REASON_TAG_LABELS[tag]).join('、') : '（无）'
          }`
        })
      );
      content.appendChild(
        make('p', {
          className: 'helper',
          text: `参考答案：${revision.rubric.referenceAnswer || '（空）'} · 必须包含：${
            revision.rubric.mustInclude.join('、') || '（空）'
          } · 必须避免：${revision.rubric.mustAvoid.join('、') || '（空）'}`
        })
      );
      item.appendChild(content);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  function renderEditorActions(): HTMLElement {
    const footer = make('footer', { className: 'review-editor-actions' });
    footer.appendChild(
      make('button', {
        className: 'button',
        text: '上一题',
        attrs: { type: 'button', 'data-action': 'prev' }
      })
    );
    footer.appendChild(
      make('button', {
        className: 'button',
        text: '下一题',
        attrs: { type: 'button', 'data-action': 'next' }
      })
    );
    footer.appendChild(
      make('button', {
        className: 'button danger',
        text: '删除案例',
        attrs: { type: 'button', 'data-action': 'delete' }
      })
    );
    footer.appendChild(
      make('span', {
        className: 'helper',
        text: '提交需要每个论断都有判断，且偏好与理由已填写。⌘ / Ctrl + Enter 保存并下一题。'
      })
    );
    return footer;
  }

  /* ---------------- research task data flow ---------------- */

  async function refreshResearch(options: { force?: boolean } = {}): Promise<void> {
    if (!mounted) return;
    if (state.researchLoaded && !options.force) return;
    const token = ++researchListToken;
    const generation = sessionGeneration;
    try {
      const result = await deps.api.listResearchTasks();
      if (token !== researchListToken || isStaleSession(generation)) return;
      state.researchTasks = result.tasks;
      state.researchNote = result.note;
      state.researchLoaded = true;
      if (
        state.researchTaskId &&
        !result.tasks.some((task) => task.taskId === state.researchTaskId)
      ) {
        state.researchTaskId = null;
        state.researchDetail = null;
        state.researchLoading = false;
      }
      renderResearch();
    } catch (error) {
      if (token !== researchListToken || isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      deps.onToast(error instanceof ApiError ? error.message : '读取研究案例列表失败。', 'error');
    }
  }

  async function selectResearchTask(taskId: string): Promise<void> {
    const token = ++researchTaskToken;
    const generation = sessionGeneration;
    state.researchTaskId = taskId;
    state.researchDetail = null;
    state.researchLoading = true;
    renderResearch();
    try {
      const task = await deps.api.getResearchTask(taskId);
      if (token !== researchTaskToken || isStaleSession(generation)) return;
      if (state.researchTaskId !== taskId) return;
      state.researchDetail = task;
      state.researchLoading = false;
      renderResearch();
    } catch (error) {
      if (token !== researchTaskToken || isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      state.researchLoading = false;
      renderResearch();
      deps.onToast(error instanceof ApiError ? error.message : '读取研究案例失败。', 'error');
    }
  }

  function researchImportHasContent(): boolean {
    return (refs.researchImportTextarea?.value ?? '').trim().length > 0;
  }

  function setResearchImportControlsDisabled(disabled: boolean): void {
    const controls = refs.researchImportDialog?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
    >('input, textarea, select, button');
    if (!controls) return;
    for (const control of controls) {
      if (disabled) {
        control.dataset.reviewWasDisabled = control.disabled ? '1' : '0';
        control.disabled = true;
      } else {
        control.disabled = control.dataset.reviewWasDisabled === '1';
        delete control.dataset.reviewWasDisabled;
      }
    }
  }

  function openResearchImport(): void {
    setText(refs.researchImportError, '');
    refs.researchImportDialog?.showModal();
  }

  function importItemLabel(value: unknown, index: number, total: number): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const externalId = (value as { externalId?: unknown }).externalId;
      if (typeof externalId === 'string' && externalId.trim().length > 0) {
        return `externalId ${externalId.trim()}`;
      }
    }
    return total > 1 ? `第 ${index + 1} 条` : '该任务';
  }

  /** Import through the real API: every failure is shown verbatim, never faked. */
  async function importResearchTasks(dialog: ResearchImportDialog): Promise<void> {
    if (state.researchImportBusy) return;
    const raw = dialog.textarea.value.trim();
    setText(refs.researchImportError, '');
    if (raw.length === 0) {
      setText(refs.researchImportError, '请先选择 JSON 文件或粘贴 JSON 内容。');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setText(refs.researchImportError, 'JSON 解析失败，请检查内容格式。');
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) {
      setText(refs.researchImportError, 'JSON 数组为空，没有可导入的任务。');
      return;
    }

    state.researchImportBusy = true;
    setResearchImportControlsDisabled(true);
    const generation = sessionGeneration;
    const failures: string[] = [];
    let succeeded = 0;
    try {
      for (let index = 0; index < items.length; index += 1) {
        if (isStaleSession(generation)) return;
        try {
          await deps.api.createResearchTask(items[index] as ResearchTaskInput);
          if (isStaleSession(generation)) return;
          succeeded += 1;
        } catch (error) {
          if (isStaleSession(generation)) return;
          if (handleUnauthorized(error, generation)) return;
          const message = error instanceof ApiError ? error.message : '导入失败。';
          failures.push(`${importItemLabel(items[index], index, items.length)}：${message}`);
        }
      }
    } finally {
      if (!isStaleSession(generation)) {
        state.researchImportBusy = false;
        setResearchImportControlsDisabled(false);
      }
    }
    if (isStaleSession(generation)) return;
    if (failures.length > 0) {
      setText(
        refs.researchImportError,
        `导入未全部成功：成功 ${succeeded} 条，失败 ${failures.length} 条。${failures.join('；')}`
      );
      // Keep the entered JSON so nothing is lost; show only real successes.
      if (succeeded > 0) await refreshResearch({ force: true });
      return;
    }
    dialog.textarea.value = '';
    dialog.file.value = '';
    dialog.element.close();
    await refreshResearch({ force: true });
    if (isStaleSession(generation)) return;
    deps.onToast(
      items.length === 1 ? '已导入 1 个研究案例。' : `已导入 ${items.length} 个研究案例。`
    );
  }

  function downloadJson(filename: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = make('a', { attrs: { href: url, download: filename } });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  /** Model input only: prompt, seeds and case ID — never the evaluator checks. */
  function exportResearchModelInput(): void {
    const task = state.researchDetail;
    if (!task) return;
    downloadJson(`research-model-input-${task.taskId}.json`, researchModelInput(task));
    deps.onToast('已导出模型输入：仅问题与种子链接，不含评估标准。');
  }

  /** Full evaluator specification, exported separately from the model input. */
  function exportResearchSpec(): void {
    const task = state.researchDetail;
    if (!task) return;
    downloadJson(`research-task-spec-${task.taskId}.json`, researchSpecExport(task));
    deps.onToast('已导出完整评估规范（含评估检查，仅供评估方使用）。');
  }

  /* ---------------- data flow ---------------- */

  async function refreshQueue(): Promise<void> {
    const token = ++queueToken;
    const generation = sessionGeneration;
    try {
      const result = await deps.api.listReviewCases();
      if (token !== queueToken || isStaleSession(generation)) return;
      state.queue = result.cases;
      state.progress = result.progress;
      queueLoaded = true;
      renderQueue();
    } catch (error) {
      if (token !== queueToken || isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      setError(error instanceof ApiError ? error.message : '读取案例队列失败。');
    }
  }

  async function loadCase(
    caseId: string,
    options: {
      quiet?: boolean;
      keepEditsIfChanged?: boolean;
      abortIfEdited?: boolean;
      preserveBusy?: boolean;
    } = {}
  ): Promise<boolean> {
    const token = ++loadToken;
    const generation = sessionGeneration;
    const editsAtLoad = editGeneration;
    // A new case context starts interactable even if an older save is pending.
    if (!options.preserveBusy) resetBusy();
    clearError();
    try {
      const response = await deps.api.getReviewCase(caseId);
      if (token !== loadToken || isStaleSession(generation)) return false;
      const editedDuringLoad = editGeneration !== editsAtLoad;
      // Navigation must not silently drop input typed while the case was loading.
      if (options.abortIfEdited && editedDuringLoad) return false;
      state.caseId = caseId;
      state.detail = response.case;
      state.annotation = response.annotation;
      state.history = response.history;
      state.historyRevisions = null;
      state.historyLoading = false;
      state.insightsOpen = false;
      refs.insights.hidden = true;
      if (!(options.keepEditsIfChanged && editedDuringLoad)) {
        state.draft = draftFrom(response.case, response.annotation);
        state.dirty = false;
      }
      renderQueue();
      renderEditor();
      return true;
    } catch (error) {
      if (token !== loadToken || isStaleSession(generation)) return false;
      if (handleUnauthorized(error, generation)) return false;
      if (!options.quiet) setError(error instanceof ApiError ? error.message : '读取案例失败。');
      return false;
    }
  }

  async function open(caseId?: string | null): Promise<void> {
    mount();
    if (destroyed) return;
    if (!queueLoaded) await refreshQueue();
    await refreshResearch();
    const target =
      caseId ?? state.caseId ?? visibleQueue()[0]?.caseId ?? state.queue[0]?.caseId ?? null;
    if (target && target !== state.caseId) {
      await loadCase(target);
      return;
    }
    renderQueue();
    renderEditor();
  }

  async function refresh(): Promise<void> {
    mount();
    if (
      hasUnsavedChanges() &&
      !window.confirm('当前案例还有未保存的修改，刷新会丢弃它们。确定刷新吗？')
    ) {
      return;
    }
    await refreshQueue();
    await refreshResearch({ force: true });
    if (state.caseId && state.queue.some((item) => item.caseId === state.caseId)) {
      await loadCase(state.caseId);
    } else {
      renderEditor();
    }
  }

  function navigateTo(caseId: string | null): void {
    // With onNavigate the host owns the hash guard; only the fallback path
    // needs to confirm here so it cannot silently drop unsaved work.
    if (
      !deps.onNavigate &&
      caseId !== state.caseId &&
      hasUnsavedChanges() &&
      !window.confirm('当前案例还有未保存的修改，切换会丢弃它们。确定切换吗？')
    ) {
      return;
    }
    if (deps.onNavigate) {
      deps.onNavigate(caseId);
      return;
    }
    if (caseId) {
      void loadCase(caseId);
    } else {
      state.caseId = null;
      state.detail = null;
      state.annotation = null;
      state.draft = null;
      state.dirty = false;
      resetBusy();
      renderQueue();
      renderEditor();
    }
  }

  function neighbor(direction: 1 | -1): string | null {
    const visible = visibleQueue();
    if (visible.length === 0) return null;
    const index = visible.findIndex((item) => item.caseId === state.caseId);
    if (index === -1) return visible[0]?.caseId ?? null;
    const next = (index + direction + visible.length) % visible.length;
    return visible[next]?.caseId ?? null;
  }

  function navigateRelative(direction: 1 | -1): void {
    const next = neighbor(direction);
    if (next && next !== state.caseId) navigateTo(next);
  }

  async function selectCase(caseId: string): Promise<void> {
    if (caseId === state.caseId) return;
    navigateTo(caseId);
  }

  function collect(status: 'draft' | 'submitted'): {
    expectedRevision: number;
    status: 'draft' | 'submitted';
    decisions: ReviewDecision[];
    preference: Preference | null;
    rationale: string | null;
    reasonTags: ReasonTag[];
    rubric: { referenceAnswer: string; mustInclude: string[]; mustAvoid: string[] };
  } | null {
    const detail = state.detail;
    const draft = state.draft;
    if (!detail || !draft) return null;
    const decisions: ReviewDecision[] = detail.claimIds.map((claimId) => {
      const decision = draft.decisions.get(claimId);
      return {
        claimId,
        label: decision?.label ?? null,
        evidenceIds: decision ? [...decision.evidenceIds] : [],
        note: decision?.note.trim() ? decision.note.trim() : null
      };
    });
    return {
      expectedRevision: state.annotation?.revision ?? 0,
      status,
      decisions,
      preference: draft.preference,
      rationale: draft.rationale.trim().length > 0 ? draft.rationale.trim() : null,
      reasonTags: [...draft.reasonTags],
      rubric: {
        referenceAnswer: draft.referenceAnswer,
        mustInclude: allLines(draft.mustIncludeRaw),
        mustAvoid: allLines(draft.mustAvoidRaw)
      }
    };
  }

  function clientIssues(payload: {
    rationale: string | null;
    rubric: { referenceAnswer: string; mustInclude: string[]; mustAvoid: string[] };
  }): string | null {
    if (payload.rationale && payload.rationale.length > LIMITS.reviewRationaleMax) {
      return `判断理由不能超过 ${LIMITS.reviewRationaleMax} 个字符。`;
    }
    if (payload.rubric.referenceAnswer.length > LIMITS.reviewReferenceAnswerMax) {
      return `参考答案不能超过 ${LIMITS.reviewReferenceAnswerMax} 个字符。`;
    }
    if (payload.rubric.mustInclude.length > RUBRIC_MAX_LINES) return `必须包含最多 ${RUBRIC_MAX_LINES} 条。`;
    if (payload.rubric.mustAvoid.length > RUBRIC_MAX_LINES) return `必须避免最多 ${RUBRIC_MAX_LINES} 条。`;
    return null;
  }

  function updateBusy(): void {
    for (const button of refs.editor.querySelectorAll<HTMLButtonElement>(
      '[data-action="save-draft"], [data-action="save-next"]'
    )) {
      button.disabled = state.busy;
    }
  }

  async function saveCurrent(status: 'draft' | 'submitted', andNext: boolean): Promise<void> {
    const detail = state.detail;
    const payload = collect(status);
    if (!detail || !payload || state.busy) return;
    const localIssue = clientIssues(payload);
    if (localIssue) {
      setError(localIssue);
      return;
    }
    const issues = validateAnnotationShape(detail, payload);
    if (issues.length > 0) {
      setError(issues[0]!.message);
      return;
    }
    clearError();
    const generation = sessionGeneration;
    const token = loadToken;
    const editsAtStart = editGeneration;
    const busyOwner = ++busyGeneration;
    state.busy = true;
    updateBusy();
    setStatus('正在保存…');
    let saved: ReviewAnnotationView;
    try {
      const result = await deps.api.saveReviewAnnotation(detail.caseId, payload);
      if (isStaleSession(generation) || token !== loadToken || state.caseId !== detail.caseId) {
        if (busyOwner === busyGeneration) {
          state.busy = false;
          updateBusy();
        }
        return;
      }
      saved = result.annotation;
      state.annotation = saved;
      // Inputs stay editable while a save is pending. If the reviewer typed
      // anything after the request started, keep those newer edits, stay dirty
      // and do not auto-advance or re-read (which would discard them).
      const editedDuringSave = editGeneration !== editsAtStart;
      if (editedDuringSave) {
        state.dirty = true;
        setStatus(`${result.acknowledgment}；保存后还有新修改，请再次保存。`);
      } else {
        state.dirty = false;
        setStatus(result.acknowledgment);
      }
      state.queue = state.queue.map((item) =>
        item.caseId === detail.caseId
          ? {
              ...item,
              status: saved.status === 'submitted' ? 'reviewed' : 'draft',
              latestStatus: saved.status,
              latestRevision: saved.revision
            }
          : item
      );
      state.progress = recountProgress();
      renderQueue();
      if (editedDuringSave) {
        if (busyOwner === busyGeneration) {
          state.busy = false;
          updateBusy();
        }
        return;
      }
    } catch (error) {
      if (busyOwner === busyGeneration) {
        state.busy = false;
        updateBusy();
      }
      if (isStaleSession(generation) || token !== loadToken) return;
      if (handleUnauthorized(error, generation)) return;
      if (error instanceof ApiError && error.code === 'stale_revision') {
        setError('该案例已有更新的评审版本，请刷新后重试；你的输入仍保留在本页。');
      } else {
        setError(error instanceof ApiError ? error.message : '保存失败，草稿仍保留在本页。');
      }
      return;
    }

    // Save succeeded and the draft is clean. Keep `busy` until the post-save
    // navigation/re-read finishes so a second save cannot race it. A
    // best-effort re-read must never be reported as a failed save or trigger a
    // duplicate revision, and must not overwrite anything typed meanwhile.
    const finishBusy = (): void => {
      if (busyOwner === busyGeneration) {
        state.busy = false;
        updateBusy();
      }
    };
    if (andNext) {
      const next = neighbor(1);
      if (next && next !== detail.caseId) {
        const loaded = await loadCase(next, { quiet: true, abortIfEdited: true, preserveBusy: true });
        finishBusy();
        if (!loaded) {
          deps.onToast('已保存；检测到新的修改，已留在当前案例。', 'info');
          return;
        }
        deps.onNavigate?.(next);
        return;
      }
    }
    if (saved.status === 'submitted') {
      // Re-read to reveal provenance and history while keeping any newer edits.
      const refreshed = await loadCase(detail.caseId, { quiet: true, keepEditsIfChanged: true, preserveBusy: true });
      finishBusy();
      if (!refreshed) deps.onToast('已保存，但刷新最新状态失败，请稍后手动刷新。', 'info');
      return;
    }
    // Draft saves need no network re-read; the local draft already holds the
    // latest input and the annotation revision is up to date.
    finishBusy();
    renderEditor();
  }

  function recountProgress(): ReviewProgress {
    const progress: ReviewProgress = { total: state.queue.length, reviewed: 0, draft: 0, unreviewed: 0 };
    for (const item of state.queue) progress[item.status] += 1;
    return progress;
  }

  async function deleteCurrent(): Promise<void> {
    const detail = state.detail;
    if (!detail || state.busy) return;
    if (!window.confirm('删除这个案例及其全部评审记录？此操作不可恢复。')) return;
    const generation = sessionGeneration;
    const token = ++loadToken;
    try {
      await deps.api.deleteReviewCase(detail.caseId);
    } catch (error) {
      if (isStaleSession(generation) || token !== loadToken) return;
      if (handleUnauthorized(error, generation)) return;
      setError(error instanceof ApiError ? error.message : '删除失败。');
      return;
    }
    if (isStaleSession(generation) || token !== loadToken) return;
    state.caseId = null;
    state.detail = null;
    state.annotation = null;
    state.history = [];
    state.historyRevisions = null;
    state.draft = null;
    state.dirty = false;
    resetBusy();
    await refreshQueue();
    if (isStaleSession(generation) || token !== loadToken) return;
    deps.onNavigate?.(null);
    await open(null);
    deps.onToast('已删除案例。');
  }

  async function seedPractice(): Promise<void> {
    if (state.busy) return;
    const generation = sessionGeneration;
    const busyOwner = ++busyGeneration;
    state.busy = true;
    updateBusy();
    try {
      const result = await deps.api.seedReviewCases();
      if (busyOwner === busyGeneration) {
        state.busy = false;
        updateBusy();
      }
      if (isStaleSession(generation)) return;
      if (result.capped) {
        deps.onToast('案例数量已达上限，只载入了部分练习案例。', 'info');
      } else {
        deps.onToast(
          result.inserted > 0 ? `已载入 ${result.inserted} 个练习案例。` : '练习案例已存在，没有重复插入。'
        );
      }
      // Only refresh the queue; reloading the open case would discard edits.
      await refreshQueue();
    } catch (error) {
      if (busyOwner === busyGeneration) {
        state.busy = false;
        updateBusy();
      }
      if (isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      deps.onToast(error instanceof ApiError ? error.message : '载入练习案例失败。', 'error');
    }
  }

  function openNewCaseDialog(): void {
    clearError();
    setText(refs.dialogError, '');
    refs.dialog.showModal();
  }

  function newCaseHasContent(): boolean {
    const form = refs.dialog?.querySelector('form');
    if (!form) return false;
    const fields = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]');
    for (const field of fields) {
      if (field.value.trim().length > 0) return true;
    }
    if (refs.sourceRows) {
      for (const field of refs.sourceRows.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
        if (field.value.trim().length > 0) return true;
      }
    }
    return false;
  }

  function hasUnsavedChanges(): boolean {
    return state.dirty || newCaseHasContent() || researchImportHasContent();
  }

  /** Disable every new-case control while the POST is pending, remembering prior state. */
  function setNewCaseControlsDisabled(disabled: boolean): void {
    const controls = refs.dialog?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
    >('input, textarea, select, button');
    if (!controls) return;
    for (const control of controls) {
      if (disabled) {
        control.dataset.reviewWasDisabled = control.disabled ? '1' : '0';
        control.disabled = true;
      } else {
        control.disabled = control.dataset.reviewWasDisabled === '1';
        delete control.dataset.reviewWasDisabled;
      }
    }
  }

  async function submitNewCase(): Promise<void> {
    if (state.newCaseBusy) return;
    const dialog = refs.dialog;
    const form = dialog.querySelector('form');
    if (!form) return;
    const value = (fieldName: string): string => {
      const element = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${fieldName}"]`);
      return element?.value.trim() ?? '';
    };
    const rows = [...refs.sourceRows.querySelectorAll<HTMLElement>('.review-source-row')];
    const sources: { title: string; text: string; locator: string | null }[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const title = row.querySelector<HTMLInputElement>('[data-source-field="title"]')?.value.trim() ?? '';
      const text = row.querySelector<HTMLTextAreaElement>('[data-source-field="text"]')?.value.trim() ?? '';
      const locator = row.querySelector<HTMLInputElement>('[data-source-field="locator"]')?.value.trim() ?? '';
      if (title.length === 0 && text.length === 0 && locator.length === 0) continue;
      if (title.length === 0 || text.length === 0) {
        setText(refs.dialogError, `第 ${index + 1} 条证据不完整：需要标题和正文，已保留你填写的内容。`);
        return;
      }
      sources.push({ title, text, locator: locator.length > 0 ? locator : null });
    }
    const question = value('question');
    const candidateA = value('candidate-a');
    const candidateB = value('candidate-b');
    if (question.length < 2) {
      setText(refs.dialogError, '请填写至少 2 个字符的问题。');
      return;
    }
    if (sources.length === 0) {
      setText(refs.dialogError, '至少需要一条有标题和正文的证据。');
      return;
    }
    if (candidateA.length === 0 || candidateB.length === 0) {
      setText(refs.dialogError, '两个候选回答都需要内容（每行一条论断）。');
      return;
    }
    state.newCaseBusy = true;
    setNewCaseControlsDisabled(true);
    const generation = sessionGeneration;
    try {
      const created = await deps.api.createReviewCase({
        title: value('title') || undefined,
        question,
        asOf: value('as-of') || null,
        sources,
        candidates: [
          { response: candidateA, origin: value('origin-a') || null },
          { response: candidateB, origin: value('origin-b') || null }
        ]
      });
      if (isStaleSession(generation)) return;
      // The new case exists server-side. Before navigating away, ask if the
      // current review has unsaved judgments and keep them if the user cancels.
      const keepCurrent = state.dirty;
      dialog.close();
      form.reset();
      while (refs.sourceRows.querySelectorAll('.review-source-row').length > 1) {
        refs.sourceRows.querySelector('.review-source-row')?.remove();
      }
      const firstRow = refs.sourceRows.querySelector('.review-source-row');
      firstRow?.querySelectorAll('input, textarea').forEach((element) => {
        (element as HTMLInputElement).value = '';
      });
      if (
        keepCurrent &&
        !window.confirm(
          '切换会丢失这些未保存的判断。取消可留在当前案例，先保存再从列表打开新案例。仍要切换吗？'
        )
      ) {
        await refreshQueue();
        if (isStaleSession(generation)) return;
        deps.onToast('已创建案例；当前案例的未保存输入仍保留。');
        return;
      }
      // Confirmed switch (or clean editor): stay put if new edits appear and
      // only clear dirty once navigation actually succeeds.
      const editsAtConfirm = editGeneration;
      await refreshQueue();
      if (isStaleSession(generation)) return;
      if (editGeneration !== editsAtConfirm) {
        deps.onToast('检测到新的修改，已留在当前案例；新案例已在列表中。', 'info');
        return;
      }
      deps.onToast('已创建案例。');
      const loaded = await loadCase(created.caseId, { quiet: true, abortIfEdited: true });
      if (isStaleSession(generation)) return;
      if (!loaded) {
        deps.onToast('已创建案例，但未切换（可能有新的修改或加载失败）。', 'info');
        return;
      }
      deps.onNavigate?.(created.caseId);
    } catch (error) {
      if (isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      setText(refs.dialogError, error instanceof ApiError ? error.message : '创建案例失败，已保留填写内容。');
    } finally {
      if (!isStaleSession(generation)) {
        state.newCaseBusy = false;
        setNewCaseControlsDisabled(false);
      }
    }
  }

  async function ensureHistory(): Promise<void> {
    const detail = state.detail;
    if (!detail || state.historyRevisions || state.historyLoading) return;
    const generation = sessionGeneration;
    const token = loadToken;
    state.historyLoading = true;
    renderHistorySection();
    try {
      const result = await deps.api.getReviewHistory(detail.caseId);
      if (isStaleSession(generation) || token !== loadToken || state.detail?.caseId !== detail.caseId) return;
      state.historyRevisions = result.revisions;
      state.history = result.history;
    } catch (error) {
      if (isStaleSession(generation) || token !== loadToken) return;
      if (handleUnauthorized(error, generation)) return;
      deps.onToast(error instanceof ApiError ? error.message : '读取历史版本失败。', 'error');
    } finally {
      if (!isStaleSession(generation) && token === loadToken) {
        state.historyLoading = false;
        renderHistorySection();
      }
    }
  }

  async function toggleInsights(): Promise<void> {
    const button = deps.root.querySelector<HTMLButtonElement>('[data-action="insights"]');
    if (state.insightsOpen) {
      state.insightsOpen = false;
      refs.insights.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
      return;
    }
    const generation = sessionGeneration;
    let insights: ReviewInsights;
    try {
      insights = await deps.api.getReviewInsights();
    } catch (error) {
      if (isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      deps.onToast(error instanceof ApiError ? error.message : '读取汇总失败。', 'error');
      return;
    }
    if (isStaleSession(generation)) return;
    state.insights = insights;
    state.insightsOpen = true;
    refs.insights.hidden = false;
    button?.setAttribute('aria-expanded', 'true');
    renderInsights();
  }

  function renderInsights(): void {
    const insights = state.insights;
    clear(refs.insights);
    if (!insights) return;
    refs.insights.appendChild(make('h2', { text: '已提交评审汇总' }));
    refs.insights.appendChild(make('p', { className: 'helper', text: insights.note }));
    refs.insights.appendChild(
      make('p', {
        className: 'mono',
        text: `来源：${insights.caseCounts.reviewed} 份已提交 / 共 ${insights.caseCounts.total} 个案例`
      })
    );
    refs.insights.appendChild(countTable('事实判断', insights.factualLabels, CLAIM_LABELS));
    refs.insights.appendChild(countTable('偏好', insights.preferenceCounts, PREFERENCE_LABELS));
    refs.insights.appendChild(countTable('理由标签', insights.reasonTagCounts, REASON_TAG_LABELS));

    const suggestions: string[] = [];
    const uncertainty = insights.reasonTagCounts.uncertainty;
    const citations = insights.reasonTagCounts.citations;
    const coverage = insights.reasonTagCounts.coverage;
    const counterevidence = insights.reasonTagCounts.counterevidence;
    if (uncertainty > 0) {
      suggestions.push(`你选择过「不确定性」（${uncertainty} 次）：建议安排人工复核证据是否足够，或补充材料，而不是自动下结论。`);
    }
    if (citations > 0) {
      suggestions.push(`你选择过「引用」（${citations} 次）：建议人工抽查候选引用是否指向真实证据 ID。`);
    }
    if (coverage > 0) {
      suggestions.push(`你选择过「覆盖」（${coverage} 次）：建议扩展 rubric 的必须包含项，或准备更完整的候选。`);
    }
    if (counterevidence > 0) {
      suggestions.push(`你选择过「反证」（${counterevidence} 次）：建议在下一轮明确要求呈现相反证据。`);
    }
    if (suggestions.length === 0) {
      suggestions.push('本轮没有选择任何理由标签：建议在下一轮补充理由标签，并安排第二位人工评审验证一致性。');
    }
    const advice = make('div', { className: 'review-insight-group' });
    advice.appendChild(make('h3', { text: '下一步建议（需人工确认）' }));
    const list = make('ul', {});
    for (const suggestion of suggestions) list.appendChild(make('li', { text: suggestion }));
    advice.appendChild(list);
    advice.appendChild(
      make('p', {
        className: 'helper',
        text: '以上只是基于已提交标签的线索，系统不自动判定质量、胜负或 benchmark 分数。'
      })
    );
    refs.insights.appendChild(advice);
  }

  function countTable(
    title: string,
    counts: Record<string, number>,
    labels: Record<string, string>
  ): HTMLElement {
    const wrapper = make('div', { className: 'review-insight-group' });
    wrapper.appendChild(make('h3', { text: title }));
    const list = make('ul', {});
    for (const [key, label] of Object.entries(labels)) {
      list.appendChild(make('li', { text: `${label}：${counts[key] ?? 0}` }));
    }
    wrapper.appendChild(list);
    return wrapper;
  }

  async function exportData(format: 'json' | 'jsonl'): Promise<void> {
    const filter = refs.exportFilter.value === 'reviewed' ? 'reviewed' : 'all';
    const generation = sessionGeneration;
    try {
      const text = await deps.api.exportReview(format, filter);
      if (isStaleSession(generation)) return;
      const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const anchor = make('a', {
        attrs: { href: url, download: `stripsearch-annotations-${filter}.${format}` }
      });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      deps.onToast(filter === 'reviewed' ? '已生成仅含已提交记录的导出文件。' : '已生成全部记录导出文件。');
    } catch (error) {
      if (isStaleSession(generation)) return;
      if (handleUnauthorized(error, generation)) return;
      deps.onToast(error instanceof ApiError ? error.message : '导出失败。', 'error');
    }
  }

  return {
    state,
    open,
    refresh,
    selectCase,
    saveCurrent,
    hasUnsavedChanges,
    reset() {
      sessionGeneration += 1;
      queueToken += 1;
      loadToken += 1;
      busyGeneration += 1;
      researchListToken += 1;
      researchTaskToken += 1;
      queueLoaded = false;
      state.queue = [];
      state.progress = { ...EMPTY_PROGRESS };
      state.caseId = null;
      state.detail = null;
      state.annotation = null;
      state.history = [];
      state.historyRevisions = null;
      state.historyLoading = false;
      state.draft = null;
      state.insights = null;
      state.insightsOpen = false;
      state.search = '';
      state.filter = 'all';
      state.busy = false;
      state.dirty = false;
      state.newCaseBusy = false;
      // Private research task DOM/cache must never survive an account switch.
      state.researchTasks = [];
      state.researchNote = '';
      state.researchLoaded = false;
      state.researchTaskId = null;
      state.researchDetail = null;
      state.researchLoading = false;
      state.researchImportBusy = false;
      // Drop references to the detached old DOM so stale form values cannot
      // keep reporting unsaved work after a session change.
      refs.dialog = undefined as never;
      refs.sourceRows = undefined as never;
      refs.researchSection = undefined as never;
      refs.researchQueue = undefined as never;
      refs.researchDetail = undefined as never;
      refs.researchNote = undefined as never;
      refs.researchImportDialog = undefined as never;
      refs.researchImportError = undefined as never;
      refs.researchImportSubmit = undefined as never;
      refs.researchImportTextarea = undefined as never;
      mounted = false;
      clear(deps.root);
    },
    destroy() {
      destroyed = true;
      sessionGeneration += 1;
      queueToken += 1;
      loadToken += 1;
      busyGeneration += 1;
      researchListToken += 1;
      researchTaskToken += 1;
      if (beforeUnload) {
        window.removeEventListener('beforeunload', beforeUnload);
        beforeUnload = null;
      }
      clear(deps.root);
      mounted = false;
    }
  };
}
