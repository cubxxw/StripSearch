# Agent、MCP 与输出契约

版本：`stripsearch/v0.1-draft`。以下是待实现设计，工具名、URI 与配置都不是已发布产品。

## 一个研究对象，多种呈现

持久化 canonical JSON，Markdown 通过确定性模板渲染。改变首屏、顺序或详细程度不重新搜索，不增加事实。HTML / JSONL 等格式等有明确消费者再加入。

请求范例见 [request.json](../examples/request.json)。关键配置：

| 配置 | 语义 |
|---|---|
| subject | 姓名、种子主页、职业上下文；可引用已有 person ID，但仍检查本轮适用性 |
| questions / as_of / languages | 本次问题、研究截止时间、检索语言；知识截止时间和抓取时间分别保存 |
| sources | allow / exclude 域名、允许的平台、已授权 local collection IDs；范围取交集 |
| output | format=markdown/json；initial_view=identity/summary/timeline/works；sections；detail；audience=internal/public |
| budget | 搜索次数、页数、请求数、墙钟时间、费用上限；按任务记账 |
| idempotency_key | 与规范化请求 hash 绑定；输出格式变化走 get/render，不重新启动研究 |

身份未解决时，`initial_view=summary` 也必须先给候选。所有格式保留人物索引、来源定位、证据状态、as_of、运行状态与覆盖缺口。public 导出必须重新验证证据权限，不只是隐藏链接。

## 返回对象

所有 MCP 工具返回一个 envelope：`schema_version, run_id|null, state, data, errors[]`。异步启动立即返回 run ID、当前状态和下一步；get 返回已有内容，不触发额外网络采集。研究模型保存在 envelope 的 data 中。

| 字段 | 必要信息 |
|---|---|
| people_index[] | person_id、display_name、identity_status、report_anchor、profile_links、identity_evidence_ids |
| identity_links[] | source_id、person_id、state、basis_evidence_ids、revision |
| sources[] | source_id、canonical_url 或 internal_uri、origin_group_id、published_at、retrieved_at、fetch_status、snapshot_hash、export_policy |
| evidence[] | evidence_id、source_id、locator、excerpt；不混入推理 |
| claims[] | claim_id、person_id、statement、kind、status、support_evidence_ids、refute_evidence_ids、valid_from/to、as_of |
| events[] | event_id、person_id、occurred_at、action_claim_ids、outcome_claim_ids、context、unknowns |
| behavior_hypotheses[] | hypothesis_id、person_id、statement、support_event_ids、counter_event_ids、alternatives、falsifier、status |
| coverage / unknowns / usage | 按问题的 answered/unknown/blocked 状态与解释、未解决项、观测到的费用/耗时 |
| revision / supersedes | 版本号与被替代的报告；不能读取无权限的前一版本 |

`claim.kind` 为 factual / attributed_statement / inference；行为解释主要放 hypotheses，不混进事实计分。`claim.status` 为 supported / contradicted / conflicting / insufficient_evidence；身份与来源是否可读另有独立状态。数值置信度不是 MVP 字段。

人物索引列出报告中实际使用的人物实体，候选和目标有不同 ID；只收与研究问题必要相关的公开人物。没有已核实主页时 `profile_links=[]`，给出原因，禁止补造链接。public 报告中的本地材料人物不能因索引自动暴露。

样例：[JSON](../examples/report.json) · [Markdown](../examples/report.md)。两者是同一份合成研究。结构字段是设计样例，不是完整 JSON Schema，也不暗示所有复杂分支已有实现。

## 对外 MCP：七个窄工具

| 工具 | 输入 → 返回 | 副作用 / 主要验收 |
|---|---|---|
| `stripsearch_resolve_identity` | subject、范围、预算 → 候选、证据、identity_session_id | 有外部检索与费用；不保证仅凭姓名解决 |
| `stripsearch_start_research` | 请求、identity_session_id 可选 → 持久 run ID | 幂等创建；身份过期或未解则 resolving / needs_input |
| `stripsearch_resume_research` | run ID、resolution revision、确认线索、幂等键 → 状态 | 校验 needs_input 状态；补充的线索仍是待核验输入 |
| `stripsearch_get_research` | run ID、format、section、cursor、limit → 快照/分页 | 只读已保存结果；支持纯渲染、状态与修订提示 |
| `stripsearch_list_people` | query、cursor、limit → 当前空间人物索引 | 只读；不是全网私人信息搜索 |
| `stripsearch_get_evidence` | run ID、evidence ID → 摘录、定位、原链接 | 只读已存证据；删除/受限内容返回相应状态 |
| `stripsearch_cancel_research` | run ID → cancelled 或已有终态 | 幂等取消后续工作；不抹掉已发生费用 |

同一 core 对宿主 Agent 暴露同样的 typed operations 与运行事件流。CLI 是本地入口；Agent 是受约束工作流，不是另一个可以绕过身份、预算和权限的入口。数据导入由本地 CLI / 管理界面显式授权，不对外提供任意文件读取工具。

每个工具声明 inputSchema / outputSchema，返回 structuredContent，同时有兼容文本摘要。大报告提供 `stripsearch://runs/{run_id}/reports/{revision}` resource link 和分页游标；resource 读取与工具调用共享授权，URI 不是任意文件路径。工具 annotations 按实际副作用填写：start/resume/cancel 都会改变任务状态，不能误标只读。

标准兼容基线参考 [MCP 2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。该版本 [Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) 为实验能力，因此 MVP 用业务 job + get/resume 工具，不依赖客户端支持 Tasks。这是选定基线，不是声称它是最新协议。

2026-09-20 初始化调研确认官方 TypeScript SDK 已进入 v2 稳定分包；具体包版本与本地兼容 smoke 见 [初始化方案](initialization-research.md#3-技术选型与官方资料核对)。该结果不自动改变此处的对外兼容基线，也不替代两个真实宿主的验收。

## 错误与兼容

| 错误 | 调用方该怎么办 |
|---|---|
| identity_ambiguous | 展示分离的候选，补充已知主页或明确公开身份线索 |
| scope_disallowed / egress_not_authorized | 缩小范围或提供对应授权；不自动重试 |
| source_inaccessible / rate_limited / provider_timeout | 保留成功部分与失败来源；有限重试受预算约束 |
| budget_exhausted / budget_unverifiable | partial 或启动前失败；不可暗中追加成本 |
| idempotency_conflict / stale_revision | 刷新状态，使用正确请求或明确创建新 run |
| outcome_unknown | 外部调用可能已计费；等待核对，避免自动重复 |
| evidence_revoked / revision_superseded | 获取新报告并提示旧结论失效 |

协议错误与业务错误区分；业务失败在 MCP 层正确设置 isError，并在结构化返回中保留可恢复信息。仅处于 needs_input 不自动表示协议失败。所有分页游标绑定用户、run 和 revision，不能跨任务使用。

首发仅提供经实测的本地接入示例。包名、启动命令和远程地址在实现后填写，不在设计阶段发布无效的 `npx` 安装指令。
