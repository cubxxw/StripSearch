# 初始化验证记录 · 2026-09-20

状态：本轮调研与离线验证完成；独立复核在约定范围内无未解决 P0/P1。基线 `c70cbcb76b3f7f27858533c5cb439f982db079f0`。本记录不作为真实人物准确率、provider 可用性或产品收益证据。

## 已观察结果

| 检查 | 实际结果 | 含义与限制 |
|---|---|---|
| 设计静态检查 | PASS | 本地链接、12 个种子、12 份来源、手写双格式样例一致；没有执行研究任务 |
| 官方 MCP v2 server + v2 client | PASS | 本地 initialize / tools/list / structuredContent / 非法输入 / resource read |
| 官方 MCP v2 server + v1 client | PASS | 相同五项；两代 SDK 客户端不是两个真实宿主 |
| better-sqlite3 事务回滚 | PASS | 唯一约束失败后旧 current 值恢复；不代表跨进程并发验证 |
| 第一版 evidence gate | 18 tests、66 checks 自动通过，但被审查否决 | 反例证明覆盖不足，不能使用这组结果声称设计已支持 |
| 修复后的 evidence gate | 33/33 单元测试；23/23 合成案例，134/134 声明检查；0 次守卫记录的网络尝试 | 程序依赖、导出及修订行为；不测真实身份、语义或搜索能力 |

本机运行时 Python `3.12.14`、Node `22.23.2`；better-sqlite3 运行时报告 SQLite `3.53.4`。SDK smoke 原始结果在 [receipt.json](../probes/runtime_compat/receipt.json)，依赖锁在 [package-lock.json](../probes/runtime_compat/package-lock.json)。

证据探针原始 [receipt.json](../probes/evidence_gate/results/receipt.json) 与 [可读报告](../probes/evidence_gate/results/report.md) 已保存。最终本地运行时间为 2026-09-20 22:02（Asia/Shanghai）；探针的输入、断言、源码与机器判定可复现。结果文件不包含真实人物资料或采集全文。

[复现清单](../probes/evidence_gate/results/reproducibility.json) 记录当前源码 SHA-256、Python/平台及实际命令。独立 reviewer 最后重新运行四项补充反例，确认正文撤回后无悬空链接且旁支保留；该审查是代码/实验边界 review，不是人工人物事实标注。

**决策：supported，仅针对已声明、明确标注的离线案例。** 建议把共享报告与修订门禁作为生产 core 的设计依据；探针代码不直接升级为生产代码。人的采纳决定仍为 `unreviewed`，原十二个种子也保持原审核状态。

## 审查改变了什么

主代理复核与独立只读 reviewer 分别检查身份依赖、public export、修订状态及评估有效性。初稿的问题包括：

- rejected 的跨来源身份链重新变为有效；自身锚点绕过其余声明依赖。
- public 导出使用内部身份闭包，间接依赖私有来源的断言仍被保留。
- 撤销时清空 coverage 依赖，反而把私有问题文字公开；无来源的自由文本也默认放行。
- 非法 audience 静默进入 internal；Markdown 遗漏反证、替代解释和事件未知。
- “拒绝不可读输入”没有覆盖“已有证据被撤回”的合法状态迁移。
- 回执可能在失败时仍打印成功事实或 supported。

上述问题已通过对应新反例关闭；没有把已知失败留作不影响结论的脚注。设计判断与运行事实分开；AI 审查不把合成样例升级为人工 gold。

最终修正包括：公共身份依赖闭包、强制文案来源、失效名称过滤、人物移除后的链接/证据可达性重算、输出枚举拒绝、反证及未知项呈现、合法正文撤回、失败回执统一判定。额外加入错误父修订拒绝、写入前 `BEGIN IMMEDIATE` 和每 run 唯一 current 约束；没有据此宣称完整并发压测已通过。

来源撤回与普通访问失败被区分：合法保存的历史正文仍可用时，原网页变得不可访问不自动抹掉证据；本地正文正式撤回后，新版只保留不含正文的内部审计标识，旧版导出返回 `revision_superseded`。数据库历史物理擦除不是本次探针能力。

## 复现

从仓库根目录运行：

```sh
python3 scripts/check_design.py
python3 -m unittest discover -s probes/evidence_gate -p 'test_*.py' -v
python3 probes/evidence_gate/run.py --output _private/evidence-gate-replay
cd probes/runtime_compat
npm ci --no-audit --no-fund
npm test
```

npm 安装需要网络；证据案例不使用网络、模型或 provider。Python 守卫只拦截当前解释器的 stdlib 网络入口，不是 OS 网络沙箱。CI 已配置相同检查；本次尚未推送，不能声称 GitHub CI 已通过。

未运行：真实采集/费用与覆盖、LLM 抽取和蕴含、原十二个研究任务、生产 TypeScript 编译、两个真实宿主、跨平台、生产并发与物理删除、用户核查时间试验。
