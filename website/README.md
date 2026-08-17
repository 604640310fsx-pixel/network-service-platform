# NSP Console Website

Network Service Platform 的客户后台 V1。总览和网络监控直接承载现有的广州三网实时监控，其余客户后台页面暂时使用演示数据。

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

网站代码与 `monitoring/` 相互独立，不修改正在运行的监控服务。监控地址必须由部署环境通过 `VITE_MONITOR_URL` 提供；未配置时页面会安全停用监控嵌入并提示“监控地址未配置”。当前版本不连接真实登录、支付、客户数据或订阅服务。
