# 2026-11-17 计划功能更新

> 本文记录10:18功能版本。11:38已追加仅社区发布误拦修复，最新部署见[社区补丁记录](2026-11-17-community-publication.md)，原模型与前端结果保留原身份。

状态：**已于上海时间 10:18:05 上线 [clyna.ai](https://clyna.ai)，公网 74/74 检查通过；完整模型评测已收齐，完整发布门禁未通过。**沿用已获授权的网页内测部署范围，不扩大邀请；账号专项、异地备份和真人设备安排按用户要求暂缓。

## 本轮用户可见改进

- 饮水和自建计划可按日、周、月查看所选范围统计，读取失败后仍可切回或重试；范围、目标和空记录文案准确。
- 历史记录页码随网址保存，返回、前进、刷新和关闭详情保持正确位置；切换周期与数据更新后调整页码。
- 上海跨日更新统计时保留尚未提交的输入；目标设置跨实际受影响周期时显示日期并要求重新核对。
- 对话查询购物／餐饮等分类时按该分类回答，不再误用整月总额。
- 服务端拒绝宽泛清空、多条删除和混合写入，不把模型最近记录列表当成全部授权；单条明确删除、关联退款确认与旧请求恢复保留。
- 创作时计量含义不清先澄清；不把未确认的杯量转换改成双填模板。无效模型输出继续拒绝，不保存错误定义。

实现、局限及原失败见[功能报告](../template-platform/plan-functionality-2026-11-17.md)，逐项勾选见[今日 TODO](../todos/2026-11-17-plan-functionality.md)。

## 精确候选与证据

| 项目 | 结果 |
| --- | --- |
| 源码身份 | `source-sha256:09ab4038048178f0fc4b26599420a069cfaa571800a8b2c8e504e72065baa5b0`，307 个输入；精确未提交快照，不是 Git commit |
| 归档 SHA-256 | `6a81138b3ec1fc7398df6cc577025d6822528cb44584847b72bc35af68da9b04` |
| Linux 构建 | `22da525acc1477b8c97fa619f96547d64bbf6915f4ff12cb4dc8cda6e95d6c86`，204 个输出（186 server、18 web） |
| 本地后端 | PostgreSQL 17.9，69 文件 727/727，0 跳过；类型检查、构建通过，测试 schema 0 |
| 浏览器 | Chromium 112/112、WebKit 112/112，共 224 个独立测试；75 个最终前端源码文件与已验版本一致 |
| 目标 PostgreSQL 15.19 | 同一候选 69 文件 727/727，0 跳过；验证 TLS、拒绝明文及未知 CA、运行连接 TLS、隔离加密恢复通过 |
| 公网部署及 GET 验证 | 上海 10:18:05 激活；74/74 匿名 GET 通过，精确 release、18 个网页文件字节和官方模板可读；0 业务写入、模型及邮件调用 |
| 真实模型 | 基础327/330、3次服务失败、0未执行/错写，查询55/55，原基础自动门槛通过；创作19/20、1非法输出严格拒绝、0错写，创作自动门槛及两组人工审定未通过 |

浏览器结果包含受控协议和本地实际 API，两者分别记录；不是实体手机或独立真人试用。新版创作执行指纹与中止检查点一致，因此只续未执行项，保留已经发生的 C002 非法输出首错，不重复跑已通过项或失败项来清零。

证据：[后端完整验证](../template-platform/evidence/plan-functionality-2026-11-17/backend-final/summary.json)、[浏览器分阶段结果](../template-platform/evidence/plan-functionality-2026-11-17/frontend/results.json)、[源码 manifest](../template-platform/evidence/plan-functionality-2026-11-17/deployment/source-manifest.json)、[构建 manifest](../template-platform/evidence/plan-functionality-2026-11-17/deployment/build-manifest.json)、[真实模型报告](../template-platform/ai-functionality-2026-11-17.md)。

部署前由 root 逐个验证 307 个输入和 204 个产物；同一构建完成目标环境全量测试。数据库 20 个源码文件及 M17 与前版一致，只执行只读迁移兼容检查，没有新增迁移；运行配置仅改变 `RELEASE_ID`。旧版 27 个不可变静态资源保留供已打开页面读取。网页、PostgreSQL、nginx 与原服务保持正常。

上线后剩余测试 schema 为 0；测试配置副本、临时 swap 已清理，swappiness 恢复 0。三类合成本地浏览器会话已退出，7 个认证状态文件与临时 WebKit 复制目录已清理；用户既有会话不计为清理目标。没有执行实际生产回滚或真实账户删除验收。

部署证据：[逐文件核验](../template-platform/evidence/plan-functionality-2026-11-17/deployment/release-validation.json)、[目标全量用例](../template-platform/evidence/plan-functionality-2026-11-17/deployment/target-tests.json)、[激活结果](../template-platform/evidence/plan-functionality-2026-11-17/deployment/activation.json)、[公网结果](../template-platform/evidence/plan-functionality-2026-11-17/deployment/public-functional-checks.json)、[运行配置与清理](../template-platform/evidence/plan-functionality-2026-11-17/deployment/post-deploy-checks.json)、[10 项证据校验表](../template-platform/evidence/plan-functionality-2026-11-17/deployment/manifest.json)。

## 保留的边界

主计划仍为 12/18，不将功能补丁等同完整发布门禁通过。真实模型自动结果和人工审定分开；账号、异地备份、真实设备及持续试用仍未完成。跨日目标复核依赖页面观测到服务器日期，后台 OFFSET 并发快照、学习历史服务端分页和聊天稳定游标另有后续事项，见功能报告。
