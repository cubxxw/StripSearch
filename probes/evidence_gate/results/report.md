# 证据门禁探针 · 决定回执

> 类型：synthetic / discovery / unreviewed。输入是作者编写的显式标注，不是抽取器。
> 不访问网络、模型或 provider；未运行仓库原有 12 个 discovery case。

## 问题

在显式标注的合成身份/证据图上，共享 canonical report 加修订/导出门禁能否在身份撤销、来源不可读或导出权限收紧后阻止 JSON 与 Markdown 输出失效结论，并保留不受影响的结论？

## 自动判定

- automated_verdict: **supported**
- human_choice: **unreviewed**（自动通过不升级为人工 gold）
- 合成检查：134/134 通过，23/23 案例通过
- forbidden-call 观察：进程内守卫记录到 0 次尝试
- artifact scan passed: True

## 案例结果

| case | 结果 | 检查 |
|---|---|---|
| `valid-unaffected-branch` | pass | 4/4 |
| `same-name-unlinked-source` | pass | 2/2 |
| `ineligible-identity-link-states` | pass | 8/8 |
| `inaccessible-source-attempted-quote` | pass | 1/1 |
| `forged-excerpt` | pass | 1/1 |
| `broken-references` | pass | 4/4 |
| `duplicate-id-and-unknown-policy` | pass | 3/3 |
| `leaf-identity-revocation-cascade` | pass | 7/7 |
| `cross-source-identity-basis-revocation` | pass | 4/4 |
| `mixed-basis-requires-cross-dependency` | pass | 4/4 |
| `identity-cycle-rejection` | pass | 5/5 |
| `superseded-revision-after-reopen` | pass | 7/7 |
| `public-private-mixed-support` | pass | 9/9 |
| `public-permission-fixed-point` | pass | 7/7 |
| `public-provenance-controls` | pass | 10/10 |
| `claim-status-requirements` | pass | 7/7 |
| `export-enum-validation` | pass | 4/4 |
| `source-withdrawal-transition` | pass | 10/10 |
| `live-inaccessible-retains-snapshot` | pass | 3/3 |
| `withdrawal-inert-validation` | pass | 4/4 |
| `private-coverage-invalidation` | pass | 4/4 |
| `renderer-parity` | pass | 15/15 |
| `renderer-material-fields` | pass | 10/10 |

## 观察事实

- 有效合成快照通过结构与资格门禁
- 内部导出保留公共与私有分支；公共导出保留未受影响的公共分支
- 自述来源摘录被当作锚点，不需要额外身份依赖
- 姓名相同不会产生身份链接（没有名称推断）
- 使用未绑定来源的断言被门禁拒绝
- 只有 linked 状态可用于支持断言
- rejected / candidate / disputed 链接保持不合格
- fetch_status=inaccessible 的来源不能被引用
- null body 不能产生摘录
- 摘录必须是合成来源正文的精确子串
- 所有外键（含人物/档案身份证据、事件与假设边）都必须存在
- ID 必须唯一
- 未知 export_policy 失败关闭
- event 不得引用他人 claim（人物对应关系）
- 撤销来源身份后其断言失效
- 事件、行为假设与已回答覆盖随之失效
- 不依赖被撤销来源的旁支完整保留
- 跨来源身份依据撤销会传播到依赖链接
- 依赖失效链接的断言从当前导出移除
- 独立锚点分支保留
- 混合自述+跨来源依据仍要求所有声明的跨来源依赖合格
- 跨来源依赖失效时依赖链接与断言一并失效
- 无独立种子的跨来源身份循环被拒绝
- 自述摘录不能免除必需的跨来源依赖
- 纯自述锚点是无前提的种子，可解析依赖它的链接
- SQLite 保存不可变快照及 current/superseded 状态
- 重连后仍明确区分旧修订
- 畸形修订在事务前失败，不改变有效报告
- payload 不可被 UPDATE 修改
- 含私有支持的断言被整体排除而非声称独立支持
- 仅私有身份的人物与档案从公共导出消失
- 受限覆盖与未验证未知不泄露隐藏材料存在
- 公共源经受限中间来源得到的身份支持不再合格
- 二跳与三跳受限依赖的断言都不进入公共导出
- 公共导出没有悬空身份/证据指针
- 缺少或混合来源的文本字段在公共导出被省略
- 显式全公共来源的上下文、未知、覆盖与假设文本保留
- 声明来源是作者输入而非语义真值（本探针只检查可达权限）
- supported 断言不能没有支持证据
- insufficient_evidence 无证据被允许且不被升级
- claim kind/status、链接状态、coverage 状态与 revision 使用封闭枚举
- audience 与 format 使用封闭枚举
- 拼写错误返回明确错误而非静默降级
- 撤回本地可用正文会失效依赖链接并级联到断言、事件、假设与覆盖
- 旧修订在新修订写入后被取代，重连后仍拒绝旧导出
- 不可读正文与摘录不再出现在内部或公共视图
- 无关的公共分支完整保留
- 这是逻辑撤回，不是物理安全删除
- live fetch_status 只是描述，不决定历史快照可用性
- 只有显式撤回才移除可用正文并级联失效
- 丢失正文但不声明撤回的输入被视为畸形而拒绝
- 撤回来源不能保留活动证据
- 惰性证据必须属于已撤回来源、不得保留摘录
- 活动断言不能引用惰性证据，不能靠标记绕过验证
- 失效覆盖保留来源依赖，因此受限问题文本被省略
- 仅私有身份的人物、断言与覆盖不进入公共导出
- 无关公共分支保留
- 两种格式的 claim/evidence ID、状态、as_of、revision、人物锚点与 canonical URL 一致
- HTML 与不安全链接被转义，渲染不修改状态、不调用 provider
- Markdown 与 JSON 对每个节点暴露相同的支持/反证与不确定性字段
- 支持与反证、支持事件与反事件使用不同标签

## AI 假设

- 门禁设计可能迁移到真实采集管线；本探针只研究合成标注上的依赖失效行为，不测抽取、语义蕴含、检索质量、真实精度或用户收益。

## 未验证 / 剩余不确定性

- 文本字段的来源是作者声明的标注，不是语义真值；探针只检查被引用节点的可达权限。
- 只覆盖作者构造的合成依赖形状，不代表真实报告的依赖图分布。
- 进程内网络守卫不是沙箱，无法证明子进程或非 Python 工具未联网。
- 自动判定未经过人工评审，结论保持 unreviewed。

## 公共导出样例（同一过滤快照）

# 证据门禁探针报告 · run-probe-001

> 合成离线探针输出；audience=public；不调用网络、模型或 provider。

`run-probe-001` · revision 1 · completed · 截至 2026-09-20

## 结构元数据
- revision: 1（supersedes: None）
- as_of: 2026-09-20

## 人物索引
- [林舟（合成）](#person-lz) · `person-lz` · 身份 resolved · [https://example.org/people/lz7](https://example.org/people/lz7)
<a id="person-lz"></a>

## 断言
| claim_id | 人物 | 断言 | kind / status | support | refute | valid | as_of |
|---|---|---|---|---|---|---|---|
| `claim-author` | `person-lz` | 公开主页把林舟列为软件作者。 | attributed_statement / supported | ev-profile |  | -..- | 2026-09-20 |
| `claim-release` | `person-lz` | 发布稿记录林舟发布 Lantern 2.0。 | attributed_statement / supported | ev-release |  | 2026-09-01..- | 2026-09-20 |
| `claim-cross` | `person-lz` | 转载称林舟在会议展示了 Lantern。 | attributed_statement / supported | ev-cross |  | -..- | 2026-09-20 |

## 事件
- `event-author` · `person-lz` · recorded=2026-09-01 · occurred= · action=claim-author · outcome= · context=公开主页陈述。
  - 事件未知：作者长期活动的完整时间线未知。
- `event-release` · `person-lz` · recorded=2026-09-01 · occurred= · action=claim-release · outcome= · context=发布稿陈述。
- `event-cross` · `person-lz` · recorded=2026-09-01 · occurred= · action=claim-cross · outcome= · context=转载陈述。

## 行为假设
- `hyp-author` · 假设：林舟以软件作者身份公开活动。 · support=event-author · counter= · status=hypothesis · falsifier=主页被证明属于他人。
- `hyp-release` · 假设：Lantern 2.0 由林舟主导发布。 · support=event-release · counter= · status=hypothesis · falsifier=发布稿作者另有其人。
- `hyp-cross` · 假设：转载内容源自一次真实会议展示。 · support=event-cross · counter= · status=hypothesis · falsifier=转载无原始来源。

## 未知与覆盖
- 公开主页是否把林舟列为作者？：answered claims=claim-author
- 发布稿记录了什么？：answered claims=claim-release
- 转载说明了什么？：answered claims=claim-cross
- 能否判断长期维护能力？：unknown（无后续记录。）
- 发布后的长期维护情况未确认。

## 来源
| source_id | 标题 | canonical URL | policy |
|---|---|---|---|
| `s-profile-a` | LZ-7 主页（合成） | [https://example.org/s-profile-a](https://example.org/s-profile-a) | public_synthetic |
| `s-news` | Lantern 发布稿（合成） | [https://example.org/s-news](https://example.org/s-news) | public_synthetic |
| `s-cross` | 会议转载（合成） | [https://example.org/s-cross](https://example.org/s-cross) | public_synthetic |

## 证据摘录
- `ev-profile` · `s-profile-a` · body:sentence:1 — “LZ-7 是软件作者林舟的公开主页。”
- `ev-release` · `s-news` · body:sentence:1 — “软件作者林舟发布 Lantern 2.0。”
- `ev-news-ref` · `s-news` · body:sentence:2 — “本文引用主页 https://example.org/people/lz7 。”
- `ev-cross` · `s-cross` · body:sentence:1 — “林舟在会议展示了 Lantern。”


## 运行方式

```
python3 -m unittest discover -s probes/evidence_gate -p 'test_*.py' -v
python3 probes/evidence_gate/run.py --output <directory>
```

## 官方参考

- sqlite3: https://docs.python.org/3.12/library/sqlite3.html
- unittest: https://docs.python.org/3.12/library/unittest.html
