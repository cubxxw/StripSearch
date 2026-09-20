# Web 运行时实施契约

状态：实施中。静态设计仍位于 `design/web`；本文件定义独立可运行 Web alpha，不代表 M1–M4 整体通过。

## 本轮交付

- 沿用 Evidence Terminal 的问题入口、三栏研究页、系统明暗主题和精简中文；正式入口位于 `apps/web`。
- 邮箱密码注册、登录、退出、持久会话。账号用于本机应用，不声称邮箱已验证；邮件找回和 OAuth 待配置后另行验收。
- 真实 GitHub 公开账号 / 仓库读取，无需密钥；可配置 Exa 网页检索与带引用回答。供应商未配置、限流、失败明确显示。
- 研究记录按账号隔离并保存在 SQLite。支持进度事件、取消、刷新恢复、追问、新建、删除、来源排除 / 恢复和 Markdown / JSON 导出。
- 动效对应请求、消息进入、引用定位、抽屉展开与按钮反馈；支持减少动态效果，不制造进度百分比。

## 技术基线

Node 22.23.2、TypeScript、Express 5.2.1、Better Auth 1.7.5、SQLite（better-sqlite3）、Vite 8.3.0 vanilla TypeScript。依赖锁定版本并提交 lockfile。认证交给 Better Auth，不自行设计密码哈希协议。

只绑定 loopback；浏览器与 API 同源。会话为 HttpOnly cookie，独立 cookie 前缀、SameSite、服务端校验、认证与任务限流。所有研究、来源、事件、导出接口校验资源所有者；修改接口校验 Origin。密钥只在服务端，运行数据与本地认证 secret 排除 Git。

## 研究与数据契约

`queued → researching → completed | partial | failed | cancelled`。无可靠对象时要求补充主页。进度来自实际阶段和来源数；断线仅重新读取，不隐式重跑付费调用。重启时未完成作业转为 partial 并注明中断，不自动追加费用。

每个 run 有 owner、输入、parent run、幂等键、revision、时间、来源、观察项、整理结果、限制、调用账和有序事件。幂等键与用户及输入摘要绑定。追问创建可见的子研究，不把固定脚本当回答。

GitHub 只请求固定 API origin 的已验证用户名和仓库路径，不读取私人邮箱或位置。自述为自述；仓库归属不等于个人贡献。最多读取一页仓库，并记录截断限制。

Exa 使用固定官方 endpoint、超时、响应大小和结果数限制，不由本机抓取用户任意 URL。结果保持原 URL、获取时间和可用的短摘录。Exa 的回答标为整理结果，引用必须能映射到实际返回的来源；不把摘要或模型回答升级为独立核实事实。搜索结果不会自动确认同名身份。排除来源后，所有依赖该来源的内容失效，导出使用相同修订模型。

离线测试注入合成 provider，不访问网络或示例域名。真实验收仅记录请求状态、计数及验证结果，人物材料留在忽略目录，不提交第三方全文或个人研究档案。

## 验证重点

认证 cookie、错误密码、退出失效、跨账号隔离、Origin 拒绝、幂等冲突、重启持久化、取消不被晚回包覆盖、来源撤回与导出一致、供应商超时 / 429 / 错误 / 非法引用、UI 空白 / 加载 / 错误 / 重试、375px 不溢出、系统主题与 reduced motion。

## 官方接口依据

- [Better Auth 安装与 SQLite](https://better-auth.com/docs/installation)
- [Express handler 与服务端会话](https://better-auth.com/docs/integrations/express)
- [邮箱密码认证](https://better-auth.com/docs/authentication/email-password)
- [认证限流](https://better-auth.com/docs/concepts/rate-limit)
- [Vite vanilla TypeScript](https://vite.dev/guide/)
- [GitHub 用户 API](https://docs.github.com/en/rest/users/users#get-a-user)
- [GitHub 用户公开仓库](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [Exa Search](https://exa.ai/docs/reference/search)
- [Exa Answer](https://exa.ai/docs/reference/answer)
