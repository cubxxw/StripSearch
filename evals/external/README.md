# 外部数据集选型

核对日期：2026-09-21。先以本项目的身份与证据案例为主，外部 benchmark 用来补能力，不直接合成一个总分。

| 数据集 | 用来测什么 | 本轮处理 | 边界 |
|---|---|---|---|
| [FRAMES](https://huggingface.co/datasets/google/frames-benchmark) | 多来源检索与数值、时间、多条件推理；824 题 | [固定版本 24 题](frames-v1/README.md)已转换 | 未跑模型；公开 test 在本地视为 discovery；数据卡 Apache-2.0 |
| [ALCE](https://github.com/princeton-nlp/ALCE) | ASQA、QAMPARI、ELI5 的回答与引用质量 | 采用 claim–evidence 核查方法，暂不搬运语料 | [代码 MIT](https://github.com/princeton-nlp/ALCE/blob/main/LICENSE)不替代各底层语料许可；不下载数十 GB 索引 |
| [DeepResearch Bench](https://github.com/Ayanami0730/deep_research_bench) | 长报告覆盖、分析、引用；100 任务 | 保留为第二阶段端到端比较 | 生成与 judge 都要固定版本；分数受 judge 与检索配置影响；[仓库 Apache-2.0](https://github.com/Ayanami0730/deep_research_bench/blob/main/LICENSE) |
| [DeepResearch Bench II](https://github.com/imlrz/DeepResearch-Bench-II) | 专家报告拆成细粒度 rubric，诊断信息召回、分析与呈现 | 优先借鉴逐项 rubric 结构 | [数据逐题许可](https://github.com/imlrz/DeepResearch-Bench-II/blob/main/DATA_LICENSE)与代码分开；未导入、未运行 |
| [People Search Bench](https://github.com/LessieAI/people-search-bench) | 按自然语言条件找人；119 queries | 仅作找人场景参考 | 与“研究指定人物”的任务不同；作者同时提供被评产品；不搬运联系方式或整个人物结果库 |

当前运行轨道是冻结 provider 回放，不评网页覆盖率。外部语义数据的实际执行需要已配置的检索候选；未配置 Exa 时不会偷偷切换供应商。人工审核与模型 judge 必须分别记录，任何 judge 都不自行生成并批准 gold。
