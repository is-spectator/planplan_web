# Web 浏览器会话

本文件描述 `planplan_web/server` 的网页会话契约。前后端同仓开发，浏览器沿用邮箱账户和业务接口；既有Bearer兼容路径保持。当前源码与发布身份见[计划索引](../plans/README.md)，不依赖相邻仓库。

## 配置

- `WEB_ALLOWED_ORIGINS`：以逗号分隔的完整来源，例如 `https://planplan.example`；不设则关闭 Web 邮箱入口与 Cookie 认证。不能包含路径或通配符。
- `WEB_COOKIE_SECURE`：默认 `1`，使用 `__Host-planplan-session` Cookie；`HttpOnly; Secure; SameSite=Lax; Path=/`，有效期 30 天，无 Domain。
- 本机开发可显式设 `WEB_COOKIE_SECURE=0`，所有来源必须为 localhost、127.0.0.1 或 [::1]；使用独立 `planplan-local-session` Cookie。production/beta 禁止关闭 Secure。
- 前端与 API 使用同源代理，不提供跨域 CORS 授权。Web 的来源是浏览器看到的前端来源。

## 请求契约

| 路由 | 请求 | 成功响应 |
| --- | --- | --- |
| POST `/v1/auth/web/email/code` | `{email,purpose:"register"\|"reset"}` | 202 `{challengeId,expiresIn,retryAfter,message}` |
| POST `/v1/auth/web/email/register` | `{email,challengeId,code,password}` | 201 `{userId}`，设置 Cookie |
| POST `/v1/auth/web/email/login` | `{email,password}` | 200 `{userId}`，设置 Cookie |
| POST `/v1/auth/web/email/reset` | `{email,challengeId,code,password}` | 200 `{reset:true}`，清除 Cookie、撤销所有旧会话；需重新登录 |
| GET `/v1/auth/web/session` | Cookie；无需 Expected-User | 200 `{userId,csrfToken}`；无效会话 401 |
| POST `/v1/logout` | Cookie + 以下会话请求头 | 200 `{ok:true}`，清除 Cookie，撤销同账户所有设备 |

Web 邮箱认证入口每次均校验 `Origin`；这些入口在会话建立前使用邮箱凭据/验证码，不要求尚不存在的 CSRF token。原有 `/v1/auth/email/code` 仍供 iOS 使用。密码至少 15 个 Unicode 字符，最多 128 个；验证码 8 位，字段规则与原有邮箱服务一致。

登录成功后先读取 session，将 `userId`、`csrfToken` 仅保留在内存。所有使用 Cookie 的受保护业务读取与写入均须 `X-PlanPlan-Expected-User: <userId>`；写入额外要求允许的 `Origin` 和 `X-CSRF-Token: <csrfToken>`。账户不一致时不能自动换账户重发旧操作。Cookie 与 Authorization 同时存在一律拒绝；业务登录权限从签名 Cookie 获取，Expected-User 仅用于防止账户切换误写。

响应统一为 `{error:{code,message,details}}`：`unauthorized` 401、`credential_conflict` 401、`origin_forbidden` 403、`csrf_invalid` 403、`account_mismatch` 409（含缺失 Expected-User）。其他错误复用原有业务契约。全部 `/v1/*` 成功与错误响应均为 `Cache-Control: private, no-store`。

## 隔离本机功能验收

从本仓库根目录运行：

```sh
pnpm --dir server install --frozen-lockfile
npm run dev:api
```

仅绑定 `127.0.0.1:8788`，不会连接现有 8787 服务。持久数据保存在本仓库忽略提交的 `server/.data/web-fixture`。前端开发代理指向 `http://127.0.0.1:8788`，前端地址使用 `http://127.0.0.1:5173` 或 `http://localhost:5173`；标准 Playwright 验收来源 `http://127.0.0.1:4173` 也仅在此 fixture 中允许。

普通邮箱登录使用 `tester@planplan.test` 或 `second@planplan.test`，密码均为 `PlanPlan-local-test-2026`。这些是专用合成凭据，不用于真实部署。可以用 `invite@planplan.test` 验证注册，验证码从本机测试接口 `GET http://127.0.0.1:8788/__fixture/mail?email=invite@planplan.test` 获取；邮件仅被捕获，绝不向外发信。删除测试账户后，重启 fixture 会重新创建初始账户；已有账户不会被覆盖。

另允许 `beta01@planplan.test`、`beta02@planplan.test`、`beta03@planplan.test` 三个本机内测邮箱，按正常验证码注册流程创建，分别设置密码。它们不属于自动初始化账户，删除后不会在重启时重建；已注册的账户与数据持续保留。密码不写入源码或提交文档。

默认模型为受控 stub，只验证 API、账户与手动记录链路，不能据此声称真实 AI 验收通过。需要真实模型验收时，按[后端说明](README.md)在 `server/.env.openrouter.local` 明确配置 `PLANPLAN_FIXTURE_REAL_AI=1`、`AI_PROVIDER=openrouter` 和服务端密钥，再由 `node --env-file` 注入。fixture本身不读取 `.env`，不自动选择现有密钥。

`/legal/metadata` 和说明页由独立的 `web-fixture-legal.ts` 提供，显式返回 `developmentOnly:true`、`reviewed:false`。真实模型模式按明确配置列出接收方、模型和云端文本处理范围，并沿用实际 AI 授权版本校验；stub 模式明确没有云端处理。此说明不复用 iOS 语音、成长或 TestFlight 发布文案，也不是正式法律告知。生产启动仍强制加载和验证真实 `LEGAL_CONFIG_PATH`，不能使用该本机注入入口。

该 fixture 仅为开发验收脚本，不被生产启动入口导入。合成数据、捕获邮件、公开测试签名密钥均不得部署到外网。

## 切换到 OpenRouter

保持 `PLANPLAN_FIXTURE_REAL_AI=1`，明确配置 `AI_PROVIDER=openrouter` 与服务端 `OPENROUTER_API_KEY`。默认 `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`、`OPENROUTER_MODEL=baidu/ernie-5.5-flash-preview:free`、`OPENROUTER_OUTPUT=compact`，也可显式写入忽略提交的本地环境文件。Qwen 仍为未设置 AI_PROVIDER 时的默认提供方，继续读取原有 `QWEN_*` 变量；两种提供方不混用密钥。

OpenRouter 请求保留同一 JSON 协议与业务校验，不发送百炼专属 `enable_thinking`；百度模型仅路由到 `baidu`，关闭供应商 fallback，并要求支持所传参数。SDK 重试保持关闭。提供方切换会改变本机告知和 `consentVersion`，需要重新同意 AI 服务说明。

官方契约：[模型与能力](https://openrouter.ai/baidu/ernie-5.5-flash-preview:free)、[端点](https://openrouter.ai/api/v1/models/baidu/ernie-5.5-flash-preview:free/endpoints)、[路由参数](https://openrouter.ai/docs/guides/routing/provider-selection)、[隐私说明](https://openrouter.ai/privacy)。免费模型仍受可用性、速率与数据处理政策约束。传输单元测试不代表真实模型业务验收已经通过。
