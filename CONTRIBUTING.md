# Contributing

当前欢迎设计审查、合成失败案例、数据标注方法与适配器契约讨论。开始实现前请对照[路线](docs/roadmap.md)和[接口](docs/interfaces.md)。

一个改动说明三件事：解决什么具体失败、采用什么证据、如何验证。声明哪些步骤没有运行。不要提交 API key、Cookie、真实个人档案、私人笔记或无许可网页全文。

```sh
python3 scripts/check_design.py
```

静态检查通过仅表示材料结构一致。研究精度、MCP 兼容、网络能力与安全边界需要分别验证。对比结果使用[实验模板](templates/experiment.md)，架构取舍使用[决策模板](templates/decision.md)。

贡献默认遵循本仓库 Apache-2.0 许可；第三方素材必须单独标注出处与许可。安全问题请勿在公开 issue 中附真实数据或密钥，可通过仓库启用后的 Private vulnerability reporting 提交。
