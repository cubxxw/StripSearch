# 林舟 · 作品研究（合成示例）

> 手工编写的设计样例，不是 Agent 运行结果。所有来源来自合成 fixture，`example.org` 不应访问。身份状态只适用于此测试语料。

`run-demo-001` · revision 1 · completed · 截至 2026-09-20 · [canonical JSON](report.json)

## 人物索引

- [林舟 · person-demo-a](#person-demo-a) · [合成主页](https://example.org/people/lin-zhou-a) · 身份 resolved（fixture）

<a id="person-demo-a"></a>

## 时间线

- **2026-08-10（公告日期）**：发布公告记录林舟发布 Lantern 2.0。[原公告 S2](https://example.org/news/lantern-v2) · `claim-release` / `event-release`

实际发生时间未单独确认；没有可验证的结果或后续维护记录。

## 已有证据支持到哪一步

| 断言 | 类别 / 状态 | 原始证据 |
|---|---|---|
| 该主页将林舟列为 Lantern 软件作者。`claim-author` | attributed_statement / supported | [S1](https://example.org/people/lin-zhou-a)，第 1 句，ev-profile |
| 2026-08-10 的发布公告记录林舟发布 Lantern 2.0。`claim-release` | attributed_statement / supported | [S2](https://example.org/news/lantern-v2)，第 1 句，ev-release |

材料归属：S1 是测试输入指定的软件作者主页；S2 明确链接该主页（ev-release-identity）。它们被 linked 到 person-demo-a；这不代表公告内容经过独立外部证实。

## 未知与覆盖

- 作品发布记录：已回答，见 claim-release。
- 长期维护能力：unknown，只有发布公告，没有后续维护记录。
- 实际使用规模与持续维护情况未知。
- 单次公告不足以判断长期行为模式。本次不生成行为假设。

## 来源定位

| 来源 | 时间 / 原始来源组 | 定位与短摘录 |
|---|---|---|
| [S1 · 主页](https://example.org/people/lin-zhou-a) | 2026-09-01 / origin-a | body:sentence:1 — “林舟，Lantern 软件作者。” |
| [S2 · 公告](https://example.org/news/lantern-v2) | 2026-08-10 / origin-release | body:sentence:1 — “软件作者林舟发布 Lantern 2.0。”；末句显式指向 S1 |

两份材料的 fixture 获取时间均为 2026-09-20T00:00:00Z。停止理由为 synthetic_scope_complete；usage=not_run，费用与耗时未测量。
