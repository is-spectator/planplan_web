# 本机平台最终技术验证

日期：2026-11-16。本记录只覆盖本机冻结源码、隔离测试数据库和本地验收服务，不代表真实移动设备、独立用户试用、生产部署或 AI 质量门槛全部通过。真实模型评测的失败/限流保持在 [P06/P13 现状](platform-ai-evaluation-2026-11-16.md) 中，没有用本次技术矩阵覆盖或改写。

## 冻结源码与完整矩阵

前端源码及实际 UI 测试先冻结；Chromium **66/66**、WebKit **66/66**，合计 **132/132**。4 件合成社区作品已全部下架，公开读取为 404；私人计划、已采用计划、记录和历史保留。下述后端完整矩阵顺序运行，没有同时跑两库整套。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| PGlite 完整套件 | 61 文件；598 通过、1 跳过，103.87 秒。跳过项是仅适用于独立 PostgreSQL 连接池的共享限流并发测试。 | [完整日志](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-pglite-final.log) |
| PostgreSQL 17 完整套件 | 62 文件；601/601 通过，35.25 秒，连接 `127.0.0.1:55439/planplan_test`，每个 fixture 隔离 schema。 | [完整日志](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-pg17-final.log) |
| 后续 PGlite 定向检查 | 35/35，通过新测试数据库选择、AI 指纹/运行时门槛；新 fixture 的两项覆盖在内。 | [日志](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-fingerprint-fixture-final.log) |
| TypeScript / build / diff | typecheck、build、`git diff --check` 通过。 | [typecheck](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-typecheck-final.log)、[build](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-build-final.log) |

PGlite 整套开始后，目标 PostgreSQL 资源验证发现测试夹具仍硬编码 PGlite，随后仅修改 `evals/fixtures.ts` 的显式测试分支：`NODE_ENV=test` 且存在 `TEST_DATABASE_URL` 时才用随机 PostgreSQL schema；真实模型评测默认仍为独立 PGlite。新文件 `test/eval-fixtures.test.ts` 验证隔离、清理和非测试环境不会继承数据库 URL。原 PGlite 执行路径不受影响，不重复整套；最终 PostgreSQL 全量覆盖新分支，新增两项和构建后指纹变化又由上述 PGlite 定向批次覆盖。

最终后端源码清单为 181 个文件，摘要 `59dc89e50dd62eb036beb6374096b45f51581af04a1a9b3f936f8ef72931a3c4`；与 PGlite 启动时清单相比，只有上述两个文件及自动生成的 `src/ai/build-fingerprint.json` 变化。参见 [最终清单](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/backend-source-final-manifest.json)、[差异说明](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/source-comparison.json)。没有 git 提交。

## 停服快照与独立恢复

先通知主线程并正常停止本地 8788 服务，确认进程退出后才复制 `server/.data/web-fixture`。没有同时打开 live 数据目录的另一个数据库实例。所有校验都在停服副本和从归档恢复的独立副本进行；live 数据没有被删除或用恢复副本覆盖。

备份目录 `/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final` 权限 **0700**；归档 `web-fixture-data.tar.gz` 权限 **0600**，大小 **13,319,831 字节**，SHA256 `eb981cbf82c014f7557d209a65779edd2a45e4b8575de985c2bf2bbc50f664b4`。参见 [归档清单](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/data-archive.json)。

逐表检查了列结构、所有行的规范化 SHA256 及表汇总。停服快照、独立恢复副本、关闭后重新打开的副本共三次摘要完全一致：

`f2a5d1b5ed81f265262a3962d817c1fbf78aa7dcdb629a5e86d486cf577271d8`

| 项目 | 当前停服快照 |
| --- | ---: |
| 公共表数量 | 50 |
| 已应用迁移 | 1–17，最高 17 |
| 用户 | 16 |
| 计划 | 193 |
| 记录 | 493 |
| 创作草稿 | 22 |
| 模板版本 | 37 |
| 社区作品 | 4，全部 `unlisted` |
| 反馈 | 4 |
| 原基线用户 | 12/12 仍存在，缺失 0 |

完整哈希与迁移证据保存在 [data-verification.json](/Users/fangnaoke/.codex/backups/planplan-web-20261116-platform-final/data-verification.json)。本次比较的是**当前停服快照与恢复副本**；原基线 37 表原行/原列在 M17 后不变的检查由主线程此前完成，不把它与本次 50 表快照混记。

## 重启与新登录只读核对

服务按原配置重启：`PLANPLAN_FIXTURE_REAL_AI=1 node --env-file=.env.openrouter.local node_modules/tsx/dist/cli.mjs scripts/web-fixture.ts`。没有输出密钥或因备份验证调用模型。`/healthz`、`/readyz` 均返回 200 / `ok:true`。

前端在 **2026-11-16T07:45:56.869Z** 完成重启后的新会话检查：作者和使用者各一次全新正常 UI 登录；创作与采用计划渲染正常；2 个八类型模板的原字段 ID/type 完整；社区 v2、100 分钟目标、false 默认填写保留。两份实际 UI ZIP 中共 6 条指定记录与重启前逐对象深比一致，11 个 ZIP 条目齐全。浏览器运行时错误为 0，375px 页面无横向溢出。两个新登录均已通过 UI 明确退出。

证据：[只读检查 JSON](/tmp/planplan-platform-qa/postrestart-check.json)、[创作桌面截图](/tmp/planplan-platform-qa/postrestart-creation-desktop.png)、[计划桌面截图](/tmp/planplan-platform-qa/postrestart-plan-desktop.png)、[计划手机视口截图](/tmp/planplan-platform-qa/postrestart-plan-mobile.png)、[作者 ZIP](/tmp/planplan-platform-qa/postrestart-author-export.zip)、[使用者 ZIP](/tmp/planplan-platform-qa/postrestart-consumer-export.zip)。这些是本地真实 API 与合成账户自动化证据，不是实际手机硬件或独立用户试用。
