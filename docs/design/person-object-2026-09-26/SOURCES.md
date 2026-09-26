# 来源与能力截面

核对日期：2026-09-26。官方资料用于验证接口和约束；产品营销宣称不是独立评测。未购买竞品报告、未运行付费检索和模型请求。

## WhiteBridge：采用机制，不臆测内部实现

- [Search Candidates](https://docs.whitebridge.ai/search-candidates.html)：支持 name/email/phone/social URL 查询与平台参数，返回候选与游标。说明 Identity Resolution 是独立步骤。
- [Create Lookup](https://docs.whitebridge.ai/create-lookup.html)：当前更推荐 candidate 对象而非已弃用 candidateId，含来源与 sections；可先 preview，完整版扣 credit；提供 HTML/JSON/PDF 入口。
- [Get Lookup](https://docs.whitebridge.ai/get-lookup.html)：结构化研究对象，有状态、时间、职业、社交和来源等字段。可借鉴对象与任务视图，但不能据此断言后台确有一个永不变化的 canonical Person 主表。
- [Get Datasources](https://docs.whitebridge.ai/get-lookup-datasources.html) 与 [PDF](https://docs.whitebridge.ai/download-pdf.html)：资料与导出有独立接口，值得与展示层解耦。
- [产品页面](https://whitebridge.ai/people-research-ai)：单输入姓名/社交链接、分用途展示。官网不同页面的来源数量、速度口径不一致，且不能用来证明我们可达到相同表现。`/pricing` 本轮未取得可用明确单价，因此不声称竞品低价或免费。

本项目的原创设计推论：稳定 Person 引用 + 可修订证据 + 带日期任务快照 + 增量研究，能让用途与格式复用数据。这是 StripSearch 的架构建议，不是对 WhiteBridge 私有实现的事实陈述。也不继承竞品的人格/敏感家庭资料、泄露库等字段。

## DeepSeek 与 DSH

- [模型/美元价格](https://api-docs.deepseek.com/quick_start/pricing/) · [人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [更新日志](https://api-docs.deepseek.com/updates/) · [模型 API](https://api-docs.deepseek.com/api/list-models/)：当前 ID 与限额随版本变化，执行时记录实际 model/priceVersion。
- [Thinking](https://api-docs.deepseek.com/guides/thinking_mode/) · [JSON mode](https://api-docs.deepseek.com/guides/json_mode/) · [Responses Schema](https://api-docs.deepseek.com/api/create-response/) · [strict tools](https://api-docs.deepseek.com/guides/tool_calls/)：格式正确与事实正确分别验收。
- [Responses 兼容](https://api-docs.deepseek.com/guides/responses_api/) · [缓存](https://api-docs.deepseek.com/guides/kv_cache/) · [限流](https://api-docs.deepseek.com/quick_start/rate_limit/)：不把兼容接口等同于相同持久性与内建工具能力。
- [DSH 固定代码基线](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443) · [架构](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md)：插件化执行层，仍在预览。
- [SDK](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/README.md) · [Workflow](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/README.md) · [MCP](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/mcp/mcp-client/README.md)：本提案据此增加独占 worker、领域 checkpoint 和 structured result 验证。
- [native search](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/web-search-deepseek/README.md) · [日志插件](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-log-deepseek/README.md) · [安全边界](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/SAFETY.md)：集成行为要在出站请求测试验证，不能只检查配置文本。
- [Harness 隐私政策](https://www.deepseek.com/en/harness/privacy/)：关闭额外会话日志不能推出所有产品/API 均零留存。数据安排在正式接入账号时核查，文档不作法律合规认证。
- [Exa 定价](https://exa.ai/pricing)：成本情景的 Search / text Contents 单价来源，不包括其他采集服务。

## 交互参考与本地依据

- [Readwise Reader](https://readwise.io/read)：借鉴读到疑问时的上下文追问入口。
- [Tapestry](https://usetapestry.com/)：借鉴时间顺序和跨来源阅读，不套用推荐流。
- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)：借鉴主内容、导航和辅助面板的层级，不复制品牌。
- 项目基线：README、docs/product.md、docs/architecture.md、docs/roadmap.md、apps/web/README.md；代码 revision `7daa7b4`，线上公开界面 revision `0bafad5`。

证据层级：代码/页面已观察；外部能力是官方文档；架构、预算与 UX 是提案；质量和低成本是待 live 实验验证的假设。四者不能互相替代。
