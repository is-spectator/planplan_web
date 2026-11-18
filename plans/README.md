# PlanPlan Web 版本计划

**当前代码统一在 `is-spectator/planplan_web`：网页 `src/`、后端 `server/`、部署 `deploy/`。** 默认主分支是 `main`；`planplan` 仅为参考来源。历史报告里的相邻checkout是当时记录，当前开发／PR入口以根README及[单仓交付TODO](todos/2026-11-17-single-repository.md)为准。

更新：2026-11-18（Asia/Shanghai；PR-001 已提交评审，尚未合并或部署，线上状态未改变）

**最新线上候选：功能修复9f763547已部署。** 歧义删除、创作时长、历史分页／游标及午夜提交保护已安装，并补齐部署前发现的跨类型否定删除缺口。同包目标PG15.19为861/861，公网83/83；仅更新版本配置，继续百度、无fallback。创作20/20身份一致；最终基础36通过、1非法输出、293未执行，完整及人工门槛仍未通过。主清单12/18不变，部署TODO4/4，详见[精确上线记录](releases/2026-11-17-trial-readiness-functions.md)。

**首次本地收尾记录（部署前历史）：[本轮 TODO](todos/2026-11-17-trial-readiness-functions.md) 6/6，已实现并验证，尚未部署。** 歧义删除先由服务器确认目标；创作时长类型／单位约束补齐；计划分页一致快照、聊天稳定游标和轮询前午夜提交保护已完成。后端858/858、双浏览器74项、真实本地API15项通过；百度创作20/20，最终基础关键子集38/38，完整330项尚余292项未执行。剩余免费额度40次，停止模型调用。人工审定、完整质量与部署验收仍未完成，主清单保持12/18。旧19/20、7/8及候选839项均属于此前阶段，当前以[本轮验证报告](template-platform/trial-readiness-functions-2026-11-17.md)为准，原始失败保留；当时公网为下述a9版本。

**当前开发目标：v0.4「模板创作与市场」。官方模板、私人创作、通用周期与默认值、社区发布和采用均已完成本机实现与相应技术验证。** 完成情况以 TODO 和验证证据为准，整阶段与发布验收仍保留。

**当前 TODO：[全版本继续实施](todos/2026-11-16-platform-completion.md)，进度12/18。** P06/P13真实AI质量、P15剩余账户与运维验收、P16真机跨端、P17独立试用、P18最终验收归档尚未完成。[私人创作](todos/2026-11-16-creation.md)保留9/9，[模板展示](todos/2026-11-16-template-presentation.md)保留4/4，[记账与饮水](todos/2026-11-16-ledger-water.md)保留10/10，[阅读](todos/2026-11-16.md)保留8/8；历史切片不重复累加为当前进度。

**当前优先级：先做功能。** 11月16日创作、计划内对话、退款关联及关联退款删除确认修复已上线；今天的统计、分页、跨日输入、分类查询和删除保护已实现并完成相应本地验证，跨标点漏拦也已修复；原功能版本已于11月17日上海10:18:05激活并完成公网匿名GET74/74；随后社区发布修复已上线，见下方最新状态。账号专项、异地备份和真人/设备安排暂缓，主清单保持12/18。

**此前功能批次：[11月17日计划功能 TODO](todos/2026-11-17-plan-functionality.md)，7/8，F04未完成。** F01–F03 修复范围参数、URL分页和已观测上海日期变化后的输入保留；F07修复分类查询回答。F08已补齐宽泛／多条删除及跨标点表达保护。冻结候选`09ab4038…`的后端PG17为69文件727/727、0跳过，typecheck/build与源码打包一致性通过；前端75个文件未变，保留分阶段去重224/224。最终目标PG15.19同包727/727及TLS、隔离加密恢复通过。09ab/a9历史创作完整19/20，C002非法输出严格拒绝、零写入，F04未勾；最终基础327/330、333次请求，S011/S015/G022三项供应商失败仍计入分母，0重试／非法输出／误写；原8个首错通过，原定自动门槛通过、人工及发布批准仍为false。旧基础322/330及6条合成误删、此前创作20/20均保留历史，不混用旧通过。

**此前线上版本：社区发布误拦修复。** source `a9d5a4337325b918afe8a221c5987757f4c03dd2e2cbcb2bc7c766b3b03449fb`、build `cb94054dd99334cfce077a2032f1dba394a9329028f5882ea9ea59dd0913b1db`，已于2026-11-17上海 **11:38:48** 激活。308输入、205输出，目标PG15.19同包70文件 **748/748**，TLS及隔离加密恢复通过。相对09ab只有`community.ts`与新增测试两项输入差异；先验证作品身份，再仅排除服务器生成ID的文本扫描，用户公开内容检查和确认hash保持。两份百度评测的执行依赖逐hash不变，正式模型仍为百度；27个旧immutable assets保留、数据库20源码文件及M17不变，仅RELEASE_ID更新，服务正常、测试schema为0、临时配置及swap已清理。新版本公网74/74已通过，精确a9版本、18个网页产物及官方模板核对一致，业务写入／模型／邮件调用均为0；publication-deployment的11项证据manifest已核验。见[最新发布记录](releases/2026-11-17-community-publication.md)、[确定性复现与修复证据](template-platform/evidence/model-candidates-2026-11-17/publication-fix/README.md)；下文09ab数据均保留为此前功能版本的证据。

**历史候选评测（本轮修复之前，未部署）。** 独立source `7c5f133b75dc9b9a45ea5fb3462ce2eaba5660d08d44478e158cf0ad0455ae75`，313输入，72文件 **839/839**，不是线上a9版本。Lightning基础31/38、创作5/20；Super VL基础36/38、创作16/20。基础各保留完整330分母及292项未执行；Lightning C037误删1条合成记录，Super VL已测安全场景0不当写入，均不能据此视为完整质量通过。两候选仅限合成数据，人工及生产就绪均为false；123次新调用、当天累计857次，均已结束。[候选任务](todos/2026-11-17-model-candidates.md)已5/5，仅表示接入、评测与社区误拦修复工作完成，不代表模型质量或生产准入通过。见[候选真实结果与运行边界](template-platform/model-candidates-2026-11-17.md)；[C037服务端歧义单删保护](backlog.md#已发现的功能缺陷)已由本轮U01修复并验证；以下候选评测失败不代表正式站点发生了该事件。当时主计划12/18、旧功能7/8及F04失败记录保留，账号／异地／设备／真人项继续暂缓。

产品方向：用户通过对话设计可复用模板，也可以从市场选用官方或社区模板；选用后生成私人计划，通过对话或表单设置目标、持续记录和查看结果。

## 从这里开始

| 文档 | 用途 |
| --- | --- |
| [功能修复部署 TODO](todos/2026-11-17-trial-readiness-deployment.md) | 4/4：当前线上9f763547，同包861项、公网验收通过；完整试用门槛仍保留 |
| [最新功能收尾 TODO · 11月17日](todos/2026-11-17-trial-readiness-functions.md) | 6/6：歧义删除、创作稳定性、历史与午夜保护，本地验证完成，后续部署见上行 |
| [最新功能验证报告](template-platform/trial-readiness-functions-2026-11-17.md) | 后端858项、浏览器74项、真实本地API15项；创作20/20，基础38/330已测通过 |
| [PR 任务索引](prs/README.md) | PR-001 后端 AI 失败提示已提交评审，尚未合并；PR-002 网页直接进入手动记录／编辑仍待实施。可并行，含独立 TODO、验收与 PR 描述 |
| [全版本继续实施 TODO](todos/2026-11-16-platform-completion.md) | v0.1–v0.4缺口、社区市场、扩展模板、技术验证与真实发布/试用 |
| [今日计划功能 TODO · 11月17日](todos/2026-11-17-plan-functionality.md) | 历史7/8：09ab已发布；该批C002失败保留，新修复与20/20见最新收尾报告 |
| [新增免费候选模型计划](todos/2026-11-17-model-candidates.md) | 独立后续阶段；默认仍百度，NVIDIA候选仅合成评测，不改变线上路由 |
| [社区发布修复上线](releases/2026-11-17-community-publication.md) | 当前线上a9d5a433，目标748项通过；仅回补社区误拦，百度执行依赖不变 |
| [NVIDIA候选真实结果](template-platform/model-candidates-2026-11-17.md) | 本地7c5f133b、839项；两候选质量未通过，仅合成数据，未部署 |
| [今日功能实现报告](template-platform/plan-functionality-2026-11-17.md) | F01–F04行为、证据与保留边界；发布状态单独核对 |
| [今日浏览器结果](template-platform/evidence/plan-functionality-2026-11-17/frontend/README.md) | Chromium/WebKit各112项，分阶段去重224项；真实本地API与协议测试分开 |
| [最终本地后端727项](template-platform/evidence/plan-functionality-2026-11-17/backend-final/summary.json) | 冻结候选09ab4038，69文件727/727、0跳过；716项保留为复核前历史 |
| [日期专项](template-platform/business-date-verification-2026-11-17.md) | 上海日期、跨期输入、目标复核44项及后台分页三项后续范围 |
| [分类查询与撤销夹具](template-platform/evidence/query-and-undo-2026-11-17/README.md) | F07红绿验证、四例真实聊天回执前提和版本化评测契约 |
| [对话删除保护](template-platform/evidence/chat-delete-guard-2026-11-17/README.md) | F08批量／宽泛删除零写入、旧pending、退款及恢复兼容 |
| [今日真实模型报告](template-platform/ai-functionality-2026-11-17.md) | 历史创作19/20、C002严格拒绝；最终基础327/330、3供应商失败，自动门槛通过、人工未审定；旧批次分别保留 |
| [11月17日功能发布](releases/2026-11-17-plan-functions.md) | 09ab4038已于上海10:18:05激活，目标PG15同包727项通过，公网匿名GET74/74通过 |
| [本轮功能 TODO](todos/2026-11-16-remaining-acceptance.md) | 先完成创作与计划使用卡点，账号/运维/真人安排暂缓 |
| [本轮功能发布](template-platform/function-release-2026-11-16.md) | R10/R11/R12功能、精确上线版本、目标PG15与双浏览器验收、实际激活证据 |
| [关联退款删除确认](template-platform/refund-confirmation-v1.md) | 固定确认范围、变化拒绝、旧客户端恢复及完整后端验证 |
| [R12浏览器验收](template-platform/refund-confirmation-qa-2026-11-16.md) | Chromium/WebKit各83项，共166/166；与R11历史148项分别记录 |
| [对话与退款修复](template-platform/chat-record-fixes-2026-11-16.md) | 归档范围、明确计划归属、退款关联与当前完整后端回归 |
| [创作到使用修复](template-platform/creation-refinement-qa-2026-11-16.md) | R11功能与历史148/148；不替代R12当前前端验收 |
| [11月16日模型功能跟进](template-platform/platform-ai-function-followup-2026-11-16.md) | 历史C010单次通过及当时1/20检查点，原首错保留；不代表今日状态 |
| [公网候选发布记录](releases/2026-11-16-web-beta.md) | 已安装版本、真实注册登录、部署证据与未通过门禁 |
| [目标部署验收](template-platform/platform-deployment-2026-11-16.md) | PG15、正式权限/恢复、HTTPS、续期、维护任务与剩余项 |
| [公网账户验收](todos/2026-11-16-public-account-acceptance.md) | 真实注册登录后的计划、账户与隐私检查 |
| [通用扩展与社区平台契约](template-platform/platform-contract-v2.md) | 默认值、日/周/月统计、发布审核、兼容升级、反馈与恢复 |
| [首轮平台技术验证](template-platform/platform-final-verification-2026-11-16.md) | 历史601项PG17矩阵、50表停服备份恢复、重启后重新登录核对 |
| [首轮平台浏览器归档](template-platform/platform-frontend-qa-2026-11-16.md) | 历史132个去重用例、实际导出、清理与重启验收，不代表本轮全部重跑 |
| [T01–T44证据索引](template-platform/platform-evidence-map-2026-11-16.md) | 自动化入口、实际证据及仍需独立验证的范围 |
| [首轮真实AI评测](template-platform/platform-ai-evaluation-2026-11-16.md) | 历史基础181/330与创作9/20；当前状态以上方今日模型报告为准 |
| [私人对话创作 TODO](todos/2026-11-16-creation.md) | 9项实现顺序、完成标准与实际验证 |
| [私人创作实现契约](template-platform/creation-contract-v1.md) | 草稿、模型生成、私人版本、能力、恢复与派生接口 |
| [私人创作验收](template-platform/creation-verification-2026-11-16.md) | 88项浏览器验证、后端回归、迁移与备份恢复 |
| [创作真实模型记录](template-platform/creation-real-model-2026-11-16.md) | 指定模型7次实际调用、发现与修复、计量核对 |
| [模板展示调整](todos/2026-11-16-template-presentation.md) | 样式预览、功能简介、选用入口和折叠试填 |
| [第二批 TODO · 记账与饮水](todos/2026-11-16-ledger-water.md) | 当前 10 项实施顺序、完成标准及证据 |
| [今日 TODO · 2026-11-16](todos/2026-11-16.md) | 今日实施顺序、8 项待办、逐项完成标准与证据 |
| [v0.4 模板创作与市场](v0.4-template-platform.md) | 本轮范围、产品决策、S1–S3 工作包和下一步任务 |
| [模板契约与数据](template-platform/contracts-and-data.md) | 模板、版本、计划、记录、通用字段、现有业务兼容 |
| [阅读第一批实现契约](template-platform/reading-contract-v1.md) | 已固定的实际接口、能力声明、限制、配置版本与兼容方式 |
| [记账与通用记录契约](template-platform/ledger-generic-contract-v1.md) | 本批字段、单位、预算、历史目标、API 与旧协议投影 |
| [记账与饮水验收记录](template-platform/ledger-water-verification-2026-11-16.md) | 最终回归、真实模型、问题修复、数据恢复与证据位置 |
| [对话与用户流程](template-platform/conversation-and-flows.md) | 创作、选用、初始化、记录、追问、纠正和发布 |
| [v0.4 验收](template-platform/acceptance.md) | 各阶段可执行场景、真实业务与模型验证、放行条件 |
| [实施进度](implementation.md) | 已完成事实、既有验证证据、环境与尚未完成事项 |
| [共同约定](00-foundation.md) | 全版本架构、会话、账户隔离、数据可靠性约束 |
| [共用发布清单](acceptance-and-release.md) | 外网候选环境、浏览器矩阵、备份恢复和发布记录 |
| [后续范围](backlog.md) | 尚未排期的成长、语音、协作、商业化等能力 |

## 当前事实与版本路线

当前本机功能已验证，公网 https://clyna.ai 已安装可操作候选。网页支持邮箱会话、计划与记录、退款、目标管理、导出、恢复核对和反馈。创作贯通草稿、对话/手动修改、预览试填、私人版本、采用和记录；通用计划支持八类型、日/周/月指标、分类趋势及用户明确启用的默认填写。社区作品贯通公开预览、独立审核、作者发布、市场检索、他人采用、兼容升级、举报与下架。合成公开作品已下架，保留已采用计划和历史；当前市场仅显示阅读、记账、饮水三个官方模板。详情见[实施进度](implementation.md)。

今日范围统计按API契约二选一发送单日或区间，错误后保留恢复入口；页码随URL恢复，观测业务版本变化后回首页；页面读取到上海新日期后保留草稿，目标跨实际受影响周期需重新核对。分类查询不再回答整月预算。F08针对聊天宽泛清空、多条和含删除的混合批次增加服务端保护，并补齐“所有记录，删掉”等跨标点表达。新增保护专项42/42、相关PG17套件85/85，最终 **PG17 69文件727/727、0跳过，typecheck/build通过，测试schema清零**，见[最终本地摘要](template-platform/evidence/plan-functionality-2026-11-17/backend-final/summary.json)。[716项复核前结果](template-platform/evidence/plan-functionality-2026-11-17/backend-716-pre-review/summary.json)保留历史，计数不累加。前端 **Chromium112/112、WebKit112/112，共224项去重通过**，包含每浏览器72项协议及40项真实本地API场景；阶段复用和边界见[浏览器证据](template-platform/evidence/plan-functionality-2026-11-17/frontend/README.md)。冻结候选的75个前端文件未变；224项不是新增F07/F08后台修复后全套浏览器重跑的声明。

09ab/a9历史真实创作完整结果为 **19/20、1项非法输出被严格拒绝、0误写**。执行身份一致，只续余下9项，保留C002把分钟目标生成为integer的首错，没有重跑失败来清零，F04继续未勾。最终基础327/330、333次请求，S011/S015/G022三项供应商失败仍计入分母，0重试／非法输出／误写；原8个首错通过，原定自动门槛通过、人工及发布批准仍为false。此前C012修复后20/20、23次请求仅为历史批次；旧基础 **322/330、8失败、333次请求** 中A039误删6条一次性评测库合成记录，正式用户数据未受影响，原失败报告保留。人工审定仍未完成，见[今日模型报告](template-platform/ai-functionality-2026-11-17.md)。 旧功能阶段累计734次实际请求已结束；新增候选模型另开阶段，候选runtime未部署；09ab的百度评测证据保留，社区回补a9d5a433的两份评测执行依赖逐hash相同。

此前功能版本已于 **2026-11-17上海10:18:05激活**：source `09ab4038048178f0fc4b26599420a069cfaa571800a8b2c8e504e72065baa5b0`，build `22da525a…`。307个输入、204个输出与186个后端产物已核对；目标PG15.19同包69文件727/727、TLS及隔离加密恢复通过。仅RELEASE_ID配置改变，数据库源码20文件不变、迁移保持M17，保留27个旧immutable assets；相关服务、旧8787health和8788监听正常。公网匿名GET74/74通过，精确release一致、failure为null，业务／模型／邮件写入均为0，详见[今日发布记录](releases/2026-11-17-plan-functions.md)。11月16日86c64c版本及661/166等结果保留为[历史发布证据](template-platform/function-release-2026-11-16.md)。 [公网只读结果](template-platform/evidence/plan-functionality-2026-11-17/deployment/public-functional-checks.json)及[10项部署证据manifest](template-platform/evidence/plan-functionality-2026-11-17/deployment/manifest.json)已核对，均匹配当时的09ab功能发布。

历史平台候选保留PG17/目标PG15各601项、双浏览器132项、迁移17的50表恢复、源站/公网匿名各135项、HTTPS续期和维护任务证据。真实收件注册登录、密码重置及旧会话失效已验证，见[既有候选发布记录](releases/2026-11-16-web-beta.md)。完整Cookie/CSRF、公网反馈/删除、异地与回滚、真机跨端和独立试用仍未完成，按用户要求暂缓安排。

| 版本 | 能力范围 | 当前状态 |
| --- | --- | --- |
| [v0.1 首次可用](v0.1-first-use.md) | 账户、对话记账、查看、纠错和恢复 | 本机主链路已实现；发布验收未完成 |
| [v0.2 日常管理](v0.2-daily-use.md) | 学习、退款、历史周期、目标与计划管理 | 目标设置、分类/负值趋势及计划管理已实现并完成本机回归；完整版本及连续试用验收保留 |
| [v0.3 基础 MVP 验收](v0.3-mvp-release.md) | 跨端、恢复、手机体验、试用与发布验证 | 版本/日期刷新、恢复中心、冲突对照和反馈已本机验证；真机跨端、独立试用与发布验收保留 |
| [v0.4 模板创作与市场](v0.4-template-platform.md) | 官方模板闭环 → 私人对话创作 → 社区模板市场 | S1–S3本机功能及对应技术验证已完成；真实AI、阶段总体验收与发布门槛保留 |

版本编号用于组织能力与验收，不表示已经发布了对应版本。按本次安排，可直接推进 v0.4 本地开发；v0.1–v0.3 的基础验收和发布缺口继续保留，不自动勾选完成。对外开放任何候选版，均须通过适用的基础门槛和该版新增验收。

原 backlog 中“候选 v0.4 成长反馈”调整为未排期事项；v0.4 编号现用于模板平台。

## 实施顺序

1. 保留主清单12/18、历史证据、未提交修改与用户数据，按[本轮功能 TODO](todos/2026-11-16-remaining-acceptance.md)逐项验证后勾选。
2. R10–R12已完成本轮双浏览器、目标PG15、安装激活及公网只读核对，保留精确版本和历史证据，不扩大为全版本门槛完成。
3. **P06/P13保持未完成。** 当前创作19/20、C002非法定义严格拒绝零写入，F04未勾；最终基础327/330、3供应商失败，原定自动门槛通过、人工及发布批准未通过。此前创作20/20与旧基础322/330及6条合成误删分别保留。保留首错和完整分母，不用修复后的本地测试代替模型质量，不混用版本；人工审定仍独立保留。
4. **P15/P16/P17暂缓新增安排。** 账号专项、异地备份/回滚、真机跨端与独立试用缺项继续登记，不作为当前功能工作的前置询问。
5. **P18保持未完成。** 候选上线、模型门槛、真实设备和独立试用分别记录，满足对应条件后再勾选；不以部署成功代替整体验收。

## 文档维护约定

- `implementation.md` 只写已经发生且可核对的实现和测试事实；版本文件写范围、工作包与尚待完成的验收。
- 勾选 `[x]` 必须有对应证据。仅完成部分子能力的工作包保持未完成，并说明剩余内容。
- `todos/YYYY-MM-DD.md` 记录每日实施切片；代码与相关验证都完成后立即勾选对应项，补充证据并同步本页进度。每日清单完成不等于整个阶段完成；未完成项保留状态，续排时链接原项。
- v0.4 的新增范围以总计划及 `template-platform/` 为准；旧版本的可靠性、隐私和部署要求继续有效。
- 用户数据、密码、模型密钥和完整邀请名单不写入规划。试用规模是提议，不代表已有外部用户。
- 本地功能实现与对外发布分别记录；受邀用户环境仍沿用最多20个邮箱的现有配置，开放注册另行规划。

## 仓库边界与依据

`is-spectator/planplan_web` 是当前唯一开发、PR 与部署仓库：浏览器前端在 `src/`，业务后端在 `server/`，部署工具在 `deploy/`，主分支为 `main`。历史报告中的 `planplan/server` 或相邻 `planplan-web-session` 是迁移前的来源与验证路径，不是新任务的工作目录；当前交付依据见[单仓交付记录](todos/2026-11-17-single-repository.md)。

初始业务依据为 `is-spectator/planplan` 提交 [`1fc1bc5136af4f4e69cc81ef74863fbe34b208d2`](https://github.com/is-spectator/planplan/tree/1fc1bc5136af4f4e69cc81ef74863fbe34b208d2)，后续已有本地会话及模型适配。实施新工作包前核对当前文件和未提交改动，保留既有数据及已工作的业务。
