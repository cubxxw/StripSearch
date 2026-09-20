# Runtime evaluations v1 · 实施契约

目标：让当前生产 GitHub / Exa 适配器读取冻结 HTTP 回放，用独立规格检查输出。此轨道衡量程序契约，不冒充真实检索或人物事实准确率。保持已有 `evals/cases.jsonl` 的 12 个设计案例原样。

## 数据格式

`cases.jsonl` 每行一个对象，字段如下；未知字段与非法类型应拒绝，不静默忽略：

```json
{
  "case_id": "rt-gh-001",
  "dataset_version": "runtime-v1",
  "title": "同名账号需要精确匹配",
  "family": "gh-identity-a",
  "split": "discovery",
  "review_status": "unreviewed",
  "tags": ["identity"],
  "mode": "provider",
  "input": {"question":"列出公开作品", "seedUrl":"https://github.com/ss-fixture-a", "provider":"github"},
  "replay": [{"method":"GET", "url":"https://api.github.com/users/ss-fixture-a", "status":200, "json":{"login":"ss-fixture-a"}}],
  "expect": {
    "state":"completed", "requests":2,
    "source_count":{"min":1,"max":3},
    "identity_status":"resolved",
    "include_urls":["https://github.com/ss-fixture-a"],
    "exclude_urls":[], "include_text":[], "exclude_text":[],
    "claim_kinds":[{"contains":"公司", "kind":"attributed_statement"}]
  },
  "check_revocation": true
}
```

- `mode`: provider 或 scope。scope 仅调用生产 `screenQuestion`，expect 使用 `disallowed: boolean` 和 `requests: 0`，不能声称跑过 HTTP 授权。
- `split`: discovery / regression。相同 family（含变体）只进一个 split；全部公开，均不是盲测 holdout。
- `replay` 严格按顺序匹配 method + URL；可选 `body_includes: string[]` 要求实际发送的请求 JSON 字符串包含这些片段（校验问题与种子均被发送）。响应 `status` + `json`；可选 `redirected: true`、`delay_ms`（遵守 abort），`raw_text` 替代 json 测试非法 JSON。仅固定 GitHub / Exa endpoint 的内存响应，不访问真实网络。
- `expect.state`: completed / partial / failed / needs_input；失败使用 `error_code`；scope 使用 `disallowed`。expect 其余字段可省略；`requests` 始终必填。`source_count`、`identity_status`、URL、文本、claim_kinds 只作用于实际输出。缺失输出不能获得 vacuous pass。
- `claim_kinds` 必须至少找到一个包含指定文字的 claim，并验证所有匹配项的 kind，不能找到一个正确项就忽略另一个升级为事实的项。
- `config` 可选 `{ "exa_configured": false, "timeout_ms": 30, "max_bytes": 2048 }`；均有严格界限。不读取当前环境中的供应商密钥。
- `check_revocation` 可选；使用生产 Store + canonical renderer 验证排除首条已被引用来源、恢复、导出修订与依赖失效；每次变更前后都要保留检查证据。报告明确这是存储 / 呈现检查，不是浏览器行为。

## 执行与评分

默认 CLI `npm --prefix apps/web run eval` 从仓库根相对路径加载数据，输出到忽略的 `_private/evals/latest`；支持 `--dataset <path>`、`--output <path>`、`--split discovery|regression`。失败退出非 0；无匹配 / 数据集无效也非 0。不要新增框架依赖。

使用真实 `githubProvider` / `createExaProvider` 与 bounded fixture transport；不要使用 tests/fakes 的固定结果，不把 expect 传进生产适配器。捕获实际调用、ProviderResult / NeedsInputError / ProviderError。导出 canonical 时用真正 Store 与 renderer，数据库隔离在临时目录并关闭、清理。默认没有模型 judge、付费调用或外网访问；非 fixture 出网企图直接失败且独立记为硬失败，不能被期待失败吞掉。

固定检查：引用外键存在、来源键与 URL 不重复、factual claims 均有引用、Markdown 无原始注入 HTML、调用与回放相符。语义蕴含、真实覆盖、准确率与未知费用保持 N/A / 未评估；不能把引用键存在命名为 citation entailment。

报告 JSON + Markdown：源代码 commit 与 dirty 状态、数据集 SHA256、运行时间、类型 `offline_provider_contract`、每案实际值 / 期望 / 失败原因、按 tag / split / provider 的启动与通过计数、硬失败、未评审数量、模型调用 0、外网调用 0、模拟 provider 调用计数。失败和超时必须保留在分母；比率分母为 0 记 null。不得仅输出一个总体分数。

给评估器本身写测试：错误账号、缺失引用、错误 claim 类型、空输出、意外请求、重复 case、family 泄漏、非法配置 / schema、断言失败退出码、篡改坏报告能被抓到。规格不是人工 gold；不得为让成绩好看放宽已有期望。
