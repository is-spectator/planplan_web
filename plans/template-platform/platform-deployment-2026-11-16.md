# clyna.ai 部署验收记录（P15 继续未完成）

日期：2026-11-16。网站已安装并通过源站及公网匿名检查；真实验证码收件、注册和登录、密码重置后新密码登录及旧会话失效，以及官方饮水计划记录/刷新、手动私人模板保存、实际ZIP导出已验证。完整Cookie/CSRF、其余登录态验收、异地备份与兼容回滚仍待完成，P15 不勾选。用户已授权使用既有服务器及 clyna.ai；本轮仅切换主域名/www，新应用、数据库与原服务隔离。

**同日后续功能更新已于20:06:20上线：当前source为86c64c…、目标PG15.19同包661/661、双浏览器166/166、公网功能入口74/74。** 详见[本轮功能上线记录](function-release-2026-11-16.md)。下文保留首发60da6e及随后账户/备份验收的历史时点；本轮没有重新操作DNS、邮箱或真实账户，账号/异地/真人专项按用户要求暂缓。

## 首发版本与安装（历史记录）

- 最终源码：`source-sha256:60da6e324719ea6e665150619bc0301e7b4b11106ab3a1896075e6b2285d0683`。
- 源码归档 SHA256：`e7dcaddfefa167c4b68cc562150abaaa3902d16186f4ffb4ef37cd91565053eb`，300 个文件；Linux 重新安装原生依赖并构建，没有复制 Mac 的 node_modules。
- 构建 SHA256：`38be4d024df062c71ee52c97e9ddbf3b3831f958e2d8c3ab7e13d841f3a238aa`，195 个输出文件。
- 已安装 root 所有、应用不可写的 release，并设置 `current`；应用使用独立账号 `planplan-web`，监听 loopback 8789。迁移 1–17、授权 SQL 与启动迁移检查均成功，公网 `/readyz` 对应上述精确 release。
- 最终包与完整 PG15 测试候选 `source-sha256:1be0ddaffe3c683da227e72aa2a8da38c94af622008f0fc8b01694e58371899a` 的 275 个应用源文件、195 个构建文件逐项相同。差异仅为 `deploy/maintenance.sh`、`deploy/grants.sql`、`deploy/README.md`；各自专项证据如下，未声称新包重新运行过 601 项。

耐久证据：[版本与构建比对](evidence/deployment-2026-11-16/release-validation.json)、[摘要文件清单及 SHA256](evidence/deployment-2026-11-16/manifest.json)。源码没有 Git 提交，不以虚构提交号标识版本。本记录后续更新不改变冻结候选包。

## 目标环境与完整测试

- Alibaba Cloud Linux 4 x86_64；Node 24.18.0；nginx 1.30.4。原 `planplan` 8787、law-rag 8788 保留；新增配置后原两个 nginx 配置 SHA256 未变，原 API `/healthz` 仍返回 200，两个旧端口继续监听。
- 独立 PostgreSQL **15.19**，仅 loopback 55432，独立目录及 systemd unit；TLS 主机名/CA 校验、SCRAM 认证。owner/app/test 身份分开，app 无 superuser、CREATEDB 或 DDL 权限。
- 本地 PG17 和目标 PG15.19 完整套件均 **62 文件、601/601**。目标测试逐文件串行，保留早先资源不足的 OOM/部分运行记录；没有删用例、跳过失败或放宽断言。目标 TLS、拒绝明文/未知 CA、managed runtime TLS、加密恢复及删除清单演练通过。
- 为目标 WASM 测试临时增加专用 swap、调整 swappiness；验收结束已 swapoff 并删除专用文件、恢复 swappiness=0，没有修改 fstab。测试凭据副本和中断遗留的随机测试 schema 已清理。原应用、nginx 与新 PG 均正常。

耐久证据：[目标 PG15 汇总](evidence/deployment-2026-11-16/target-postgres-summary.json)。完整逐文件日志仍在受限服务器 `/var/lib/planplan-web-build/final-frozen/evidence-complete/`；这些测试没有发送真实邮件或调用真实模型。

## 正式数据库权限与首发恢复

正式库验收于 `2026-11-16T08:21:09.870Z` 完成。当时为首发空库：50 张 public 表，17 条迁移、4 个预置模板，其余表为空；这是当时的快照，不代表开放注册后的实时计数。

- 正式 app 身份通过直接 TCP、指定 CA 的 TLS 连接，**10 项权限检查通过**。user/plan/record 的增改读删均实际执行后事务回滚，未提交合成业务数据；迁移表写入、建表、新建 schema、修改业务表均被拒绝。50 表及序列在前后保持一致。
- 正式备份身份产生实际 **AES-256-GCM** 加密快照，独立签名删除清单包含 0 条删除请求。快照密文为 136,895 字节，SHA256 `565da0c3382755685b7222aa7545d3be384587b2cf9b21ca9802cf3385423a7d`。没有复制秘密或备份 dump 到 plans。
- 在独占随机恢复库真实解密并运行 pg_restore，原快照、恢复后、关闭重连后的 50 表结构/行汇总摘要一致：`6da8b1215035ebc5a5ebb06c186060478e9ab921373317f51f231ecb6f7b5335`；全部序列一致。过期删除清单在写入目标前被拒绝。
- 恢复副本使用管理员 peer 后 `SET ROLE planplan_web_app` 验证同角色权限，没有声称是直接 app TCP 连接，也未放宽 HBA。app 可读 guard、不可写 guard；guard=false 后新的 app-role 会话被编译版迁移检查拒绝，恢复 true 后通过。副本 CRUD 回滚后摘要不变，随机恢复库已删除，正式源保持不变。
- 授权 SQL 在目标 PG15 隔离库 **6 项通过**。发现原错误库名分支 `\quit 1` 忽略退出码后，已改为 SQL 异常加 ON_ERROR_STOP，实际返回 3/P0001；恢复 guard 只授予 schema USAGE 与 SELECT。该修正包含在最终部署包。

耐久证据：[数据库权限与恢复摘要](evidence/deployment-2026-11-16/database-acceptance-summary.json)，保留原始报告文件 SHA256；原报告为 `/tmp/planplan-platform-origin/DB_ACCEPTANCE_REPORT.md`。首发空库恢复证明当前快照可恢复，不能代替含真实用户数据后的持续备份监测、删除演练或异地恢复。

## 注册后的在线快照与隔离恢复

于 `2026-11-16T09:00:40.740Z` 固定正式库只读快照T1，当时包含 **1个已注册用户、1个计划、1条记录**，以及对应私人创作数据。用户可以继续操作或重置密码；本次不要求快照后仍在变化的线上数据保持原摘要。服务未停止，`current`、HBA、秘密配置及正式业务数据均未修改。

- 只读 `REPEATABLE READ` 事务导出snapshot，PG15 `pg_dump --snapshot`与48张实际备份表的列/行摘要使用同一T1；未使用阻止业务写入的SHARE锁，也未调用会重试账户删除的维护backup分支。
- 实际AES-256-GCM密文为 **144,892字节**，SHA256 `6ef259b2203883137207f0f2b80a32fa987202e1c6741206fc28e9a79d580af9`。恢复到独占随机测试库后，48表原始摘要与T1完全一致：`057577f8d1df7ca65e65b729916e15dd5390dc3f86f02c58c4aaa3fe3b5fa8bc`。
- `request_rate_limits`按设计不恢复；`deletion_jobs`不按原行hash比较，而由独立签名清单重建。清单覆盖截止时间为`09:00:41.287Z`，生成于`09:00:41.288Z`，本轮0条删除请求；过期和签名篡改均拒绝。清单只在内存校验，额外证据以密文留在受限服务器目录，没有在plans保存账户地址或用户行。
- guard在原始摘要、迁移和删除清单核验完成前保持false，普通迁移检查实际拒绝；核验后解除隔离并关闭重连，副本50表摘要保持一致。6个序列的下一值均安全；序列不属于同一MVCC快照，因此未声称与持续使用的线上序列全等。
- 本轮没有实际删除真实账户，不把空删除清单验收称为真人删除演练。随机恢复库及临时明文dump已清理，未创建临时凭据文件；真实密文留在正式备份目录，独立清单密文和脱敏证据留在受限验收目录。

耐久证据：[含用户数据的在线恢复摘要](evidence/deployment-2026-11-16/online-restore-summary.json)。先前SSH复用连接失效发生在上传/执行前，恢复原授权连接后仅运行一次实际数据库验收，不记为数据库失败。此结果不证明异地恢复或不同业务版本回滚，也不将P15/P18改为完成。

## 维护任务、公开资料与邮箱

- 加密备份、删除清单、保留清理的 oneshot 均已成功；删除清单连续两次刷新成功，3 个 timer 已启用。日备份与 28 天保留已配置；首次启用仍需继续观察定时运行及保留周期，异地副本尚未配置。
- 在线恢复期间只读复核发现backup/prune当前oneshot启动时间为空，原观察保留attention；限定journal随后补证：两者分别在`08:22:51Z`、`08:22:52Z`有结构化成功输出和Finished事件，未见失败。ledger累计10次成功日志，最近一次`08:58:37Z`；检查时独立清单125秒新鲜、签名有效，3份密文hash和权限全部通过。backup/prune的首次自然日历触发仍待观察，分别计划于11月17日02:04、03:00（上海时间）；没有为补证重启或触发任务，不能将手动成功计为完整28天运行结果。详见[在线恢复与维护摘要](evidence/deployment-2026-11-16/online-restore-summary.json)。
- 删除清单采用新临时文件写入后原子替换，失败保留旧文件；目标 Linux 合成验证 **5 项通过**，覆盖首次、重复刷新、失败保留、临时清理和 0600 权限。备份及删除清单使用独立秘密，没有复用模型、邮箱或 JWT 秘密。
- [公开资料](web-release-review-2026-11-16.md)已获业务负责人确认，通过字段校验并安装。数据库、JWT、模型、限流及邮件秘密均保存在受限运行配置中，不进入网页、源码或本记录。
- `smtp.qiye.aliyun.com:465` 的 TLS 和新 planplan 邮箱身份的实际 SMTP AUTH 已成功。POP/IMAP 已关闭；仅该账号从第三方客户端禁用策略中排除，没有放开所有邮箱。
- 真实网页验证码收件、注册和登录已验证：用户在验证码注册步骤回复“已经登陆”，随后实际浏览器进入公网“计划”空状态，并在“我的”看到记录与账户关联。该证据来自真实页面与用户完成步骤，未使用开发免密入口。真实密码重置、新密码重新登录及旧会话失效已按下述A05验证；完整Cookie/CSRF与其余账户流程继续验收。
- 邮箱服务到期在控制台不同页面分别显示11月27日/28日，按11月下旬核对，以用户控制台账单为准；未擅自购买或开启续费。

## DNS、HTTPS 与公网匿名检查

- Cloudflare 两条仅匹配主域名/www 的规则已 active：Strict SSL；非 `/assets/` 页面/API 绕过缓存。zone 其他主机仍保持原设置。
- 主域名 A 已从 `47.251.1.42` 切为 `8.211.187.188` 并启用代理；www CNAME 未变，HTTPS 308 跳转主域名。其他 DNS/MX 未改。
- 独立证书覆盖 `clyna.ai`、`www.clyna.ai`，有效期 2026-11-16 至 2027-02-14。临时 DNS01 记录已清理，80 端口两个域名 ACME webroot 实际读回探针后清除。
- 初次 reconfigure 沿用了旧 `pref_challs=dns-01` 而失败；随后显式指定 `--webroot --preferred-challenges http` 成功，持久配置为 `pref_challs=http-01`、`authenticator=webroot`、`webroot_path=/var/lib/planplan-web-acme`。
- 再次执行不带配置覆盖的 `certbot renew --cert-name planplan-web-clyna --dry-run --run-deploy-hooks`，全部模拟续期成功，nginx 检查/reload hook exit 0。既有 `planplan-cert-renew.timer` active；没有把只带临时参数成功当成持久续期配置成功。

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| 直连源站第二轮 | **135/135** | 首轮执行到 48 项时通过 47 项，一次 TCP 连接超时中断；原失败保留，未自动重试，后续健康检查正常后完整重跑。 |
| 公网 DNS / Cloudflare 首轮 | **135/135** | 0 网络失败、0 自动重试；26 个动态响应均为 `CF-Cache-Status: DYNAMIC`。 |
| 版本与运行状态 | 通过 | 公网 ready 对应最终 release；新 app、原 planplan、nginx、PG active。 |

耐久证据：[直连源站汇总](evidence/deployment-2026-11-16/direct-http-summary.json)、[公网汇总](evidence/deployment-2026-11-16/public-http-summary.json)。以上 HTTP 检查均匿名，不带账号凭据、不调用邮件/模型、不写业务数据，不能替代登录态 Cookie/CSRF、真实注册或功能验收。

## 公网真实账户与归档 A01–A06

实际Chrome公网会话在真实邮箱注册后完成以下操作，摘要时间为 `2026-11-16T08:51:51.788057+00:00`：

- A01：真实验证码收件、注册和登录已由用户确认，实际页面核对了登录态。
- A02：采用官方饮水模板，计划改名为“上线验收·饮水”，设置目标2000毫升，保存250毫升记录，备注明确为合成验收数据。页面显示剩余1750毫升、进度12.5%；整页刷新后仍为1条记录。
- A03：手动创建私人打卡模板，保存v1并通过独立详情页回读。没有开启AI，没有发布社区作品；此项仅验证手动创作，不能计为AI生成质量通过。
- A04：真实界面导出ZIP，实际文件5948字节、11个条目，ZIP完整性通过；1个计划、1条记录、1个私人模板、1个草稿及记录/计划/已保存模板关联逐项相符。工具等待下载事件超时后，通过原生Chrome下载面板确认完成并检查实际文件，不记为产品导出失败。

耐久证据：[公网账户摘要](evidence/deployment-2026-11-16/public-account-summary.json)、[含新增摘要的manifest](evidence/deployment-2026-11-16/manifest.json)；操作勾选见[账户验收TODO](../todos/2026-11-16-public-account-acceptance.md)。原5项证据摘要哈希未变。本轮没有验证公网AI创作、反馈、删除或完整Cookie/CSRF矩阵。

A05真实密码重置已完成：用户回复“重置密码可以了”。实际无痕Chrome公网页面显示新会话已登录，饮水计划250毫升/1条记录保留；切回普通Chrome旧会话，聚焦刷新后显示“登录后，开始积累”“登录或注册”，确认旧会话失效。再返回无痕新会话，数据仍在。

服务端只读诊断确认：2026-11-16 **18:37:32（Asia/Shanghai）** 密码变更已提交，`token_version=2`；18:37:38存在成功登录遥测。诊断时近30分钟没有服务故障、重启或OOM。此前“连接中断”的准确请求和原因无法由现有证据确定，nginx access log当时关闭；没有把网络原因猜测或修复当成事实，也没有修改源码或代用户重试凭据。诊断原件保存在受限私档，本文不保存凭据或个人账户标识。

A06已完成本轮结果、截图、实际ZIP和脱敏重置诊断的受限归档，目录0700、文件0600。详见[账户验收TODO](../todos/2026-11-16-public-account-acceptance.md)，本轮 **6/6**；该切片完成不改变主清单 **12/18** 或P15/P18状态。

## P15 尚未完成的条件

1. 完整Cookie/CSRF与同源保护验收；真实收件、注册、首次登录、密码重置、新密码登录和旧会话失效已通过。
2. 公网反馈、删除与其余登录态验收；官方饮水计划、手动私人创作和实际导出已有上述证据。公网AI创作尚未验，实际模型调用的质量和供应商限流按原AI验收记录分别判断。
3. 异地备份、持续备份监测、真实账户删除后的恢复演练与不同业务版本的兼容回滚实测。含已注册用户、计划和记录的在线快照隔离恢复已通过，不能替代这些剩余项。
4. 真实设备与独立用户试用另列 P16/P17，不能由匿名 HTTP 或本机浏览器自动化替代。

本轮更新部署及A01–A05真实账户证据，P15 继续未勾选；候选状态见[发布记录](../releases/2026-11-16-web-beta.md)，后续流程见[公网账户验收](../todos/2026-11-16-public-account-acceptance.md)。注册成功不等于完整账户验收或独立试用完成。

参考：[Cloudflare 特定域名加密设置](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)、[官方代理 IP 列表](https://www.cloudflare.com/ips/)、[阿里企业邮箱 SMTP](https://help.aliyun.com/zh/document_detail/36687.html)、[Certbot 续期配置](https://eff-certbot.readthedocs.io/en/stable/using.html#modifying-the-renewal-configuration-of-existing-certificates)。
