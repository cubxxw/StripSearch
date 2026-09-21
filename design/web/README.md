# StripSearch Evidence Terminal 原型

`index.html` 是 StripSearch 的**最终本地交互设计原型**：以 Open Design 方向 A（Evidence Terminal）为起点收敛，保留细网格与绿色品牌，支持纸白 / 深绿亮色和黑 / 荧光绿深色，默认随系统色调实时切换。它演示输入校验、同名候选确认、可观察研究活动与进度、结构化回答、来源排除与撤销、复制 / 下载报告。

这是一个**本地合成演示**，尚未接入真实研究引擎：

- 没有真实检索、模型推理、后台服务、持久化或网络请求。
- 研究对象林舟、项目 Lantern 与来源 S1–S4 全部为合成材料。
- 每个视图只有一个 `示例模式` 折叠，展开说明人物和资料均为虚构、暂不连接真实检索；不伪造指标、覆盖率或可信度百分比。

## 静态访问

无需构建步骤，直接以静态文件打开即可。`index.html` 不依赖外部字体、脚本或图片。

推荐用任意静态服务器（避免浏览器对 `file://` 的跨源限制）：

```bash
cd design/web
python3 -m http.server 8000 --bind 127.0.0.1
```

然后访问 `http://localhost:8000/index.html`。路由使用 hash：`#/` 是首页，`#/app` 是研究 App 视图。

## 交互要点

- 首页问题优先：`想了解谁？` + 必填问题框 + `开始研究` / `看示例`；三个示例按钮填入问题并把焦点移回输入框。
- 输入有内容时出现 `清空`；`Cmd/Ctrl + Enter` 提交，忽略输入法组合与按键重复。
- App 工作状态只用中文：`等待确认` / `正在查看资料` / `已暂停` / `已完成` / `N 处待复核`；进度条由已完成步骤数驱动。
- `复制报告` 只在报告就绪时可用，复制成功才提示成功，被阻断时提示改用 `下载报告`。
- 快速追问固定在 composer 上方，点击立即发送且不改动草稿；手动发送成功后才清空输入并保持焦点。
- `不采用这条来源` 会同步更新所有依赖语句、已有回答与导出，并在出处面板就地提供 `撤销`；桌面检查器与移动抽屉都可用。

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

测试覆盖：URL 与问题校验（含畸形的 `https://`）、错误身份拒绝、暂停 / 继续单定时器、快捷键的输入法 / 重复 / 重复启动防护、清空控件焦点回还、进度计数与暂停 / 完成一次、剪贴板的异步成功 / 失败 / 缺失 / 报告门禁、S2 排除与就地撤销、重置后无残留撤销、移动抽屉内撤销与背景 `inert`、抽屉 `Escape` / 焦点回还 / Tab 陷阱、窄屏到桌面不搁置控件、快速追问草稿策略、任意追问边界、reduced-motion 完成运行，以及 Markdown 导出内容。

36 项检查验证 DOM 行为，不测量网络、模型、provider 或 MCP 运行时。另有真实浏览器的布局与交互验收，见 [验证记录](VALIDATION.md)。

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
