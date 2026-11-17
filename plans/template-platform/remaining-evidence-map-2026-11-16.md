# T01–T45 证据核对（2026-11-16）

本表核对的是本轮功能修复前的证据基线，后续增量验收单独记录。132前端为66协议/公开页＋66实际本地API；不是132生产测试。PG17/目标PG15各601是不同环境运行，不拼成1202独立案例。公网/源站匿名各135不包含认证Cookie/CSRF。旧 S2 七模型请求不替代当前 v2 评测；本轮模型最新结果以 [AI 评测记录](platform-ai-evaluation-2026-11-16.md) 为准。

“技术已证”允许更新实现/本机验收记录；存在生产、AI、硬件或真人子场景时，不应将整个T编号或版本门槛勾完。

| 编号 | 现状 | 直接证据 | 剩余范围 |
|---|---|---|---|
| T01 | 技术已证 | templates/generic/template-api；132浏览器+601后端；公网三模板目录与饮水采用 | 公网三类全部初始化可用QA补烟测；真机另属T43 |
| T02 | 技术已证 | generic-templates/ledger-water-api/engine；generic和functionality真实浏览器 | 生产QA记账20→25→20/ZIP可补；不使用真实用户数据 |
| T03 | 技术已证 | templates/domain/reading-chat；templates实际表单累计/修改/归档 | 真实模型整体质量另属T40/41，不能由领域通过代替 |
| T04 | 部分：AI子场景待 | generic-templates/generic-chat+generic浏览器800/40%；公网250/2000已证 | 真实0.5L/一杯澄清的当前模型证据需T41补，整项不以受控响应代替 |
| T05 | 技术已证 | platform-api/generic-v2-domain；platform-live显式默认、零事实、pending | 生产QA可补取消/刷新不复制实例 |
| T06 | 部分：时间/硬件待 | 双浏览器深链历史；本机重启新登录和6条记录深比；公网刷新/重置后保留 | 浏览器跨时区、跨午夜无写入/原请求时间专项；真机周期变更未证 |
| T07 | 技术已证 | generic-templates/engine；templates/generic真实归档恢复/唯一记账复用 | 生产QA可补，不能当真人多次使用 |
| T08 | 部分：AI待 | creation-ai/api/evaluation；既有部分真实创作和旧 S2 七调用 | 当前固定集人工审定、失败和未调用病例复验；不能整体勾选 |
| T09 | 部分：AI待 | creation-domain+creation浏览器手动修改/稳定ID/撤回 | 当前模型多轮修改语义验证未齐 |
| T10 | 技术已证 | creation-domain/API+creation八类型控件保存编辑删除导出；重启字段ID深比 | 真实手机控件/输入法归T43 |
| T11 | 技术已证 | generic-v2-domain/platform-api+platform-live周月分母分类趋势/目标 | 模型生成定义的统计语义归T40/41 |
| T12 | 技术已证 | creation/generic浏览器预览增改删切日零业务写入；ZIP/正式队列隔离 | 可用现有最终日志收尾旧索引的待补备注 |
| T13 | 技术已证 | creation-api同ID/跨进程lookup；creation浏览器丢响应/真实保存采用 | 生产恢复链可专用QA补，不复用真实用户会话 |
| T14 | 技术已证；生产待 | creation-api拒跨账户；creation实际A/B；601含私人列表/读取/派生 | 生产独立QA A/B猜ID、列表、深链、导出检查 |
| T15 | 技术已证 | community-domain合成公开示例/hash/defaults；platform-live预览提审 | 独立创作者理解公开内容归T44/45；如生产发布测试要明确授权清理 |
| T16 | 技术已证；生产待 | community-domain/platform-api权限状态机；platform-live审核/历史 | 专用正常注册reviewer生产提审/拒绝/回复；禁止DBseed登录 |
| T17 | 技术已证；生产待 | platform-api/public filters+platform-live市场详情采用；公网官方目录DYNAMIC | 生产社区内容发布/详情缓存尚缺；不以官方目录通过替代 |
| T18 | 技术已证；真人待 | community-domain两个消费者隔离；platform-live作者/消费者分账号 | 独立B/C真实任务归T45；生产QA可验证技术A/B，不能算真人试用 |
| T19 | 技术已证 | platform-api稳定ID采用；templates浏览器响应丢失；generic唯一性 | 真机弱网另验；生产QA可一次abort-response验证 |
| T20 | 技术已证；生产待 | community-domain/platform-api下架新采用拒绝；platform-live已采用可维护 | 生产社区下架/缓存刷新专项；不污染公开市场 |
| T21 | 技术已证 | community-domain兼容/破坏性拒绝；platform-live显式v1→v2保留记录 | 公网QA社区升级可独立小范围执行 |
| T22 | 部分：用户清理查询缺口 | creation-retirement8项+community-domain；platform-live删除私人来源仍可写 | 私人删除/公开解绑已有证据；账户清理只返回一次回执，刷新或响应丢失后无法查询，尚未实现。生产删除另待 |
| T23 | 技术已证；AI子场景待 | generic/creation/v2安全整数、单位、null/false/多选/范围；UI真实记录 | 当前模型原始单位语义待T40/41；硬件输入法归T43 |
| T24 | 部分：浏览器时间待 | query-periods/first-week/generic-v2/form-duplicates上海日期/原inputAt | 现有浏览器未发现timezoneId设置；补非上海时区与跨午夜协议/现实边界，不能称真机已验 |
| T25 | 技术已证 | generic-v2/platform-api+platform-live目标/建议默认和事实分离 | 未开放initial累计语义不声称支持；公网QA可核对采用零记录 |
| T26 | 技术已证 | creation/community/platform-api幂等同体异体；双浏览器保存/采用恢复 | 生产QA小批同ID重放与变体拒绝；不做压力并发 |
| T27 | 技术已证；生产待 | creation/generic/templates/platform-live真实丢响应lookup；backend批次事务 | 生产QA仅自己的反馈/记录拦截一次响应，原ID恢复一次 |
| T28 | 技术已证 | Recovery/session/chat/creation协议处理404/202/瞬时错/解码失败 | 生产不制造无边界故障；如复验仅隔离browser network route |
| T29 | 技术已证 | domain/API expectedVersion；platform-live同步409保留输入和新旧对照 | 生产QA两独立正常会话冲突一次 |
| T30 | 技术已证；生产待 | web-session/session/creation账户绑定、迟到响应；实际A/B隔离 | 生产正常邮件QA两账户同源cookie切换/队列旧expectedUser拒绝 |
| T31 | 部分：跨端待 | 共享恢复队列/服务端幂等/批次撤销/删除失效的601与浏览器协议 | 实际两设备/iOS跨端未证；生产logout/delete会话失效待专用QA |
| T32 | 技术已证 | 受控模型失败/取消；132中无AI手动采用/配置/八字段/纠错 | 公网用户未启AI已手动成功；本批QA保持aiConsent=false、无模型调用 |
| T33 | 部分：旧iOS待 | legacy study/ledger真实浏览器＋601旧协议/查询/迁移保留 | 真实旧iOS客户端及Web同账户交替读写未验 |
| T34 | 部分：导出已证，清理查询未实现 | 两浏览器实际ZIP和新登录后ZIP；公网用户真实11条目ZIP | 刷新后的账户清理状态查询未实现；生产专用账户删除、独立删除清单与删除后恢复待验 |
| T35 | 部分：规模/手机待 | generic历史分页/换计划清输入；platform-api市场分页；平台visible sync | 大数据浏览器滚动/返回及真实手机内存未证，可先做本地受控专项 |
| T36 | 技术已证；生产认证待 | web-session/runtime-secrets/creation/platform-api；源站与公网135匿名各过 | 实际Set-Cookie wire、认证CSRF good/bad、真实A/B、生产日志最小化补证 |
| T37 | 部分：回滚待 | M17旧37表保护/50表本机恢复；PG17+PG15 601；正式首发和含用户在线恢复 | 不同兼容候选受控回滚、真实删除后恢复和异地副本未验 |
| T38 | 部分：旧iOS待 | platform-api旧cap拒绝v2写/回放；creation/generic未知结构保留成功 | 真实旧iOS未知模板显示及只读行为待验 |
| T39 | 部分：真实注入待 | creation/community定义约束+预览零写；公网CSP；部分AI运行器自检 | 当前真实模型注入病例未齐；生产QA私有文本HTML渲染/无外发可补，禁止真实恶意外站 |
| T40 | 未通过 | 固定基础330和创作20集存在；领域运行器自检/601通过 | 固定集仍draft需人工审定；历史基础181/330、创作9/20仅为当时结果；当前复跑由AI专项记录，不删除失败分母 |
| T41 | 未齐 | 旧S2七次、历史部分创作、单次UI10分钟来源消息 | 当前供应商三官方+单位澄清+创作修改闭环+社区B实例独立真实调用，需独立授权配额 |
| T42 | 部分：真实完整评测待 | creation-api迟到取消/恢复、provider-wait-recovery；浏览器原ID | 真实C020未齐；prompt改后完整固定评测按原分母重跑 |
| T43 | 部分：真机待 | Chromium/WebKit各66；320/375/390/800视口与runtime0截图 | 真实iPhone Safari/Android Chrome/桌面Safari、中文IME、200%缩放、键盘焦点/辅助技术；不可视口替代 |
| T44 | 部分：独立理解待 | foundation/creation/session/platform-v2/live深链、状态、回执定位与恢复 | 独立使用者能判断模板/预览/计划/事实及错误状态；生产QA仅补技术路径 |
| T45 | 未执行：真人 | 无独立试用完成证据；不能把用户一次注册或代理代操作计为角色试用 | 至少3创作者5使用者（角色可重叠但登记独立总人数），A→B、两次使用、匿名反馈，候选门槛先通过 |


本表“生产待”“真人待”说明证据边界，不是本轮继续账号、运维或真人任务的授权。用户已要求优先做功能，R04–R08 暂缓。本轮新增创作试填、自动示例与归档对话修复由 R11 单独验收；旧证据不能掩盖新发现的问题。

可收尾的旧索引：v0.1 手动基础操作、v0.2 七个实施包及 v0.3 前台同步/恢复具有本机实现证据；整版真人试用、跨端、生产专项不能一起勾选。模板平台 acceptance 的“全部待执行”文字已过期，准确状态以本矩阵、[最终验收](platform-final-verification-2026-11-16.md)、[前端 132 项报告](platform-frontend-qa-2026-11-16.md) 和 [本轮 TODO](../todos/2026-11-16-remaining-acceptance.md) 联合判断。
