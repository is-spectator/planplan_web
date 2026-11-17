# 2026-11-17 社区模板发布修复

状态：**已于上海11:38:48上线 [clyna.ai](https://clyna.ai)，目标完整回归748/748、公网匿名GET74/74通过。**

完整回归发现社区模板预览成功后，提交偶尔被私人信息检查误拦。确定性复现表明，服务器生成的模板 UUID 可能包含手机号形状的数字；提交、审核和发布扫描整个对象时，把该系统编号也当作了用户内容。

修复统一四阶段的公开内容检查：先确认模板编号和来源与当前作品匹配，只从内容扫描中排除这一项服务器编号；所有其他用户可控值继续使用原检查规则，完整公开确认 hash 仍包含编号。固定编号的 HTTP 预览→提交→审核→发布→公开读取通过，真实邮箱、电话、地址、密钥、链接及字段／默认值保护保留。

## 回补范围

本候选从已上线 `09ab4038048178f0fc4b26599420a069cfaa571800a8b2c8e504e72065baa5b0` 的精确源快照产生，只有两项输入差异：`server/src/services/community.ts` 和新增 `server/test/community-privacy.test.ts`。网页、模型传输、评测执行依赖、配置及数据库源码保持原值；NVIDIA 候选适配属于另一份本地合成评测源码，不混入正式用户路由。

| 项目 | 精确值 |
| --- | --- |
| 回补源码 | `source-sha256:a9d5a4337325b918afe8a221c5987757f4c03dd2e2cbcb2bc7c766b3b03449fb`，308 个输入 |
| 归档 SHA-256 | `a9a600ea5bafb33e33f59e7609e14c00ef5ae2fcfb10f87eff3d9250ab322c09` |
| Linux 构建 | `cb94054dd99334cfce077a2032f1dba394a9329028f5882ea9ea59dd0913b1db`，205 个输出 |
| 修复专项 | PG17、PGlite 各43/43；原确定性红测19/21保留 |
| 主工作目录完整回归 | 含候选适配的独立源码 `7c5f133b…`，72文件839/839；不能代替此回补包的目标验证 |
| 回补包目标环境 | PostgreSQL 15.19，70文件748/748、0跳过，TLS正向／负向、运行连接及隔离加密恢复通过 |
| 激活与公网 | 11:38:48激活；74/74匿名GET通过，精确release、18网页产物与官方模板可读；零业务写入、模型及邮件调用 |

原817/818失败报告未保存当时的随机编号，不能声称已还原该编号；本修复依据相同调用路径的固定编号复现。原失败与复现证据见[修复记录](../template-platform/evidence/model-candidates-2026-11-17/publication-fix/README.md)。

两份已完成百度模型报告的执行依赖逐文件与回补快照一致，保留原327/330、19/20及其失败，不声称重新进行了模型请求；见[范围核对](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/scope-validation.json)。主计划仍12/18，完整人工质量、设备和持续试用门槛没有由此通过。

上线后网页/PG/nginx和原服务正常，运行配置仅变更RELEASE_ID；M17和20个数据库源码不变，保留27个已核验旧静态资源。剩余测试schema0、测试配置副本与swap已清理、swappiness0，部署SSH会话已关闭；未执行实际回滚或新的账号验收。

部署证据：[11项校验表](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/manifest.json)、[逐文件版本核验](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/release-validation.json)、[目标全量用例](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/target-tests.json)、[公网检查](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/public-functional-checks.json)、[激活与清理](../template-platform/evidence/model-candidates-2026-11-17/publication-deployment/post-deploy-checks.json)。
