# dashboard-live

生产监控面板（monitor.siqiapparel.com → VPS nginx → fnnas `:3002`，systemd `network-monitor-dashboard`）
的仓库副本，来源 `/vol1/1000/network-monitor/dashboard/`（2026-10-02 只读拷贝）。

- 部署只替换 `static/` 下的文件；`server.py` 不从仓库部署。
- 仓库副本的 `server.py` 已把 Nezha 默认地址脱敏为文档地址，其余与生产一致。
- `static/style.css` 未被 `index.html` 引用，按原样保留。
- 测试：`node --test monitoring/dashboard-live/tests/i18n.test.cjs`
- 公网入口（VPS nginx）只按精确路径放行 `/`、`/app.js`、`/master.css`、`/api/*` 与 `/__monitor_mini/`：
  不要新增静态文件路径（界面语言代码因此内联在 `app.js` 中），测试会检查 `index.html` 的引用。
