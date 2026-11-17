# PlanPlan Web 服务端

本目录是 `planplan_web` 仓库内的 TypeScript + Hono 后端，负责网页会话、计划与记录、模板创作和社区、确定性统计、恢复及模型调用。不需要相邻的 `planplan` checkout；前端、后端、测试和部署源码都在同一仓库。

当前公网是受限内测候选，使用OpenRouter百度模型；完整质量和正式试用事项仍按 [plans](../plans/README.md) 逐项验收。旧端协议兼容保留，但不以参考仓库的iOS实现作为本项目运行前提。

## 本地网页开发

在仓库根目录运行：

```sh
npm ci
pnpm --dir server install --frozen-lockfile
npm run dev:api
```

另一个终端运行 `npm run dev`，打开 `http://127.0.0.1:5173`。API仅监听 `127.0.0.1:8788`，前端开发代理默认指向此地址。

`dev:api` 调用本目录的 `pnpm dev:web`：先生成AI协议指纹，再启动 `scripts/web-fixture.ts`。它使用独立PGlite目录 `.data/web-fixture`、合成邮箱账户、捕获邮件和受控模型；默认不连接现有数据库、不发真实邮件、不调用模型。依赖固定pnpm 10.33.2，锁文件为 `pnpm-lock.yaml`。

合成账户与Cookie／CSRF契约见 [WEB_SESSION.md](WEB_SESSION.md)。本地fixture不能部署到公网，也不能用它的公开测试密码／签名配置代替正式配置。

## 真实模型配置

后端配置与根目录的Vite代理配置分开。日常fixture无需配置文件；需要真实模型时，将 [本地模型示例](.env.example) 复制成忽略提交的 `.env.openrouter.local`，填入自己的服务端密钥，并明确改为 `PLANPLAN_FIXTURE_REAL_AI=1`。从本目录运行：

```sh
pnpm exec tsx scripts/ai-fingerprint.ts
NODE_ENV=development node --env-file=.env.openrouter.local node_modules/tsx/dist/cli.mjs scripts/web-fixture.ts
```

| 配置 | 用途 |
| --- | --- |
| `PLANPLAN_FIXTURE_REAL_AI` | 仅等于 `1` 时本地fixture调用真实模型；默认受控模型 |
| `AI_PROVIDER` | 本项目示例明确设为 `openrouter`；兼容代码在未设置时仍使用Qwen默认值 |
| `OPENROUTER_API_KEY` | 只保存在后端忽略的配置或受限秘密文件中 |
| `OPENROUTER_BASE_URL` | 默认 `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | 默认 `baidu/ernie-5.5-flash-preview:free` |
| `OPENROUTER_OUTPUT` | 默认 `compact`；固定协议和服务端校验不随模型输出放宽 |
| `OPENROUTER_TIMEOUT_MS` | 声明网页恢复能力的免费模型请求默认等待60000毫秒，允许20000–60000；旧端预算保持 |

真实调用前需要用户同意当前AI告知。SDK自动重试关闭，正式配置不启用fallback；两个NVIDIA免费候选仍只限合成评测，应用入口不会接收它们处理真实用户内容。密钥、数据库URL、真实邮箱名单和数据不能提交，也不能使用 `VITE_*` 传给浏览器。

`src/main.ts` 是正式API入口，默认端口8787；`pnpm dev` 运行该入口，不等同上面的隔离网页fixture。它需要与运行模式匹配的AI、法律告知及会话配置。正式环境只读取显式受限配置和秘密挂载，禁止本地测试登录；配置规范见 [网页部署说明](../deploy/web-target/README.md)，不要复制fixture配置上线。

## 验证

从本目录执行：

```sh
pnpm run typecheck
pnpm run build
pnpm test --maxWorkers=2
```

根目录也提供 `npm run typecheck:api`、`npm run build:api`、`npm run test:api -- --maxWorkers=2`。构建／类型检查会生成 `src/ai/build-fingerprint.json` 与 `creation-build-fingerprint.json`；它们是生成物，不是手工维护的业务源码。

默认测试使用隔离PGlite。需要真实PostgreSQL矩阵时，用独立测试库设置 `TEST_DATABASE_URL`；不能指向线上业务数据库。测试中的 `release-controller` 与 `backup-failure-paths` 使用同仓上级 `deploy/` 的三份兼容脚本及合成命令，不执行真实部署或上传。

网页协议测试、真实本地API测试、真实模型和生产验收分别计数。迁移后的构建和路径验证不等于重新完成全部历史用例；实际证据与跳过项记录在plans。

## 固定AI评测

基础评测固定分母330项，创作固定分母20项。每例使用独立合成数据，检查提案、领域执行及事实差异；供应商错误、非法输出和未执行项都保留，不能删去失败或拼接不同执行身份。

运行器分别为 `evals/run.ts` 与 `evals/creation-run.ts`。它们支持有身份校验的检查点与续跑；基础只允许单并发、请求间隔至少4秒，创作默认至少15秒。执行前先核对当前额度和待运行范围，使用明确的 `--max-requests` 与 `--out`；不要把默认全量命令当作本机启动步骤，也不要为了确认配置随意发起真实调用。

`--only` 子集不能证明全量质量；显式复跑必须保留首错。人工审定和发布批准独立于程序通过状态，不由agent代签。旧源码的评测报告只保留历史；当前结果见 [plans最新发布记录](../plans/README.md)。

## 代码与运行目录

| 目录 | 内容 |
| --- | --- |
| `src/domain` | 上海业务日期、金额、目标与周期等确定性规则 |
| `src/db` | PGlite／PostgreSQL接口与版本迁移 |
| `src/services` | 计划、记录、模板、创作、社区、统计、撤销与请求恢复 |
| `src/templates` | 模板定义、字段与能力契约 |
| `src/ai` | 固定提示词、输出校验、模型适配、计量与恢复预算 |
| `src/api`、`src/auth` | Cookie及兼容认证、CSRF、预期账户和HTTP接口 |
| `scripts` | 本地fixture、指纹、迁移、维护与恢复演练 |
| `test`、`evals`、`perf` | 确定性回归、真实模型固定集与合成性能验证 |

Beta／正式环境使用显式迁移和PostgreSQL，应用运行身份不自动迁移；备份、独立删除清单、TLS与隔离恢复的操作入口见 [同仓网页部署说明](../deploy/web-target/README.md)。当前迁移及线上版本以发布记录为准，不从README中的历史测试数量推断已放行。
