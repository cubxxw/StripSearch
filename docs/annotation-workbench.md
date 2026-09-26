# 标注工作台（Annotation Workbench）

状态：**可运行垂直切片**。`/#/review` 是 `apps/web` 内的真实持久化功能，不是静态原型。它让人把「什么算正确、哪个研究结果更好」写成带版本的人工标签，供后续 harness / agent 评测使用。它**不**运行 DSH agent，**不**伪造人工判断，也**不**把主观偏好称为 gold。

## 定位与边界

- 记录的是**人工单评审**的探索性标签，不是双盲 gold，也不自动成为 benchmark 真值。
- 一个案例由创建者评审时，全部标签都是单人判断；导出中显式标注 `human_single_review` 与 eligibility。
- 候选偏好是主观选择，不等于模型胜负。
- 内置练习案例里的候选回答是**开发时生成的合成示例**，由参与本仓库开发的 AI 编码助手生成，**不是** DeepSeek / Claude 等模型的实测输出，也不是人类研究人员撰写。它们只用于验证工作流，不能当作模型质量证据。
- 汇总页只统计**已提交的最新修订**，并且只说明「这些判断用于形成评估标准，尚未运行模型对照」，不给准确率或胜率。
- 所有案例固定 `split = discovery`。没有伪造的 holdout 控制。
- 不做自动外发；没有付费 API、没有联网抓取。练习案例不包含可抓取 URL。

## 综合人物研究案例（尚无候选回答的 研究任务库）

`/#/review` 顶部新增**独立于**两候选回答评审的「综合人物研究案例」库：它保存人物研究任务的**评估规范**（task specification + evaluator checks），供后续 harness 使用。当前**没有任何模型运行**，也没有人工判断；旧的 10 个合成练习案例、既有标注、导出与汇总完全不变，仍在下方「回答对照评审」分组中可用。

### 共享契约 `ResearchTaskInput`

服务端、客户端与测试共用 `apps/web/src/shared/research-task.ts` 中的类型与校验。所有字段都有界，**超长或无效直接拒绝（400）；文本去除控制字符及首尾空白，不截断内容**；请求体总大小仍受现有 `32 KiB` 上限约束。

| 字段 | 约束 |
| --- | --- |
| `externalId` | 必填字符串，1–120 字符，幂等键的一部分 |
| `datasetVersion` | 必填字符串，1–60 字符，幂等键的一部分 |
| `title` | 必填字符串，1–120 字符 |
| `input.prompt` | 必填字符串，1–2000 字符（保留换行） |
| `input.identitySeedUrls` | 1–8 条；每条 1–2048 字符，仅 `http(s)`、无凭据、有主机名（复用 `validateSeedUrl`），规范化后去重 |
| `commonChecks[]` / `personChecks[]` | 各 1–12 条对象 `{ id, focus, lookFor }`：`id` 1–64、`focus` 1–200、`lookFor` 1–1000 字符，列表内 `id` 不得重复（典型为 6 条共同检查 + 4 条人物检查） |
| `observedStartingPoint` | 必填字符串，1–1000 字符，**暂定观察起点** |
| `typicalFailure` | 必填字符串，1–1000 字符 |
| `sourcePackStatus` | 固定 `incomplete`，其他值拒绝 |
| `interactionSampleStatus` | 固定 `not_systematically_sampled`，其他值拒绝 |

未知的额外顶层键被忽略（前向兼容）；`POST` 只接受**单个**任务对象，数组请由客户端逐条提交。

创建时服务端追加并固定：`split = discovery`、`executionStatus = not_run`、`reviewStatus = unreviewed`、`modelOutputs = []`、`humanLabels = null`、服务端 `taskId`、`createdAt` 与 `contentHash`（对规范化后的 `ResearchTaskInput` 做 `stableStringify` 后 SHA-256，可独立重算）。这些字段是**不可变快照**；AI 拟定的检查标准 只是提议标准，**不是人工标签，也不是 gold**。

### 存储：新表 `review_research_tasks`（纯增量）

| 字段 | 说明 |
| --- | --- |
| `id` / `owner_id` | 服务端 ID 与账号隔离；读写都校验 owner，其他账号得到 `404` |
| `dataset_version` / `external_id` | `UNIQUE(owner_id, dataset_version, external_id)` 幂等键 |
| `content_hash` | 创建时对规范内容的 SHA-256；同键同哈希幂等（达到容量上限仍可重试），同键不同内容 `409` |
| `spec_json` | 规范化后的完整 `ResearchTaskInput` 快照（不可变） |
| `created_at` | 创建时间 |

`review_cases` / `review_annotations` 的表结构、内容与 `content_hash` **不变**；研究任务不写入、不读取、不修改旧评审数据。

### API（同源 `/api/review/research-tasks*`）

与既有评审路由共用登录、精确 `Origin` 与 32 KiB 请求体中间件；响应只含安全的 owner 数据，**绝不回传原始 owner ID**；`GET` 永不创建或修改任务，也**不抓取种子链接**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/review/research-tasks` | 当前账号任务列表（标题、状态、哈希，不含评估标准正文） |
| `POST` | `/api/review/research-tasks` | 创建单个规范；同 owner+`datasetVersion`+`externalId` 且同 `contentHash` 返回同一条（`200`，`created:false`），同键不同内容 `409 research_task_conflict`；每账号上限 50 条（`409 research_task_limit`） |
| `GET` | `/api/review/research-tasks/:id` | 完整规范视图（含 checks）；非 owner 一律 `404` |

### 界面与导出

- 「综合人物研究案例」库位于回答对照评审**之前**，列出标题；选中后展示：实际问题、身份种子链接（仅 `http(s)`，文本渲染不注入 HTML）、共同 / 人物评估检查、**暂定**观察起点、常见失败、来源包 `不完整` 与交互样本 `未系统抽样` 状态。
- 每条显示 `待运行 · 未评审`，并显式说明**模型输出 0 条**、人工判断为空白；界面上没有自动勾选的人工判断控件。
- 空库显示「导入研究案例」：JSON 文件或 textarea，支持单个对象或对象数组；逐条走真实 `POST`，失败原样展示服务端错误，**绝不假报成功**；成功条数只按真实成功统计。
- 两种导出互相独立：**模型输入导出**只含 `caseId`、`externalId`、`datasetVersion`、`prompt` 与种子链接（`stripsearch/research-model-input/v1`），**不含任何评估标准**，避免标准泄漏给被评模型；**完整评估规范导出**才包含 checks、观察起点与常见失败。
- 刷新页面从服务端重新读取（持久化保留）；账号切换 / 会话失效会清空研究案例缓存与 DOM，迟到的列表 / 详情 / 导入响应被忽略（与既有工作台的 generation 守卫一致）。

## 入口与工作流

1. 登录后打开顶部导航「标注工作台」，或直接访问 `/#/review`（深链案例：`/#/review/<caseId>`）。
2. 点击「载入 10 个练习案例」。该动作**只在显式按钮触发时**插入：8 个改编自 [Behavior v1](../evals/behavior-v1/README.md) 的合成练习，加 2 个身份 / 引用练习；对同一账号幂等，重复点击不会重复插入。`GET` 永远不会创建案例。当账号案例数接近上限时，只插入剩余容量并提示，不会静默超出。
3. 选择案例，按两阶段评审：
   - **阶段 1 · 证据与论断正确性**：证据面板展示来源 ID、标题、正文与定位；每条候选论断单独判断 `支持 / 矛盾 / 证据不足 / 无法判断`。默认全部空白。桌面端证据面板保持可见（sticky）。
   - **阶段 2 · 盲选偏好**：先展示两个候选的完整文本对照，再选择 `A / B / 平局 / 都不好 / 无法判断`（默认不选）；可多选理由标签 `事实性 / 引用 / 覆盖 / 反证 / 不确定性 / 可读性`，并填写判断理由。
   - **人工评分标准**：参考答案、必须包含、必须避免都是可编辑的自由文本，作为本题的人工 rubric 随版本保存。
4. 规则：`支持` 或 `矛盾` 必须至少选择一条真实证据 ID，可附说明；`证据不足`（材料不足但问题可判定）/ `无法判断`（问题或来源无法评估）允许不选证据。
5. **保存草稿** 允许不完整；**提交**要求每个论断都有判断、引用有效、偏好与理由齐全。只有服务端响应之后才显示「已保存」。
6. **保存并下一题**（`⌘ / Ctrl + Enter`，不会拦截普通输入）；**上一题 / 下一题**在当前筛选结果中移动。保存与进度条固定在评审区顶部，滚动论断时仍可操作。
7. 队列显示未评审 / 草稿 / 已提交与进度计数，支持按标题或问题搜索、按状态筛选。
8. 提交后才能看到候选来源元数据；已保存的每个历史版本都可以在「历史版本」中**只读查看**旧判断、证据、偏好、理由与 rubric。

## 草稿保护与导航

- 任何未保存的评审输入或未提交的「新建案例」表单都会被视为未保存工作。
- 浏览器刷新 / 关闭走 `beforeunload` 提示；站内 hash、浏览器后退、切换案例或退出登录都会先确认。拒绝确认时保持当前案例与输入不变。
- 服务端保存成功但随后刷新失败时，不误报「保存失败」，也不会因重试产生重复版本；由于版本号已在保存响应中更新，重试使用新的 `expectedRevision`。
- 保存进行中输入的新内容会被保留为未保存状态：不会自动跳到下一题，也不会用旧响应覆盖新输入；下一次保存使用已推进的 `expectedRevision`。
- 导出 / 汇总 / 新建案例 / 载入练习等请求在账号切换或会话失效后返回时会被忽略，不会触发下载、提示或改动新账号的界面。
- 账号切换或会话失效会清空工作台缓存与 DOM，并使进行中的请求失效，避免上一个账号的私有案例被下一个账号看到。

## 存储与不变量

SQLite 表由 `apps/web/src/server/db/schema.ts` 的 `CORE_SCHEMA_SQL` 幂等创建。

### `review_cases`

| 字段 | 说明 |
| --- | --- |
| `id` / `owner_id` | 账号隔离；所有读 / 写 / 删都校验 owner |
| `seed_key` | 练习案例去重键，`UNIQUE(owner_id, seed_key)`，用户案例为 `NULL` |
| `dataset_version` / `split` / `kind` | 数据集版本、固定 `discovery`、`practice` 或 `user` |
| `title` / `question` / `as_of` / `badge` | 展示与上下文 |
| `rubric_version` | 随案例固定的 rubric 版本 |
| `content_hash` | 创建时对内容（来源 + 候选 + 盲映射）做稳定序列化后的 SHA-256；创建后不可变 |
| `source_json` | `[{ sourceId, title, text, locator }]`，来源 ID 为稳定的 `S1…Sn` |
| `candidate_json` | `{ blindMap, candidates: [{ candidateId, origin, model, notes, claims: [{ claimId, text }] }] }`；盲映射创建时随机一次并持久化 |

### `review_annotations`（只追加）

| 字段 | 说明 |
| --- | --- |
| `case_id` / `owner_id` / `revision` | `UNIQUE(case_id, revision)`；每次保存追加新 revision |
| `status` | `draft` 或 `submitted` |
| `actor_id` / `actor_pseudonym` | 服务端从会话推导，绝不接受请求体中的 reviewer 身份 |
| `case_hash` / `rubric_version` | 保存时的案例内容 hash 与 rubric 版本 |
| `decisions_json` | 逐论断 `{ claimId, label, evidenceIds, note }` |
| `preference` / `rationale` / `reason_tags_json` | 偏好、理由与理由标签 |
| `reference_answer` / `must_include_json` / `must_avoid_json` | 人工 rubric |

约定：

- 乐观并发：保存携带 `expectedRevision`；与当前最大 revision 不一致返回 `409 stale_revision`。
- 空判断不会预填；草稿可以有未判断的论断，提交时校验完整性。
- `DELETE` 案例通过外键级联删除其全部私有评审。
- 请求体总大小沿用现有 `32 KiB` 上限。**字段超长或列表超限会返回 400 并说明原因，绝不静默截断或改写人类判断。**

## API 契约（同源 `/api/review/*`）

全部要求登录并校验所有权（其他账号得到 `404`），变更请求要求精确 `Origin`（否则 `403`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/review/seed` | 为当前账号幂等载入练习案例（受 200 案例上限约束）；仅显式调用 |
| `GET` | `/api/review/cases` | 队列与进度（不泄露候选来源元数据） |
| `POST` | `/api/review/cases` | 新建案例：问题、证据行、两个粘贴回答（每行一条论断）、可选来源 / 模型元数据；服务端随机 A/B 映射 |
| `GET` | `/api/review/cases/:id` | 案例、最新评审、历史摘要；提交前不含 `provenance` 与隐藏 gold |
| `GET` | `/api/review/cases/:id/history` | `revisions`（完整、升序、含判断 / 理由 / rubric）与 `history`（摘要、降序） |
| `PUT` | `/api/review/cases/:id/annotation` | 保存草稿 / 提交；`expectedRevision` 不匹配返回 `409`；成功后返回 `acknowledgment: "已保存"` |
| `DELETE` | `/api/review/cases/:id` | 删除案例及其全部评审 |
| `GET` | `/api/review/insights` | 仅基于已提交的最新修订的聚合计数与人工确认建议 |
| `GET` | `/api/review/export?format=json\|jsonl&filter=all\|reviewed` | 用户触发的下载导出 |
| `GET` | `/api/review/research-tasks` | 综合人物研究案例列表（尚无候选回答的，见上文契约） |
| `POST` | `/api/review/research-tasks` | 创建单个研究任务规范；同键同哈希幂等（达到容量上限仍可重试），同键不同内容 `409` |
| `GET` | `/api/review/research-tasks/:id` | 单条完整规范；非 owner `404` |

写入校验（均在返回 `400` 前明确拒绝）：

- `isClaimLabel` / `isPreference` / `isReasonTag` 使用自有属性判断（`Object.hasOwn`），原型键如 `toString` / `constructor` 会被拒绝。
- `expectedRevision` 必须是非负安全整数，不接受 `null`、布尔、字符串或小数。
- `evidenceIds` 必须是字符串数组；混合类型、未知 ID、重复 ID 会被拒绝。
- 过长文本、过多 rubric 条目、过多理由标签会被拒绝并给出字段与上限。

## 导出

JSON 为信封对象，JSONL 为每行一条记录。记录包含：

- `schemaVersion`、导出时间、评审者假名 ID 与 `human_single_review`；不含任何原始 owner ID。
- 不可变的案例快照：来源、候选（盲标签）、稳定 ID、`blindMapping`、`contentHash`、实际来源元数据（`provenance`）。
- `annotation`（最新）、`revisions`（**全部只追加修订，含逐条判断、偏好、理由与 rubric**）与 `history`（元数据摘要）。历史不再受 50 条限制。
- `case.hash`：`{ algorithm: 'sha256', serialization: 'stableStringify', contentHash, payload }`。`payload` 就是被哈希的完整案例快照（含候选数组的存储顺序），因此可用 `sha256(stableStringify(payload))` 独立重算并与 `case.contentHash`、`annotation.caseHash` 比对。
- 草稿 / 未评审记录带 `eligibility.accepted = false` 与原因，绝不静默当作已接受标签。
- `filter=reviewed` 只导出最新修订为已提交的案例；`filter=all` 明确包含其余记录并标注资格。

`stableStringify` 算法：对象按 key 排序，数组保持原顺序，忽略值为 `undefined` 的键，输出紧凑 JSON（无空白），再取 SHA-256。

## 汇总

`GET /api/review/insights` 只从**已提交的最新修订**统计事实判断、偏好与理由标签计数，并给出「下一步建议（需人工确认）」——例如不确定性偏高时建议人工复核或补充材料——同时明确提示尚未运行模型对照。不同案例的 A/B 映射独立随机，因此偏好计数仅作探索性聚合。

## 本地验证

```bash
npm --prefix apps/web test        # 离线测试
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
python3 scripts/check_design.py
```

离线测试覆盖：认证 / Origin / 所有权、练习案例幂等与上限、案例与评审重启持久化、过期 revision 拒绝、原型键与错误类型拒绝、伪造证据与论断 ID、超长输入拒绝、草稿与提交门槛、盲映射稳定与提交前元数据不泄露、重复保存不重复计数、删除级联、导出完整历史 / 可复现哈希 / 资格、账号切换与迟到响应隔离；客户端覆盖内容转义、默认无选择、保存失败保留草稿、保存并下一题、快捷键、队列筛选、未保存保护、历史只读查看与候选全文对照。综合人物研究案例覆盖：认证 / Origin / 所有权且响应不泄露 owner ID、同键同哈希幂等与内容冲突 409、每账号 50 条上限、固定 `not_run` / `unreviewed` 字段与可复现 `contentHash`、非法 / 超长输入（含非 http(s) 种子链接与 32 KiB 载荷）拒绝、`GET` 永不创建、重启后持久化；客户端覆盖空库邀请、选中详情（含 6+4 检查、暂定观察起点与固定状态、无自动勾选）、真实 API 导入的失败与部分失败展示（不假报成功）、模型输入导出不含任何评估标准、重载重新拉取与账号切换迟到列表 / 详情响应隔离。

## 实现参考（版本锁定见 `apps/web/package.json`）

- better-sqlite3 `transaction(fn)`：同步提交 / 回滚，事务函数内不得 `await` — <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function>
- Express 路由指南（`Router`、路径参数、中间件顺序）— <https://expressjs.com/en/guide/routing.html>
- MDN `beforeunload`（离开页面前的未保存提示）— <https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event>

## 从人工标注到 Harness / Agent

1. **先形成标准**：用练习题熟悉标签，再加入真实研究问题、获授权的证据和两份候选回答。记录具体错在哪里、哪些内容必须出现、什么情况下应承认不知道；10 道练习不是统计有效的模型比较。
2. **先解决分歧，再冻结版本**：查看「无法判断 / 都不好 / 平局」及修改历史，完善 rubric。单评审仍标探索性；第二位独立评审与分歧裁决是后续功能，不能用系统自动判断代替。
3. **先建最小 Harness**：消费已提交导出，固定案例快照、rubric、模型版本、工具环境与预算；保存运行轨迹、成本、耗时和逐条证据。人工标签用于校准判定器，自动判定结果须与人类判断分开保存。
4. **再按失败类型设计 Agent**：身份混淆对应身份核验，证据不足对应补充检索，忽略反证对应反证搜索，引用错误对应证据绑定。每次只增加一个有案例支持的机制，与同模型、同预算基线比较。
5. **最后做保留集比较**：另建按人物 / 来源族隔离、未用于调参的任务集，重复运行并报告不确定性。当前导出全部是 `discovery`；不得直接把这一批反复调参的案例改称独立测试集。

上述步骤是下一阶段的实施顺序；当前交付止于可用的标注、版本记录与导出，尚未实现自动 Harness 或运行模型对照。

## 已知限制

- 综合人物研究案例只是**评估规范**：`not_run` / `unreviewed`，模型输出恒为 0，人工判断恒为空白；AI 拟定的检查标准 不是人工标签或 gold，规范存在不等于评测通过。
- 研究任务库没有删除 / 编辑端点（导入幂等，修正需父级重新导入新 `externalId` 或由后续工作补充）；种子链接只做校验与展示，从不抓取。
- 单评审探索：没有第二位评审时不能称为双盲 gold，也不能写成基准通过。
- 合成示例候选只能说明流程可用，不能证明任何模型质量；这不是完美的盲选保证（人工作者仍可能记得自己写了哪一版）。
- 偏好与理由标签是主观判断，汇总不计算准确率 / 胜率。
- 只有 `discovery` 分片；没有 holdout、没有模型对照、没有 DSH agent。
- 服务端对每个账号最多保留 200 个案例；达到上限后需删除旧案例才能新建或载入练习。
- 分页与 rubric 版本迁移尚未实现。
