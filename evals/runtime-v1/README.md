# Runtime v1 · 冻结回放

40 个原创合成案例、20 组对照：GitHub 16、Exa 16、范围检查 8。28 discovery + 12 regression；同组变体不跨 split。全部公开且 unreviewed，不是盲测或人工 gold。

每组保留有效对照，再改变一处关键输入：账号、归属、fork、主页缺失、返回附带字段、超时、响应大小、引用缺失 / 无效、URL 去重、种子命中、密钥缺失、HTML 与空结果。规格在运行前编写；不要看到失败后删题或改成通过。

```bash
npm --prefix apps/web run eval
npm --prefix apps/web run eval -- --split regression --output _private/evals/regression
```

执行真实生产适配器；HTTP 回答来自本文件，不访问 GitHub、Exa 或合成来源 URL。输出包含逐案断言、错误、数据 hash、源码版本和分组计数。引用外键存在只表示引用结构合法，**不表示来源支持结论**。真实检索、LLM 输出质量、费用与人工核查时间未评估。

`check_revocation` 用生产 Store 与 canonical renderer 验证来源排除 / 恢复和导出一致；浏览器与 HTTP 权限由应用测试另行验证。所有原创输入按仓库 Apache-2.0 提供。格式见 [CONTRACT.md](CONTRACT.md)。
