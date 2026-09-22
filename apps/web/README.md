# StripSearch Web Alpha (`apps/web`)

一个可运行的、同源的 StripSearch Web alpha：Express + Better Auth + SQLite + 原生 TypeScript 客户端。
它实现认证、按账号隔离的研究作业、真实的 GitHub 公开资料读取、可选的 Exa 检索与带引用整理、来源排除 / 恢复、
Markdown / JSON 导出，以及 Evidence Terminal 风格的界面。

> 状态：**可运行 alpha**。它不改变仓库既有的 M1–M4 验收，也不代表 Exa 真机、MCP 宿主或评测已经通过。
> 静态设计原稿仍保留在 [design/web](../../design/web/DESIGN.md)，未修改。

## 运行

要求：Node **22.23.2**，npm 12。

```bash
npm --prefix apps/web ci          # 安装锁定依赖（联网）
npm --prefix apps/web run build   # 构建客户端与服务器到 apps/web/dist
npm --prefix apps/web start        # 单端口同源服务 http://localhost:4392
```

打开 <http://localhost:4392>。默认只绑定 loopback；远程访问使用下述 hosted 模式和 HTTPS 反向代理。

## 部署模式

`STRIPSEARCH_DEPLOYMENT` 默认 `local`，保持上述 HTTP loopback 行为。

`hosted` 用于「本机反向代理终止 TLS、进程仍只绑定 loopback」的场景：

```bash
STRIPSEARCH_DEPLOYMENT=hosted \
STRIPSEARCH_PUBLIC_ORIGIN=https://search.example.com \
STRIPSEARCH_SIGNUP_EMAILS=alice@example.com,bob@example.com \
PORT=4392 npm --prefix apps/web start
```

- `STRIPSEARCH_PUBLIC_ORIGIN` 必填，必须是 HTTPS，且无凭据 / 路径 / 查询 / 片段 / 通配符；hosted 只信任这一个 Origin，`baseURL` 固定为它。
- cookie 变为 Secure（名称 `__Secure-stripsearch.*`），其余属性不变。
- `STRIPSEARCH_SIGNUP_EMAILS` 是逗号分隔、大小写不敏感、精确地址的注册允许名单。未设置或为空时拒绝全部新注册，但已有账号仍可登录；被拒时 UI 显示可读提示。
- 反向代理契约：代理终止公网 HTTPS，并转发到 loopback `PORT`，用真实客户端 IP **覆盖**（不要追加）`X-Forwarded-For`，可选覆盖 `X-Real-IP`。服务端只在 hosted 模式信任来自 loopback（`127.0.0.1` / `::1`）的这些头，用于认证限流 IP 归并；不信任 `X-Forwarded-Host` / `X-Forwarded-Proto`。hosted 认证变更与业务变更都要求精确 Origin，缺失或外来 Origin 返回 403。
- 部署、持久化、备份与发布验收步骤见[部署说明](../../docs/deployment.md)。

开发：

```bash
npm --prefix apps/web run dev        # 构建客户端后以 tsx watch 启动服务器
npm --prefix apps/web run dev:client # 仅监听客户端改动并重建 dist/client
```

## 测试与检查（离线）

```bash
npm --prefix apps/web test           # node:test + tsx，注入合成 provider，不访问网络
npm --prefix apps/web run typecheck  # server / client / tests 三套 tsconfig
npm --prefix apps/web run build
python3 scripts/check_design.py      # 仓库根目录
```

测试覆盖认证 cookie 与退出、跨账号授权、Origin 拒绝、请求边界（含 chunked 超限）、幂等键语义、并发上限、取消 / 删除后晚回包、
重启中断保留、GitHub / Exa 适配器（固定端点、账号归属校验、超时、重定向、429/403/404、非法 URL 与引用）、来源修订与导出一致性、
SSE 终态与会话撤销，以及基于 jsdom 的真实控制器回归（迟到请求 / 退出 / 切换运行不污染 UI）与渲染转义、链接安全。
适配器测试使用注入的离线 transport，不发出真实请求。

## 配置

复制 [`.env.example`](.env.example) 为 `apps/web/.env`（已被 Git 忽略）。所有值只在服务端使用：

| 变量 | 作用 |
| --- | --- |
| `EXA_API_KEY` | 可选。未设置时 UI 显示「未配置」，Exa 来源被禁用且服务端拒绝启动 Exa 研究。 |
| `GITHUB_TOKEN` | 可选。GitHub 公开读取无需 token；配置后只提高匿名配额。 |
| `PORT` | 默认 `4392`。 |
| `STRIPSEARCH_DATA_DIR` | 默认 `apps/web/.data`（已忽略）。 |
| `STRIPSEARCH_DEPLOYMENT` | 默认 `local`；`hosted` 启用 HTTPS 部署约束、Secure cookie 与注册名单。 |
| `STRIPSEARCH_PUBLIC_ORIGIN` | 受信任的同源地址。local 默认 `http://localhost:4392` 且必须是 loopback HTTP 并匹配 `PORT`；hosted 必填 HTTPS，无路径 / 凭据 / 通配符，仅信任该 Origin。 |
| `STRIPSEARCH_SIGNUP_EMAILS` | 仅 hosted 生效。逗号分隔、大小写不敏感的注册允许名单；为空则拒绝全部新注册，已有账号仍可登录。 |
| `BETTER_AUTH_SECRET` | 可选。缺省时在数据目录生成一次 `auth-secret`（权限 `0600`），没有共享默认值。 |

服务端绝不把供应商密钥写入客户端 bundle、日志或 `/api/health`。

## 实际限制（与 `src/shared/limits.ts` 一致）

| 项 | 值 |
| --- | --- |
| 研究问题 | 2–500 字符 |
| 主页链接 | ≤ 2048 字符，仅 http(s) |
| 密码 | 8–128 字符 |
| 认证请求体 | 实际读取 ≤ 8 KiB（含 chunked）；应用 JSON ≤ 32 KiB |
| Provider 超时 / 响应上限 | 15 s / 512 KiB |
| GitHub | 每个账号 2 次请求；一页最多 30 个仓库；最多展示 8 个非 fork 作品 |
| Exa | 固定 `https://api.exa.ai`；`/search` 6 条结果、每条摘录 ≤ 1200 字符；`/answer` ≤ 4000 字符；引用必须全部有效且映射到来源，否则不采用整理结果 |
| 并发 | 每用户 1 个运行中作业，全局 3 |
| 启动限流 | 每用户 60 秒 10 次 |
| 记录上限 | 每用户 200 份研究 |
| 会话 | 7 天，HttpOnly、SameSite=Lax，cookie 前缀 `stripsearch`；hosted 追加 Secure（名称 `__Secure-stripsearch.*`） |

## API 契约（同源，`/api/*`）

认证（Better Auth，`basePath=/api/auth`）：`sign-up/email`、`sign-in/email`、`sign-out`、`get-session`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 仅返回能力标记，不含密钥。 |
| GET | `/api/runs` | 当前账号的研究摘要列表。 |
| POST | `/api/runs` | 创建研究；`Idempotency-Key` 可选：同一键 + 同一规范化请求返回同一运行；已删除返回 410；新键或省略键创建新运行。 |
| GET | `/api/runs/:id` | 规范化视图 + 有序事件（`?since=`）。 |
| GET | `/api/runs/:id/events` | SSE 事件流，支持 `Last-Event-ID` / `?after=`，终态后发送 `done`。 |
| POST | `/api/runs/:id/cancel` | 取消并中止后续写入；幂等。 |
| POST | `/api/runs/:id/resume` | 为 `needs_input` 补充主页后继续。 |
| POST | `/api/runs/:id/retry` | 显式重试，创建新的子运行；可带幂等键重复提交。 |
| POST | `/api/runs/:id/followup` | 追问（仅 Exa 来源），创建关联子研究。 |
| DELETE | `/api/runs/:id` | 删除研究、来源与事件。 |
| GET | `/api/runs/:id/export?format=markdown\|json` | 与界面同一份规范化视图。 |
| POST | `/api/runs/:id/sources/:key/exclude\|restore` | 需 `expectedRevision`，过期返回 `409 stale_revision`。 |

所有 `/api/*` 应用路由都要求登录并对资源做所有权校验（其他账号得到 `404`），变更请求要求精确匹配的 `Origin`（否则 `403`）。

## 验收与限制

- 离线自动化测试全部通过（`npm --prefix apps/web test`），覆盖认证 cookie / hosted Secure 与退出、受限注册拒绝、跨账号授权、Origin 缺失 / 伪造拒绝（含认证变更）、幂等键语义、并发上限、取消 / 删除后晚回包、重启中断保留、GitHub / Exa 适配器、来源修订与导出一致性、SSE，以及编译产物从 `dist/client` 提供真实客户端资源。
- 真实验收（历史）：GitHub 调研（2 次请求、9 条来源）、账号隔离、导出、修订和重启持久化；记录仅保留状态与计数，不提交人物档案。
- hosted 模式的线上验收须单独核对证书、代理、会话、持久化及发布版本，不能仅用本地测试代替。
- Safari 与内嵌 Chromium 验证登录、来源操作、刷新恢复；375px 无横向溢出，明暗与 reduced-motion 跟随系统。
- Exa 未配置真实密钥，未验证真实调用或回答质量。邮箱验证、密码找回与 OAuth 尚未实现。
- 仅读取 GitHub 公开元数据，不读取仓库代码；仓库归属不代表个人贡献。GitHub 来源不解释任意问题，追问需要配置 Exa。
- Exa 的整理结果是供应商生成的摘要，不是独立核实事实；引用不完整时直接不采用。
- 不含 MCP 宿主、TikHub、本地档案导入或评测；人名不自动合并。
