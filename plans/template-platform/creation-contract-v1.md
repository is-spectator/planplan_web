# 私人创作实现契约 v1

2026-11-16冻结；对应[创作TODO](../todos/2026-11-16-creation.md)。

## 边界

生成结果仅为generic声明式定义。服务端注入`id/version/source=private/engine=generic/requiredCapabilities`与作者；不信任模型提供身份。能力`private-template-v1`与`generic-record-v1`同时声明；官方已有版本不改。旧端不读取或编辑私人定义，既有已成功操作通过兼容投影显示已保存事实。

字段开放text/integer/date/duration/money/single_select/multi_select/boolean；decimal不开放。name/startDate为固定配置字段，date为固定记录日期。分钟与人民币分为安全整数，单位仅已有合法单位；多选无重复且只接受定义中的选项。目标与事实分离，按日统计，字段/单位/指标引用由服务端校验。边界与数量上限由领域校验和客户端共同实现。旧字段ID不复用于另一含义；改类型/单位需新字段及明确影响说明。

本批没有默认初始化值机制，`example.config`只供预览，选用后目标仍需填写。明确要求默认值时创作助手先说明限制并询问是否接受单独设置；不能把示例值冒充已经实现的默认设置。对用户展示分钟、毫升、元、是/否等可读值，内部规范单位只在协议/存储使用。

## 创作请求

独立端点`POST /v1/creation/requests`，共享浏览器恢复队列，`kind=creation`。请求含`clientOpId`（UUID）、`action`和适用参数：

| action | 参数 | 结果 |
| --- | --- | --- |
| create | 无 | 新建空草稿，不调用模型 |
| fork | sourceTemplateId+sourceTemplateVersion，或sourcePlanId | 仅复制有权访问的定义；保留原计划版本供后续明确应用 |
| message | draftId、expectedVersion、text | 独立模型生成或澄清，只更新草稿 |
| update | draftId、expectedVersion、definition | 手动确认定义，完整服务端校验 |
| undo | draftId、expectedVersion | 恢复上一份可撤回定义，仍增加版本 |
| save | draftId、expectedVersion | 保存新的不可变私人版本；相同定义不重复造版本 |

`CreationDraft`：`id, version, name, definition|null, messages[{id,role,text,createdAt}], changeSummary:string[], canUndo, savedTemplate:{id,version,name}|null, sourcePlanId|null, sourcePlanVersion:number|null, createdAt, updatedAt`。`version`是乐观锁版本，保存新定义/撤回会增加版本；原样重复保存复用已有版本。修改后`savedTemplate=null`，之前已保存版本仍在私人作品中。消息与修订由服务器持久化，模型只接收当前草稿和同草稿有界历史。

每条输入最长2000字，每草稿最多100条对话消息；超限在调用模型前拒绝。整句“取消”由服务端确定处理，不调用模型、不改定义；后续生成忽略取消之前的需求/澄清上下文，完整对话仍供用户查看。针对字段的“取消备注字段”等修改继续交给模型。目标进度引用的整数目标必须声明`min>=1`。

成功结果`CreationResult={clientOpId, kind:action, draft, transient:false}`；明确未完成的模型失败可返回`{clientOpId,kind:'message',draft,transient:true,message}`，原请求身份保留供用户重试。查询`GET /v1/creation/requests/:clientOpId`返回`{status:'succeeded',result}`、`{status:'processing'}`或`{status:'not_found'}`。处理中查询不调用模型；同ID异体拒绝。未知结果不当失败、不换ID自动重发。

生成期间不持有数据库锁；落库前重新检查账户状态、AI授权、草稿版本及请求持有权。崩溃后的过期处理中请求须用持久租约/栅栏安全恢复，晚到模型结果不得覆盖后来状态。

## 读取、选用与应用

- `GET /v1/creation/drafts?limit=20&offset=0` → `{drafts,total}`；`GET /v1/creation/drafts/:id` → `CreationDraft`。
- `GET /v1/creation/templates?limit=20&offset=0` → `{templates,total}`；每项`{id,version,name,description,draftId,updatedAt}`。
- `GET /v1/creation/templates/:id?version=N` → `TemplateDefinition`，仅作者可读；公共`/v1/templates`继续只列官方模板。
- 采用私人模板沿用`adopt_template`及原操作核对，显式固定`templateVersion`；`templatePlan.source`和definition.source新增private。
- 已有generic计划通过创作fork后保存私人版本；明确确认后提交`apply_private_template{planId,templateId,templateVersion,expectedVersion}`，expectedVersion为计划配置版本。只允许旧字段/指标语义与约束保持的兼容扩展及展示修改；新增记录字段必须可选。不得复制私人初始化值或事实。
- 新旧记录均保留模板来源ID与版本；新增`definitionTemplateId`防止不同模板的同一版本号混淆。旧记录缺少新增字段时保持缺失；修改和撤销遵循当前兼容定义并保留可解释来源。

## 数据与安全

新增migration13：草稿、修订、消息、创作请求/租约、私人版本作者与绑定来源；现有记录补充来源ID。不可变版本禁止修改，账户删除可清理其私人版本且不影响官方版本。导出覆盖私人模板/草稿，不包含独立试填。冻结列与DTO若需调整，先同步本文件及实现者。
