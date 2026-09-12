import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useThemePreference } from "../../lib/theme";
import { networkTypes, regions } from "../../lib/subscribeCatalog";
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
const pipelineStages = [
  { code: "01", key: "LOCAL", zh: "本地网络", note: "客户侧出口与基础连通性", tags: ["连通性", "MTU"] },
  { code: "02", key: "DNS", zh: "DNS 解析", note: "解析结果是否与出口一致", tags: ["DNS"] },
  { code: "03", key: "EGRESS", zh: "出口环境", note: "出口归属与网络类型判定", tags: ["IPv4", "IPv6"] },
  { code: "04", key: "ROUTE", zh: "线路质量", note: "双向链路稳定性与协议能力", tags: ["UDP", "双向"] },
  { code: "05", key: "TARGET", zh: "目标平台", note: "业务侧可达性核对", tags: ["可达性"] },
] as const;

/* ---------- 02 DIAGNOSIS ---------- */
const checks = [
  { name: "本地网络", detail: "本机出口、MTU 与基础连通性是否正常", tags: ["连通性", "MTU"] },
  { name: "DNS 一致性", detail: "解析结果是否与实际出口环境一致", tags: ["DNS", "一致性"] },
  { name: "出口环境", detail: "出口归属与网络类型判定", tags: ["出口", "归属"] },
  { name: "IPv4 / IPv6", detail: "双栈可用性与实际优先级", tags: ["IPv4", "IPv6"] },
  { name: "UDP 能力", detail: "UDP 通行情况与协议层限制", tags: ["UDP", "QUIC"] },
  { name: "延迟与丢包", detail: "链路稳定性、抖动与丢包表现", tags: ["延迟", "丢包"] },
  { name: "平台可达性", detail: "目标业务平台的可达性与环境一致性", tags: ["可达性"] },
] as const;

const verdicts: { mark: string; title: string; detail: string; accent?: boolean }[] = [
  { mark: "01", title: "无需更换网络", detail: "问题出在本地环境或配置，调整后即可恢复。" },
  { mark: "02", title: "局部优化", detail: "线路或协议能力不足，针对具体环节优化。", accent: true },
  { mark: "03", title: "更换方案", detail: "当前网络环境不满足业务要求，更换类型或地区。" },
];

/* ---------- 03 PREMIUM ROUTING：纵向双向拓扑 + 线路 segmented control ----------
   四层为通用网络分段（本地 / 骨干 / 出口 / 目标），不描述任何具体路由或真实 IP。
   三条线路为可切换能力项，切换只改变"精品骨干"层的线路标识，不出现任何性能数字。 */
const routeLines = [
  { id: "cn2gia", name: "CN2 GIA", carrier: "中国电信", note: "电信精品线路能力" },
  { id: "as9929", name: "AS9929", carrier: "中国联通", note: "联通精品线路能力" },
  { id: "cmin2", name: "CMIN2", carrier: "中国移动", note: "移动精品线路能力" },
] as const;

const pathLayers: { key: string; label: string; note: string; premium?: boolean }[] = [
  { key: "local", label: "客户本地网络", note: "本地接入 · 客户侧" },
  { key: "backbone", label: "双向精品骨干", note: "跨境骨干 · 精品线路作用段", premium: true },
  { key: "egress", label: "海外地区出口", note: "目标地区落地" },
  { key: "target", label: "目标业务环境", note: "平台 / 业务侧" },
];

/* ---------- 04 REAL RESIDENTIAL：三层环境核验档案 ----------
   住宅真实性靠多项环境事实交叉核验，而非一个 IP 数据库标签。
   状态一律"待实际检测"，不出现"已通过 / 验证通过"，不写 100% 真住宅等未批准事实。 */
const residentialGroups: {
  no: string;
  title: string;
  caption: string;
  items: { name: string; detail: string }[];
}[] = [
  {
    no: "01",
    title: "接入来源",
    caption: "这条网络从哪里接入",
    items: [
      { name: "接入类型", detail: "实际家庭宽带 / 住宅 ISP 接入" },
      { name: "实际运营商", detail: "接入的本地 ISP 归属" },
      { name: "地区匹配", detail: "业务所在地与目标平台匹配" },
    ],
  },
  {
    no: "02",
    title: "环境一致性",
    caption: "网络行为是否自洽",
    items: [
      { name: "DNS 一致性", detail: "解析结果是否与出口一致" },
      { name: "UDP 能力", detail: "UDP 通行与协议层限制" },
      { name: "IPv4 / IPv6", detail: "双栈可用性与实际优先级" },
      { name: "共享 / 独享", detail: "共享程度与独享规格可选" },
    ],
  },
  {
    no: "03",
    title: "交付核验",
    caption: "交付前实际验证",
    items: [
      { name: "双向线路", detail: "去程与回程的链路质量" },
      { name: "平台可达性", detail: "目标业务平台可达性核对" },
      { name: "交付前实际检测", detail: "按同一维度实测后交付" },
      { name: "适用性判断", detail: "是否满足该业务场景" },
    ],
  },
];

/* ---------- 05 OBSERVABILITY：产品视图（网络状态 / 线路质量 / 服务管理，全部为示意占位）
   三个视图忠实对齐仓库中真实的客户中心 Dashboard 与三网监控面板语言；
   本页不接实时数据，全部数值一律 —，并标注 CUSTOMER CENTER · DEMO。 */
type ConsoleView = {
  id: string;
  label: string;
  caption: string;
  kind: "latency" | "route" | "stats";
  stats?: string[];
  rows?: string[];
};

/* 逐跳表结构对应真实路由追踪字段；跳序号仅为行号，其余一律 —，不展示任何真实 IP。 */
const routeHops = [
  { hop: "01", premium: false },
  { hop: "02", premium: false },
  { hop: "03", premium: true },
  { hop: "04", premium: true },
  { hop: "05", premium: false },
] as const;

const consoleViews: ConsoleView[] = [
  {
    id: "network",
    label: "网络状态",
    caption: "网络状态待接入 · 非实时数据",
    kind: "latency",
    rows: ["广州电信", "广州联通", "广州移动"],
  },
  {
    id: "route",
    label: "线路质量",
    caption: "已接入线路信息预览 · 非实时数据",
    kind: "route",
  },
  {
    id: "service",
    label: "服务管理",
    caption: "已接入服务信息；用量与系统状态待接入",
    kind: "stats",
    stats: ["已接入服务", "本月用量（待接入）", "最近到期", "工单与告警（待接入）"],
    rows: ["运行时间（待接入）", "内存（待接入）", "存储（待接入）"],
  },
];

const AUTO_ADVANCE_MS = 7000;

/* ---------- 06 OPERATIONAL CHAIN ---------- */
const chainSteps = [
  { code: "01", title: "诊断", detail: "按固定维度采集实际网络表现。" },
  { code: "02", title: "判断", detail: "定位问题环节，给出是否需要更换的结论。" },
  { code: "03", title: "交付", detail: "按结论优化，或交付匹配业务的网络方案。" },
  { code: "04", title: "验收", detail: "以同一套检查维度复核交付结果。" },
  { code: "05", title: "查看", detail: "交付后可在客户中心查看已接入的服务信息；状态与用量能力按接入结果显示。" },
] as const;

const typeMeta: Record<string, { role: string; scene: string }> = {
  "ai-network": { role: "AI / 开发", scene: "AI 工具、开发环境与国际服务访问" },
  "local-isp": { role: "本地网络", scene: "面向指定国家的本地 ISP 网络环境" },
  residential: { role: "家庭宽带", scene: "跨境内容与社媒运营的真实家庭宽带环境" },
};

const regionCodes: Record<string, string> = {
  sg: "SG", jp: "JP", vn: "VN", my: "MY", kr: "KR", us: "US", tw: "TW", more: "···",
};

/* 地区场景标签：本地覆盖层，不改写 subscribeCatalog 的 badge 字段（仅一个短语），
   用于首页展示更完整的场景描述。数量与措辞由业务侧确认，不含任何延迟/带宽/SLA 数字承诺。 */
const regionTags: Record<string, string[]> = {
  sg: ["AI 首选", "社媒", "低延迟", "高速", "稳定"],
  jp: ["AI 推荐", "社媒", "低延迟", "高速", "稳定"],
  vn: ["AI 推荐", "社媒", "低延迟", "性价比高"],
  my: ["AI 推荐", "社媒", "低延迟", "稳定"],
  kr: ["AI 推荐", "社媒", "低延迟", "稳定"],
  tw: ["AI 推荐", "社媒", "低延迟", "稳定"],
  us: ["AI 推荐", "社媒"],
};

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
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKeyDown = makeTabKeyDown(routeLines.length, active, setActive, tabRefs);
  const line = routeLines[active]!;

  return (
    <div className="home-routes">
      <div className="home-routes-tabs" role="tablist" aria-label="精品线路">
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
            <small>{item.carrier}</small>
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
          <span className="home-nb">{line.carrier}</span>
          <em>{line.note}</em>
        </div>
        <div className="home-topo">
          {pathLayers.map((layer, index) => (
            <Fragment key={layer.key}>
              <div className={`home-topo-node${layer.premium ? " is-premium" : ""}`}>
                <span className="home-topo-dot" aria-hidden="true" />
                <div className="home-topo-copy">
                  <strong>{layer.label}</strong>
                  <small>{layer.note}</small>
                </div>
                {layer.premium ? (
                  <span className="home-topo-line">
                    {line.name}
                    <em>{line.carrier}</em>
                  </span>
                ) : null}
              </div>
              {index < pathLayers.length - 1 ? (
                <div className="home-topo-link" aria-hidden="true">
                  <span className="home-topo-rail">
                    <i className="home-topo-signal is-forward" />
                    <i className="home-topo-signal is-return" />
                  </span>
                  <span className="home-topo-dir"><b>去程</b><b>回程</b></span>
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>

        <div className="home-routes-meta">
          <div>
            <b>方向</b>
            <span>去程 / 回程<em>分别核验</em></span>
          </div>
          <div>
            <b>路径</b>
            <span>逐跳路由<em>ASN 与反向解析</em></span>
          </div>
          <div>
            <b>落地</b>
            <span>目标地区<em>海外出口</em></span>
          </div>
          <div>
            <b>适用性</b>
            <span>按地区与<em>实际方案判断</em></span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* 控制台展示：Tabs + 慢速自动切换。hover / focus 暂停，键盘可操作，
   prefers-reduced-motion 下关闭自动切换。 */
function ConsoleShowcase() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
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
        <span className="home-showcase-title">客户中心 · {view.label}</span>
        <span className="home-chip is-muted">产品预览</span>
      </div>

      <div className="home-showcase-tabs" role="tablist" aria-label="客户中心视图">
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
            {item.label}
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
        {/* 网络状态：三网延迟轨道 + 24h 窗口刻度，数值一律 — */}
        {view.kind === "latency" ? (
          <div className="home-latency">
            <div className="home-latency-head">
              <b>三网延迟（ms）</b>
              <span>24 小时 · Asia/Shanghai</span>
            </div>
            {view.rows?.map((row, index) => (
              <div className="home-latency-row" key={row} data-line={index}>
                <span className="home-latency-name"><i aria-hidden="true" />{row}</span>
                <span className="home-latency-track" aria-hidden="true"><i /></span>
                <b>—</b>
              </div>
            ))}
            <div className="home-latency-axis" aria-hidden="true">
              <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>现在</span>
            </div>
          </div>
        ) : null}

        {/* 线路质量：去/回程逐跳字段结构对应真实路由追踪；不展示任何真实 IP */}
        {view.kind === "route" ? (
          <div className="home-route">
            <div className="home-route-head">
              <span className="home-chip">去程</span>
              <span className="home-chip">回程</span>
              <span className="home-chip is-muted">ICMP / TCP</span>
              <em>精品线路以金色标记</em>
            </div>
            <div className="home-route-table" role="table" aria-label="逐跳路由示意">
              <div className="home-route-row is-head" role="row">
                <span role="columnheader">跳数</span>
                <span role="columnheader">节点</span>
                <span role="columnheader">延迟</span>
                <span role="columnheader">地区</span>
                <span role="columnheader">ASN</span>
                <span role="columnheader">反向解析</span>
              </div>
              {routeHops.map((hop) => (
                <div className={`home-route-row${hop.premium ? " is-premium" : ""}`} role="row" key={hop.hop}>
                  <span role="cell">{hop.hop}</span>
                  <span role="cell">—</span>
                  <span role="cell">—</span>
                  <span role="cell">—</span>
                  <span role="cell">—</span>
                  <span role="cell">—</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 服务管理：对齐客户中心 Dashboard 的 OVERVIEW 概览 + SYSTEM 系统状态，值一律 — */}
        {view.kind === "stats" ? (
          <div className="home-showcase-split">
            <div className="home-showcase-stats">
              {view.stats?.map((label) => (
                <div className="home-preview-stat" key={label}>
                  <span>{label}</span>
                  <b>—</b>
                </div>
              ))}
            </div>
            <div className="home-preview-panel">
              <b><em>SYSTEM</em>系统状态（待接入）</b>
              <div className="home-preview-rows">
                {view.rows?.map((row) => (
                  <div key={row}><span>{row}</span><b>—</b></div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <p className="home-preview-note"><i aria-hidden="true" />界面预览，非实时数据 · {view.caption}</p>
      </div>
    </div>
  );
}

export function HomePage() {
  const { theme, toggleTheme } = useThemePreference();
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
                跨境网络环境诊断与交付
              </span>
              <h1>
                跨境网络环境
                <br />
                先<em>诊断</em>，再交付
              </h1>
              <p className="home-hero-lead">
                从本地网络、DNS、出口环境到双向线路质量，先判断问题在哪里，
                再决定是否需要优化或更换方案。
              </p>
              <div className="home-cta-row">
                <Link to="/diagnosis" className="home-btn home-btn-secondary">开始诊断</Link>
                <Link to="/subscribe" className="home-btn home-btn-primary">
                  查看网络方案
                  {ARROW}
                </Link>
              </div>
              <p className="home-hero-note">填写当前网络环境与问题概况，用于后续人工判断。</p>
            </div>

            {/* Signature visual 01：诊断管线（示意，只有一个"检查中"游标，无 VERIFIED） */}
            <div className="home-pipeline" aria-label="诊断流程示意">
              <span className="home-pipeline-grid" aria-hidden="true" />
              <div className="home-pipeline-inner">
                <div className="home-pipeline-head">
                  <span className="home-console-dots" aria-hidden="true"><i /><i /><i /></span>
                  <b>DIAGNOSTIC PIPELINE</b>
                  <span className="home-pipeline-flag">示意 · 非实时</span>
                </div>

                <div className="home-pipeline-body">
                  {pipelineStages.map((stage) => (
                    <div className="home-stage" key={stage.key}>
                      <span className="home-stage-node" aria-hidden="true" />
                      <span className="home-stage-code">{stage.code}</span>
                      <span className="home-stage-copy">
                        <strong>{stage.key}<i>{stage.zh}</i></strong>
                        <small>{stage.note}</small>
                      </span>
                      <span className="home-stage-tags">
                        {stage.tags.map((tag) => (
                          <span className="home-chip" key={tag}>{tag}</span>
                        ))}
                      </span>
                      <span className="home-stage-state" aria-hidden="true">
                        <i className="is-pending">待检查</i>
                        <i className="is-checking">检查中</i>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="home-pipeline-foot">
                  <span><i aria-hidden="true" />实时诊断结果待接入，本图仅演示检查流程</span>
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
              <h2>不是所有问题都需要换网络</h2>
              <p className="home-section-lead">
                很多跨境业务的异常并不出在出口线路上。我们按固定维度先把问题定位清楚，
                再判断需要调整、优化，还是真的需要更换网络方案。
              </p>
            </div>

            <div className="home-system" ref={diagnosis.ref} data-reveal={diagnosis.phase}>
              <div className="home-system-head">
                <span className="home-system-step">检查</span>
                <span className="home-system-arrow" aria-hidden="true" />
                <span className="home-system-step">判断</span>
                <span className="home-system-arrow" aria-hidden="true" />
                <span className="home-system-step is-end">结论</span>
                <span className="home-system-meta">DECISION SYSTEM · 7 项检查</span>
              </div>
              <div className="home-system-body">
                <div className="home-matrix">
                  {checks.map((check, index) => (
                    <div className="home-matrix-row" key={check.name}>
                      <span className="home-matrix-index">{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <strong>{check.name}</strong>
                        <small>{check.detail}</small>
                      </span>
                      <span className="home-matrix-tags">
                        {check.tags.map((tag) => (
                          <span className="home-chip" key={tag}>{tag}</span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="home-verdict">
                  <b>三种可能的结论</b>
                  <p>诊断的目的是给出判断，而不是默认推荐更换网络。</p>
                  {verdicts.map((verdict) => (
                    <div className={`home-verdict-item${verdict.accent ? " is-accent" : ""}`} key={verdict.mark}>
                      <span className="home-verdict-mark">{verdict.mark}</span>
                      <span>
                        <strong>{verdict.title}</strong>
                        <small>{verdict.detail}</small>
                      </span>
                    </div>
                  ))}
                  <p className="home-verdict-foot">
                    实际结论以真实检测为准。本页只说明检查维度，不展示具体排查步骤。
                  </p>
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
                <h2>双向精品线路，不只看单一出口</h2>
                <p className="home-section-lead">
                  跨境体验由本地与目标之间的完整链路决定。我们分别核验去程与回程两个方向，
                  而不是只确认一个出口 IP 的归属。
                </p>
              </div>
              <span className="home-console-tag">BIDIRECTIONAL · SCHEMATIC</span>
            </div>

            {/* 先讲人话：为什么要看双向 */}
            <div className="home-routing-lead">
              <strong>去程和回程，要分开看。</strong>
              <p>
                一个出口 IP 的归属，只说明数据"从哪里出去"。真正决定跨境是否稳定的，
                是去程与回程两条方向的完整链路——<em>单一出口，代表不了完整链路质量</em>。
              </p>
            </div>

            {/* Signature visual 02：纵向双向拓扑 + 三条线路 segmented control */}
            <RouteShowcase />

            <p className="home-routing-note">
              <span className="home-nb">CN2 GIA</span> / <span className="home-nb">AS9929</span> / <span className="home-nb">CMIN2</span>
              {" "}分别对应电信 / 联通 / 移动的精品线路能力，<span className="home-nb">去程 / 回程</span>分别核验。
              线路可用性以实际方案与地区为准，本页不给出任何延迟、丢包或带宽指标。
            </p>
          </div>
        </section>

        {/* ================= 04 REAL RESIDENTIAL ================= */}
        <section className="home-section">
          <div className="home-wrap">
            <div className="home-section-head">
              <p className="home-eyebrow"><i aria-hidden="true" />REAL RESIDENTIAL</p>
              <h2>真实家宽，不只是一个住宅 IP 标签</h2>
              <p className="home-section-lead">
                面向需要真实住宅网络属性的业务场景。住宅是否"真"，靠的是多项环境事实交叉核验，
                而不是一个 IP 数据库标签。
              </p>
            </div>

            <div className="home-dossier">
              <div className="home-dossier-bar">
                <b>住宅网络环境核验档案</b>
                <span className="home-console-tag">RESIDENTIAL ENVIRONMENT · 示意</span>
              </div>

              <div className="home-dossier-lead">
                <span className="home-dossier-tag" aria-hidden="true">住宅 IP 标签</span>
                <p>
                  <b>只能说明"出口归属"这一项。</b>
                  真正决定这条网络能不能用于你的业务的，是下面三层环境事实的交叉核验。
                </p>
              </div>

              <div className="home-dossier-grid">
                {residentialGroups.map((group) => (
                  <section className="home-dossier-col" key={group.no} aria-label={group.title}>
                    <div className="home-dossier-head">
                      <span className="home-dossier-no">{group.no}</span>
                      <div>
                        <strong>{group.title}</strong>
                        <small>{group.caption}</small>
                      </div>
                    </div>
                    <span className="home-dossier-verify"><i aria-hidden="true" />交付前逐项核验</span>
                    <div className="home-dossier-items">
                      {group.items.map((item) => (
                        <div className="home-dossier-item" key={item.name}>
                          <strong>{item.name}</strong>
                          <small>{item.detail}</small>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>

              <div className="home-dossier-foot">
                <p>
                  <b>不编造任何"已通过"。</b>
                  以上为核验维度，实际结果在交付前逐项检测，以交付验收为准。
                </p>
              </div>
            </div>

            <div className="home-residential-note">
              <p>
                不是看到住宅标签就默认推荐——先判断业务场景，再决定网络类型、地区与规格。
              </p>
              <Link to="/subscribe" className="home-text-link">查看网络方案{ARROW}</Link>
            </div>
          </div>
        </section>

        {/* ================= 05 OBSERVABILITY（深色带） ================= */}
        <section className="home-section is-console home-observability" id="observability">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />OBSERVABILITY</p>
                <h2>交付后，已接入信息可在客户中心查看</h2>
                <p className="home-section-lead">
                  交付后可在客户中心查看已接入的服务与线路信息。网络状态、系统状态与实际用量未接入时显示待接入，不作推测。
                  以下为客户中心界面预览，非实时数据。
                </p>
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
              <h2>一条闭环的工作链路</h2>
            </div>

            <div className="home-chain">
              {chainSteps.map((step, index) => (
                <div className={`home-chain-step${index === 0 ? " is-accent" : ""}`} key={step.code}>
                  <span className="home-chain-node" aria-hidden="true" />
                  <span className="home-chain-code">{step.code}</span>
                  <strong>{step.title}</strong>
                  <small>{step.detail}</small>
                </div>
              ))}
            </div>

            <div className="home-standard">
              <b>交付验收标准</b>
              <p>
                验收使用与诊断相同的检查维度复核：住宅属性、DNS、UDP、IPv4 / IPv6、
                双向线路质量与平台可达性。验收结果以实际检测为准。
              </p>
            </div>
          </div>
        </section>

        {/* ================= 07 SERVICE TYPES（次级） ================= */}
        <section className="home-section home-secondary">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />SERVICE TYPES</p>
                <h2>三类网络，按业务场景选择</h2>
              </div>
              <Link to="/subscribe" className="home-text-link">查看完整方案{ARROW}</Link>
            </div>

            <div className="home-types">
              {networkTypes.map((type) => (
                <article className="home-type" key={type.id}>
                  <p className="home-type-role">{typeMeta[type.id]?.role ?? "网络类型"}</p>
                  <div className="home-type-head">
                    <h3>{type.name}</h3>
                    {type.badge ? <span className="home-chip is-accent">{type.badge}</span> : null}
                  </div>
                  <p className="home-type-scene">
                    <b>适用场景</b>
                    {typeMeta[type.id]?.scene ?? "—"}
                  </p>
                  <ul className="home-type-features">
                    {type.features.map((feature) => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                  <Link to="/subscribe" className="home-text-link">查看方案{ARROW}</Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ================= 08 REGIONS（次级） ================= */}
        <section className="home-section home-secondary">
          <div className="home-wrap">
            <div className="home-section-head is-split">
              <div>
                <p className="home-eyebrow"><i aria-hidden="true" />REGIONS</p>
                <h2>可选地区</h2>
              </div>
              <span className="home-section-aside">具体运营商与规格以网络方案页为准</span>
            </div>

            <div className="home-coverage">
              <div className="home-regions">
                {regionOrder.flatMap((id) => {
                  const region = regions.find((item) => item.id === id);
                  if (!region) return [];
                  const tags = regionTags[region.id];
                  return (
                    <div className={`home-region${region.id === "more" ? " is-more" : ""}`} key={region.id}>
                      <div className="home-region-top">
                        <span className={`home-flag is-${region.flagClass}`} aria-hidden="true" />
                        <span className="home-region-copy">
                          <strong>{region.name}<em>{regionCodes[region.id] ?? ""}</em></strong>
                        </span>
                      </div>
                      {tags ? (
                        <div className="home-region-tags">
                          {tags.map((tag) => (
                            <span className="home-chip" key={tag}>{tag}</span>
                          ))}
                        </div>
                      ) : (
                        <small className="home-region-note">{region.badge ?? "—"}</small>
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
              <h2>不知道该选哪种方案？</h2>
              <p>先判断当前网络环境，再决定需要优化还是更换方案。</p>
              <div className="home-cta-row">
                <a href="#diagnosis" className="home-btn home-btn-secondary">了解诊断方式</a>
                <Link to="/subscribe" className="home-btn home-btn-primary">
                  查看网络方案
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
