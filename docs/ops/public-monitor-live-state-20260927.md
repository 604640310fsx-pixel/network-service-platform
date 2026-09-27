# 公开监控与 /status 线上状态（2026-09-27）

## 1. 用户决定

- 2026-09-27 用户决定、项目经理裁决（尚未最终验收）：保留现有 `monitor.siqiapparel.com` 与公开 3002 运营方监控展示；供应商、节点、路由公网 IP/ASN、带宽可不脱敏；账户、订单、凭据仍私有。
- 所有访客（含已登录用户）的 `/status` 与 `/monitor` 都显示同一公开 3002 监控页。
- 不开启客户状态投影（`MONITOR_AUTH_PROJECTION_ENABLED` 保持关闭），不声称客户状态投影已接通。
- 公开面不使用 `MONITOR-PUBLIC-PRIVATE-GATEWAY-01` 的脱敏网关；该设计与代码保留在仓库中。
- Draft PR #93 与本决定冲突，其处置由项目经理另行决定；其作者与未提交工作不在本任务范围内。
- 发布时必须保留的配置、发布后证明与恢复步骤已纳入 [`consolidated-release-runbook.md`](consolidated-release-runbook.md)「Public operator monitor preservation」与 [`consolidated-release-bindings.md`](consolidated-release-bindings.md) 同名小节；本文件是它们引用的现场记录。

## 2. 当前线上状态（在网站主机上手工落地，未经发布工具生成）

| 项 | 线上做法 |
| --- | --- |
| 官网构建 | 以 `VITE_MONITOR_URL=https://monitor.siqiapparel.com` 构建；`/monitor`、`/status`（同一 3002 嵌入页）与侧栏迷你卡片都依赖它 |
| 官网 root | 指向独立 override 目录中的构建，原 release bundle 未改动（其 manifest 记录了 dist 哈希） |
| `monitor.siqiapparel.com:80` | 放行 ACME webroot 续期，其余 301 到 HTTPS（原 503 会阻断证书续期） |
| `monitor.siqiapparel.com:443` | 经私有 tailnet 反代到监控主机的 3002 监控页；仅 GET/HEAD；仅放行 `/`、`/master.css`、`/app.js` 与 8 个 `/api/*`；`frame-ancestors` 只允许官网 www 与裸域 |
| 侧栏迷你卡片 | 监控主机上的 3002 构建没有 `?view=mini`；`/?view=mini` 及其版本化 `app.js` / `master.css` 由网站主机内部重写到本仓库 `monitoring/dashboard-next/static`（5ab1d68）的静态文件，数据仍取 3002 |
| 监控 API 缓存 | nginx `proxy_cache`：20 秒有效，过期先回旧值并后台刷新，同 URL 单飞；浏览器侧保持 `no-store`；响应头 `X-Monitor-Cache` |
| 监控主机数据库 | `latency_samples` 新增 3 个只读查询索引（未改数据、代码、服务）；备份与撤销 SQL 在监控主机 backups 目录 |

具体值、上游地址、备份与逐项回滚步骤只记录在网站主机 `/opt/network-service-platform/backups/claude-20260927T-monitor/README.txt` 与监控主机备份目录，不进入仓库。

## 3. 下一次正式发布必须满足

1. 发布内容包含本分支（`/status` 公开，与 `/monitor` 相同地嵌入 3002 实时监控页）。
2. 官网构建设置 `VITE_MONITOR_URL=https://monitor.siqiapparel.com`。
3. 保留网站主机 nginx 中：`monitor.siqiapparel.com` 的 80/443 server 块、`proxy_cache_path` 缓存区、迷你视图内部重写与其静态目录。
4. 发布后验收：`/monitor` 显示实时数据；`/status` 免登录显示同一 3002 监控页；登录后侧栏卡片显示 LIVE；`X-Monitor-Cache` 命中；无内网地址出现在官网构建产物中。

不满足时的回归：`/monitor`、`/status` 与侧栏回到「监控地址未配置」（若同时丢失本分支，`/status` 回到登录后投影页，当前投影关闭，只会显示未配置），监控接口恢复 5–30 秒冷启动。

## 4. 已知事项

- 监控主机 3002 构建（含带宽、100TB Cloud 等后续改动）与仓库 `monitoring/dashboard-next` 已分叉；迷你视图目前靠网站主机重写拼接，长期应合并两者。
- 未解决 / 延后：旧的已登录客户状态页 `BuyerServerStatusPage` 原入口已被公开 `/status` 替代，组件保留但不再挂载；客户状态投影未接通。是否恢复及入口位置由项目经理另行决定。
- 采样缺口：为监控主机数据库建第三个索引时写锁持续约 90 秒，超过采集写库 10 秒等待且采集不重试，2026-09-27 北京时间 18:38（10:38Z）一分钟 54 条采样丢失，不可恢复。其余核对时段逐分钟完整。
- 证书续签：`monitor.siqiapparel.com` 证书 2026-11-28 到期；已确认 HTTP 下 ACME 验证路径可达（返回 webroot 404 而非 301/503），但未运行 certbot dry-run 或真实续签，续签能否成功为 UNVERIFIED。
- `/api/targets`、`/api/vps-targets` 在监控主机上仍需约 2 秒（全量样本统计），由边缘缓存隐藏。
