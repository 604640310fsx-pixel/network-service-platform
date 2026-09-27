import { useEffect, useState } from "react";
import {
  getPublicServerStatus,
  getPublicSummary,
  PublicStatusAbortError,
  PublicStatusError,
  type PublicServerStatus,
  type PublicWan,
  type WanStatus,
} from "../../lib/public-node-status-api";
import "./server-status.css";

/* Public operator node status (no login). Shows the sanitized three-network
   summary and the single operator server chosen server-side. It never shows a
   customer's own service, order or account; that stays behind the
   authenticated /api/me/monitor-status. One request per endpoint per mount or
   manual refresh; no polling, no cached or demo fallback. */

type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "error"; readonly message: string };

const WAN_STATUS_TEXT: Record<WanStatus, string> = {
  healthy: "正常",
  degraded: "波动",
  unavailable: "不可用",
  no_data: "暂无数据",
  stale: "数据已过期",
};

function failureMessage(error: unknown): string {
  if (error instanceof PublicStatusError) {
    if (error.kind === "rate_limited") return "查询过于频繁，请稍后手动刷新。";
    if (error.kind === "timeout") return "状态源响应超时，本页未显示任何旧数据。";
    if (error.kind === "invalid") return "状态响应未通过安全校验，本页未显示任何旧数据。";
  }
  return "状态源暂不可用，本页未显示任何旧数据或演示数据。";
}

function formattedTime(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function wanDetail(wan: PublicWan): string {
  const parts = [WAN_STATUS_TEXT[wan.status]];
  if (wan.latestLatencyMs !== null) parts.push(`${wan.latestLatencyMs.toFixed(1)} ms`);
  if (wan.packetLossSummary !== null) parts.push(`丢包 ${wan.packetLossSummary.toFixed(1)}%`);
  return parts.join(" · ");
}

export function PublicNodeStatusPage() {
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<Load<readonly PublicWan[]>>({ kind: "loading" });
  const [server, setServer] = useState<Load<PublicServerStatus>>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSummary({ kind: "loading" });
    setServer({ kind: "loading" });
    // Deferred so React StrictMode's development double-mount issues no duplicate request.
    void Promise.resolve().then(() => {
      if (!active) return;
      getPublicSummary(controller.signal).then(
        (value) => active && setSummary({ kind: "ready", value }),
        (error: unknown) => {
          if (active && !(error instanceof PublicStatusAbortError)) {
            setSummary({ kind: "error", message: failureMessage(error) });
          }
        },
      );
      getPublicServerStatus(controller.signal).then(
        (value) => active && setServer({ kind: "ready", value }),
        (error: unknown) => {
          if (active && !(error instanceof PublicStatusAbortError)) {
            setServer({ kind: "error", message: failureMessage(error) });
          }
        },
      );
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const busy = summary.kind === "loading" || server.kind === "loading";

  return (
    <main className="cc-status-page">
      <div className="cc-public-status">
        <p className="cc-public-status-note">
          运营方节点公开状态，数据来自实时监控源；不包含任何客户账户、套餐、订单或连接信息。
        </p>

        <section className="cc-status-state" aria-labelledby="cc-public-wan-title" aria-busy={summary.kind === "loading"}>
          <strong id="cc-public-wan-title">三网线路</strong>
          {summary.kind === "loading" && <p role="status">正在读取三网状态…</p>}
          {summary.kind === "error" && <p role="alert">{summary.message}</p>}
          {summary.kind === "ready" && (
            <dl className="cc-status-meta">
              {summary.value.map((wan) => (
                <div key={wan.wanId}>
                  <dt>{wan.displayName}</dt>
                  <dd>
                    {wanDetail(wan)}
                    <small className="cc-public-status-time"> · 更新 {formattedTime(wan.updatedAt)}</small>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section
          className={`cc-status-state cc-status-card${server.kind === "ready" ? ` is-${server.value.status}` : ""}`}
          aria-labelledby="cc-public-server-title"
          aria-busy={server.kind === "loading"}
        >
          <div className="cc-status-card-head">
            {server.kind === "ready" && (
              <span className={`cc-status-glyph is-${server.value.status}`} aria-hidden="true">
                <span />
              </span>
            )}
            <div>
              <small>OPERATOR SERVER</small>
              <h2 id="cc-public-server-title">{server.kind === "ready" ? server.value.label : "服务器状态"}</h2>
            </div>
          </div>
          {server.kind === "loading" && <p role="status">正在读取服务器状态…</p>}
          {server.kind === "error" && <p role="alert">{server.message}</p>}
          {server.kind === "ready" && (
            <>
              <div className="cc-status-result">
                <span>当前状态</span>
                <strong>
                  {server.value.status === "online" ? "在线" : server.value.status === "offline" ? "离线" : "数据已过期"}
                </strong>
                {server.value.stale && <p>最近状态已明确标记为过期，不当作当前在线状态。</p>}
              </div>
              <dl className="cc-status-meta">
                <div>
                  <dt>最近更新</dt>
                  <dd>{formattedTime(server.value.updatedAt)}</dd>
                </div>
              </dl>
            </>
          )}
        </section>

        <button className="cc-status-retry" type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
          手动刷新
        </button>
      </div>
    </main>
  );
}
