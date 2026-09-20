# FRAMES discovery v1

来自 Google 的 [FRAMES](https://huggingface.co/datasets/google/frames-benchmark)，固定上游 revision `58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef`。原始 test split 824 题，本地选择 24 题用于早期调试，包含数值、时间、表格与多条件推理。[论文](https://aclanthology.org/2025.naacl-long.243/)

上游数据卡标注 Apache-2.0；本地只做选题与 schema 转换，问题和参考答案不改写。原始行 ID、证据 URL、上游版本和校验和保留在 [cases.jsonl](cases.jsonl) 与 [manifest.json](manifest.json)。Apache-2.0 正文见仓库 [LICENSE](../../../LICENSE)。署名：Google FRAMES benchmark 及论文作者；不是 StripSearch 原创问题。

当前状态：**24 题准备完成，0 次模型运行**。参考答案为上游答案，尚未由本项目复核；Wikipedia 页面未下载、未冻结，涉及日期的问题应以题目时间作答。公开上游 test 题在本项目只能用于 discovery，不能宣传为未见 holdout。这一选题不是随机代表样本。

重建：先将 manifest 指定的固定 URL 下载到忽略目录，再运行：

```bash
python3 scripts/import_frames.py --source _private/evals/frames-test.tsv
```

转换器只读本地文件，验证完整 TSV 的 SHA256；不自动更新源版本或发起网页研究。`npm run eval` 默认只跑 Runtime v1，不会误把这批未执行题计成通过。后续真实检索候选需要输出回答、逐项引用与调用账，再评答案正确性、证据覆盖和耗时；引用存在不能替代 entailment 判断。
