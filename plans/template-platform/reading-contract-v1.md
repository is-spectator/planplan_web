# 阅读模板第一批实现契约

冻结日期：2026-11-16。对应[今日 D01–D04](../todos/2026-11-16.md)与 S1-01；本文件记录已落入类型与校验的接口约定，功能是否验收通过仍以每日 TODO 为准。

## 定义和能力

服务端权威定义位于配套后端 `server/src/templates/contracts.ts`、`definitions.ts`；浏览器 DTO 位于本仓库 `src/lib/contracts.ts`。定义格式 `schemaVersion=1`，官方模板各自从版本 1 开始。模板字段标识与中文显示名称分离，来源身份由服务端维护。

| 定义 | 引擎与边界 | 计量与限制 | 当前运行状态 |
| --- | --- | --- | --- |
| `official.reading` | study；目标与事实分离；书名、位置、收获保存为有标签的备注 | 每次及每日累计不超过 1440 整数分钟；每周目标 1–7 天；备注沿用最多 200 字；当前书籍最多 80 字 | 本日接通的唯一市场模板 |
| `official.ledger` | ledger；支出/退款角色与分类明确，支出指标来源为既有支出规则，退款仍关联原记录 | 人民币整数分；金额、预算上限沿用 99,999,999 分 | 定义已固定，市场接入后续实施 |
| `official.water` | generic；按日求和与目标进度；不以学习分钟承载 | 整数 ml；单条及每日目标 1–100,000 ml；明确的 L 按 1000 换算，“杯”容量未知需追问 | 定义已固定，运行能力未开放 |
| `legacy.study` | 原学习计划的兼容来源；保留原身份、历史与业务口径 | 沿用现有 study 规则 | 迁移关联，不作为市场作品 |

日期使用真实有效的上海业务日期；空目标与零分开。字段/指标/组件有数量与长度上限，未知能力、缺失记录入口、重复字段、错误单位配型、无效指标引用和非法示例拒绝。枚举/布尔等定义类型不代表它们已具备通用运行能力；本日只开放明确的官方阅读适配。

## 读取接口

| 接口 | 返回与访问范围 |
| --- | --- |
| `GET /v1/templates` | `{ templates: TemplateDefinition[] }`，公开官方目录，只列当前可执行版本 |
| `GET /v1/templates/:id` | 直接返回 `TemplateDefinition`；不可用/未知模板 404，不包含用户配置与记录 |
| `GET /v1/plans/:id/template` | 直接返回 `TemplatePlanState`；认证、预期账户和计划归属校验；他人的计划或无适配的计划 404 |
| `GET /v1/plans` | 支持本契约的网页收到可选 `plan.template={id,version,setupStatus}`，用于区分初始化待完善与主动跳过目标；旧协议仍返回原形状 |
| `GET /v1/messages?scopePlanId=...` | 指定计划的对话；先校验计划归属；不带参数保留原全局历史 |

`TemplatePlanState` 包含 `planId/templateId/templateVersion/source/engine/definition/config`。`config` 包含版本、初始化状态、名称、开始日期、当前书籍、本周目标和生效周，以及真实读取的 `nextWeekGoals`。下周生效的修改在界面中明确显示，不能把本周旧值当作刚保存失败。

## 写入和恢复

继续使用 `POST /v1/operations` 与现有 Cookie/CSRF/预期账户/稳定操作身份机制，无独立的模板写入队列。新网页发送 `X-PlanPlan-Capabilities: reading-template-v1`；旧协议缺省无此能力，服务端在执行新动作前限制。聊天同样传递能力，模型输出不能越过服务端校验。

- `adopt_template`：`templateId`、`templateVersion`。本日只接受 `official.reading` 的可用版本；事务内创建私人 study 计划、固定定义快照及待完善配置，不生成事实记录。明确再次选用可产生另一实例，网络重试仍返回原实例。
- `configure_reading_plan`：`planId`、`expectedVersion`、`patch`，可选 `completeSetup`、`goalScope`。patch 支持名称、开始日期、明确的当前书籍、每周天数、每日分钟；书籍与目标可用 null 清除。仅待完善且尚无记录、目标或生命周期历史时可改开始日期。
- 初始化状态 `pending/ready` 与计划状态 `active/archived` 分开。取消不删计划，跳过可选目标可就绪；归档后不能修改设置，恢复仍是原实例。
- 目标范围为仅本周、本周及以后、下周及以后；清除目标也保存有效区段，保留以前和其他周期的规则。旧改名/目标/生命周期操作同样使配置版本递增，过期表单不能覆盖最新设置。
- 新模板动作每次只提交一项；多字段配置合并在一个 patch 内。模板配置混入其他写入时整批拒绝。既有 ledger/study 原子批次保留，新增 generic 多计划批次不算今日完成。
- 结果保留原 `OperationResult` 和 `plan_created/plan_updated` 类型，额外带 `templatePlan`。模板选用/配置不提供撤销删除实例；使用归档及后续版本化配置操作。事实的编辑、删除、适用撤销仍沿用原规则。

成功重放校验账户、原内容与输入时间；同身份换内容、拿旧普通操作身份冒充选用均拒绝。丢响应先通过 `GET /v1/operations/:clientOpId` 核对，同一动作不可换新 ID 盲目重建。配置过期返回 409 `version_conflict`，内容与身份冲突返回 409 `operation_changed`；Cookie 会话不匹配 409，缺 CSRF 403，未认证 401，结构不合法 400，业务校验拒绝通常 422，资源不可用 404。

## 存储、导出和兼容

迁移 11 使用已冻结的 SQL 种子，新建不可变 `template_versions`、私人 `plan_template_bindings`、模板请求摘要；给原学习计划添加关联，给目标规则增加明确清除标记。原计划/记录 ID、金额、日期、目标区段和退款关系保留。模板版本禁止原地更新或删除，后续版本必须追加迁移，不改已应用迁移校验和。

ZIP 新增 `templates.json`，包含本账户的定义快照、来源版本和配置；`plans.json`、两类记录 CSV 继续保留，已清除目标明确标为 `cleared=true/value=null`。账户清理级联删除私人绑定与请求摘要，官方定义不属于任何用户的私人数据。

旧客户端继续读取 study 类型、原记录和回执形状，既有目标/记录操作仍可用。HTTP 兼容测试不能代替真实 iOS 设备验收；generic 混合账户、新类型展示和正式跨端发布仍按总计划后续验证。模型真实调用和浏览器真实保存的证据分别记录，不以协议测试替代。
