# NSP Console Website

Network Service Platform 的客户后台 V1。公开 `/monitor` 与侧栏 mini 只承载身份无关的三网摘要；登录后的 `/status` 只读取同源 Auth 账户投影。

## 技术栈

- React
- Vite
- TypeScript
- React Router

## 本地运行

```bash
npm install
npm run dev
```

## 构建验证

```bash
npm run build
```

网站代码与 `monitoring/` 相互独立，不修改正在运行的监控服务。`VITE_MONITOR_URL` 只能由部署环境配置为已批准的公共脱敏监控 origin；页面只附加 `theme` 与 `view=mini|embed`，不会附加 VPS、客户、节点或目标身份。未配置时公开页面会安全停用嵌入并提示“监控地址未配置”，横幅显示“监控未接入 / NOT CONFIGURED”。已配置只表示地址通过校验，不证明公共网关可达、已授权或数据新鲜，因此横幅显示“状态待确认 / CONFIGURED”，不声称 LIVE 或 15 秒实时。

`/status` 不复用公共监控 origin，也不读取 `?vps=` 或任何浏览器 target。它仅向同源 `GET /api/me/monitor-status` 发出一个带现有 Session 的请求，严格解析 allowlisted JSON，并以手动重试、无 polling、无旧成功回退的方式呈现完整状态。客户订单和交付响应也不会向浏览器暴露 `monitorTargetKey`。

当前仓库实现遵循 [`MONITOR-AUTH-PROJECTION-01`](../docs/architecture/MONITOR-AUTH-PROJECTION-01.md)。本地测试、Draft PR 或 CI 只证明精确代码候选；不证明管理验收、生产配置、证书绑定、部署、真实支付受理、真实客户数据或外部服务可用。
