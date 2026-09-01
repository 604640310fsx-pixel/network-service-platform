import "./server-status.css";

/* 登录后的 /status 需要网站 Session + Auth Service 的客户授权投影。
   当前任务只接公开匿名三网摘要，不能把 VITE_MONITOR_URL 当成具体 VPS 状态源，
   也不能根据查询参数推测目标；因此在独立 Auth 投影完成前明确 fail closed。 */
export function BuyerServerStatusPage() {
  return (
    <main className="cc-status-page">
      <div className="cc-status-empty" role="status" aria-live="polite">
        <strong>服务器状态待接入</strong>
        <p>账户授权的服务器状态投影尚未接入。公开网络监控不会显示或推测具体 VPS。</p>
      </div>
    </main>
  );
}
