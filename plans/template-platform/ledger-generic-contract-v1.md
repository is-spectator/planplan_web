# 第二批实际契约：记账与通用记录

日期：2026-11-16。与[本批 TODO](../todos/2026-11-16-ledger-water.md)同步。实现与验证进度以 TODO 的证据为准；本文说明接口约定，不代表验收全部完成。

## 定义与数据

- 保留 `official.reading@1`、`official.ledger@1`、`official.water@1` 的不可变定义；不修改已经应用的迁移 11，通过新增迁移 12扩展运行能力。
- 记账继续使用唯一人民币账本、整数分、原支出/退款记录及目标区段。旧账本补上来源绑定，不从模板默认值覆盖预算。已有账本必须提供匹配的 `existingPlanId` 和 `existingLedgerAction: reuse | restore`；归档账本只能明确选择恢复。
- 通用计划为 `kind: generic`；记录为 `kind: generic`，在 `fields` 中保存经过定义校验的字段值，并保存 `definitionVersion`。不是备注拼接，也不占用金额或学习分钟列。
- 当前通用运行时支持 `text / integer / date` 字段，`sum / count / distinct_days / mean / goal_progress` 指标，按日定义指标，`summary / goal / records` 组件。未实现的字段、单位或指标组合在执行前拒绝。第二个合成定义用于证明运行逻辑不依赖饮水 ID。
- 饮水整数毫升范围 1–100000；明确的 L 精确乘以 1000 后必须得到整数毫升，不截断或四舍五入，不猜杯容量。目标可空；目标配置不产生事实记录。用户日期使用上海时区，事实不接受未来日期。
- 每个实例固定来源定义版本。配置版本独立于记录版本；每次配置写入带 `expectedVersion`。目标保存生效区段，支持 `current_only / current_and_future / next_and_future`；日目标对应今天/从今天起/从明天起，预算对应本月/从本月起/从下月起。历史查询读取历史有效目标。

## 写入与恢复

统一通过 `POST /v1/operations`、既有 Cookie/CSRF/预期账户、稳定 `clientOpId` 和原输入时间执行。配置、选用单独提交，事实可以在账本/学习/通用计划之间原子批量提交。

| 动作 | 关键输入 |
| --- | --- |
| `adopt_template` | `templateId, templateVersion`；已有账本再带显式复用/恢复选择 |
| `configure_ledger_plan` | `planId, expectedVersion, patch: {name?, budgetCents?}, completeSetup?, goalScope?` |
| `configure_generic_plan` | `planId, expectedVersion, patch: {name?, startDate?, values?}, units?, completeSetup?, goalScope?` |
| `add_generic_record` | `planId, values`（包括日期及定义必填字段），可选 `units` |
| `edit_generic_record` | `recordId, expectedVersion, values, units?` |
| `delete_record` / undo | 沿用原操作入口与版本/依赖校验，扩展支持通用记录 |

任何一项缺失、非法或存在版本/依赖冲突，整个事实批次均不保存。澄清完成前不先保存其中已经明确的项。撤销只逆转原批次；后来独立的记录保留，任何依赖冲突拒绝整批撤销。配置修改以再次配置纠正，不冒充事实撤销。

未知结果先查 `GET /v1/operations/:clientOpId` 或 `GET /v1/chat/:clientMsgId`。重试使用原标识和原始内容；相同标识不同请求体报 `operation_changed`。恢复材料按账户隔离，换账户不能重放上一账户操作。

## 查询与前端

- 市场 `GET /v1/templates` 公开返回三个可运行官方定义及合成示例，不含私人事实。登录后的 `GET /v1/plans/:id/template` 返回固定定义、当前配置、后续生效值和 `canChangeStartDate`。
- `GET /v1/plans/:id/generic` 默认今天；可选 `date` 或完整 `from + to`，两者互斥；最多 366 天且结束不晚于今天，支持 `offset` 和 `limit`（1–100，默认 20）。
- 返回 `{plan, templatePlan, today, summary, records, totalRecords, offset, limit, dataVersion}`。`summary` 为 `{planId, from, to, recordCount, metrics}`，每个指标带 `id, label, operation, fieldId?, unit?, value, target, remaining, progressPct`。多日区间不冒充单日目标：`target / remaining / progressPct` 为 null。
- 计划卡片增加 `generic: summary`；对话查询卡为 `type: query, kind: generic_period`。所有正式摘要由服务端根据保存事实计算，前端不根据模型文案累计。
- 预览和试填仅在临时界面状态中计算，不调用正式写入，不计入计划、统计或导出。控件、单位、约束、列表和指标从定义生成。
- 无 AI 授权也可完成全部手动操作。对话补齐配置/事实时使用相同写入引擎与权限校验；容量、计划归属不明时追问，取消不写入。

## 旧协议

网页每次私有请求声明 `X-PlanPlan-Capabilities: reading-template-v1,ledger-template-v1,generic-record-v1,chat-recovery-v1`。服务端分别检查模板/记录能力，不把阅读能力当作通用授权。

`chat-recovery-v1` 表示网页支持请求超时后的同消息 ID 核对。只有明确声明此能力的 OpenRouter 免费模型请求可等待最多 60 秒（供应商专用配置限 20–60 秒）；网页 30 秒连接等待到期后保留原输入与 ID，核对返回 `processing` 时继续等待、不重发，完成后读取同一结果。旧客户端与 Qwen 仍使用原 20 秒模型预算，不放宽既有发布时延门槛，也不启用备用付费模型。

旧客户端不收到 `generic` 计划/记录或 `generic_period` 查询枚举：

1. 列表保留原账本和学习计划，并附 `compatibility` 的隐藏数量、说明和网页入口；不伪装成学习计划。
2. 历史、回复及核对中的通用卡片投影成已有 `notice` 类型。混合回执保留认识的项目，明确提示部分内容需在新版网页查看、已保存的记录无需重复提交，并禁用该混合回执的撤销入口。
3. 成功操作核对始终保持 `status: succeeded`，原操作标识不变；不会把已成功的通用写入伪装成不存在或失败。数据库中完整回执不修改，新端仍获得完整内容。
4. 通用详情、目标修改、事实修改/删除、归档/恢复、视图设置、撤销均要求相应能力，在写入前拒绝。通过旧账本/学习详情入口访问通用计划也会拒绝。
5. ZIP 导出保留所有类型的数据，不按旧端能力丢弃用户事实。

HTTP 自动化验证覆盖此策略。真实旧版 iOS 设备的渲染与跨端体验仍属于发布验收，不能用协议测试代替。

## 迁移保护

基线保存于本机受限目录 `~/.codex/backups/planplan-web-20261116-ledger-water-start`，含两仓源码、停服后的数据库与 11 张原表的哈希。已独立解压恢复并逐表比对一致。实际迁移后按原列和原行核对，允许新列及为旧账本增加绑定，不允许改写既有事实。完成后还需重启、重新登录、下载 ZIP 和新旧计划读写验证。
