# 网页端独立部署候选

这是可检查、可构建的候选部署包。目标为 Alibaba Cloud Linux 4 x86_64、Node 24、nginx 和该机器官方仓库提供的 PostgreSQL **15.19**。应用使用独立账号 `planplan-web`、端口 `127.0.0.1:8789`、数据库 `planplan_web`；新 PostgreSQL 集群只监听 `127.0.0.1:55432`。不替换已有 `planplan:8787`、`law-rag:8788`、原项目环境文件、nginx 主配置或证书。

代码尚未提交时，以归档及文件的 SHA256 标识精确源码，不能把工作区内容冒充某个 Git SHA。此目录的脚本不 SSH、不操作 DNS、不把候选设为 current，也不绕过邮件、法律资料、TLS 或迁移检查。生产公网部署结果以独立验收记录为准。

## 1. 顺序和边界

1. 记录主机发行版/架构、实际 Node 路径、现有监听端口/服务、目标域名当前解析与代理状态、相关证书域名/到期时间。只留脱敏结果，不保存 `nginx -T` 或 `systemctl show` 中可能含密钥的全部输出。确认 55432/8789 未用。
2. 只安装官方 PG15.19 server/client，不启动发行版默认 PostgreSQL unit，不运行默认 `postgresql-setup initdb`。本包只操作下述新路径。
3. 初始化新集群和新 TLS，启动独立 PostgreSQL unit；创建独立数据库角色。正式运行角色不具有 DDL、CREATEDB、superuser 权限。
4. 固化源码候选，在 Linux x86_64/Node24 上从锁文件安装依赖、编译；在隔离 **PG15.19** 上运行全套测试、TLS拒绝检查和加密备份恢复演练。PGlite/PG17 的通过不能代替目标版本验收。
5. 安装 root 持有、应用不可写的候选目录；配置受限 JSON 秘密、真实邮箱邀请名单、经实际审核的网页法律告知。执行显式迁移，再授予 API DML 权限；启动8789并验证就绪。
6. 在目标域名对应的新 server block 配置 HTTPS，同源转发 `/v1`、`/legal`、`/healthz`、`/readyz`；`nginx -t` 后 reload，核对原服务继续正常。网页端没有 `/api` 前缀，不需要构建时 API 密钥或 URL。
7. 验证真实邮件、Cookie/CSRF、账户切换/删除、社区审核/使用、私人删除、记录/导出及断网恢复。安装并验证备份、独立删除清单和异地保留规则之后才记录完整发布验收。

## 2. PostgreSQL 15.19 与 TLS

以下是管理员执行的显式命令。`PG_BIN` 必须先由安装结果确定，不能猜测默认路径。脚本在目录或角色已经存在时拒绝继续，不覆盖已有密码/数据。

```sh
bash prepare-postgres.sh --new-independent-cluster /实际/PG/bin
python3 render-config.py --domain 已确认的域名 \
  --node-bin /usr/bin/node-24 --pg-bin /实际/PG/bin \
  --cert-chain /既有或新证书/fullchain.pem --cert-key /对应/privkey.pem \
  --output /root/planplan-web-rendered
install -m 0644 /root/planplan-web-rendered/planplan-web-postgres.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now planplan-web-postgres.service
python3 create-database-roles.py --new-independent-databases \
  --pg-bin /实际/PG/bin --output /etc/planplan-web/bootstrap
```

新目录为 `/var/lib/planplan-web-postgres/15/data`，证书位于 `/etc/planplan-web-postgres/tls`。CA 私钥留在 root-only `ca/`，不能交给应用、上传网页或随数据库备份存放。把 `ca/ca.crt` 复制为 `/etc/planplan-web/pg-ca.pem`（只含公有证书）；服务证书含 `localhost` 与 `127.0.0.1` SAN。监测 397 天服务证书有效期，提前签发并 reload 独立 PG unit，不能停用证书校验解决过期。

PG 使用 `hostssl` + SCRAM，拒绝明文 TCP；只保留 postgres 系统用户的本地 peer 管理。`owner-db.json` 是独立迁移身份，`app-db.json` 仅供 API，`test-db.json` 仅供隔离测试与恢复演练。三个文件仅含新凭据且0600，脚本不打印内容。测试角色的 CREATEDB 只用于随机命名的演练库；测试完成可由管理员撤回，不能授予应用。

应用 `DATABASE_URL` 不带 `sslmode` 等参数；`PG_CA_FILE` 是绝对路径。managed runtime 使用 CA + 主机名验证；备份 libpq 使用 `verify-full`。测试脚本会另行构造测试连接 URL 的 TLS 参数，因为现有测试夹具直接使用 `pg.Client`。不能配置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `DEPLOYMENT_ENV=local` 运行正式应用。[PG15 SSL](https://www.postgresql.org/docs/15/ssl-tcp.html)、[PG15 HBA](https://www.postgresql.org/docs/15/auth-pg-hba-conf.html)。

## 3. 源码候选、构建与目标版本验收

网页 `src/`、后端 `server/` 和部署文件均来自本仓库，无需检出另一份 `planplan`。同仓 `deploy/beta/release.sh`、`deploy/database-backup.sh`、`deploy/deletion-ledger.sh` 保留供既有合成回归使用；实际网页部署入口是本目录。

在本机执行（源路径显式传入）：

```sh
python3 deploy/web-target/package-candidate.py \
  --frontend . \
  --server ./server \
  --output /受限目录/候选包
```

归档排除所有 `.env*`、数据、依赖、dist、Git、证书私钥。它使用明确目录白名单，把网页源码/锁文件、后端源码/测试/锁文件和本部署包复制成快照；检测明显真实 OpenRouter key 时拒绝打包。程序打印归档摘要、源码摘要与文件数。传输后先用归档 `.sha256` 检查，再解压到新构建目录：

```sh
sha256sum -c planplan-web-摘要.tar.gz.sha256
tar -xzf planplan-web-摘要.tar.gz
bash candidate/deploy/build-candidate.sh /绝对路径/candidate
node candidate/deploy/target-pg-check.mjs /绝对路径/candidate \
  /受限目录/test-db.json /受限目录/pg15-evidence
```

构建要求 Node24 与 pnpm10.33.2，输出 `web/`、`server/dist/`、`build-manifest.json`。不会从 Mac 复制 argon2 原生依赖；Linux 构建会验证 argon2 binding。`source-manifest.json` 描述输入快照；AI fingerprint 是构建生成文件，因此构建后不要用源码校验器断言源目录完全没变，应核对输出的 build manifest。`build-manifest.json` 的外部验收字段初始均为 pending，不会假造成功。

`target-pg-check.mjs` 仅接受 private0600 JSON `{TEST_DATABASE_URL,PG_CA_FILE}`，限定 loopback55432、`planplan_web_test` 数据库及角色。它实际查询 `server_version_num=150019`、确认 TLS、拒绝明文/未知CA、验证 managed runtime TLS，再按 Vitest 发现的完整文件集合逐文件新进程串行跑全部测试和恢复演练；清单必须与源码manifest一致，不省略用例。小机器上这样回收编译器/worker累计内存。测试日志0600，报告只含版本/计数性结果/摘要；不读取 runtime、模型或邮件秘密。测试期间不会调用真实模型或发邮件。运行失败时报告固定分类，详细测试输出只留在受限目录。[Node LTS](https://nodejs.org/en/about/previous-releases)。

安装时把已验证候选移入 `/opt/planplan-web/releases/<源码摘要>`。所有应用源码和 node_modules 由 root 持有、可读不可写；普通目录0755、普通文件0644、需执行的脚本0755。`/opt/planplan-web/current` 只能由 root 原子切换。不要把测试配置、证据日志、真实秘密复制到 release。nginx 只公开 `current/web/`。

## 4. 运行配置与迁移

创建新 `planplan-web` 系统用户，无登录 shell。`runtime.env.example` 仅非秘密配置，安装到 `/etc/planplan-web/runtime.env`，替换真实 HTTPS origin 与 `source-sha256:<64hex>` RELEASE_ID。应用秘密 JSON `/etc/planplan-web/secrets/runtime.json` 使用 root:planplan-web 0640，父目录0750；不把整个 bootstrap 目录授权给应用。必须填：

- `DATABASE_URL`（app 角色）、`OPENROUTER_API_KEY`；模型固定 `baidu/ernie-5.5-flash-preview:free`，不启用fallback。
- `JWT_KEYS_JSON` 字符串：`{current:{kid,secret},previous:[]}`，secret为恰好32随机字节的标准base64。与原服务和备份密钥分开；不同时设置 JWT_SECRET。
- `EMAIL_AUTH_SECRET`、`RATE_LIMIT_SECRET`，各为独立32字节以上随机秘密。
- `EMAIL_FROM`、`EMAIL_SMTP_PASSWORD`、最多20个有效邮箱的 `BETA_EMAIL_ALLOWLIST`。真实投递配置与邀请名单不能用 fixture 替代。默认候选为阿里企业邮箱 smtp.qiye.aliyun.com:465 TLS；也可显式选择 DirectMail 官方SMTP。旧 DIRECTMAIL_* 与新 EMAIL_* 若并存必须同值，换主机时清除旧主机配置。

法律文件为 `/etc/planplan-web/legal.json`。operator/region/AI recipient/OpenRouter processing/mail/retention/distribution说明必须实际核对；不得复制旧 TestFlight/测试登录说明，不能为了启动手动伪造 `reviewed:true`。缺失时 managed 启动按现有代码拒绝。审核者UUID只在 trusted runtime `COMMUNITY_REVIEWER_USER_IDS` 中指定。

迁移以 owner JSON 和同一PG_CA_FILE显式执行，不让服务自动迁移：

```sh
# 用受限迁移env文件提供 DEPLOYMENT_ENV=beta、PG_CA_FILE 和 owner JSON路径。
cd /opt/planplan-web/releases/已验证候选/server
/usr/bin/node-24 --env-file=/etc/planplan-web/migrate.env dist/scripts/maintenance.js migrate up
# 用本地postgres管理员在planplan_web上执行本包grants.sql，然后再核对API角色。
/usr/bin/node-24 --env-file=/etc/planplan-web/runtime.env dist/scripts/entrypoint.js migrate-check
```

`grants.sql` 只在 `planplan_web` 执行，错误库名以SQL异常和非零退出码拒绝：API仅DML、序列使用和函数执行；迁移表只读。恢复后若存在隔离guard，仅授API读取guard的权限，不允许修改或解除隔离。每次新增迁移或恢复后重跑权限并做 API 实际读写/删除/导出；不可假定“能连库”代表权限完整。

安装渲染的 `planplan-web.service` 后检查 `systemd-analyze verify`，再 daemon-reload/start；`ExecStartPre` 只检查迁移，入口固定隐藏原始供应商/数据库启动异常。应用仅监听loopback8789，Node/V8需要JIT，未设置不兼容的 MemoryDenyWriteExecute。[systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。

## 5. HTTPS、nginx 与 Cloudflare

先从127.0.0.1:8789验证 `/healthz` 和 `/readyz`，ready响应 releaseId必须与候选一致。公网block安装前保留原配置。模板只新增明确域名的server blocks，SPA入口no-store，内容摘要assets可长期缓存，API/法律/就绪检查不缓存；75秒上游等待覆盖60秒模型等待，浏览器中断后仍通过原请求ID核对结果；nginx不自动重放写请求。Cookie Secure/HttpOnly 与CSRF由后端控制。[nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

模板默认假定DNS-only直连。如果实际使用Cloudflare代理，管理员必须仅对这个host配置 Full (strict) 规则与非缓存规则，保留zone上旧API/其他应用行为。不能依赖Flexible回源HTTP。仅在本server作用域配置从Cloudflare官方最新CIDR信任 `CF-Connecting-IP`，用 `render-config.py --trusted-proxy-include /etc/nginx/snippets/专用.conf` 引入已核对文件；不要信任任意来源客户端头，也不要改nginx全局real-IP规则。检查可信代理和直接源站访问两种情况下X-Real-IP不能伪造。www若需跳转，证书需覆盖www，再添加专用HTTPS跳转block。

现有certbot证书与续期timer保持独立。首次DNS01证书与后续webroot迁移需分别验证challenge路径、renewal配置和dry-run；本模板没有虚构ACME挑战目录。安装后的 `nginx -t` 与reload不改变默认server，不重启原应用。公网HTTPS还需验证证书链/名称、SecureCookie、API无共享缓存、陌生origin拒绝、两账号隔离、旧8787/8788服务状态。

## 6. 加密备份、删除清单与恢复

复用后端 `dist/scripts/maintenance.js`：custom pg_dump、AES-256-GCM、归档hash、原子完成目录，原始dump临时文件失败后清除。备份客户端必须用PG15工具，不用PG17二进制宣称15兼容。每份快照只代表开始备份时的数据，不承诺零数据丢失。[PG15备份](https://www.postgresql.org/docs/15/backup-dump.html)。

新建 `planplan-web-backup` 系统用户，独立 `/etc/planplan-web/backup.env` 与 `backup-secrets.json`；仅含owner DB连接、独立BACKUP_ENCRYPTION_KEY(base64 32B)、BACKUP_LEDGER_KEY(32+字节)，不复制模型、邮箱、JWT秘密。配置文件root:backup0640，备份目录 `/var/lib/planplan-web-backups/{database,...}` backup所有且0700。把 `maintenance.sh` 安装为可执行，核对PG客户端PATH。

先手动执行 `planplan-web-maintenance@backup.service`、`@ledger.service`、`@prune.service` 并校验输出、恢复结果，再启用三个timer。backup每天02:00中国时间，独立删除清单5分钟刷新；清单写入同目录临时文件，成功后原子替换，失败时保留上次成功副本。prune每天03:00且不依赖DB连接，固定最多28天。timer不代表异地备份已经存在：必须另外配置受限异地加密存储、版本/副本28天过期与独立删除清单刷新，并从下载的备份演练。不要把备份密钥与备份存到同一位置。

恢复只使用新空库和单独RESTORE_DATABASE_URL/RESTORE_PG_CA_FILE，`RESTORE_ISOLATED=1`，提供独立新鲜删除清单和 `RESTORE_REQUIRED_THROUGH` 截止时间。maintenance restore先校验checksum与认证tag，拒绝非空库/陈旧删除清单，恢复并应用账户删除后才解除隔离guard。先做合成 `target-pg-check` 演练，再对真实备份在隔离副本核对旧事实hash、私人/社区版本、typed记录、删除账户不复活、新建和撤销可写；不将恢复目标切为live来代替验收。恢复凭据不共享应用文件，结束后清理测试账户和临时恢复库。

## 7. 切换、回滚与证据

应用和schema严格匹配。首次上线前使用空正式库；已有正式数据变更前做可恢复备份，停止新写入并保存迁移版本/摘要。切换 `current` 前完成静态构建摘要、PG15/应用角色验证，再重启独立8789 unit并核对readyz。失败恢复仅同迁移列表/校验值的兼容候选；不要自动 `migrate down` 或把旧代码强行指向新schema。

最终脱敏记录至少包含：源码/归档/build摘要、实际Node/PG/nginx版本、迁移版本及checksum、目标PG15测试和恢复结果、证书域名/有效期/续期验证、HTTPS/no-store/Cookie/CSRF实测、真实邮件结果、原服务持续运行、备份/删除清单/异地保留证据，以及尚未完成事项。报告不含连接串、token、邮箱名单、原始输入或业务记录。
