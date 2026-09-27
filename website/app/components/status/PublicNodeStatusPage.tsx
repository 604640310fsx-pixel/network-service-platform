import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThemePreference } from "../../lib/theme";
import { WorkbenchBanner, workbenchBannerLayoutClass } from "../WorkbenchBanner";
import { SiteHeader } from "../home/SiteHeader";
import { SiteFooter } from "../home/SiteFooter";
import {
  formatPercent,
  formatRate,
  formatUpdatedAt,
  formatUptime,
  nodeStatusApiOrigin,
  nodeStatusLabel,
  nodeStatusUrl,
  nodeTargetsUrl,
  parseNodeStatus,
  parseNodeTargets,
  type NodeStatusTarget,
  type NodeStatusView,
} from "../../lib/public-node-status";
import "../home/home.css";
import "./server-status.css";
import "./public-node-status.css";

/* 公开 /status：官网统一风格的节点服务器状态页（游客与登录用户看到同一页面）。
   数据取自 VITE_MONITOR_URL 所在监控 origin 的只读接口，每 30 秒在页面可见时刷新；
   失败时保留上一次真实结果并明确标注，从未成功时显示真实错误态，不回退演示数据。 */

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

type NodeRow = { readonly target: NodeStatusTarget; readonly status: NodeStatusView };

type PageState =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly rows: readonly NodeRow[]; readonly syncFailed: boolean };

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

async function loadNodes(apiOrigin: string, signal: AbortSignal): Promise<NodeRow[]> {
  const targets = parseNodeTargets(await getJson(nodeTargetsUrl(apiOrigin), signal));
  const statuses = await Promise.allSettled(
    targets.map(async (target) => parseNodeStatus(await getJson(nodeStatusUrl(apiOrigin, target.name), signal))),
  );
  return targets.map((target, index) => {
    const result = statuses[index];
    return { target, status: result.status === "fulfilled" ? result.value : parseNodeStatus(null) };
  });
}

function Metric({ label, value, percent }: { label: string; value: string; percent?: number | null }) {
  return (
    <div className="pns-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {percent !== undefined && (
        <span className="pns-meter" aria-hidden="true">
          <i style={{ width: `${percent ?? 0}%` }} />
        </span>
      )}
    </div>
  );
}

function NodeCard({ row }: { row: NodeRow }) {
  const { target, status } = row;
  const glyph = status.kind === "unavailable" ? "unknown" : status.kind;
  return (
    <article className={`pns-card is-${status.kind}`}>
      <header className="pns-card-head">
        <span className={`cc-status-glyph is-${glyph}`} aria-hidden="true">
          <span />
        </span>
        <div>
          <small>NODE</small>
          <h2>{target.displayName}</h2>
        </div>
        <strong className="pns-state">{nodeStatusLabel(status.kind)}</strong>
      </header>
      <dl className="pns-metrics">
        <Metric label="CPU" value={formatPercent(status.cpuPercent)} percent={status.cpuPercent} />
        <Metric label="内存" value={formatPercent(status.memoryPercent)} percent={status.memoryPercent} />
        <Metric label="磁盘" value={formatPercent(status.storagePercent)} percent={status.storagePercent} />
        <Metric label="上行" value={formatRate(status.uploadBytesPerSecond)} />
        <Metric label="下行" value={formatRate(status.downloadBytesPerSecond)} />
        <Metric label="运行时间" value={formatUptime(status.uptimeSeconds)} />
      </dl>
      <p className="pns-updated">最近更新 {formatUpdatedAt(status.updatedAt)}</p>
    </article>
  );
}

export function PublicNodeStatusPage() {
  const { theme, toggleTheme } = useThemePreference();
  const apiOrigin = useMemo(
    () => nodeStatusApiOrigin(import.meta.env.VITE_MONITOR_URL, window.location.origin),
    [],
  );
  const [state, setState] = useState<PageState>(apiOrigin ? { kind: "loading" } : { kind: "unconfigured" });
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!apiOrigin || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setRefreshing(true);
    try {
      const rows = await loadNodes(apiOrigin, controller.signal);
      setState({ kind: "ready", rows, syncFailed: false });
    } catch {
      setState((previous) =>
        previous.kind === "ready" ? { ...previous, syncFailed: true } : { kind: "error" },
      );
    } finally {
      window.clearTimeout(timer);
      if (controllerRef.current === controller) controllerRef.current = null;
      setRefreshing(false);
    }
  }, [apiOrigin]);

  useEffect(() => {
    if (!apiOrigin) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [apiOrigin, refresh]);

  const rows = state.kind === "ready" ? state.rows : [];
  const online = rows.filter((row) => row.status.kind === "online").length;
  const offline = rows.filter((row) => row.status.kind === "offline").length;

  const banner =
    state.kind === "ready" && !state.syncFailed
      ? { statusLabel: "实时数据同步", badge: "LIVE · 30S" }
      : state.kind === "ready" || state.kind === "error"
        ? { statusLabel: "同步失败", badge: "RETRY" }
        : state.kind === "loading"
          ? { statusLabel: "正在读取", badge: "—" }
          : { statusLabel: "未配置", badge: "—" };

  return (
    <div className="cc-shell cc-home pns-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main className="pns-main">
        <section className={workbenchBannerLayoutClass}>
          <WorkbenchBanner
            kicker="SERVER STATUS"
            title="服务器状态"
            description="查看各节点服务器的在线状态与资源占用"
            statusLabel={banner.statusLabel}
            badge={banner.badge}
          />
        </section>

        <section className="pns-page" aria-live="polite">
          {state.kind === "unconfigured" && (
            <div className="cc-status-state is-warning" role="status">
              <strong>状态服务未配置</strong>
              <p>监控地址尚未配置，配置后此处将显示各节点服务器状态。</p>
            </div>
          )}

          {state.kind === "loading" && (
            <div className="cc-status-state is-loading" role="status" aria-busy="true">
              <span className="cc-status-spinner" aria-hidden="true" />
              <strong>正在读取服务器状态</strong>
              <p>首次读取可能需要几秒钟。</p>
            </div>
          )}

          {state.kind === "error" && (
            <div className="cc-status-state is-danger" role="alert">
              <span className="cc-status-state-mark" aria-hidden="true">!</span>
              <strong>服务器状态暂不可用</strong>
              <p>状态服务暂时无法连接，本页不会显示演示或旧数据。</p>
              <button className="cc-status-retry" type="button" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "正在重试…" : "手动重试"}
              </button>
            </div>
          )}

          {state.kind === "ready" && (
            <>
              <div className="pns-toolbar">
                <p>
                  共 {rows.length} 个节点 · 在线 {online} · 离线 {offline}
                  {state.syncFailed && <em>最近一次刷新失败，以下为上次成功读取的数据</em>}
                </p>
                <button className="cc-status-retry" type="button" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing ? "刷新中…" : "手动刷新"}
                </button>
              </div>
              {rows.length === 0 ? (
                <div className="cc-status-state is-empty" role="status">
                  <strong>暂无节点</strong>
                  <p>监控目录中还没有可显示的节点。</p>
                </div>
              ) : (
                <div className="pns-grid">
                  {rows.map((row) => (
                    <NodeCard key={row.target.name} row={row} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
