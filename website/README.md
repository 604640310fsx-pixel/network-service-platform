# NSP Console Website

Network Service Platform 的客户后台 V1。公开 `/monitor` 与侧栏 mini 只承载身份无关的三网摘要；登录后的 `/status` 等待独立的账户授权投影接入。

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

网站代码与 `monitoring/` 相互独立，不修改正在运行的监控服务。`VITE_MONITOR_URL` 只能由部署环境配置为已批准的公共脱敏监控 origin；页面只附加 `theme` 与 `view=mini|embed`，不会附加 VPS、客户、节点或目标身份。未配置时公开页面会安全停用嵌入并提示“监控地址未配置”。

`/status` 不复用公共监控 origin，也不根据 `?vps=` 推测目标。在 `MONITOR-AUTH-PROJECTION-01` 完成前，该页明确显示“服务器状态待接入”。当前版本不连接真实登录、支付、客户数据或订阅服务。
