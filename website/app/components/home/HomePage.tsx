import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useCatalogText, useT } from "../../lib/i18n";
import { useThemePreference } from "../../lib/theme";
import { regions } from "../../lib/subscribeCatalog";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";
import "./home.css";

/* UI-HOME-04 官网首页（TRUST PROOF PASS）。
   视觉继承 customer-center.css 的 --cc-* 令牌与 .cc-shell 基座，复用既有主题偏好，
   不改动 /subscribe、/dashboard、/login、/register 任何已冻结页面。

   事实纪律：
   - 网络类型与地区取自 app/lib/subscribeCatalog.ts，不新增或改写业务事实；
   - CN2 GIA / AS9929 / CMIN2 为总控提供的线路能力，按"去程与回程分别核验、
     可用性以实际方案与地区为准"表述，不给任何延迟、丢包、带宽或 SLA 数字；
   - 不编造在线率、节点数量、客户数量、成功率、客户评价或合作品牌；
   - Hero 诊断管线只表达"正在按流程逐项检查"，不展示任何 VERIFIED / 真实结果；
   - 全部控制台视觉均为 SCHEMATIC / DEMO 示意，数值一律 — 或"待接入 / 待实际检测"。 */

const ARROW = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <path d="M5 12h13M12 5.5 18.5 12 12 18.5" />
  </svg>
);

/* ---------- 01 HERO：诊断管线（示意；只有"检查中"游标，无 VERIFIED） ---------- */
/* 结构（顺序、编号、英文代号）留在组件；名称、说明与标签来自 i18n 字典。 */
const pipelineStages = [
  { code: "01", key: "LOCAL", id: "local" },
  { code: "02", key: "DNS", id: "dns" },
  { code: "03", key: "EGRESS", id: "egress" },
  { code: "04", key: "ROUTE", id: "route" },
  { code: "05", key: "TARGET", id: "target" },
] as const;

/* ---------- 02 DIAGNOSIS ---------- */
const checkIds = ["local", "dns", "egress", "dualStack", "udp", "latency", "platform"] as const;

const verdicts: { mark: string; id: "keep" | "optimize" | "replace"; accent?: boolean }[] = [
  { mark: "01", id: "keep" },
  { mark: "02", id: "optimize", accent: true },
  { mark: "03", id: "replace" },
];

/* ---------- 03 PREMIUM ROUTING：纵向双向拓扑 + 线路 segmented control ----------
   四层为通用网络分段（本地 / 骨干 / 出口 / 目标），不描述任何具体路由或真实 IP。
   三条线路为可切换能力项，切换只改变"精品骨干"层的线路标识，不出现任何性能数字。 */
const routeLines = [
  { id: "cn2gia", name: "CN2 GIA" },
  { id: "as9929", name: "AS9929" },
  { id: "cmin2", name: "CMIN2" },
] as const;

const pathLayers: { key: "local" | "backbone" | "egress" | "target"; premium?: boolean }[] = [
  { key: "local" },
  { key: "backbone", premium: true },
  { key: "egress" },
  { key: "target" },
];

/* ---------- 04 REAL RESIDENTIAL：三层环境核验档案 ----------
   住宅真实性靠多项环境事实交叉核验，而非一个 IP 数据库标签。
   状态一律"待实际检测"，不出现"已通过 / 验证通过"，不写 100% 真住宅等未批准事实。 */
const residentialGroups = [
  { no: "01", id: "source" },
  { no: "02", id: "consistency" },
  { no: "03", id: "delivery" },
] as const;

/* ---------- 05 OBSERVABILITY：产品视图（网络状态 / 线路质量 / 服务管理，全部为示意占位）
   三个视图忠实对齐仓库中真实的客户中心 Dashboard 与三网监控面板语言；
   本页不接实时数据，全部数值一律 —，并标注 CUSTOMER CENTER · DEMO。 */
type ConsoleView = {
  id: "network" | "route" | "service";
  kind: "latency" | "route" | "stats";
};

/* 逐跳表结构对应真实路由追踪字段；以下为虚构演示数据（非实时）：节点名为虚构称谓，
   ASN 取 RFC 5398 文档保留段，反向解析取 RFC 2606 保留域 example.net，不展示任何 IP。
   延迟为累计 ms；去程末跳与网络状态页“广州电信”当前值一致。 */
type DemoHopNode = "gateway" | "metro" | "premiumDomestic" | "premiumCross" | "landing";
type DemoHop = { node: DemoHopNode; ms: number; region: "gz" | "hk" | "sg"; asn: string; rdns: string; premium?: boolean };
const DEMO_ROUTES: Record<"outbound" | "return", readonly DemoHop[]> = {
  outbound: [
    { node: "gateway", ms: 1, region: "gz", asn: "AS64496", rdns: "gw1.access.example.net" },
    { node: "metro", ms: 4, region: "gz", asn: "AS64496", rdns: "agg2.metro.example.net" },
    { node: "premiumDomestic", ms: 7, region: "gz", asn: "AS64500", rdns: "pb-cn.backbone.example.net", premium: true },
    { node: "premiumCross", ms: 31, region: "hk", asn: "AS64500", rdns: "pb-x.backbone.example.net", premium: true },
    { node: "landing", ms: 38, region: "sg", asn: "AS64510", rdns: "edge1.landing.example.net" },
  ],
  return: [
    { node: "landing", ms: 1, region: "sg", asn: "AS64510", rdns: "edge1.landing.example.net" },
    { node: "premiumCross", ms: 30, region: "hk", asn: "AS64500", rdns: "pb-x.backbone.example.net", premium: true },
    { node: "premiumDomestic", ms: 35, region: "gz", asn: "AS64500", rdns: "pb-cn.backbone.example.net", premium: true },
    { node: "metro", ms: 38, region: "gz", asn: "AS64496", rdns: "agg2.metro.example.net" },
    { node: "gateway", ms: 39, region: "gz", asn: "AS64496", rdns: "gw1.access.example.net" },
  ],
};

/* 服务管理虚构演示数据（非实时）：用量 ≤ 总量，百分比由数值计算，不含价格或权益。 */
const DEMO_SERVICE = {
  services: { running: 3, total: 3 },
  usage: { used: 412, total: 1000 },
  expiryDays: 37,
  tickets: { open: 1, alerts: 0 },
  uptime: { days: 18, hours: 6 },
  memory: { used: 2.1, total: 4 },
  storage: { used: 23, total: 60 },
} as const;
const percentOf = (used: number, total: number) => Math.round((used / total) * 100);

const consoleViews: ConsoleView[] = [
  { id: "network", kind: "latency" },
  { id: "route", kind: "route" },
  { id: "service", kind: "stats" },
];

const AUTO_ADVANCE_MS = 7000;

/* ---------- 06 OPERATIONAL CHAIN ---------- */
const chainSteps = [
  { code: "01", id: "diagnose" },
  { code: "02", id: "judge" },
  { code: "03", id: "deliver" },
  { code: "04", id: "accept" },
  { code: "05", id: "view" },
] as const;


const regionCodes: Record<string, string> = {
  sg: "SG", jp: "JP", vn: "VN", my: "MY", kr: "KR", us: "US", tw: "TW", more: "···",
};

/* 地区场景标签（i18n 字典 home.regions.tags）：本地覆盖层，不改写 subscribeCatalog 的 badge 字段，
   用于首页展示更完整的场景描述。数量与措辞由业务侧确认，不含任何延迟/带宽/SLA 数字承诺。 */

/* 首页展示顺序：本地覆盖层，不改写 subscribeCatalog 数组本身的顺序。 */
const regionOrder = ["sg", "jp", "vn", "my", "kr", "tw", "us", "more"];

/* 通用 Tabs 键盘导航：左右 / Home / End，在给定 refs 数组内移动焦点并切换。 */
function makeTabKeyDown(
  count: number,
  active: number,
  setActive: (index: number) => void,
  refs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
) {
  return (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = count - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = active === last ? 0 : active + 1;
    if (event.key === "ArrowLeft") next = active === 0 ? last : active - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
}

/* 滚动进入视口时一次性淡入。默认可见，只有在允许动画时 JS 才标记为待揭示，
   因此 JS 失败或用户开启 reduced motion 时内容始终可读。 */
function useRevealOnce<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [phase, setPhase] = useState<"static" | "pending" | "done">("static");

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    setPhase("pending");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setPhase("done");
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, phase };
}

/* 精品线路展示：segmented control 切换三条线路，纵向双向拓扑随之更新"精品骨干"层标识。
   拓扑连接段的去/回程信号为低频克制动画，prefers-reduced-motion 下静止，不伪装真实实时路由。 */
function RouteShowcase() {
  const t = useT();
  const copy = t.home.routing;
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKeyDown = makeTabKeyDown(routeLines.length, active, setActive, tabRefs);
  const line = routeLines[active]!;

  return (
    <div className="home-routes">
      <div className="home-routes-tabs" role="tablist" aria-label={copy.tabsLabel}>
        {routeLines.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`route-tab-${item.id}`}
            aria-selected={index === active}
            aria-controls={`route-panel-${item.id}`}
            tabIndex={index === active ? 0 : -1}
            ref={(node) => { tabRefs.current[index] = node; }}
            className={index === active ? "is-active" : undefined}
            onClick={() => setActive(index)}
            onKeyDown={onTabKeyDown}
          >
            <strong>{item.name}</strong>
            <small>{copy.lines[item.id].carrier}</small>
          </button>
        ))}
      </div>

      <div
        className="home-routes-panel"
        role="tabpanel"
        id={`route-panel-${line.id}`}
        aria-labelledby={`route-tab-${line.id}`}
        key={line.id}
      >
        <div className="home-routes-cap">
          <strong>{line.name}</strong>
          <span className="home-nb">{copy.lines[line.id].carrier}</span>
          <em>{copy.lines[line.id].note}</em>
        </div>
        <div className="home-topo">
          {pathLayers.map((layer, index) => (
            <Fragment key={layer.key}>
              <div className={`home-topo-node${layer.premium ? " is-premium" : ""}`}>
                <span className="home-topo-dot" aria-hidden="true" />
                <div className="home-topo-copy">
                  <strong>{copy.layers[layer.key].label}</strong>
                  <small>{copy.layers[layer.key].note}</small>
                </div>
                {layer.premium ? (
                  <span className="home-topo-line">
                    {line.name}
                    <em>{copy.lines[line.id].carrier}</em>
                  </span>
                ) : null}
              </div>
              {index < pathLayers.length - 1 ? (
                <div className="home-topo-link" aria-hidden="true">
                  <span className="home-topo-rail">
                    <i className="home-topo-signal is-forward" />
                    <i className="home-topo-signal is-return" />
                  </span>
                  <span className="home-topo-dir"><b>{copy.forward}</b><b>{copy.return}</b></span>
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>

        <div className="home-routes-meta">
          {(["direction", "path", "landing", "fit"] as const).map((id) => (
            <div key={id}>
              <b>{copy.meta[id].label}</b>
              <span>{copy.meta[id].value}<em>{copy.meta[id].detail}</em></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 三网延迟虚构演示数据（非实时）：每条 17 个点 = 近 24 小时每 90 分钟一个点，末点即“现在”。
   曲线、当前值、24 小时平均与提示文字都由同一组数值计算，保证一致；不读取任何监控接口。
   曲线静态绘制（Catmull-Rom → 三次贝塞尔），横轴与 -24h…现在 刻度对齐。 */
const LATENCY_AXIS = { min: 30, max: 70 } as const;
const DEMO_LATENCY: readonly { samples: readonly number[]; loss: string; health: "ok" | "watch" }[] = [
  { samples: [37, 36, 35, 37, 39, 41, 40, 38, 36, 35, 37, 42, 44, 41, 39, 37, 38], loss: "0.1%", health: "ok" },    // 电信
  { samples: [48, 46, 44, 47, 50, 53, 55, 52, 49, 47, 48, 54, 58, 56, 52, 49, 47], loss: "0.3%", health: "ok" },    // 联通
  { samples: [55, 52, 50, 55, 58, 61, 57, 54, 52, 56, 63, 66, 62, 59, 57, 55, 58], loss: "0.8%", health: "watch" }, // 移动
];

// y 为 viewBox 高 22 内的纵坐标（越小越高），按 LATENCY_AXIS 线性映射。
function latencyCurvePath(samples: readonly number[]): string {
  const span = LATENCY_AXIS.max - LATENCY_AXIS.min;
  const points = samples.map((ms, index): [number, number] => [
    (index / (samples.length - 1)) * 100,
    2 + ((LATENCY_AXIS.max - ms) / span) * 18,
  ]);
  const at = (index: number) => points[Math.min(Math.max(index, 0), points.length - 1)]!;
  let d = `M${points[0]![0]},${points[0]![1].toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = at(index - 1);
    const [x1, y1] = at(index);
    const [x2, y2] = at(index + 1);
    const [x3, y3] = at(index + 2);
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  }
  return d;
}

const LATENCY_ROWS = DEMO_LATENCY.map((row) => ({
  ...row,
  path: latencyCurvePath(row.samples),
  now: row.samples[row.samples.length - 1]!,
  avg: Math.round(row.samples.reduce((sum, ms) => sum + ms, 0) / row.samples.length),
}));

/* 控制台展示：Tabs + 慢速自动切换。hover / focus 暂停，键盘可操作，
   prefers-reduced-motion 下关闭自动切换。 */
function ConsoleShowcase() {
  const t = useT();
  const copy = t.home.observability;
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [direction, setDirection] = useState<"outbound" | "return">("outbound");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKeyDown = makeTabKeyDown(consoleViews.length, active, setActive, tabRefs);

  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setTimeout(
      () => setActive((current) => (current + 1) % consoleViews.length),
      AUTO_ADVANCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, paused]);

  const view = consoleViews[active]!;
  const viewCopy = copy.views[view.id];

  return (
    <div
      className="home-showcase"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="home-showcase-bar">
        <span className="home-console-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="home-showcase-title">{copy.barTitle(viewCopy.label)}</span>
        <span className="home-chip is-demo">{copy.previewChip}</span>
      </div>

      <div className="home-showcase-tabs" role="tablist" aria-label={copy.tabsLabel}>
        {consoleViews.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`showcase-tab-${item.id}`}
            aria-selected={index === active}
            aria-controls={`showcase-panel-${item.id}`}
            tabIndex={index === active ? 0 : -1}
            ref={(node) => { tabRefs.current[index] = node; }}
            className={index === active ? "is-active" : undefined}
            onClick={() => setActive(index)}
            onKeyDown={onTabKeyDown}
          >
            <em>{String(index + 1).padStart(2, "0")}</em>
            {copy.views[item.id].label}
          </button>
        ))}
      </div>

      <div
        className="home-showcase-panel"
        role="tabpanel"
        id={`showcase-panel-${view.id}`}
        aria-labelledby={`showcase-tab-${view.id}`}
        key={view.id}
      >
        {/* 网络状态：三网延迟曲线 + 24h 窗口刻度，虚构演示数据（非实时） */}
        {view.kind === "latency" ? (
          <div className="home-latency">
            <div className="home-latency-head">
              <b>{copy.latencyTitle}</b>
              <span>{copy.latencyWindow}</span>
            </div>
            {copy.views.network.rows.map((row, index) => {
              const data = LATENCY_ROWS[index % LATENCY_ROWS.length]!;
              const health = copy.health[data.health];
              return (
                <div
                  className="home-latency-row"
                  key={row}
                  data-line={index}
                  title={copy.latencyTip(row, data.now, data.avg, data.loss, health)}
                >
                  <span className="home-latency-name">
                    <i aria-hidden="true" />
                    <span>
                      {row}
                      <em className={`home-latency-health is-${data.health}`}>{health}</em>
                    </span>
                  </span>
                  <span className="home-latency-track" aria-hidden="true">
                    <svg className="home-latency-curve" viewBox="0 0 100 22" preserveAspectRatio="none" focusable="false">
                      <path d={data.path} />
                    </svg>
                  </span>
                  <span className="home-latency-value">
                    <b>{data.now} ms</b>
                    <small>{copy.lossValue(data.loss)}</small>
                  </span>
                </div>
              );
            })}
            <div className="home-latency-axis" aria-hidden="true">
              <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>{copy.now}</span>
            </div>
            <p className="home-latency-legend">{copy.latencyLegend(LATENCY_AXIS.min, LATENCY_AXIS.max)}</p>
          </div>
        ) : null}

        {/* 线路质量：去/回程逐跳字段结构对应真实路由追踪；虚构演示数据，不展示任何 IP */}
        {view.kind === "route" ? (
          <div className="home-route">
            <div className="home-route-head">
              <span className="home-route-dir" role="group" aria-label={copy.directionLabel}>
                {(["outbound", "return"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`home-chip${direction === item ? " is-accent" : ""}`}
                    aria-pressed={direction === item}
                    onClick={() => setDirection(item)}
                  >
                    {item === "outbound" ? copy.forward : copy.return}
                  </button>
                ))}
              </span>
              <span className="home-chip is-muted">ICMP / TCP</span>
              <em>{copy.premiumHint}</em>
            </div>
            <p className="home-route-sample">{copy.routeSample[direction]}</p>
            <div className="home-route-table" role="table" aria-label={`${copy.routeTableLabel} · ${copy.routeSample[direction]}`}>
              <div className="home-route-row is-head" role="row">
                <span role="columnheader">{copy.columns.hop}</span>
                <span role="columnheader">{copy.columns.node}</span>
                <span role="columnheader">{copy.columns.latency}</span>
                <span role="columnheader">{copy.columns.region}</span>
                <span role="columnheader">{copy.columns.asn}</span>
                <span role="columnheader">{copy.columns.reverse}</span>
              </div>
              {DEMO_ROUTES[direction].map((hop, index) => (
                <div className={`home-route-row${hop.premium ? " is-premium" : ""}`} role="row" key={`${direction}-${hop.node}`}>
                  <span role="cell">{String(index + 1).padStart(2, "0")}</span>
                  <span role="cell">{copy.hopNodes[hop.node]}</span>
                  <span role="cell">{hop.ms} ms</span>
                  <span role="cell">{copy.hopRegions[hop.region]}</span>
                  <span role="cell">{hop.asn}</span>
                  <span role="cell">{hop.rdns}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 服务管理：对齐客户中心 Dashboard 的 OVERVIEW 概览 + SYSTEM 系统状态，虚构演示数据（非实时） */}
        {view.kind === "stats" ? (
          <div className="home-showcase-split">
            <div className="home-showcase-stats">
              {[
                { value: copy.servicesValue(DEMO_SERVICE.services.total), sub: copy.servicesSub(DEMO_SERVICE.services.running, DEMO_SERVICE.services.total) },
                {
                  value: `${DEMO_SERVICE.usage.used} GB`,
                  sub: copy.usageSub(DEMO_SERVICE.usage.total, percentOf(DEMO_SERVICE.usage.used, DEMO_SERVICE.usage.total)),
                  meter: percentOf(DEMO_SERVICE.usage.used, DEMO_SERVICE.usage.total),
                },
                { value: copy.daysValue(DEMO_SERVICE.expiryDays), sub: copy.expirySub },
                { value: `${DEMO_SERVICE.tickets.open} · ${DEMO_SERVICE.tickets.alerts}`, sub: copy.ticketsSub(DEMO_SERVICE.tickets.open, DEMO_SERVICE.tickets.alerts) },
              ].map((stat, index) => (
                <div className="home-preview-stat" key={copy.views.service.stats[index]}>
                  <span>{copy.views.service.stats[index]}</span>
                  <b>{stat.value}</b>
                  {stat.meter !== undefined ? (
                    <i className="home-preview-meter" aria-hidden="true"><i style={{ width: `${stat.meter}%` }} /></i>
                  ) : null}
                  <small>{stat.sub}</small>
                </div>
              ))}
            </div>
            <div className="home-preview-panel">
              <b><em>SYSTEM</em>{copy.systemStatus}</b>
              <div className="home-preview-rows">
                {[
                  copy.uptimeValue(DEMO_SERVICE.uptime.days, DEMO_SERVICE.uptime.hours),
                  `${DEMO_SERVICE.memory.used.toFixed(1)} / ${DEMO_SERVICE.memory.total.toFixed(1)} GB · ${percentOf(DEMO_SERVICE.memory.used, DEMO_SERVICE.memory.total)}%`,
                  `${DEMO_SERVICE.storage.used} / ${DEMO_SERVICE.storage.total} GB · ${percentOf(DEMO_SERVICE.storage.used, DEMO_SERVICE.storage.total)}%`,
                ].map((value, index) => (
                  <div key={copy.views.service.rows[index]}><span>{copy.views.service.rows[index]}</span><b>{value}</b></div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <p className="home-preview-note"><i aria-hidden="true" />{copy.previewNote(viewCopy.caption)}</p>
      </div>
    </div>
  );
}

export function HomePage() {
  const { theme, toggleTheme } = useThemePreference();
  const t = useT();
  const ct = useCatalogText();
  const copy = t.home;
  const diagnosis = useRevealOnce<HTMLDivElement>();

  return (
    <div className="cc-shell cc-home" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main id="home-main" tabIndex={-1}>
        {/* ================= 01 HERO ================= */}
        <section className="home-hero">
          <div className="home-wrap home-hero-grid">
            <div className="home-hero-copy">
              <span className="home-hero-badge">
                <i aria-hidden="true" />
                {copy.hero.badge}
              </span>
              <h1>
                {copy.hero.titleLine1}
                <br />
                {copy.hero.titleBefore}<em>{copy.hero.titleEmphasis}</em>{copy.hero.titleAfter}
              </h1>
              <p className="home-hero-lead">{copy.hero.lead}</p>
              <div className="home-cta-row">
                <Link to="/diagnosis" className="home-btn home-btn-secondary">{copy.hero.startDiagnosis}</Link>
                <Link to="/subscribe" className="home-btn home-btn-primary">
                  {copy.hero.viewPlans}
                  {ARROW}
                </Link>
              </div>
              <p className="home-hero-note">{copy.hero.note}</p>
            </div>

            {/* Signature visual 01：诊断管线（示意，只有一个"检查中"游标，无 VERIFIED） */}
            <div className="home-pipeline" aria-label={copy.pipeline.ariaLabel}>
              <span className="home-pipeline-grid" aria-hidden="true" />
              <div className="home-pipeline-inner">
                <div className="home-pipeline-head">
                  <span className="home-console-dots" aria-hidden="true"><i /><i /><i /></span>
                  <b>DIAGNOSTIC PIPELINE</b>
                </div>

                <div className="home-pipeline-body">
                  {pipelineStages.map((stage) => (
                    <div className="home-stage" key={stage.key}>
                      <span className="home-stage-node" aria-hidden="true" />
                      <span className="home-stage-code">{stage.code}</span>
                      <span className="home-stage-copy">
                        <strong>{stage.key}<i>{copy.pipeline.stages[stage.id].name}</i></strong>
                        <small>{copy.pipeline.stages[stage.id].note}</small>
                      </span>
                      <span className="home-stage-tags">
                        {copy.pipeline.stages[stage.id].tags.map((tag) => (
                          <span className="home-chip" key={tag}>{tag}</span>
                        ))}
                      </span>
                      <span className="home-stage-state" aria-hidden="true">
                        <i className="is-pending">{copy.pipeline.pending}</i>
                        <i className="is-checking">{copy.pipeline.checking}</i>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="home-pipeline-foot">
                  <span><i aria-hidden="true" />{copy.pipeline.foot}</span>
                  <b>—</b>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= 02 DIAGNOSIS ================= */}
        <section className="home-section" id="diagnosis">
          <div className="home-wrap">
            <div className="home-section-head">
              <p className="home-eyebrow"><i aria-hidden="true" />DIAGNOSIS</p>
              <h2>{copy.diagnosis.title}</h2>
              <p className="home-section-lead">{copy.diagnosis.lead}</p>
            </div>

            <div className="home-system" ref={diagnosis.ref} data-reveal={diagnosis.phase}>
              <div className="home-system-head">
                <span className="home-system-step">{copy.diagnosis.stepCheck}</span>
                <span className="home-system-arrow" aria-hidden="true" />
                <span className="home-system-step">{copy.diagnosis.stepJudge}</span>
                <span className="home-system-arrow" aria-hidden="true" />
                <span className="home-system-step is-end">{copy.diagnosis.stepConclude}</span>
                <span className="home-system-meta">{copy.diagnosis.meta(checkIds.length)}</span>
              </div>
              <div className="home-system-body">
                <div className="home-matrix">
                  {checkIds.map((id, index) => (
                    <div className="home-matrix-row" key={id}>
                      <span className="home-matrix-index">{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <strong>{copy.diagnosis.checks[id].name}</strong>
                        <small>{copy.diagnosis.checks[id].detail}</small>
                      </span>
                      <span className="home-matrix-tags">
                        {copy.diagnosis.checks[id].tags.map((tag) => (
                          <span className="home-chip" key={tag}>{tag}</span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="home-verdict">
                  <b>{copy.diagnosis.verdictTitle}</b>
                  <p>{copy.diagnosis.verdictLead}</p>
                  {verdicts.map((verdict) => (
                    <div className={`home-verdict-item${verdict.accent ? " is-accent" : ""}`} key={verdict.mark}>
                      <span className="home-verdict-mark">{verdict.mark}</span>
                      <span>
                        <strong>{copy.diagnosis.verdicts[verdict.id].title}</strong>
                        <small>{copy.diagnosis.verdicts[verdict.id].detail}</small>
                      </span>
                    </div>
                  ))}
                  <p className="home-verdict-foot">{copy.diagnosis.verdictFoot}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= 03 PREMIUM ROUTING（深色带） ================= */}
        <section className="home-section is-console home-routing">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />PREMIUM ROUTING</p>
                <h2>{copy.routing.title}</h2>
                <p className="home-section-lead">{copy.routing.lead}</p>
              </div>
              <span className="home-console-tag">BIDIRECTIONAL · SCHEMATIC</span>
            </div>

            {/* 先讲人话：为什么要看双向 */}
            <div className="home-routing-lead">
              <strong>{copy.routing.plainTitle}</strong>
              <p>
                {copy.routing.plainBody}<em>{copy.routing.plainEmphasis}</em>{copy.routing.plainEnd}
              </p>
            </div>

            {/* Signature visual 02：纵向双向拓扑 + 三条线路 segmented control */}
            <RouteShowcase />

            <p className="home-routing-note">
              <span className="home-nb">CN2 GIA</span> / <span className="home-nb">AS9929</span> / <span className="home-nb">CMIN2</span>
              {copy.routing.noteMiddle}<span className="home-nb">{copy.routing.noteDirections}</span>{copy.routing.noteEnd}
            </p>
          </div>
        </section>

        {/* ================= 04 REAL RESIDENTIAL ================= */}
        <section className="home-section">
          <div className="home-wrap">
            <div className="home-section-head">
              <p className="home-eyebrow"><i aria-hidden="true" />REAL RESIDENTIAL</p>
              <h2>{copy.residential.title}</h2>
              <p className="home-section-lead">{copy.residential.lead}</p>
            </div>

            <div className="home-dossier">
              <div className="home-dossier-bar">
                <b>{copy.residential.dossierTitle}</b>
                <span className="home-console-tag">{copy.residential.dossierTag}</span>
              </div>

              <div className="home-dossier-lead">
                <span className="home-dossier-tag" aria-hidden="true">{copy.residential.labelTag}</span>
                <p>
                  <b>{copy.residential.labelStrong}</b>
                  {copy.residential.labelBody}
                </p>
              </div>

              <div className="home-dossier-grid">
                {residentialGroups.map((group) => {
                  const groupCopy = copy.residential.groups[group.id];
                  return (
                  <section className="home-dossier-col" key={group.no} aria-label={groupCopy.title}>
                    <div className="home-dossier-head">
                      <span className="home-dossier-no">{group.no}</span>
                      <div>
                        <strong>{groupCopy.title}</strong>
                        <small>{groupCopy.caption}</small>
                      </div>
                    </div>
                    <span className="home-dossier-verify"><i aria-hidden="true" />{copy.residential.verifyEach}</span>
                    <div className="home-dossier-items">
                      {groupCopy.items.map((item) => (
                        <div className="home-dossier-item" key={item.name}>
                          <strong>{item.name}</strong>
                          <small>{item.detail}</small>
                        </div>
                      ))}
                    </div>
                  </section>
                  );
                })}
              </div>

              <div className="home-dossier-foot">
                <p>
                  <b>{copy.residential.footStrong}</b>
                  {copy.residential.footBody}
                </p>
              </div>
            </div>

            <div className="home-residential-note">
              <p>{copy.residential.note}</p>
              <Link to="/subscribe" className="home-text-link">{copy.residential.viewPlans}{ARROW}</Link>
            </div>
          </div>
        </section>

        {/* ================= 05 OBSERVABILITY（深色带） ================= */}
        <section className="home-section is-console home-observability" id="observability">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />OBSERVABILITY</p>
                <h2>{copy.observability.title}</h2>
                <p className="home-section-lead">{copy.observability.lead}</p>
              </div>
              <span className="home-console-tag">CUSTOMER CENTER · PRODUCT PREVIEW</span>
            </div>

            {/* Signature visual 03：客户中心产品视图（网络状态 / 线路质量 / 服务管理） */}
            <ConsoleShowcase />
          </div>
        </section>

        {/* ================= 06 OPERATIONAL CHAIN（安静过渡） ================= */}
        <section className="home-section home-chain-section">
          <div className="home-wrap">
            <div className="home-section-head">
              <p className="home-eyebrow"><i aria-hidden="true" />OPERATIONAL CHAIN</p>
              <h2>{copy.chain.title}</h2>
            </div>

            <div className="home-chain">
              {chainSteps.map((step, index) => (
                <div className={`home-chain-step${index === 0 ? " is-accent" : ""}`} key={step.code}>
                  <span className="home-chain-node" aria-hidden="true" />
                  <span className="home-chain-code">{step.code}</span>
                  <strong>{copy.chain.steps[step.id].title}</strong>
                  <small>{copy.chain.steps[step.id].detail}</small>
                </div>
              ))}
            </div>

            <div className="home-standard">
              <b>{copy.chain.standardTitle}</b>
              <p>{copy.chain.standardBody}</p>
            </div>
          </div>
        </section>

        {/* ================= 08 REGIONS（次级） ================= */}
        <section className="home-section home-secondary">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />REGIONS</p>
                <h2>{copy.regions.title}</h2>
              </div>
              <span className="home-section-aside">{copy.regions.aside}</span>
            </div>

            <div className="home-coverage">
              <div className="home-regions">
                {regionOrder.flatMap((id) => {
                  const region = regions.find((item) => item.id === id);
                  if (!region) return [];
                  const tags = copy.regions.tags[region.id];
                  return (
                    <div className={`home-region${region.id === "more" ? " is-more" : ""}`} key={region.id}>
                      <div className="home-region-top">
                        <span className={`home-flag is-${region.flagClass}`} aria-hidden="true" />
                        <span className="home-region-copy">
                          <strong>{ct(region.name)}<em>{regionCodes[region.id] ?? ""}</em></strong>
                        </span>
                      </div>
                      {tags ? (
                        <div className="home-region-tags">
                          {tags.map((tag) => (
                            <span className="home-chip" key={tag}>{tag}</span>
                          ))}
                        </div>
                      ) : (
                        <small className="home-region-note">{region.badge ? ct(region.badge) : "—"}</small>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* ================= FINAL CTA ================= */}
        <section className="home-final">
          <div className="home-wrap">
            <div className="home-final-card">
              <h2>{copy.final.title}</h2>
              <p>{copy.final.body}</p>
              <div className="home-cta-row">
                <a href="#diagnosis" className="home-btn home-btn-secondary">{copy.final.learnDiagnosis}</a>
                <Link to="/subscribe" className="home-btn home-btn-primary">
                  {copy.final.viewPlans}
                  {ARROW}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
