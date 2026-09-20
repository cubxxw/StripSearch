# StripSearch Evidence Terminal 原型

`index.html` 是 StripSearch 的**最终本地交互设计原型**：以 Open Design 方向 A（Evidence Terminal）为起点收敛，保留黑 / 绿细网格品牌。它演示输入校验、同名候选确认、可观察研究活动、结构化回答、来源撤回与 Markdown 导出。

这是一个**本地合成演示**，尚未接入真实研究引擎：

- 没有真实检索、模型推理、后台服务、持久化或网络请求。
- 研究对象林舟、项目 Lantern 与来源 S1–S4 全部为合成材料。
- 页面持续显示「交互演示 · 合成样例」徽标，不伪造指标、覆盖率或可信度百分比。

## 静态访问

无需构建步骤，直接以静态文件打开即可。`index.html` 不依赖外部字体、脚本或图片。

推荐用任意静态服务器（避免浏览器对 `file://` 的跨源限制）：

```bash
cd design/web
python3 -m http.server 8000 --bind 127.0.0.1
```

然后访问 `http://localhost:8000/index.html`。路由使用 hash：`#/` 是首页，`#/app` 是研究 App 视图。

## 测试

离线 DOM 测试基于 jsdom 30.1.0（本机验证 Node 22.23.2）。在仓库根目录运行；`npm ci` 是联网依赖准备，测试本身不发出网络请求：

```bash
npm --prefix design/web/qa ci --ignore-scripts
npm --prefix design/web/qa test
```

仓库根目录的静态一致性检查：

```bash
python3 scripts/check_design.py
```

测试覆盖：URL 与问题校验（含畸形的 `https://`）、错误身份拒绝、暂停 / 继续单定时器、初始与新建研究的导出门禁、来源筛选与空状态、S4 重试后仍被排除、S2 撤下与恢复在所有展示语句和导出文本上的传播、脚本追问边界、抽屉 `Escape` / 焦点回还 / Tab 陷阱、窄屏到桌面不搁置控件，以及 reduced-motion 完成运行。

21 项检查验证 DOM 行为，不测量网络、模型、provider 或 MCP 运行时。另有真实浏览器的布局与交互验收，见 [验证记录](VALIDATION.md)。

## 文件

| 文件 | 作用 |
| --- | --- |
| [index.html](index.html) | 自包含原型（内联 CSS 与 JS） |
| [DESIGN.md](DESIGN.md) | 最终设计令牌、关键流程与原型边界 |
| [BRIEF.md](BRIEF.md) | 阶段一 A/B 概念 brief |
| [concept-a.html](concept-a.html) / [concept-b.html](concept-b.html) | 保留的概念对照，不再修改 |
| [qa/prototype.test.cjs](qa/prototype.test.cjs) | jsdom 离线行为测试 |
| [qa/package.json](qa/package.json) | 测试依赖与 `npm test` 脚本 |

## 约束

- 原型不访问 `example.org` 或其他 fixture 域名，也不做任何外发请求。
- 不修改后端探针、canonical 报告契约或 `design/web/qa` 之外的依赖。
- 正式实现应读取同一份 canonical report；原型不是第二份事实来源。
