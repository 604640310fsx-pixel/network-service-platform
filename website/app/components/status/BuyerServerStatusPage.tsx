import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyDeliveryLines,
  type MyDeliveryLineItem,
} from "../../lib/payment-api";
import "./server-status.css";

/* /status 买家「服务器状态」页。
   唯一数据源是 GET /api/me/delivery-lines，后端只返回已开通服务的 orderRef、position
   与买家可见 label；本页也只展示这三项，绝不展示订阅地址、主机名、IP、面板地址、
   凭据、监控 ID 或供应商身份。线路实时运行状态没有公共契约，在线 / 维护 / 离线三项
   一律保持 — 未知态；「已交付线路」是名称记录条数，不是在线节点数。
   视觉语言与 /network、/services 完全一致：只用 --cc-* 令牌，图标块 + eyebrow + 标签
   的面板头，真实数据用 --cc-text 强调、未接入数据用 --cc-text-4 弱化。 */

type LineState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyDeliveryLineItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

type LineGroup = {
  readonly orderRef: string;
  readonly lines: readonly MyDeliveryLineItem[];
};

const UNKNOWN = "—";

function lineErrorMessage(error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return "线路名称数据返回异常，请稍后重试。";
  }
  return "暂时无法读取已交付线路，请稍后重试。";
}

/* 后端已按 services.id DESC、position ASC 返回。按订单聚合时保留该顺序，
   只在组内按 position 升序兜底，不在前端重排订单本身。 */
function groupByOrder(items: readonly MyDeliveryLineItem[]): LineGroup[] {
  const groups: { orderRef: string; lines: MyDeliveryLineItem[] }[] = [];
  const index = new Map<string, { orderRef: string; lines: MyDeliveryLineItem[] }>();
  for (const line of items) {
    const existing = index.get(line.orderRef);
    if (existing === undefined) {
      const created = { orderRef: line.orderRef, lines: [line] };
      index.set(line.orderRef, created);
      groups.push(created);
      continue;
    }
    existing.lines.push(line);
  }
  for (const group of groups) group.lines.sort((left, right) => left.position - right.position);
  return groups;
}

function LinesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8M5.5 15A7 7 0 0 0 17.8 17.8L20 16" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 17l4-4 3 2 6-7 3 3" />
      <path d="M16 8h4v4" />
    </svg>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="cc-status-loading" role="status" aria-live="polite" aria-busy="true">
      <ul className="cc-status-skeleton" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <li key={index} />
        ))}
      </ul>
      <p>{label}</p>
    </div>
  );
}

/* 空 / 登录失效 / 读取失败共用同一居中容器，只切换 role 与配色，
   保证四种状态在同一位置、同一高度出现，不产生跳动。 */
function StateBlock({
  tone,
  title,
  hint,
  action,
}: {
  tone: "empty" | "alert";
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`cc-status-state ${tone === "alert" ? "is-alert" : ""}`}
      role={tone === "alert" ? "alert" : undefined}
    >
      <span className="cc-status-state-icon"><LinesIcon /></span>
      <strong>{title}</strong>
      <p>{hint}</p>
      {action !== undefined && <div className="cc-status-state-actions">{action}</div>}
    </div>
  );
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

  const reload = () => setReloadToken((token) => token + 1);
  const ready = state.kind === "ready";
  const groups = ready ? groupByOrder(state.items) : [];
  const lineCount = ready ? state.items.length : null;

  /* 四格统计：只有「已交付线路」是真实数据，且它是名称记录条数而不是在线节点数。
     在线 / 维护 / 离线没有任何可用接口，保持 — 未知态，不用服务数或线路数顶替。 */
  const metrics = [
    {
      label: "已交付线路",
      value: lineCount === null ? UNKNOWN : String(lineCount),
      hint: "名称记录 · 非在线数",
      unknown: lineCount === null,
    },
    { label: "在线", value: UNKNOWN, hint: "状态接口待接入", unknown: true },
    { label: "维护", value: UNKNOWN, hint: "状态接口待接入", unknown: true },
    { label: "离线", value: UNKNOWN, hint: "状态接口待接入", unknown: true },
  ] as const;

  const subline = ready
    ? `已交付线路名称 ${lineCount ?? 0} 条 · 关联订单 ${groups.length} 笔 · 运行状态未接入`
    : state.kind === "loading"
      ? "正在读取已交付线路名称"
      : "已交付线路名称暂不可读取";

  return (
    <main className="cc-status-page">
      <div className="cc-status-layout">
        <header className="cc-status-head">
          <span className="cc-status-head-icon"><LinesIcon /></span>
          <div>
            <h1>服务器状态</h1>
            <p>
              查看当前账户已交付的 VPS 中转线路名称；线路的实时运行状态尚未接入，页面不会显示任何推算的在线数或健康值。
            </p>
          </div>
          <button type="button" onClick={reload} disabled={state.kind === "loading"}>
            <RefreshIcon />
            {state.kind === "loading" ? "读取中…" : "刷新线路"}
          </button>
        </header>

        <section className="cc-status-panel" aria-labelledby="cc-status-summary-title">
          <div className="cc-status-panel-head">
            <span className="cc-status-panel-icon"><LinesIcon /></span>
            <div className="cc-status-panel-title">
              <em>SERVER STATUS</em>
              <h2 id="cc-status-summary-title">中转线路概览</h2>
              <p>{subline}</p>
            </div>
            <span className="cc-status-tag">
              {state.kind === "loading" ? "读取中" : "实时状态待接入"}
            </span>
          </div>

          <div className="cc-status-metrics" aria-label="中转线路统计">
            {metrics.map((metric) => (
              <article className={metric.unknown ? "is-unknown" : ""} key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
                <small>{metric.hint}</small>
              </article>
            ))}
          </div>

          {state.kind === "loading" && <Skeleton label="正在读取已交付线路…" />}

          {/* 会话失效必须整页导航：SPA Link 会被旧的 authenticated 状态弹回 /dashboard。 */}
          {state.kind === "unauthorized" && (
            <StateBlock
              tone="alert"
              title="登录状态已失效"
              hint="重新登录后即可查看当前账户的中转线路名称；不会展示其他账户的任何线路。"
              action={<a className="cc-status-primary" href="/login">重新登录</a>}
            />
          )}

          {state.kind === "error" && (
            <StateBlock
              tone="alert"
              title={state.message}
              hint="不会回退到公开监控，也不会展示缓存或示例线路。网络恢复后可重新读取。"
              action={
                <button type="button" className="cc-status-primary" onClick={reload}>
                  重新加载
                </button>
              }
            />
          )}

          {ready && groups.length === 0 && (
            <StateBlock
              tone="empty"
              title="暂无已交付中转线路"
              hint="服务完成人工开通并填写买家可见线路名称后，会显示在这里；等待开通的服务不会提前显示线路。"
              action={<Link className="cc-status-primary" to="/services">查看当前套餐</Link>}
            />
          )}

          {ready && groups.length > 0 && (
            <>
              <ul className="cc-status-groups">
                {groups.map((group) => (
                  <li className="cc-status-group" key={group.orderRef}>
                    <div className="cc-status-group-head">
                      <div className="cc-status-group-ref">
                        <small>关联订单</small>
                        <strong>{group.orderRef}</strong>
                      </div>
                      <div className="cc-status-group-badges">
                        <span className="cc-status-badge is-open">已交付 {group.lines.length} 条</span>
                        <span className="cc-status-badge is-unknown">运行状态待接入</span>
                      </div>
                    </div>
                    <ul className="cc-status-lines">
                      {group.lines.map((line) => (
                        <li key={line.position}>
                          <span className="cc-status-line-index" aria-hidden="true">{line.position}</span>
                          <div className="cc-status-line-body">
                            <small>VPS 中转线路 {line.position}</small>
                            <strong>{line.label}</strong>
                          </div>
                          <span className="cc-status-line-state">运行状态待接入</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="cc-status-foot">
                以上仅为已交付线路的买家可见名称，不包含订阅地址、主机名、IP、面板地址或任何连接信息；线路条数也不代表在线节点数。
              </p>
            </>
          )}

          <div className="cc-status-boundary">
            <span className="cc-status-boundary-icon"><MonitorIcon /></span>
            <div>
              <strong>账户线路与公开监控相互独立</strong>
              <p>公开监控展示三网整体状态，不代表上述 VPS 中转线路的实时状态。</p>
            </div>
            <Link className="cc-status-ghost" to="/monitor">查看公开实时监控</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
