# PlanPlan Web

PlanPlan 的网页应用。**只需这个仓库**：根目录 `src/` 是 React 前端，`server/` 是 TypeScript + Hono 后端，`deploy/web-target/` 是部署工具。`is-spectator/planplan` 是早期设计与实现参考，日常开发、测试和部署不依赖相邻仓库。

网站 [clyna.ai](https://clyna.ai) 已运行受限内测候选。当前版本、实际验收与尚未完成的正式试用事项以 [plans](plans/README.md) 为准。

交给其他开发者或 agent 的任务统一放在 [PR 计划书目录](plans/prs/README.md)：每项列明范围、TODO、验收和交付要求，从本仓库最新 `main` 建立独立分支。

## 本地运行

建议使用与部署环境一致的 Node.js 24；前端最低要求 Node.js 22.12。后端包管理器固定 pnpm 10.33.2，前后端分别使用自己的锁文件。

在仓库根目录安装依赖：

```sh
npm ci
pnpm --dir server install --frozen-lockfile
```

在两个终端分别启动：

```sh
# 终端一：本仓库的隔离本地API，127.0.0.1:8788
npm run dev:api
```

```sh
# 终端二：网页，127.0.0.1:5173
npm run dev
```

Vite 默认将 `/v1`、`/legal`、`/healthz`、`/readyz` 代理到 `http://127.0.0.1:8788`，因此首次检出也无需本机专用配置。需要其他API地址时，在忽略提交的 `.env.local` 设置 `PLANPLAN_API_TARGET`；它仅由Vite服务端读取。

`dev:api` 会生成AI协议指纹，再启动 `server/scripts/web-fixture.ts`。数据持久保存在忽略提交的 `server/.data/web-fixture`，默认模型为受控响应、邮件由本地夹具捕获，不调用云端模型或发送真实邮件。不要同时对同一数据库启动两个fixture进程。

本地合成登录账户：`tester@planplan.test`、`second@planplan.test`，公开测试密码均为 `PlanPlan-local-test-2026`。这些账户和凭据仅限本地夹具，不能作为正式环境配置。注册测试可用 `invite@planplan.test`；验证码从本地API的 `/__fixture/mail?email=invite@planplan.test` 读取。

## 真实模型与配置

日常手动流程无需模型密钥。需要明确验证真实AI时，在 `server/.env.openrouter.local` 配置 `AI_PROVIDER=openrouter`、`PLANPLAN_FIXTURE_REAL_AI=1` 和 `OPENROUTER_API_KEY`，再从 `server/` 启动；该文件必须保持忽略提交。

```sh
cd server
pnpm exec tsx scripts/ai-fingerprint.ts
NODE_ENV=development node --env-file=.env.openrouter.local node_modules/tsx/dist/cli.mjs scripts/web-fixture.ts
```

目前正式配置使用 `baidu/ernie-5.5-flash-preview:free`。真实模型受供应商可用性和额度限制，固定评测另见 [后端说明](server/README.md)。模型密钥、邮件凭据、数据库连接和运行数据不得放进前端、`VITE_*` 环境变量或Git。没有AI授权、模型失败或暂时限流时，仍可通过手动方式维护计划和模板。

会话、CSRF及本机测试契约见 [Web会话说明](server/WEB_SESSION.md)。正式环境使用独立部署配置，不使用本地fixture。

## 功能与目录

| 位置 | 内容 |
| --- | --- |
| `src/` | 对话、计划、模板市场、创作、账户与恢复界面 |
| `server/` | Cookie会话、计划与记录、模板创作／社区、统计、恢复、模型适配及测试 |
| `tests/` | 网页协议与真实本地API浏览器测试 |
| `deploy/web-target/` | 同仓源码打包、Linux构建、目标PG15验证和部署配置 |
| `plans/` | 当前版本、TODO、PR任务和实际验收记录 |

市场包含记账、阅读、饮水等官方模板，以及经审核的社区模板。采用模板生成私人计划；创作支持对话与手动编辑、预览试填、保存版本、采用和兼容升级。记录支持表单与对话、统计、编辑、删除、关联退款、撤销及原请求恢复。

业务读取按账户隔离，写入有CSRF及预期账户约束；疑似重复、版本冲突和未知结果保留核对路径。用户对象统一称“计划”，内部协议、日志和构建信息不放在普通产品页面。

## 验证

从仓库根目录执行：

```sh
npm run typecheck
npm run lint
npm run build
npm run typecheck:api
npm run build:api
npm run test:api -- --maxWorkers=2
npm run test:e2e
```

`npm run test:e2e` 启动4173端口的网页。测试需要本机已安装与Playwright版本匹配的Chromium和WebKit；必要时先运行 `npx playwright install chromium webkit`。协议测试用受控响应；真实API测试需先运行 `npm run dev:api`，并显式提供独立合成账户。例如：

```sh
PLANPLAN_E2E_EMAIL=tester@planplan.test \
PLANPLAN_E2E_PASSWORD=PlanPlan-local-test-2026 \
PLANPLAN_E2E_SECOND_EMAIL=second@planplan.test \
PLANPLAN_E2E_SECOND_PASSWORD=PlanPlan-local-test-2026 \
npm run test:e2e -- --workers=1
```

创作、社区等测试还使用各自的专用测试账户变量；缺少时会明确跳过，不能算作通过。后端默认用隔离PGlite；真实PostgreSQL矩阵须显式配置独立 `TEST_DATABASE_URL`，不能指向生产库。实际通过、失败和未执行项记录在plans，不以历史报告替代本次验证。

## 部署

前端构建输出 `dist/`；后端构建输出 `server/dist/`。正式服务同源提供网页和API，业务响应不进入公共缓存。源码打包从本仓库根目录执行：

```sh
python3 deploy/web-target/package-candidate.py \
  --frontend . \
  --server ./server \
  --output /本机受限目录/候选包
```

完整步骤见 [网页部署说明](deploy/web-target/README.md)。同仓迁移只整理开发交付，不代表自动执行新部署；公网实际版本以发布记录为准。
