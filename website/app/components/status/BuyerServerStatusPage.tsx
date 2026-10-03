import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { readStatusLineParam } from "../../lib/buyerStatusLink";
import { useT, type Messages } from "../../lib/i18n";
import { getMyDeliveryLineListing } from "../../lib/payment-api";
import {
  getMonitorStatus,
  MonitorStatusAbortError,
  MonitorStatusApiError,
  type MonitorStatusProjection,
} from "../../lib/monitor-status-api";
import "./server-status.css";

type PageState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly projection: MonitorStatusProjection }
  | {
      readonly kind: "error";
      readonly tone: "empty" | "warning" | "danger";
      readonly title: string;
      readonly detail: string;
    };

export function monitorStatusErrorView(
  error: unknown,
  copy?: Messages["serverStatus"],
): Extract<PageState, { kind: "error" }> {
  if (copy !== undefined && error instanceof MonitorStatusApiError) {
    if (error.status === 404 && error.code === "line_not_found") {
      return { kind: "error", tone: "empty", title: copy.lineNotFoundTitle, detail: copy.lineNotFoundDetail };
    }
    if (error.status === 409 && error.code === "line_unbound") {
      return { kind: "error", tone: "warning", title: copy.lineUnboundTitle, detail: copy.lineUnboundDetail };
    }
  }
  if (!(error instanceof MonitorStatusApiError)) {
    return {
      kind: "error",
      tone: "danger",
      title: "服务器状态暂不可用",
      detail: "状态服务暂时无法连接，请稍后手动重试。",
    };
  }
  if (error.status === 401 && error.code === "unauthorized") {
    return {
      kind: "error",
      tone: "warning",
      title: "登录状态已失效",
      detail: "请重新登录后再查看服务器状态。",
    };
  }
  if (error.status === 403 && error.code === "forbidden") {
    return {
      kind: "error",
      tone: "warning",
      title: "当前账户不可使用此页面",
      detail: "管理员请继续使用现有管理工作流。",
    };
  }
  if (error.status === 404 && error.code === "no_eligible_service") {
    return {
      kind: "error",
      tone: "empty",
      title: "暂无可查看的服务器",
      detail: "当前账户还没有已支付并已开通的服务。",
    };
  }
  if (error.status === 409 && error.code === "monitor_unbound") {
    return {
      kind: "error",
      tone: "warning",
      title: "服务器监控尚未配置",
      detail: "已开通服务尚未绑定可用的监控目标，请联系支持人员。",
    };
  }
  if (error.status === 429 && error.code === "rate_limited") {
    return {
      kind: "error",
      tone: "warning",
      title: "检查次数过多",
      detail: "请稍后再手动重试。页面不会自动轮询。",
    };
  }
  if (
    error.code === "monitor_invalid_response" ||
    error.code === "invalid_request" ||
    error.code === "method_not_allowed"
  ) {
    return {
      kind: "error",
      tone: "danger",
      title: "服务器状态响应异常",
      detail: "返回内容未通过安全校验，本页未显示任何旧状态。",
    };
  }
  if (error.status === 504) {
    return {
      kind: "error",
      tone: "danger",
      title: "服务器状态请求超时",
      detail: "本次检查已停止，请稍后手动重试。",
    };
  }
  if (error.code === "monitor_unconfigured") {
    return {
      kind: "error",
      tone: "warning",
      title: "服务器状态服务未配置",
      detail: "账户监控投影尚未启用，本页不会改用公开监控或演示数据。",
    };
  }
  return {
    kind: "error",
    tone: "danger",
    title: "服务器状态暂不可用",
    detail: "状态服务暂时无法连接，请稍后手动重试。",
  };
}

function StatusGlyph({ status }: { status: MonitorStatusProjection["status"] }) {
  return (
    <span className={`cc-status-glyph is-${status}`} aria-hidden="true">
      <span />
    </span>
  );
}

function formattedUpdate(value: string): string {
  const parsed = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

/* This page makes one same-origin request per mount or manual retry. The target
   never enters browser state, URL parameters, headers, storage, or a public
   monitor origin; Auth derives it from the authenticated account. */
/* 线路名称只来自买家本人的 delivery-lines（只含名称）；读不到时显示通用「所选线路」，不影响状态查询。 */
function useLineLabel(line: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(null);
    if (line === null) return;
    const controller = new AbortController();
    const [kind, ref, position] = line.split(":");
    void getMyDeliveryLineListing(controller.signal)
      .then((listing) => {
        const match = kind === "service"
          ? listing.services.find((item) => item.orderRef === ref && String(item.position) === position)
          : listing.grants.find((item) => String(item.grantId) === ref && String(item.position) === position);
        if (match !== undefined) setLabel(match.label);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [line]);
  return label;
}

export function BuyerServerStatusPage() {
  const copy = useT().serverStatus;
  const lineParam = readStatusLineParam(useLocation().search);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const lineLabel = useLineLabel(lineParam === "invalid" ? null : lineParam);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: "loading" });

    // Deferring the start avoids React StrictMode's development-only first
    // setup/cleanup pass from issuing a duplicate mount request.
    void Promise.resolve().then(async () => {
      if (!active) return;
      try {
        if (lineParam === "invalid") throw new MonitorStatusApiError("line_not_found", 404);
        const projection = lineParam === null
          ? await getMonitorStatus(controller.signal)
          : await getMonitorStatus(controller.signal, undefined, lineParam);
        if (active) setState({ kind: "ready", projection });
      } catch (error) {
        if (!active || error instanceof MonitorStatusAbortError) return;
        setState(monitorStatusErrorView(error, copy));
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, lineParam]);

  const retry = () => {
    if (state.kind !== "loading") setAttempt((value) => value + 1);
  };

  return (
    <main className={`cc-status-page${lineParam !== null ? " has-line" : ""}`}>
      {lineParam !== null && (
        <nav className="cc-status-line" aria-label={copy.allServers}>
          <span>{lineLabel === null ? copy.viewingLineUnknown : copy.viewingLine(lineLabel)}</span>
          <Link to="/network">{copy.allServers}</Link>
        </nav>
      )}
      {state.kind === "loading" && (
        <section className="cc-status-state is-loading" role="status" aria-live="polite" aria-busy="true">
          <span className="cc-status-spinner" aria-hidden="true" />
          <strong>正在检查服务器状态</strong>
          <p>正在读取当前账户获准的状态投影…</p>
        </section>
      )}

      {state.kind === "ready" && (
        <section className={`cc-status-card is-${state.projection.status}`} aria-live="polite">
          <div className="cc-status-card-head">
            <StatusGlyph status={state.projection.status} />
            <div>
              <small>ACCOUNT SERVER</small>
              <h2>{state.projection.label}</h2>
            </div>
          </div>
          <div className="cc-status-result">
            <span>当前状态</span>
            <strong>
              {state.projection.status === "online"
                ? "在线"
                : state.projection.status === "offline"
                  ? "离线"
                  : "数据已过期"}
            </strong>
            <p>
              {state.projection.status === "stale"
                ? "最近状态已明确标记为过期，本页不会把它当作当前在线状态。"
                : "状态由账户授权投影返回，不包含目标地址、供应商或连接信息。"}
            </p>
          </div>
          <dl className="cc-status-meta">
            <div>
              <dt>最近更新</dt>
              <dd>{formattedUpdate(state.projection.updatedAt)}</dd>
            </div>
            <div>
              <dt>数据新鲜度</dt>
              <dd>{state.projection.stale ? "已过期" : "当前"}</dd>
            </div>
          </dl>
          <button className="cc-status-retry" type="button" onClick={retry}>
            手动刷新
          </button>
        </section>
      )}

      {state.kind === "error" && (
        <section
          className={`cc-status-state is-${state.tone}`}
          role={state.tone === "empty" ? "status" : "alert"}
          aria-live="polite"
        >
          <span className="cc-status-state-mark" aria-hidden="true">!</span>
          <strong>{state.title}</strong>
          <p>{state.detail}</p>
          <button className="cc-status-retry" type="button" onClick={retry}>
            手动重试
          </button>
        </section>
      )}
    </main>
  );
}
