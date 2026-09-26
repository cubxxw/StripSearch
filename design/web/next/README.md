# A · Signal Atlas

用户已选择 A。本轮参考 [Octen](https://octen.ai/) 的直接输入、可视流程与分步骤接入，深化官网、研究工作台和配置体验。B 保留为存档。均使用原创合成材料，不连接检索服务，不替换 `apps/web`。

| 入口 | 内容 |
| --- | --- |
| [官网](index.html) | 精简主张与输入；可点选账号图谱、证据检查器、流程切换 |
| [图谱工作台](index.html#/workspace) | 账号图谱、平台列表、结论、时间线、公开互动、质量核查 |
| [新建研究](index.html#/setup) | 平台范围 → 研究方式 → 检查并开始 |
| [配置](index.html#/settings) | 研究偏好、数据源草稿、动态效果；保存非敏感偏好 |
| [B 存档](dossier.html) | 暖白档案与时间切片，保留原交互 |

从仓库根目录启动：

```sh
python3 -m http.server 9293 --bind 127.0.0.1
```

访问 `http://127.0.0.1:9293/design/web/next/index.html`。无需构建、远程字体或依赖脚本。

## 主要动作与状态

- 图谱可选中、缩放、隐藏待核查账号；排除候选可恢复。明确链接才有身份连线，同名账号保持独立。
- 来源可检查、撤回和恢复；相关归属、事实、时间线和人物互动关联同步待复核。Markdown / JSON 保留同一状态。
- 8 个平台、7 个候选；支持多账号、未发现、读取失败、未配置、已排除等不同状态。研究范围真正控制列表、图谱和导出内容。
- 新建研究有三步引导、范围校验、暂停/继续；离开运行中的研究会暂停。输入只在当前页面用于展示，所有研究仍运行固定林舟样例。
- 配置保存到此浏览器，仅用于下次研究；当前报告使用启动时的范围快照。Exa / TikHub / Apify / Maigret 草稿不代表连接成功，不收集真实密钥；下载模板只包含环境变量名。
- `⌘ / Ctrl K` 查找动作，`N` 新建研究，`Esc` 关闭弹窗并返回焦点。动效跟随节点选择、流程切换与阶段推进；支持系统和应用内减少动态。

姓名、用户名、授权邮箱及授权图片入口仍是设计演示。图片只作本地预览与公开出处流程设计，不做人脸识别或按相貌合并身份。

`demo.js` 提供 A/B 唯一的合成语料与来源生命周期；`atlas-ui.js` 提供 A 的视图、范围快照和配置。契约见 [NEXT-DESIGN](../NEXT-DESIGN.md)。

## 验证

```sh
npm --prefix design/web/qa run test:next
npm --prefix design/web/qa test
python3 scripts/check_design.py
```

22 项 A 行为检查、14 项 B 回归、36 项原基线检查及设计静态校验通过。真实 Chrome 在 1440 / 768 / 375px 检查官网、工作台、引导、偏好、数据源共 15 个组合；检查导出、撤回、焦点、草稿保存/刷新和减少动态。没有页面脚本异常或外部页面请求。

当前 A 记录：[atlas-browser-receipt.json](screenshots/atlas-browser-receipt.json)。旧 [browser-receipt.json](screenshots/browser-receipt.json) 仅记录深化前 A/B 验收。均不代表网络采集、模型或 benchmark 验收。

| | 桌面 | 手机 |
| --- | --- | --- |
| 官网 | [截图](screenshots/atlas-desktop.png) | [截图](screenshots/atlas-mobile.png) |
| 工作台 | [截图](screenshots/workspace-desktop.png) | [截图](screenshots/workspace-mobile.png) |
| 新建研究 | [截图](screenshots/setup-desktop.png) | [截图](screenshots/setup-mobile.png) |
| 配置 | [截图](screenshots/settings-desktop.png) | [截图](screenshots/settings-mobile.png) |
| 数据源 | [截图](screenshots/connections-desktop.png) | [截图](screenshots/connections-mobile.png) |

动作截图：[候选检查](screenshots/candidate-inspector.png) · [来源撤回](screenshots/evidence-withdrawn.png) · [流程图](screenshots/atlas-evidence.png) · [接入草稿](screenshots/provider-draft.png) · [动作菜单](screenshots/action-menu.png) · [开始前复核](screenshots/setup-review.png) · [运行过程](screenshots/research-progress.png)。

[真实浏览器下载的合成报告](screenshots/export-after-withdrawal.md) · [深化前 A 首屏](screenshots/atlas-before-desktop.png)。
