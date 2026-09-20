# Dataset card · v0.1-draft

12 个原创合成任务、12 份合成来源；中文；一个共享实体族；全部为 `synthetic / discovery / unreviewed`。来源为本项目设计阶段编写的虚构材料，不对应真实个人。按仓库 Apache-2.0 许可提供。

## 能验证什么

身份种子、同名歧义、公开笔名、转载去重、履历时效、冲突、自述、缺失、不可访问、文档注入、格式一致与范围拒绝。case 的 required/forbidden assertions 是待人工裁决的验收规格。

## 不能证明什么

没有真实搜索环境，没有 provider 覆盖统计，没有真实人物精度，也没有人工 gold。12 个 case 不是 12 个独立人物，不能用它们宣传总体可靠性。行为研究的 8 个扩展规格尚未加入这些 fixture。

## 使用约束

- 只从 `fixtures.json` 读取；`network_access=false`，不得访问合成 URL。
- 所有 `available_source_ids` 都应能解析；inaccessible 来源没有正文。
- 评估器必须保留每个失败，不只汇总成功输出。case 未执行不得标 pass。
- 当前期望由设计生成，review_status 保持 unreviewed；评审后另发布版本和变更理由。
- frozen-source 测试主要测抽取和核验；要评检索需补充查询→候选的回放环境。

扩展与 split 见[评估设计](../docs/evaluation.md)。公开真实材料前，逐条确认必要性与再分发许可，不以“在网上找得到”为准。
