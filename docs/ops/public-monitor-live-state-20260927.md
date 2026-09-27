# 公开监控与 /status 线上状态（2026-09-27）

## 1. 用户决定

- 2026-09-27 用户明确决定：公开监控与服务器状态**不脱敏**，游客无需登录即可查看（含供应商名称与路由数据）。
- 公开面不再使用 `MONITOR-PUBLIC-PRIVATE-GATEWAY-01` 的脱敏网关；该设计与代码保留在仓库中，但当前公开页面不依赖它。
- Draft PR #93（网关投影、中性标签「节点01」的 `/status`）与本决定冲突，需由用户或 GPT 决定关闭或改造。

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

不满足时的回归：`/monitor` 与侧栏回到「监控地址未配置」，`/status` 回到登录后投影页（当前 `MONITOR_AUTH_PROJECTION_ENABLED=false`，只会显示未配置），监控接口恢复 5–30 秒冷启动。

## 4. 已知事项

- 监控主机 3002 构建（含带宽、100TB Cloud 等后续改动）与仓库 `monitoring/dashboard-next` 已分叉；迷你视图目前靠网站主机重写拼接，长期应合并两者。
- `BuyerServerStatusPage`（账户投影 `/status`）组件保留但不再挂路由。
- `/api/targets`、`/api/vps-targets` 在监控主机上仍需约 2 秒（全量样本统计），由边缘缓存隐藏。
