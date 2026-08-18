import { useState } from "react";
import { Link, Navigate, NavLink, useParams } from "react-router-dom";
import { CustomerCenterShell } from "./customer/CustomerCenterShell";
import { SubscribePage } from "./subscribe/SubscribePage";
import type { SectionKey } from "../lib/sections";
import { sectionKeys } from "../lib/sections";

type LegacySectionKey = Exclude<SectionKey, "subscribe">;

type NavItem = { href: LegacySectionKey; label: string; icon: string };
type NavGroup = { label: string; items: NavItem[] };

const navigation: NavGroup[] = [
  { label: "概览", items: [{ href: "dashboard", label: "总览", icon: "⌂" }] },
  {
    label: "服务",
    items: [
      { href: "services", label: "我的服务", icon: "◇" },
      { href: "reports", label: "诊断报告", icon: "▤" },
      { href: "monitor", label: "网络监控", icon: "⌁" },
      { href: "orders", label: "订单", icon: "□" },
    ],
  },
  {
    label: "支持",
    items: [
      { href: "tickets", label: "工单", icon: "◌" },
      { href: "docs", label: "使用文档", icon: "≡" },
      { href: "status", label: "服务状态", icon: "●" },
    ],
  },
  {
    label: "账户",
    items: [
      { href: "profile", label: "个人中心", icon: "○" },
      { href: "security", label: "安全设置", icon: "⌾" },
    ],
  },
];

const sectionMeta: Record<LegacySectionKey, { title: string; eyebrow: string; description: string }> = {
  dashboard: { title: "网络服务总览", eyebrow: "2026 年 8 月 9 日 · 星期日", description: "早上好，所有核心服务均在正常运行。" },
  services: { title: "我的服务", eyebrow: "服务管理", description: "集中管理网络接入、边缘节点与监控服务。" },
  reports: { title: "诊断报告", eyebrow: "分析中心", description: "查看链路质量、路由与故障诊断结果。" },
  monitor: { title: "网络监控", eyebrow: "实时观测", description: "持续追踪跨区域链路健康度与性能趋势。" },
  orders: { title: "订单", eyebrow: "商务中心", description: "查看服务订单、续费周期与账单状态。" },
  tickets: { title: "工单", eyebrow: "技术支持", description: "与支持团队协作处理服务问题。" },
  docs: { title: "使用文档", eyebrow: "帮助中心", description: "快速查找部署、接入与排障指南。" },
  status: { title: "服务状态", eyebrow: "运行透明度", description: "查看平台组件与区域服务的实时状态。" },
  profile: { title: "个人中心", eyebrow: "账户信息", description: "管理个人资料、通知偏好与团队信息。" },
  security: { title: "安全设置", eyebrow: "账户保护", description: "管理登录安全、会话与访问凭据。" },
};

const serviceRows = [
  ["全球链路监控", "企业版", "运行中", "99.99%", "2026-09-08"],
  ["亚太边缘接入", "标准版", "运行中", "99.97%", "2026-09-12"],
  ["智能路由分析", "专业版", "运行中", "99.95%", "2026-10-01"],
  ["故障告警中心", "团队版", "维护中", "99.91%", "2026-08-19"],
];

const chartBars = [38, 44, 31, 53, 47, 62, 58, 67, 73, 61, 79, 72, 84, 76, 88, 82, 91, 86, 78, 89, 81, 94, 87, 96];

function Logo() {
  return (
    <div className="brand" aria-label="NSP Console">
      <span className="brand-mark"><i /><i /><i /></span>
      <span><strong>NSP</strong><small>CONSOLE</small></span>
    </div>
  );
}

function Sidebar({ active, open, onClose }: { active: SectionKey; open: boolean; onClose: () => void }) {
  return (
    <>
      <button className={`sidebar-backdrop ${open ? "visible" : ""}`} onClick={onClose} aria-label="关闭菜单" />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-head"><Logo /><button className="close-menu" onClick={onClose} aria-label="关闭菜单">×</button></div>
        <nav aria-label="主导航">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  to={`/${item.href}`}
                  key={item.href}
                  className={({ isActive }) => isActive ? "active" : ""}
                  onClick={onClose}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                  {item.href === "tickets" && <b className="nav-badge">2</b>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="support-orb">?</div>
          <div><strong>需要帮助？</strong><span>技术团队 7×24 小时在线</span></div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="topbar">
      <button className="menu-button" onClick={onMenu} aria-label="打开菜单">☰</button>
      <div className="system-health"><span className="live-dot" />系统运行正常 <em>最后更新于 1 分钟前</em></div>
      <div className="top-actions">
        <button className="icon-button" aria-label="搜索">⌕</button>
        <button className="icon-button notification" aria-label="通知">♧<i /></button>
        <span className="divider" />
        <div className="user"><span className="avatar">FX</span><div><strong>Fang</strong><small>管理员</small></div><b>⌄</b></div>
      </div>
    </header>
  );
}

function MetricCard({ label, value, detail, tone, icon }: { label: string; value: string; detail: string; tone: string; icon: string }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
      <span className="metric-arrow">↗</span>
    </article>
  );
}

function Overview() {
  return (
    <>
      <section className="metric-grid">
        <MetricCard label="运行中的服务" value="12" detail="全部服务正常" tone="violet" icon="◇" />
        <MetricCard label="本月可用率" value="99.98%" detail="较上月 +0.06%" tone="green" icon="↗" />
        <MetricCard label="活跃告警" value="2" detail="均为低优先级" tone="amber" icon="!" />
        <MetricCard label="平均响应时间" value="42 ms" detail="过去 24 小时" tone="blue" icon="⌁" />
      </section>

      <section className="dashboard-grid">
        <article className="panel performance-panel">
          <div className="panel-title"><div><span>网络性能</span><strong>实时链路响应</strong></div><select aria-label="时间范围" defaultValue="24h"><option value="24h">过去 24 小时</option><option value="7d">过去 7 天</option></select></div>
          <div className="chart-summary"><div><span>平均延迟</span><strong>42<small>ms</small></strong></div><div><span>数据传输</span><strong>8.24<small>TB</small></strong></div><div><span>丢包率</span><strong>0.02<small>%</small></strong></div></div>
          <div className="bar-chart" aria-label="过去 24 小时网络响应趋势">
            {chartBars.map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}
          </div>
          <div className="chart-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>现在</span></div>
        </article>

        <article className="panel regions-panel">
          <div className="panel-title"><div><span>节点状态</span><strong>区域健康度</strong></div><Link to="/monitor">查看全部</Link></div>
          <div className="region-list">
            {[["华东 · 上海", "24 ms", "正常", "cn"], ["华南 · 广州", "31 ms", "正常", "cn"], ["亚太 · 新加坡", "48 ms", "正常", "sg"], ["北美 · 洛杉矶", "138 ms", "轻微波动", "us"]].map(([name, latency, status, code]) => (
              <div className="region-row" key={name}><span className={`flag ${code}`}>{code.toUpperCase()}</span><div><strong>{name}</strong><small>响应 {latency}</small></div><span className={status === "正常" ? "pill success" : "pill warning"}>{status}</span></div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel services-panel">
        <div className="panel-title"><div><span>服务清单</span><strong>最近使用的服务</strong></div><Link to="/services">管理所有服务 <b>→</b></Link></div>
        <ServiceTable rows={serviceRows.slice(0, 3)} />
      </section>
    </>
  );
}

function ServiceTable({ rows = serviceRows }: { rows?: string[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>服务名称</th><th>规格</th><th>状态</th><th>本月可用率</th><th>到期时间</th><th /></tr></thead>
        <tbody>{rows.map((row) => <tr key={row[0]}>{row.map((cell, i) => <td key={i}>{i === 2 ? <span className={cell === "运行中" ? "pill success" : "pill warning"}>{cell}</span> : i === 0 ? <strong>{cell}</strong> : cell}</td>)}<td><button className="row-action">•••</button></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ServicesPage() {
  return <><section className="section-toolbar"><div className="filter-tabs"><button className="active">全部 12</button><button>运行中 10</button><button>维护中 2</button></div><button className="primary-button">＋ 添加服务</button></section><section className="panel"><ServiceTable /></section></>;
}

const pageContent: Record<Exclude<LegacySectionKey, "dashboard" | "services">, { stats: string[][]; rows: string[][]; headers: string[]; action: string }> = {
  reports: { stats: [["本月报告", "18", "已完成 16 份"], ["平均评分", "92", "链路质量良好"], ["待处理", "2", "需要人工复核"]], headers: ["报告名称", "类型", "生成时间", "评分", "状态"], rows: [["亚太区域链路周报", "综合诊断", "今天 08:30", "96", "已完成"], ["跨境路由质量分析", "路由分析", "昨天 21:10", "91", "已完成"], ["核心节点异常复盘", "故障分析", "8 月 7 日", "—", "分析中"]], action: "生成诊断报告" },
  monitor: { stats: [["在线探针", "36", "覆盖 8 个区域"], ["监控目标", "128", "全部正在采集"], ["今日事件", "7", "2 个仍需关注"]], headers: ["监控目标", "区域", "响应时间", "可用率", "状态"], rows: [["客户门户", "华东", "24 ms", "99.99%", "正常"], ["边缘 API", "新加坡", "48 ms", "99.97%", "正常"], ["路由分析器", "洛杉矶", "138 ms", "99.89%", "波动"]], action: "添加监控" },
  orders: { stats: [["有效订单", "8", "均已正常交付"], ["本月消费", "¥ 8,420", "较上月 +4.8%"], ["待支付", "1", "将于 3 天后到期"]], headers: ["订单编号", "服务", "金额", "创建日期", "状态"], rows: [["NSP-202608-021", "全球链路监控", "¥ 2,499", "8 月 8 日", "已完成"], ["NSP-202608-018", "边缘接入扩容", "¥ 1,280", "8 月 6 日", "已完成"], ["NSP-202608-009", "智能路由分析", "¥ 3,600", "8 月 2 日", "待支付"]], action: "创建订单" },
  tickets: { stats: [["待回复", "2", "支持团队处理中"], ["本月已解决", "14", "平均 18 分钟响应"], ["满意度", "4.9", "来自 12 次评价"]], headers: ["工单主题", "优先级", "更新时间", "负责人", "状态"], rows: [["新加坡节点延迟波动", "中", "12 分钟前", "技术支持组", "处理中"], ["新增监控目标咨询", "低", "1 小时前", "客户成功组", "待回复"], ["API 访问白名单", "低", "昨天", "技术支持组", "已解决"]], action: "新建工单" },
  docs: { stats: [["文档条目", "86", "覆盖全部产品"], ["本周更新", "12", "含 4 篇新指南"], ["热门分类", "快速开始", "平均阅读 6 分钟"]], headers: ["文档标题", "分类", "更新时间", "阅读时长", "状态"], rows: [["五分钟接入链路监控", "快速开始", "8 月 8 日", "5 分钟", "已发布"], ["告警策略最佳实践", "监控指南", "8 月 6 日", "8 分钟", "已发布"], ["路由分析 API 参考", "开发接口", "8 月 2 日", "12 分钟", "已更新"]], action: "浏览全部文档" },
  status: { stats: [["整体可用率", "99.98%", "过去 30 天"], ["正常组件", "18 / 18", "当前无中断"], ["最近事件", "6 天前", "已完全恢复"]], headers: ["服务组件", "当前状态", "最近 30 天", "延迟", "备注"], rows: [["客户控制台", "正常", "99.99%", "22 ms", "—"], ["监控数据 API", "正常", "99.98%", "38 ms", "—"], ["北美探测网络", "性能下降", "99.91%", "138 ms", "持续观察"]], action: "订阅状态通知" },
  profile: { stats: [["账户等级", "企业", "已认证"], ["团队成员", "6", "2 位管理员"], ["通知渠道", "3", "全部已验证"]], headers: ["资料项目", "当前信息", "可见范围", "更新时间", "状态"], rows: [["显示名称", "Fang", "团队内", "今天", "已确认"], ["所属团队", "网络运营团队", "团队内", "8 月 1 日", "已确认"], ["时区", "Asia / Shanghai", "仅自己", "7 月 28 日", "已确认"]], action: "编辑个人资料" },
  security: { stats: [["安全评分", "92", "状态优秀"], ["活跃会话", "3", "均为可信设备"], ["访问密钥", "4", "最近使用于今天"]], headers: ["安全项目", "方式", "最近活动", "设备 / 范围", "状态"], rows: [["双重验证", "验证器应用", "今天 08:12", "账户全局", "已启用"], ["当前会话", "密码 + 2FA", "1 分钟前", "macOS", "活跃"], ["API 访问密钥", "受限令牌", "今天 07:48", "只读监控", "正常"]], action: "添加安全方式" },
};

function StandardPage({ section }: { section: Exclude<LegacySectionKey, "dashboard" | "services"> }) {
  const data = pageContent[section];
  return (
    <>
      <section className="compact-metrics">{data.stats.map(([label, value, detail], i) => <article key={label}><span>{label}</span><strong>{value}</strong><small><i className={i === 2 ? "amber-dot" : "green-dot"} />{detail}</small></article>)}</section>
      <section className="panel data-panel">
        <div className="panel-title"><div><span>最近记录</span><strong>{sectionMeta[section].title}</strong></div><button className="primary-button">＋ {data.action}</button></div>
        <div className="table-wrap"><table><thead><tr>{data.headers.map((h) => <th key={h}>{h}</th>)}<th /></tr></thead><tbody>{data.rows.map((row) => <tr key={row[0]}>{row.map((cell, i) => <td key={i}>{i === 0 ? <strong>{cell}</strong> : i === 4 ? <span className={/(正常|完成|解决|发布|更新|确认|启用|活跃)/.test(cell) ? "pill success" : "pill warning"}>{cell}</span> : cell}</td>)}<td><button className="row-action">•••</button></td></tr>)}</tbody></table></div>
      </section>
    </>
  );
}

export function DashboardShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { section: requestedSection = "dashboard" } = useParams();

  if (!sectionKeys.includes(requestedSection as SectionKey)) {
    return <Navigate to="/dashboard" replace />;
  }

  const section = requestedSection as SectionKey;
  if (section === "subscribe") {
    return <CustomerCenterShell><SubscribePage /></CustomerCenterShell>;
  }

  const meta = sectionMeta[section];
  const showLiveMonitor = section === "dashboard" || section === "monitor";
  const monitorUrl = import.meta.env.VITE_MONITOR_URL?.trim();

  return (
    <div className="app-shell">
      <Sidebar active={section} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className={`main-column ${showLiveMonitor ? "live-monitor-column" : ""}`}>
        <Topbar onMenu={() => setMenuOpen(true)} />
        {showLiveMonitor ? (
          <main className="live-monitor-main">
            {monitorUrl ? (
              <iframe
                className="live-monitor-frame"
                src={monitorUrl}
                title="广州三网实时监控"
                allow="fullscreen"
              />
            ) : (
              <section className="panel" role="status" aria-live="polite">
                <div className="panel-title">
                  <div><span>网络监控</span><strong>监控地址未配置</strong></div>
                </div>
              </section>
            )}
          </main>
        ) : <main>
          <div className="page-heading">
            <div><span>{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
          </div>
          {section === "services" ? <ServicesPage /> : <StandardPage section={section as Exclude<LegacySectionKey, "dashboard" | "services">} />}
          <footer><span>© 2026 Network Service Platform</span><span>服务条款 · 隐私政策 · v1.0.0</span></footer>
        </main>}
      </div>
    </div>
  );
}
