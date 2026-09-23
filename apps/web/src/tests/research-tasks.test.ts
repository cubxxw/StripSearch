import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, TestClient } from './harness.js';
import type { TestServer } from './harness.js';
import { LIMITS } from '../shared/limits.js';
import { parseResearchTaskInput } from '../shared/research-task.js';
import type { ResearchTaskListItem, ResearchTaskView } from '../shared/research-task.js';

/** Independent re-implementation proving the exported hash is reproducible. */
function stableStringifyIndependent(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringifyIndependent).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyIndependent(item)}`);
  return `{${entries.join(',')}}`;
}

function independentHash(payload: unknown): string {
  return createHash('sha256').update(stableStringifyIndependent(payload)).digest('hex');
}

function seedUrls(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://example.org/seed-${index + 1}`);
}

function checks(count: number, prefix: string): { id: string; focus: string; lookFor: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    focus: `CRITERIA focus ${prefix} ${index + 1}`,
    lookFor: `CRITERIA lookFor ${prefix} ${index + 1}`
  }));
}

function taskInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: 'person-alpha-v1',
    datasetVersion: 'private-research-2026q3',
    title: '人物甲综合研究任务',
    input: {
      prompt: '研究这位公开创作者的公开经历与作品，并说明证据来源。',
      identitySeedUrls: ['https://example.org/person-alpha']
    },
    commonChecks: checks(6, 'common'),
    personChecks: checks(4, 'person'),
    observedStartingPoint: '暂定起点：以其公开作品时间线切入。',
    typicalFailure: '把同名他人误认为同一人。',
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled',
    ...overrides
  };
}

interface ListBody {
  tasks: ResearchTaskListItem[];
  note: string;
}

interface DetailBody {
  task: ResearchTaskView;
}

interface PostBody {
  task: ResearchTaskView;
  created: boolean;
  error?: { code: string; message: string };
}

async function createTask(
  client: TestClient,
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; body: PostBody }> {
  return client.json<PostBody>('/api/review/research-tasks', {
    method: 'POST',
    json: taskInput(overrides)
  });
}

// One shared server keeps the suite inside Better Auth's per-IP sign-up limit;
// exact-count aggregates use their own isolated servers.
let shared: TestServer;
test.before(async () => {
  shared = await startTestServer({});
  assert.equal((await shared.client.signUp('research-shared@example.test')).status, 200);
});
test.after(async () => {
  await shared.close();
});

let isolatedCounter = 0;

async function isolatedServer(t: { after: (fn: () => Promise<void>) => void }): Promise<TestServer> {
  isolatedCounter += 1;
  const server = await startTestServer({});
  assert.equal((await server.client.signUp(`research-isolated-${isolatedCounter}@example.test`)).status, 200);
  t.after(async () => server.close());
  return server;
}

test('research tasks require auth, exact Origin and owner scoping', async () => {
  const userB = new TestClient(shared.baseUrl, shared.origin);
  assert.equal((await userB.signUp('research-b@example.test')).status, 200);

  const anonymous = new TestClient(shared.baseUrl, shared.origin);
  assert.equal((await anonymous.request('/api/review/research-tasks')).status, 401);
  assert.equal(
    (await anonymous.request('/api/review/research-tasks', { method: 'POST', json: taskInput() })).status,
    401
  );
  assert.equal((await anonymous.request('/api/review/research-tasks/rtask_x')).status, 401);

  const noOrigin = await shared.client.request('/api/review/research-tasks', {
    method: 'POST',
    origin: null,
    json: taskInput()
  });
  assert.equal(noOrigin.status, 403);
  const foreign = await shared.client.request('/api/review/research-tasks', {
    method: 'POST',
    origin: 'http://evil.test',
    json: taskInput()
  });
  assert.equal(foreign.status, 403);

  const created = await createTask(shared.client, { externalId: 'owner-scoping-v1' });
  assert.equal(created.status, 201);
  const taskId = created.body.task.taskId;

  // Another owner sees nothing: exact-owner reads are 404, lists are empty.
  assert.equal((await userB.request(`/api/review/research-tasks/${taskId}`)).status, 404);
  const otherList = await userB.json<ListBody>('/api/review/research-tasks');
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.body.tasks, []);

  // Responses never expose the raw owner id.
  const session = await shared.client.json<{ user: { id: string } }>('/api/auth/get-session');
  const ownerId = session.body.user.id;
  assert.ok(ownerId.length > 0);
  const listRaw = await (await shared.client.request('/api/review/research-tasks')).text();
  const detailRaw = await (await shared.client.request(`/api/review/research-tasks/${taskId}`)).text();
  assert.equal(listRaw.includes(ownerId), false, 'list must not leak the owner id');
  assert.equal(detailRaw.includes(ownerId), false, 'detail must not leak the owner id');
});

test('created specs carry fixed not-run/unreviewed fields and GET never mutates', async () => {
  const listBefore = await shared.client.json<ListBody>('/api/review/research-tasks');
  const countBefore = listBefore.body.tasks.length;

  const created = await createTask(shared.client, { externalId: 'fixed-status-v1' });
  assert.equal(created.status, 201);
  const task = created.body.task;

  assert.equal(task.executionStatus, 'not_run');
  assert.equal(task.reviewStatus, 'unreviewed');
  assert.deepEqual(task.modelOutputs, []);
  assert.equal(task.humanLabels, null);
  assert.equal(task.split, 'discovery');
  assert.equal(task.sourcePackStatus, 'incomplete');
  assert.equal(task.interactionSampleStatus, 'not_systematically_sampled');
  assert.match(task.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(task.taskId.length > 0);
  assert.ok(task.createdAt.length > 0);

  // The hash is exactly sha256(stableStringify(spec)) over the shared contract.
  const spec = parseResearchTaskInput(taskInput({ externalId: 'fixed-status-v1' }));
  if (!spec.ok) throw new Error(spec.message);
  assert.equal(independentHash(spec.spec), task.contentHash);

  // GET only reads: repeated reads never create or mutate a task.
  const first = await shared.client.json<ListBody>('/api/review/research-tasks');
  const second = await shared.client.json<ListBody>('/api/review/research-tasks');
  assert.equal(first.body.tasks.length, countBefore + 1);
  assert.equal(second.body.tasks.length, countBefore + 1);
  const row = second.body.tasks.find((item) => item.taskId === task.taskId);
  assert.ok(row);
  assert.equal(row.modelOutputCount, 0);
  assert.equal(row.executionStatus, 'not_run');
  assert.equal(row.reviewStatus, 'unreviewed');
  assert.equal(row.contentHash, task.contentHash);

  // List rows omit evaluator criteria bodies; only detail exposes them.
  const listRaw = JSON.stringify(second.body);
  assert.equal(listRaw.includes('CRITERIA focus'), false);
  assert.doesNotMatch(listRaw, /共同|暂定起点/);

  const detail = await shared.client.json<DetailBody>(`/api/review/research-tasks/${task.taskId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.contentHash, task.contentHash);
  assert.equal(detail.body.task.input.prompt, task.input.prompt);
  assert.equal(detail.body.task.commonChecks.length, 6);
  assert.equal(detail.body.task.personChecks.length, 4);
  assert.equal(detail.body.task.observedStartingPoint, '暂定起点：以其公开作品时间线切入。');
  assert.equal(detail.body.task.typicalFailure, '把同名他人误认为同一人。');
});

test('same key and content is idempotent; changed content conflicts with 409', async () => {
  const before = await shared.client.json<ListBody>('/api/review/research-tasks');
  const countBefore = before.body.tasks.length;

  const first = await createTask(shared.client, { externalId: 'idempotent-v1' });
  assert.equal(first.status, 201);

  const replay = await createTask(shared.client, { externalId: 'idempotent-v1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.created, false);
  assert.equal(replay.body.task.taskId, first.body.task.taskId);
  assert.equal(replay.body.task.contentHash, first.body.task.contentHash);
  assert.equal(replay.body.task.createdAt, first.body.task.createdAt);

  const after = await shared.client.json<ListBody>('/api/review/research-tasks');
  assert.equal(after.body.tasks.length, countBefore + 1);

  const conflict = await createTask(shared.client, {
    externalId: 'idempotent-v1',
    title: '内容被改动的标题'
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, 'research_task_conflict');

  // The immutable snapshot was not overwritten.
  const unchanged = await shared.client.json<ListBody>('/api/review/research-tasks');
  assert.equal(unchanged.body.tasks.length, countBefore + 1);
  const row = unchanged.body.tasks.find((item) => item.externalId === 'idempotent-v1');
  assert.equal(row?.title, first.body.task.title);
});

test('validation rejects invalid and oversize specs without truncation', async () => {
  const before = await shared.client.json<ListBody>('/api/review/research-tasks');
  const countBefore = before.body.tasks.length;

  const arrayResponse = await shared.client.json<{ error?: { code: string; message: string } }>(
    '/api/review/research-tasks',
    { method: 'POST', json: [taskInput()] }
  );
  assert.equal(arrayResponse.status, 400);
  assert.equal(arrayResponse.body.error?.code, 'invalid_research_task');
  assert.match(arrayResponse.body.error?.message ?? '', /对象/);

  const invalids: [label: string, overrides: Record<string, unknown>, expected: RegExp][] = [
    ['缺少 input', { input: undefined }, /input 必须是/],
    ['空 prompt', { input: { prompt: '  ', identitySeedUrls: ['https://example.org/a'] } }, /input.prompt/],
    [
      '超长 prompt',
      { input: { prompt: 'x'.repeat(LIMITS.researchTaskPromptMax + 1), identitySeedUrls: ['https://example.org/a'] } },
      /input.prompt 不能超过 2000/
    ],
    [
      'javascript 链接',
      { input: { prompt: '问题？', identitySeedUrls: ['javascript:alert(1)'] } },
      /身份种子链接/
    ],
    [
      '无协议链接',
      { input: { prompt: '问题？', identitySeedUrls: ['example.org/person'] } },
      /身份种子链接/
    ],
    [
      'ftp 链接',
      { input: { prompt: '问题？', identitySeedUrls: ['ftp://example.org/person'] } },
      /身份种子链接/
    ],
    [
      '带凭据链接',
      { input: { prompt: '问题？', identitySeedUrls: ['https://user:pass@example.org/person'] } },
      /身份种子链接/
    ],
    ['空种子列表', { input: { prompt: '问题？', identitySeedUrls: [] } }, /identitySeedUrls/],
    [
      '超过 8 条种子',
      { input: { prompt: '问题？', identitySeedUrls: seedUrls(9) } },
      /identitySeedUrls/
    ],
    ['错误来源包状态', { sourcePackStatus: 'complete' }, /sourcePackStatus/],
    ['错误交互样本状态', { interactionSampleStatus: 'random_sample' }, /interactionSampleStatus/],
    ['commonChecks 为空', { commonChecks: [] }, /commonChecks/],
    ['commonChecks 超限', { commonChecks: checks(13, 'extra') }, /commonChecks/],
    [
      '重复检查项 id',
      { commonChecks: [checks(1, 'dup')[0], { id: 'dup-1', focus: 'f', lookFor: 'l' }] },
      /重复/
    ],
    ['personChecks 缺失', { personChecks: undefined }, /personChecks/],
    ['检查项不是对象', { commonChecks: ['oops'] }, /对象/],
    ['超长 focus', { commonChecks: [{ id: 'c1', focus: 'x'.repeat(LIMITS.researchTaskFocusMax + 1), lookFor: 'l' }] }, /focus/],
    ['空 externalId', { externalId: '   ' }, /externalId/],
    ['超长 datasetVersion', { datasetVersion: 'd'.repeat(LIMITS.researchTaskDatasetVersionMax + 1) }, /datasetVersion/],
    ['超长 title', { title: 't'.repeat(LIMITS.reviewTitleMax + 1) }, /title/],
    ['超长观察起点', { observedStartingPoint: 'x'.repeat(LIMITS.researchTaskObservationMax + 1) }, /observedStartingPoint/],
    ['超长常见失败', { typicalFailure: 'x'.repeat(LIMITS.researchTaskFailureMax + 1) }, /typicalFailure/]
  ];

  for (const [label, overrides, expected] of invalids) {
    // Field-specific overrides win so each case exercises its own rule.
    const payload = taskInput({
      externalId: `invalid-${encodeURIComponent(label)}`,
      datasetVersion: 'invalid-v1',
      ...overrides
    });
    const response = await shared.client.json<{ error?: { code: string; message: string } }>(
      '/api/review/research-tasks',
      { method: 'POST', json: payload }
    );
    assert.equal(response.status, 400, `${label} must be rejected with 400`);
    assert.equal(response.body.error?.code, 'invalid_research_task', `${label} must use invalid_research_task`);
    assert.match(response.body.error?.message ?? '', expected, `${label} message`);
  }

  // Payloads beyond the shared 32 KiB cap are refused before validation.
  const tooLarge = await shared.client.json('/api/review/research-tasks', {
    method: 'POST',
    json: { ...taskInput({ externalId: 'too-large-v1' }), padding: 'x'.repeat(40 * 1024) }
  });
  assert.equal(tooLarge.status, 413);

  // Nothing above created a record.
  const after = await shared.client.json<ListBody>('/api/review/research-tasks');
  assert.equal(after.body.tasks.length, countBefore);
});

test('the per-account research task limit is enforced', async (t) => {
  const server = await isolatedServer(t);
  const session = await server.client.json<{ user: { id: string } }>('/api/auth/get-session');
  const ownerId = session.body.user.id;

  const fillers = LIMITS.researchTaskMaxPerUser - 1;
  for (let index = 0; index < fillers; index += 1) {
    const parsed = parseResearchTaskInput(
      taskInput({ externalId: `filler-${index}`, datasetVersion: 'limit-v1' })
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const result = server.boot.reviewStore.createResearchTask({ ownerId, spec: parsed.spec });
    assert.equal(result.ok, true);
  }
  assert.equal(server.boot.reviewStore.countResearchTasksForOwner(ownerId), fillers);

  const lastSlot = await createTask(server.client, {
    externalId: 'limit-last',
    datasetVersion: 'limit-v1'
  });
  assert.equal(lastSlot.status, 201);
  const replayAtLimit = await createTask(server.client, {
    externalId: 'limit-last', datasetVersion: 'limit-v1'
  });
  assert.equal(replayAtLimit.status, 200, 'existing identical task remains idempotent at capacity');
  assert.equal(replayAtLimit.body.task.taskId, lastSlot.body.task.taskId);
  const conflictAtLimit = await createTask(server.client, {
    externalId: 'limit-last', datasetVersion: 'limit-v1', title: 'changed'
  });
  assert.equal(conflictAtLimit.body.error?.code, 'research_task_conflict');


  const overflow = await createTask(server.client, {
    externalId: 'limit-overflow',
    datasetVersion: 'limit-v1'
  });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error?.code, 'research_task_limit');
  assert.equal(server.boot.reviewStore.countResearchTasksForOwner(ownerId), LIMITS.researchTaskMaxPerUser);
});

test('research tasks and their hash survive a server restart', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stripsearch-research-restart-'));
  const server = await startTestServer({}, {}, { dataDir, preserveData: true });
  let taskId = '';
  let contentHash = '';
  let prompt = '';
  try {
    assert.equal((await server.client.signUp('research-restart@example.test')).status, 200);
    const created = await createTask(server.client, { externalId: 'restart-v1' });
    assert.equal(created.status, 201);
    taskId = created.body.task.taskId;
    contentHash = created.body.task.contentHash;
    prompt = created.body.task.input.prompt;
  } finally {
    await server.close();
  }

  const restarted = await startTestServer({}, {}, { dataDir });
  t.after(async () => {
    await restarted.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal((await restarted.client.signIn('research-restart@example.test')).status, 200);

  const list = await restarted.client.json<ListBody>('/api/review/research-tasks');
  assert.equal(list.status, 200);
  assert.equal(list.body.tasks.length, 1);
  assert.equal(list.body.tasks[0]?.taskId, taskId);
  assert.equal(list.body.tasks[0]?.contentHash, contentHash);

  const detail = await restarted.client.json<DetailBody>(`/api/review/research-tasks/${taskId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.contentHash, contentHash);
  assert.equal(detail.body.task.input.prompt, prompt);
  assert.equal(detail.body.task.executionStatus, 'not_run');
  assert.equal(detail.body.task.humanLabels, null);

  // Re-importing after restart is idempotent, not a duplicate row.
  const replay = await createTask(restarted.client, { externalId: 'restart-v1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.created, false);
  assert.equal(replay.body.task.taskId, taskId);
  assert.equal((await restarted.client.json<ListBody>('/api/review/research-tasks')).body.tasks.length, 1);
});
