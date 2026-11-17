# 2026-11-17 模型备选 TODO

用户在计划功能上线后新增两个备选：`nvidia/nemotron-3.5-lightning:free`、`nvidia/nemotron-3.5-super-vl:free`。继续先列 TODO，完成并验证一项再勾选。

前一功能版本已经上线，完整结果见[计划功能 TODO](2026-11-17-plan-functionality.md)及[上线记录](../releases/2026-11-17-plan-functions.md)。新增候选单独记录，不覆盖百度的已完成评测，也不把不同模型结果拼接成通过。

## 执行清单

- [x] M01 · 已核对两个精确模型ID、输入/输出token零价格与输出参数，实际供应商nvidia；Lightning端点nvidia/nvfp4、Super VL端点nvidia，二者均可关闭推理。官方数据限制与原始目录已归档并核对：[能力证据](../template-platform/evidence/model-candidates-2026-11-17/official-constraints.md)、[目录与端点校验表](../template-platform/evidence/model-candidates-2026-11-17/catalog-manifest.json)。当前默认仍为百度，候选能力用于服务端配置与合成评测入口。
- [x] M02 · 已完成并验证候选传输适配及执行边界。Lightning 紧凑模式省略不支持的 `response_format`，本地 JSON／领域校验保持严格；不支持的 strict 模式明确拒绝。Super VL 使用支持的结构化输出。普通网页运行入口拒绝这两个仅限合成验证的候选；专用评测入口可运行。已验证百度/Qwen五种请求字节不变、无自动重试／隐式回退、错误提案零写入。最终整合PG17 72文件839/839、0跳过，类型与构建通过；[传输证据](../template-platform/evidence/model-candidates-2026-11-17/transport/README.md)、[完整回归](../template-platform/evidence/model-candidates-2026-11-17/backend-final/summary.json)。
- [x] M03 · 已完成专用合成入口及四套真实评测：Lightning基础31/38、创作5/20，Super VL基础36/38、创作16/20；123次请求，无重试／备用调用。Lightning的C037含糊删除误删1条合成记录，另有分类／计划归属和查询错误；Super VL仍有非法输出与多轮查询错误。所有首错保留，非法定义严格拒绝。基础各报告完整分母330、292未执行；创作完整20均未全过，人工与发布门槛未通过。[真实结果](../template-platform/model-candidates-2026-11-17.md#真实合成结果)、[原始汇总](../template-platform/evidence/model-candidates-2026-11-17/evaluations/summary.json)。本项完成表示已验证并明确比较，不是候选通过上线质量门槛。
- [x] M04 · 已完成类型／构建与72文件839/839完整后端回归、源快照匹配、CLI配置示例及结果归档。正式站点保留已验收百度配置，候选适配不冒充已启用自动故障切换；人工质量门槛与端点数据限制单列。

- [x] M05 · 已修复并上线整合回归发现的社区提交误拦。首轮818项为817通过、1项发布提交返回私人信息422，预览曾成功；固定生成UUID确定性复现，修复四阶段仅排除已校验归属的系统模板ID，保留真实邮箱／电话／地址／密钥／链接保护及完整hash。仅两文件从已上线09ab回补，目标PG15同包70文件748/748，11:38:48激活a9d5a433，公网74/74；NVIDIA候选代码不进入正式用户路由。详见[补丁上线记录](../releases/2026-11-17-community-publication.md)。[原完整结果](../template-platform/evidence/model-candidates-2026-11-17/full-before-publication-fix/summary.json)。

## 已核实的范围

[OpenRouter 模型目录](https://openrouter.ai/api/v1/models)当前列出这两个 ID，输入／输出 token 价格为 0。Lightning 的 `supported_parameters` 不包含 `response_format`，Super VL 包含该参数及结构化输出。

两个官方免费端点页面明确要求不上传个人或保密数据。因此本轮使用固定合成场景和一次性内存数据库，不把正式用户的记录或创作输入交给这些候选。此限制来自[Lightning 官方页面](https://openrouter.ai/nvidia/nemotron-3.5-lightning:free)及[Super VL 官方页面](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free)，不是把新增模型误当作需要重新申请用户授权。

## 请求预算与统计

前一阶段本地真实调用共 **734** 次，已完整停止；10:47:42 只读额度查询返回剩 268，本地按剩 266 保守计算。新增候选阶段最多 **160** 次，今日总上限 **894**；单并发、无自动重试、无付费模型、429 停止全部候选调用。已固定每模型38项基础子集（最多41输入步）＋完整20项创作（最多23请求），两模型上界128，小于本段160总预算；实际请求最小间隔4秒。基础报告保留330完整分母及292项未执行，报告记录实际消耗。

最终候选实际123次，今日本地累计857≤894；全部HTTP200，22次非法输出仍计失败，无429／网络服务失败，最短起始间隔4001ms、0请求重叠。结束额度used853／remaining147，与本地差4次原因未证实，不据此减少计数。[时间线与额度证据](../template-platform/evidence/model-candidates-2026-11-17/evaluations/manifest.json)。四套已完整退出，没有启动后续模型请求。

当前 **5/5**（完成接入、限定评测和发布误拦修复工作，不代表两模型达到生产质量或完整330门槛）。M03的真实验证已完成，但结果未满足完整上线质量门槛；M04/M05单独验收。
