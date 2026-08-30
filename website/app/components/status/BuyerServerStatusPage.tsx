import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyDeliveryLines,
  type MyDeliveryLineItem,
} from "../../lib/payment-api";
import "./server-status.css";

type LineState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyDeliveryLineItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

function lineErrorMessage(error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return "线路名称数据返回异常，请稍后重试。";
  }
  return "暂时无法读取已交付线路，请稍后重试。";
}

export function BuyerServerStatusPage() {
  const [state, setState] = useState<LineState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyDeliveryLines(controller.signal)
      .then((items) => {
        if (!stopped) setState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: lineErrorMessage(error) });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  const deliveredCount = state.kind === "ready" ? String(state.items.length) : "—";

  return (
    <main className="cc-status-page">
      <div className="cc-status-layout">
        <header className="cc-status-head">
          <div>
            <h1>服务器状态</h1>
            <p>查看当前账户已交付的 VPS 中转线路名称；实时运行状态尚未接入。</p>
          </div>
          <button
            type="button"
            disabled={state.kind === "loading"}
            onClick={() => setReloadToken((token) => token + 1)}
          >
            {state.kind === "loading" ? "读取中…" : "刷新线路"}
          </button>
        </header>

        <section className="cc-status-panel" aria-labelledby="cc-status-summary-title">
          <div className="cc-status-panel-head">
            <div><small>SERVER STATUS</small><h2 id="cc-status-summary-title">中转线路概览</h2></div>
            <span>实时状态待接入</span>
          </div>
          <div className="cc-status-metrics" aria-label="中转线路统计">
            <article><strong>{deliveredCount}</strong><span>已交付线路</span><small>买家可见名称</small></article>
            <article><strong>—</strong><span>在线</span><small>状态接口待接入</small></article>
            <article><strong>—</strong><span>维护</span><small>状态接口待接入</small></article>
            <article><strong>—</strong><span>离线</span><small>状态接口待接入</small></article>
          </div>

          {state.kind === "loading" && <p className="cc-status-state" role="status">正在读取已交付线路…</p>}
          {state.kind === "unauthorized" && (
            <div className="cc-status-state" role="alert">
              <strong>登录状态已失效</strong>
              <p>重新登录后即可查看当前账户的中转线路。</p>
              <a href="/login">重新登录</a>
            </div>
          )}
          {state.kind === "error" && (
            <div className="cc-status-state" role="alert">
              <strong>{state.message}</strong>
              <p>不会回退到公开监控或展示其他账户的线路。</p>
              <button type="button" onClick={() => setReloadToken((token) => token + 1)}>重新加载</button>
            </div>
          )}
          {state.kind === "ready" && state.items.length === 0 && (
            <div className="cc-status-state">
              <strong>暂无已交付中转线路</strong>
              <p>服务完成人工开通并填写买家可见线路名称后，会显示在这里。</p>
              <Link to="/services">查看当前套餐</Link>
            </div>
          )}
          {state.kind === "ready" && state.items.length > 0 && (
            <ul className="cc-status-lines">
              {state.items.map((line) => (
                <li key={`${line.orderRef}:${line.position}`}>
                  <div>
                    <small>VPS 中转线路 {line.position}</small>
                    <strong>{line.label}</strong>
                    <span>关联订单 {line.orderRef}</span>
                  </div>
                  <div>
                    <span>已交付</span>
                    <span>运行状态待接入</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="cc-status-boundary">
            <div><strong>账户线路与公开监控相互独立</strong><p>公开监控展示三网整体状态，不代表上述 VPS 中转线路的实时状态。</p></div>
            <Link to="/monitor">查看公开实时监控</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
