import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PaymentApiError, getMyServices, type MyServiceItem } from "../../lib/payment-api";
import "./buyer-network.css";

type ServiceState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyServiceItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

const UNKNOWN_METRICS = [
  { label: "全部", detail: "节点数据待接入" },
  { label: "在线", detail: "在线状态待接入" },
  { label: "超时", detail: "延迟状态待接入" },
  { label: "离线", detail: "离线状态待接入" },
] as const;

function serviceErrorMessage(error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return "服务数据返回异常，请稍后重试。";
  }
  return "暂时无法读取当前服务状态，请稍后重试。";
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8M5.5 15A7 7 0 0 0 17.8 17.8L20 16" />
    </svg>
  );
}

function NodesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </svg>
  );
}

function TrafficIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      <path d="M2 19h20" />
    </svg>
  );
}

function ServiceEvidence({
  state,
  onRetry,
}: {
  state: ServiceState;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className="cc-net-service-proof" role="status" aria-live="polite" aria-busy="true">
        <span>账户服务证明</span>
        <strong>正在读取…</strong>
        <small>仅核验已有服务，不推算节点数量。</small>
      </div>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <div className="cc-net-service-proof" role="alert">
        <span>账户服务证明</span>
        <strong>登录状态已失效</strong>
        <small>重新登录后可读取当前账户的服务状态。</small>
        <a href="/login">重新登录</a>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="cc-net-service-proof" role="alert">
        <span>账户服务证明</span>
        <strong>读取失败</strong>
        <small>{state.message}</small>
        <button type="button" onClick={onRetry}>重新加载</button>
      </div>
    );
  }

  const openCount = state.items.filter((item) => item.serviceStatus === "open").length;
  const pendingCount = state.items.length - openCount;
  return (
    <div className="cc-net-service-proof">
      <span>账户服务证明</span>
      <strong>{openCount} 项已开通服务</strong>
      <small>{pendingCount > 0 ? `另有 ${pendingCount} 项等待人工开通。` : "当前没有待开通服务。"}</small>
      <Link to="/services">查看当前套餐</Link>
    </div>
  );
}

export function BuyerNetworkPage() {
  const [state, setState] = useState<ServiceState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyServices(controller.signal)
      .then((items) => {
        if (!stopped) setState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: serviceErrorMessage(error) });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  return (
    <main className="cc-net-page">
      <div className="cc-net-layout">
        <section className="cc-net-boundary" aria-label="数据边界说明">
          <div>
            <strong>账户网络数据边界</strong>
            <p>现有接口只提供服务与订单状态；节点在线状态和流量统计尚未接入，因此未知数据不会显示为 0。</p>
          </div>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            disabled={state.kind === "loading"}
          >
            <RefreshIcon />刷新服务状态
          </button>
        </section>

        <div className="cc-net-grid">
          <section className="cc-net-panel" aria-labelledby="cc-net-nodes-title">
            <div className="cc-net-panel-head">
              <div className="cc-net-title">
                <span className="cc-net-title-icon"><NodesIcon /></span>
                <div><em>NODES</em><h2 id="cc-net-nodes-title">可用节点</h2></div>
              </div>
              <span className="cc-net-tag">数据待接入</span>
            </div>

            <div className="cc-net-metrics" aria-label="节点状态">
              {UNKNOWN_METRICS.map((metric) => (
                <article key={metric.label} title={metric.detail}>
                  <strong>—</strong>
                  <span>{metric.label}</span>
                </article>
              ))}
            </div>

            <ServiceEvidence state={state} onRetry={() => setReloadToken((token) => token + 1)} />

            <div className="cc-net-empty">
              <span className="cc-net-empty-icon"><NodesIcon /></span>
              <strong>节点状态数据待接入</strong>
              <p>当前服务契约尚未提供节点清单、在线、超时或离线状态。本页会保留真实未知态，等待后续接口接入。</p>
            </div>
          </section>

          <section className="cc-net-panel" aria-labelledby="cc-net-traffic-title">
            <div className="cc-net-panel-head">
              <div className="cc-net-title">
                <span className="cc-net-title-icon"><TrafficIcon /></span>
                <div><em>TRAFFIC</em><h2 id="cc-net-traffic-title">流量明细</h2></div>
              </div>
              <span className="cc-net-tag">数据待接入</span>
            </div>

            <div className="cc-net-traffic-summary" aria-label="流量统计">
              <div><span>已用流量</span><strong>—</strong><small>统计接口待接入</small></div>
              <div><span>剩余流量</span><strong>—</strong><small>配额接口待接入</small></div>
              <div><span>重置周期</span><strong>—</strong><small>周期数据待接入</small></div>
            </div>

            <div className="cc-net-empty cc-net-empty-traffic">
              <span className="cc-net-empty-icon"><TrafficIcon /></span>
              <strong>流量统计接口待接入</strong>
              <p>当前接口尚未提供用量、配额或时间序列。公开实时监控只展示线路运行状态，不作为账户流量数据。</p>
              <Link to="/monitor">查看公开实时监控</Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
