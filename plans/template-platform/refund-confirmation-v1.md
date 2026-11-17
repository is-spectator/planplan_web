# 关联退款删除确认 v1

2026-11-16，R12。删除原支出时，确认内容必须覆盖实际将一并删除的退款。此次不改变退款父记录版本，不修改撤销步骤，不新增迁移或客户端能力标记。真实模型调用为 0。

## 协议与行为

`GET /v1/records/:id` 新增 `refundSnapshot: { token, count, totalCents } | null`。原支出始终返回对象，零退款也返回快照；其他记录返回 `null`。原记录、有效退款集合、笔数与总额来自同一条 SQL 的一致快照，所有权校验保持在服务端。

`delete_record` 新增可选 `expectedRefundSnapshot`。token 格式为 `refunds-v1:` 加 64 位 SHA-256；摘要包括原支出 ID/版本以及按 ID 排序的每条有效退款 ID/版本/金额。它是相等性前置条件，不是授权凭据；响应不列出退款成员 ID。只比较总额或笔数不足以识别同金额替换，因此不采用该做法。

网页应固定打开确认时的原记录版本和关联快照，展示笔数与总额。后台刷新不得替换已打开确认中的快照。原来零退款时也传入 token，避免确认后新增退款漏过检查。

执行顺序为：验证请求身份与原请求一致性，查已保存成功回执；仅未成功执行的新请求进入现有用户锁事务，核对原记录版本与退款快照，再整批软删除。集合变化返回 HTTP 409 `version_conflict`，附最新 `record` 与 `refundSnapshot`；整个业务事务回滚。成功请求的原 `clientOpId` 可以恢复原回执，即使随后已删除、撤销或改变退款集合。

对话在提出删除问题时把 token 存入服务端 pending 的选项补丁；选择按钮只引用该保存的选项，模型不能生成确认凭据。选择后集合变化时重新展示当前笔数/金额，不执行删除。若变化发生在对话解析完成和执行取得用户锁之间，引擎仍拒绝旧快照；现有对话错误卡提示冲突，用户需要重新发起删除。这一分支不自动继续原删除。

## 旧客户端与恢复

- API 字段保持可选，使历史已成功的旧请求可以按原 ID 恢复。
- 新执行的 `includeRefunds:true` 若缺 token，返回 HTTP 409 `refund_confirmation_required`。提示在新版网页刷新后重新核对，或先逐笔删除退款，再删除原支出。
- 旧普通非级联删除继续有效；有退款时仍返回 `has_refunds`，不会自动扩大删除范围。
- 旧未执行队列不补 token；旧 pending 的 `__with_refunds__` 标记也只触发重新确认。模型直接产生该标记不能绕过确认。
- 原软删除、整次撤销及逐条撤销机制保持不变。可撤销性不作为替代事前确认的依据。

## 本地验证

新增 `refund-snapshot.test.ts` 18 项，PostgreSQL 17 专项全部通过。与既有 usage 回归合跑为 27/27，通过日志见[定向验证](evidence/refund-confirmation-2026-11-16/postgres17-targeted.log)。覆盖：

- 同一次读取、所有权与成员 ID 不外露；零退款变为有退款。
- 新增、金额/日期/备注修改、删除、撤销删除、撤销新增、笔数及总额相同但退款 ID 被替换。
- 冲突时同批前序写入一起回滚；退款变化不提升父支出版本。
- 新确认成功、整次撤销、原成功请求恢复；历史无请求 hash 的旧回执恢复与未执行旧队列拒绝。
- HTTP 详情/409/无权限和对话重新确认；旧 pending 与模型伪造旧确认标记。
- PostgreSQL 并发测试先观察 `pg_locks` 中删除事务真实等待持锁写入事务，再提交新增退款，验证旧确认冲突且原支出保留。

完整 PGlite 已通过：**66 文件，659 通过、2 项 PostgreSQL 专用跳过，共 661 项，122.77 秒**。见[完整日志](evidence/refund-confirmation-2026-11-16/pglite-full.log)与[脱敏摘要及源码 hash](evidence/refund-confirmation-2026-11-16/summary.json)。10 个 R12 后端源码/测试文件的 hash 核对一致。

独立完整 PostgreSQL 17 已通过：**66 文件，661/661，0 跳过/失败，47.08 秒**；类型检查、构建与 diff 检查通过。185 个后端源码/测试文件的聚合 hash 在验证前后一致，隔离测试 schema 清零。见[完整日志](evidence/refund-confirmation-2026-11-16/postgres17-full.log)、[逐文件摘要](evidence/refund-confirmation-2026-11-16/postgres17-full-summary.json)与[证据文件 hash](evidence/refund-confirmation-2026-11-16/manifest.json)。独立代码审阅未发现阻断问题。

网页实际交互与目标服务器新候选验收另行登记。前一候选的 643 项测试不作为 R12 的最终验证结果。
