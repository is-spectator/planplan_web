# 通用扩展与社区平台契约

冻结日期：2026-11-16。本契约承接私人创作 v1；此文冻结行为和接口，不等于测试全部通过或公开发布。

## 数据基线与兼容

本批开始前的前端、后端源码和停服数据已分别备份至本机受限目录 `~/.codex/backups/planplan-web-20261116-platform-start/`。数据归档在隔离副本恢复、关闭再打开，37 张表摘要一致，400 条记录、156 个计划。逐行摘要保存在该目录的 `baseline-hashes.json`，不在仓库放业务行值。原迁移 13 不修改，扩展按 14、15、16 追加，落库前先冻结并验证。

定义仍为 schemaVersion 1。仅使用扩展能力的定义增加 `generic-template-v2`；社区版本增加 `community-template-v1`。旧客户端不得读取或写入缺少能力的计划（包括实例已启用默认项的旧定义），恢复回执、撤销、消息和模型上下文使用同一过滤边界。没有能力不会把通用事实改存为学习或记账。

## 默认值与统计

定义可有 `configurationDefaults`、`recordDefaults`，都是字段 ID 到规范值的映射。采用仅建立待完善实例，不自动写目标或事实；用户接受建议时 `configure_generic_plan` 明确传 `applyTemplateDefaults:true` 且 `completeSetup:true`，仅 pending 状态有效，显式 patch（含 null）优先。

实例 `recordDefaults` 只有明确设置后才生效，不含 date/name/startDate。新增记录缺值可沿用，保存 `defaulted_fields` 并在回执标明；显式提供的值优先，编辑不套默认。修改字段后该字段不再标作沿用，撤销恢复原来源标记。模板示例完全独立，不作默认配置或事实。

统计 period 为 day/week/month，周一开始，月为自然月。目标范围 current_only/current_and_future/next_and_future 按每个目标字段所属周期解释。首个不完整周期不折算，返回 partialPeriod。goal_progress 支持 sum/count/distinct_days，目标字段不能混用不同周期或累计口径。分类只允许单选/布尔，缺值为独立 null 组；多选不重复累计。趋势给每日值与 sampleCount/recordCount；没有样本的均值为 null，计数/总量为 0。

`TemplatePlanState.config` 增加 recordDefaults/proposedDefaults/goals；每项目标返回 period/from/to/value/effectiveFrom/next/partialPeriod。`GenericMetricValue` 可返回 period/from/to/partialPeriod/sampleCount/groups/series。显式区间查询按用户区间，不把日目标套整段；概览按每个指标自己的周期。

## 公开作品与审核

私人模板不原地公开。预览生成 `community.<listingUUID>` 独立公开快照：标题、简介、分类、署名需明确填写；示例由服务端按约束合成，默认值仅来自显式 publicDefaults。没有邮箱署名回退，不携带私人示例、计划配置、记录和消息。明显密钥、邮箱、地址或外链拒绝公开。派生和无法确认原创来源的旧草稿首期仅自用。

申请状态 pending/approved/rejected/withdrawn/published；作品可见性 unlisted/listed/suspended/author_deleted 独立。审核通过不会自动上架，作者再次确认 publish 才生成不可变公开版本。v2 审核不改变已上架 v1。审核者由服务端可信配置注入，作者不能自审，客户端不能自授角色。每次变更带 expectedVersion；所有 mutation 用 clientOpId 原 ID 核对/重试，同 ID 异体拒绝。

市场只返回已上架、作者仍有效的推荐版本；采用创建自己的独立实例，真实采用数来自成功绑定而非浏览/点击。升级必须显式选择比当前更新的推荐版本、先看差异再确认；只允许兼容新增可选字段/展示调整，保留记录身份、历史来源、个人配置、默认项和目标规则。下架或作者注销拒绝新采用，既有使用者仍可读写自己的快照。作者资料撤下匿名化，不删除使用者数据。

## HTTP 与恢复

公开 GET `/v1/market/templates` 接受 q/source/category/limit/offset，返回 templates/total/limit/offset；官方在前，社区按发布时间及 ID 稳定分页。card 为 id/templateId/source/title/description/category/author/templateVersion/adoptionCount/definition，官方采用数为 null。GET `/v1/market/templates/:templateId?version=` 返回单 card。原 `/v1/templates` 保持官方目录兼容。

登录后 POST `/v1/community/requests`、GET `/v1/community/requests/:clientOpId`；动作和 DTO 以服务端 `community-contracts.ts` 严格 schema 为准。作者作品 `/v1/community/works`、单作品 `/works/:id`、申请 `/submissions/:id`；审核列表 `/review`、举报 `/reports` 均限审核角色。公开资格 `/v1/creation/templates/:id/publication-eligibility?version=` 返回 canPublish/reason。

升级预览 GET `/v1/plans/:id/community-upgrade?targetVersion=` 返回 current/next 定义、changes 文本列表、expectedVersion/currentTemplateVersion/compatible。操作 action `upgrade_community_template` 带 planId/targetVersion/expectedVersion；不兼容明确拒绝，不存在自动迁移。消息定位 GET `/v1/messages/:id` 返回本人 MessageView。

反馈 POST `/v1/feedback/requests`，GET 同路径加 clientOpId 核对；create 只含用户预览确认的 description 及可选诊断 route/version；update 仅审核者可处理状态和回复。用户读取自己的工单，审核者读取处理队列；不得自动提交对话、记录、邮箱或凭据。反馈按用户删除，恢复副本随其工单一并删除。

可见页面每 15 秒核对账户 dataVersion/today；版本或日期变化刷新业务，消息单独刷新；隐藏/离线停止，失败退避，重新联网/前台刷新。待核对请求仍只存当前账户一条，原 ID 和原内容重试；冲突保留用户输入并展示最新值，不能自动覆盖。退出/删号前先处理待核对内容。

## 本次部署边界

用户指定服务器与 Cloudflare 管理的 clyna.ai，允许在该目标准备网页/API同源部署。现有 planplan API 和 law-rag 服务保持独立；网页采用独立进程、数据目录/数据库及配置。部署资源、源码候选、备份/回滚、邮件、告知、真实 HTTPS 和真人试用分别验收。任何未具备的项保留未完成，不用本机模拟替代。
