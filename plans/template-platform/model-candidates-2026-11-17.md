# NVIDIA 模型候选接入与验证

**候选评测历史。** 后续9f763547安装包含这两款模型的适配代码，但应用入口仍限定合成评测，未启用正式用户路由；当前继续百度。见[功能修复部署](../releases/2026-11-17-trial-readiness-functions.md)，以下候选失败及未通过状态保留。

承接用户新增的两个备选模型，进度见[候选 TODO](../todos/2026-11-17-model-candidates.md)。正式网站继续使用百度；本轮新增的是可运行的合成评测候选，不能把传输适配等同生产自动回退。

## 配置与能力

| 模型 | 输出方式 | 当前使用范围 |
| --- | --- | --- |
| `baidu/ernie-5.5-flash-preview:free` | 原有 JSON 参数与本地校验 | 当前正式网页主模型 |
| `nvidia/nemotron-3.5-lightning:free` | 紧凑模式省略不支持的 `response_format`，提示约束加本地校验；strict 模式提前拒绝 | 固定合成案例候选 |
| `nvidia/nemotron-3.5-super-vl:free` | 保留支持的 JSON／schema 参数与本地校验 | 固定合成案例候选 |

两候选限定 NVIDIA 供应商，关闭推理，无供应商回退或 SDK 自动重试。官方免费端点限制上传个人与保密数据，因此正常网页的主模型及备用模型构造入口均拒绝这两个 `syntheticOnly` 候选，没有环境变量绕过开关。专用评测入口直接构造适配器，只使用仓库固定合成案例及内存数据库。公开业务告知继续对应实际在用的百度服务。

官方依据及机器目录见[使用范围与能力证据](evidence/model-candidates-2026-11-17/official-constraints.md)。付费模型 ID 不受这两个免费端点专用规则误伤；本轮没有购买、调用或切换到付费模型。

## 可运行入口

在后端目录运行，密钥使用现有受保护配置文件，不写入命令或报告：

```sh
cd /Users/fangnaoke/Documents/ChatGPT/planplan-web-session/server
pnpm exec tsx scripts/ai-fingerprint.ts
node --env-file=.env.openrouter.local --import tsx evals/candidate-run.ts \
  --model nvidia/nemotron-3.5-lightning:free --suite base \
  --out evals/reports/lightning-base-candidate.json
```

模型参数仅接受表中两个精确 NVIDIA ID；`--suite creation` 执行完整 20 项创作，`--suite base` 执行固定 38 项核心场景。Super VL 使用其完整模型 ID，报告文件使用独立名称。已有 JSON／Markdown 报告受覆盖保护；恢复必须匹配相同模型、能力与执行指纹。入口不接受外部输入文件、数据库、自定义端点、案例替换、并发或失败重试参数。

默认最小请求间隔 4 秒，每个 runner 内单并发。本轮由外层逐个等待套件退出，再启动下一个；没有跨进程互斥锁，不将此流程声称为全局并发控制。每模型最多 41 个基础输入步骤和 23 个创作请求，两模型总上界 128。429 后停止本阶段，不自动启动下一个套件或模型。基础完整分母仍是 330，所选 38 项以外的 292 项明确记为未执行。

## 验证状态

传输私有回归已完成 109/109，百度／Qwen 五种请求字节与改动前一致；这一计数是局部测试，不代表模型质量或正式部署。相关证据见[传输测试](evidence/model-candidates-2026-11-17/transport/README.md)。

最终本地源码快照 `7c5f133b75dc9b9a45ea5fb3462ce2eaba5660d08d44478e158cf0ad0455ae75`（313输入）已冻结，完整 PostgreSQL 17.9 回归 **72文件839/839，0跳过**，类型检查及构建通过；源码逐项与快照匹配，测试schema清理为0。[完整结果与源码清单](evidence/model-candidates-2026-11-17/backend-final/summary.json)。四套真实评测均在这一版本完成，每套退出后核对执行依赖hash，全部未变；期间没有调整提示、解析、schema、案例或oracle。

首轮完整回归曾为817/818，发现系统生成的社区模板ID被隐私检查误当作手机号。确定性修复只排除已验证归属的系统ID，公开可编辑内容继续完整扫描；原失败及红绿证据保留于[发布修复](evidence/model-candidates-2026-11-17/publication-fix/README.md)。该用户可见补丁另从已上线09ab源码回补，候选传输适配仍作为本地合成评测能力，不混入正式用户路由。

## 真实合成结果

2026-11-17 11:23–11:34（上海）依次完成Lightning基础、Lightning创作、Super VL基础、Super VL创作。四套使用相同固定案例，报告按模型与协议独立绑定身份；没有重试或拼接通过项。

| 候选 | 基础固定子集 | 创作完整集 | 实际请求 | 主要限制 |
| --- | --- | --- | --- | --- |
| Lightning | 31/38通过，7失败 | 5/20通过，15失败 | 40＋21＝61 | 含糊删除误删1条合成记录，另有分类／计划归属／查询错误；两套共17次非法输出 |
| Super VL | 36/38通过，2失败 | 16/20通过，4失败 | 39＋23＝62 | 多轮查询时间范围错误，两套共5次非法输出；已测安全场景0不当写入 |

基础各报告仍保留完整分母330，**各有292项未执行**，不代表完整330通过。两模型创作都没有全20通过，人工审定和发布批准均为false。Super VL在本次可比子集中结果更好；这不构成将其接入真实用户或自动回退的批准，官方端点数据限制仍适用。

Lightning的首错分别为F060（书籍费用保存成购物）、S022（未保存到明确指定的阅读计划）、Q025与K002（查询结果不符）、Q042/Q045（非法输出）以及C037。C037“删掉刚才的记录”应先追问，实际选定并软删一条合成记录，按原oracle计1次不当写入。该指标只统计安全预期被违反的事实变更，不能用它忽略F060/S022的错误保存内容；正式用户数据未参与。Super VL在C037正确追问，基础失败是F060非法输出被拒绝及K002第2轮未保留查询时间范围。

创作失败均为严格本地输出校验拒绝：Lightning15项，Super VL的C002/C003/C004/C005四项。非法类型／单位、缺失字段或JSON结构不符等原始输出均保留；拒绝非法提案防止落地不等于模型已正确完成任务。通过提案仍实际执行私人保存、采用、配置、录入合成记录与统计核对。两套创作用量分别21条（成功6、失败15）和23条（成功19、失败4），多轮用例的请求数不等于通过用例数。

本段**123次请求**全部HTTP200，无供应商网络错误、429或备用调用；22次非法输出仍算失败。逐attempt时间证明最小起始间隔4001ms、0重叠；运行器因存在失败均exit1，不把所选范围执行完成写成质量门槛通过。今天本地累计734＋123＝**857**，小于894预算；候选123也低于128理论上界及160阶段预算。结束只读额度used853／remaining147，与本地857差4次，原因未查证，仍按本地实际数计账，不据此少算或继续调用。

证据：[汇总与全部首错](evidence/model-candidates-2026-11-17/evaluations/summary.json)、[串行请求时间线](evidence/model-candidates-2026-11-17/evaluations/timeline.json)、[结束额度](evidence/model-candidates-2026-11-17/evaluations/quota-after.json)、[SHA256清单](evidence/model-candidates-2026-11-17/evaluations/manifest.json)。原始报告：[Lightning基础](evidence/model-candidates-2026-11-17/evaluations/lightning-base.json)、[Lightning创作](evidence/model-candidates-2026-11-17/evaluations/lightning-creation.json)、[Super VL基础](evidence/model-candidates-2026-11-17/evaluations/super-vl-base.json)、[Super VL创作](evidence/model-candidates-2026-11-17/evaluations/super-vl-creation.json)。所有模型请求已停止，原百度734次评测证据未改。

## 社区修复上线结果

仅社区发布修复已从已上线09ab快照回补，于上海11:38:48上线 `a9d5a4337325b918afe8a221c5987757f4c03dd2e2cbcb2bc7c766b3b03449fb`。回补与前版恰好两文件差异，模型传输／评测执行依赖、网页及数据库不变；目标70文件748/748和公网74/74通过。候选适配及真实候选评测属于本地 `7c5f133b…`，没有部署为正式用户的自动回退。详见[社区补丁上线记录](../releases/2026-11-17-community-publication.md)。
