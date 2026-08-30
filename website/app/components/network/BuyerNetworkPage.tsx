import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyDeliveryLines,
  getMyOrders,
  getMyServices,
  type MyDeliveryLineItem,
  type MyOrderItem,
  type MyServiceItem,
  type ServiceStatus,
} from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";
import "./buyer-network.css";

/* /network 买家「节点与流量」页。
   真实数据只来自既有 GET /api/me/services、GET /api/me/orders 与 GET /api/me/delivery-lines；
   服务属性名称来自已冻结的 SUBSCRIBE-CATALOG-V1（目录标称，非实测值）。节点在线 / 超时 /
   离线、实际用量、配额与重置周期没有公共契约，一律显示「待接入」的未知态：参考稿里的
   0 在本页一律写成 —，绝不渲染伪造的 0 值或 Mock 生产数据。
   交付线路只展示后端已脱敏的 orderRef / position / label 三项，绝不展示订阅地址、主机名、
   IP、面板地址、凭据、监控 ID 或供应商身份；线路条数也不当作在线节点数使用。
   三个接口相互独立：交付线路读取失败时保留仍然有效的服务与订单，只降级为局部警告 + 重试。
   视觉语言：真实数据用 --cc-text 强调，未知数据用 --cc-text-4 弱化，二者一眼可分。
   公开 /monitor 保持独立入口，不与账户数据混用。 */

type Resource<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

type AccountServiceView = {
  readonly orderRef: string;
  readonly serviceStatus: ServiceStatus;
  readonly createdAt: string;
  readonly region: string | null;
  readonly isp: string | null;
  readonly type: string | null;
  readonly traffic: string | null;
  readonly bandwidth: string | null;
  readonly lines: readonly MyDeliveryLineItem[];
};

type OrphanLineGroup = {
  readonly orderRef: string;
  readonly lines: readonly MyDeliveryLineItem[];
};

const UNKNOWN = "—";

function resourceErrorMessage(resource: "服务" | "订单" | "交付线路", error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return `${resource}数据返回异常，请稍后重试。`;
  }
  return `暂时无法读取${resource}状态，请稍后重试。`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function catalogValue(value: string): string | null {
  return value === UNKNOWN || value === "" ? null : value;
}

/* 交付线路按 orderRef 聚合，组内按 position 升序：position 是买家可见的线路序号，
   与「VPS 中转线路 N」一一对应，必须保留而不是重新编号。 */
function groupLinesByOrder(
  lines: readonly MyDeliveryLineItem[] | null,
): Map<string, MyDeliveryLineItem[]> {
  const grouped = new Map<string, MyDeliveryLineItem[]>();
  for (const line of lines ?? []) {
    const bucket = grouped.get(line.orderRef);
    if (bucket === undefined) {
      grouped.set(line.orderRef, [line]);
      continue;
    }
    bucket.push(line);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => left.position - right.position);
  }
  return grouped;
}

/* 服务接口只能证明账户关联服务及其开通状态，不能证明节点数量。
   订单仅用于补充服务的目录属性；缺失或读取失败时属性留空，不猜测地区与运营商。
   交付线路按 orderRef 挂到对应服务上；读取失败时 lines 为空，由调用方区分
   「尚未配置线路名称」与「线路名称暂不可读取」，不把两者混为一谈。 */
function buildAccountServices(
  services: readonly MyServiceItem[],
  orders: readonly MyOrderItem[] | null,
  linesByOrder: Map<string, MyDeliveryLineItem[]>,
): AccountServiceView[] {
  const orderList: readonly MyOrderItem[] = orders ?? [];
  const orderByRef = new Map(orderList.map((order) => [order.orderRef, order] as const));
  return [...services]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((service) => {
      const order = orderByRef.get(service.orderRef) ?? null;
      const lines = linesByOrder.get(service.orderRef) ?? [];
      if (order === null) {
        return {
          orderRef: service.orderRef,
          serviceStatus: service.serviceStatus,
          createdAt: service.createdAt,
          region: null,
          isp: null,
          type: null,
          traffic: null,
          bandwidth: null,
          lines,
        };
      }
      const resolved = resolveSelection({
        typeId: order.typeId,
        regionId: order.regionId,
        ispId: order.ispId,
        specId: order.specId,
        durationId: order.durationId,
      });
      return {
        orderRef: service.orderRef,
        serviceStatus: service.serviceStatus,
        createdAt: service.createdAt,
        // 目录未收录的历史 ID 直接显示原始 ID：不隐藏，也不编造名称。
        region: resolved.selectedRegion?.name ?? order.regionId,
        isp: resolved.selectedIsp?.name ?? order.ispId,
        type: resolved.selectedType?.name ?? order.typeId,
        traffic: catalogValue(resolved.summary.traffic),
        bandwidth: catalogValue(resolved.summary.bandwidth),
        lines,
      };
    });
}

/* 服务与交付线路是两个独立请求，可能在同一次刷新里读到不同快照。
   匹配不上任何服务的线路不静默丢弃，单独成组显示，避免真实数据凭空消失。 */
function collectOrphanLineGroups(
  linesByOrder: Map<string, MyDeliveryLineItem[]>,
  services: readonly MyServiceItem[],
): OrphanLineGroup[] {
  const knownRefs = new Set(services.map((service) => service.orderRef));
  const groups: OrphanLineGroup[] = [];
  for (const [orderRef, lines] of linesByOrder) {
    if (!knownRefs.has(orderRef)) groups.push({ orderRef, lines });
  }
  return groups;
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
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5" cy="18" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M12 7.4v4.2M10 13l-3.6 3M14 13l3.6 3" />
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

function MonitorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 17l4-4 3 2 6-7 3 3" />
      <path d="M16 8h4v4" />
    </svg>
  );
}

function PanelHead({
  eyebrow,
  title,
  titleId,
  subline,
  tag,
  icon,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  subline: string;
  tag: string;
  icon: ReactNode;
}) {
  return (
    <div className="cc-net-panel-head">
      <span className="cc-net-panel-icon">{icon}</span>
      <div className="cc-net-panel-title">
        <em>{eyebrow}</em>
        <h2 id={titleId}>{title}</h2>
        <p>{subline}</p>
      </div>
      <span className="cc-net-tag">{tag}</span>
    </div>
  );
}

function Skeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div className="cc-net-loading" role="status" aria-live="polite" aria-busy="true">
      <ul className="cc-net-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} />
        ))}
      </ul>
      <p>{label}</p>
    </div>
  );
}

/* 参考稿的空态：居中图标 + 主标题 + 说明，占据面板主要高度。
   错误 / 登录失效沿用同一容器，只切换 role 与配色，保证四种状态观感一致。 */
function StateBlock({
  tone,
  icon,
  title,
  hint,
  action,
}: {
  tone: "empty" | "alert";
  icon: ReactNode;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`cc-net-state ${tone === "alert" ? "is-alert" : ""}`}
      role={tone === "alert" ? "alert" : undefined}
    >
      <span className="cc-net-state-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{hint}</p>
      {action !== undefined && <div className="cc-net-state-actions">{action}</div>}
    </div>
  );
}

/* 每条买家可见线路名称都指向 /status。管理员已绑定 3002 目标时，仅把经过
   后端校验的目标键放入 vps 查询参数，让监控页自动选中；历史未绑定行进入
   默认监控视图，不根据线路名称猜测 VPS。长名称仍完整换行显示。 */
function DeliveryLineLinks({
  lines,
  orderRef,
}: {
  lines: readonly MyDeliveryLineItem[];
  orderRef: string;
}) {
  return (
    <ul className="cc-net-line-labels">
      {lines.map((line) => (
        <li key={line.position}>
          <Link
            className="cc-net-line-label"
            to={
              line.monitorTargetKey === null
                ? "/status"
                : `/status?vps=${encodeURIComponent(line.monitorTargetKey)}`
            }
            aria-label={`线路 ${line.position}：${line.label}（订单 ${orderRef}），前往服务器状态页查看`}
          >
            <span className="cc-net-line-label-index" aria-hidden="true">{line.position}</span>
            <span className="cc-net-line-label-text">{line.label}</span>
            <span className="cc-net-line-label-go" aria-hidden="true">服务器状态</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* 一个服务的交付线路区块有四种诚实状态，彼此不可互相顶替：
   1. pending_open：明确「等待人工交付」，此时后端本就不会返回任何线路名称；
   2. 已开通且有线路：逐条列出可访问链接；
   3. 已开通但线路接口仍在读取 / 读取失败：显示读取中或「暂不可读取」，不谎称未配置；
   4. 已开通、线路接口成功但没有名称：显示「尚未配置买家可见线路名称」。 */
function ServiceDeliveryLines({
  service,
  deliveryState,
}: {
  service: AccountServiceView;
  deliveryState: Resource<readonly MyDeliveryLineItem[]>;
}) {
  if (service.serviceStatus === "pending_open") {
    return (
      <p className="cc-net-line-note">
        等待人工交付：服务完成开通后才会生成买家可见线路名称，当前不展示任何线路。
      </p>
    );
  }
  if (service.lines.length > 0) {
    return <DeliveryLineLinks lines={service.lines} orderRef={service.orderRef} />;
  }
  if (deliveryState.kind === "loading") {
    return <p className="cc-net-line-note">正在读取该服务的线路名称…</p>;
  }
  if (deliveryState.kind === "ready") {
    return (
      <p className="cc-net-line-note is-unknown">
        尚未配置买家可见线路名称：服务已开通，但没有可展示的线路条目。
      </p>
    );
  }
  return (
    <p className="cc-net-line-note is-unknown">
      线路名称暂不可读取，本次未显示该服务的任何线路。
    </p>
  );
}

function NodesPanel({
  servicesState,
  accountServices,
  ordersState,
  deliveryState,
  orphanLineGroups,
  onRetry,
  onRetryDeliveryLines,
}: {
  servicesState: Resource<readonly MyServiceItem[]>;
  accountServices: readonly AccountServiceView[];
  ordersState: Resource<readonly MyOrderItem[]>;
  deliveryState: Resource<readonly MyDeliveryLineItem[]>;
  orphanLineGroups: readonly OrphanLineGroup[];
  onRetry: () => void;
  onRetryDeliveryLines: () => void;
}) {
  const openCount = accountServices.filter((service) => service.serviceStatus === "open").length;
  const ready = servicesState.kind === "ready";
  /* 线路条数只作为「名称记录数」出现在说明文字里，并且始终与「不代表节点数量」同句，
     绝不进入四格统计，也绝不被读成在线节点数。 */
  const lineCountText =
    deliveryState.kind === "ready" ? ` · 已交付线路名称 ${deliveryState.items.length} 条` : "";
  const subline = ready
    ? `关联服务 ${accountServices.length} 项 · 已开通 ${openCount} 项${lineCountText} · 不代表节点数量`
    : servicesState.kind === "loading"
      ? "正在读取账户服务"
      : "账户服务暂不可读取";
  const tag = servicesState.kind === "loading" ? "读取中" : "节点待接入";

  /* 参考稿的四格：全部 / 在线 / 超时 / 离线。
     当前公共接口连节点总数都不能证明，因此四项都保持 — 未知态。 */
  const metrics = [
    { label: "全部", value: UNKNOWN, hint: "节点接口待接入", unknown: true },
    { label: "在线", value: UNKNOWN, hint: "待接入", unknown: true },
    { label: "超时", value: UNKNOWN, hint: "待接入", unknown: true },
    { label: "离线", value: UNKNOWN, hint: "待接入", unknown: true },
  ] as const;

  return (
    <section className="cc-net-panel" aria-labelledby="cc-net-nodes-title">
      <PanelHead
        eyebrow="NODES"
        title="可用节点"
        titleId="cc-net-nodes-title"
        subline={subline}
        tag={tag}
        icon={<NodesIcon />}
      />

      <div className="cc-net-metrics" aria-label="节点状态统计">
        {metrics.map((metric) => (
          <article className={metric.unknown ? "is-unknown" : ""} key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
            <small>{metric.hint}</small>
          </article>
        ))}
      </div>

      {servicesState.kind === "loading" && <Skeleton rows={3} label="正在读取关联账户服务…" />}

      {/* 会话失效必须整页导航；SPA Link 会被旧的 authenticated 状态弹回 /dashboard。 */}
      {servicesState.kind === "unauthorized" && (
        <StateBlock
          tone="alert"
          icon={<NodesIcon />}
          title="登录状态已失效"
          hint="重新登录后即可查看当前账户的关联服务；节点数据仍以接口接入状态为准。"
          action={<a className="cc-net-primary" href="/login">重新登录</a>}
        />
      )}

      {servicesState.kind === "error" && (
        <StateBlock
          tone="alert"
          icon={<NodesIcon />}
          title={servicesState.message}
          hint="网络恢复后可重新读取关联账户服务；不会据此推算节点数量。"
          action={
            <button type="button" className="cc-net-primary" onClick={onRetry}>
              重新加载
            </button>
          }
        />
      )}

      {ready && accountServices.length === 0 && (
        <StateBlock
          tone="empty"
          icon={<NodesIcon />}
          title="暂无关联账户服务"
          hint="节点接口尚未接入；当前账户也没有可用于辅助说明的服务记录。"
          action={<Link className="cc-net-primary" to="/subscribe">前往套餐订阅</Link>}
        />
      )}

      {ready && accountServices.length > 0 && (
        <>
          {(ordersState.kind === "error" || ordersState.kind === "unauthorized") && (
            <p className="cc-net-inline-note" role="status">
              服务属性（地区、运营商、类型）暂时无法读取，已留空而非猜测。
            </p>
          )}

          {/* 局部失败：服务与订单仍然有效，只有交付线路读不到。保留已读到的真实数据，
              降级成带重试的警告，绝不把整页替换成错误态。 */}
          {(deliveryState.kind === "error" || deliveryState.kind === "unauthorized") && (
            <div className="cc-net-warning" role="status">
              <div>
                <strong>
                  {deliveryState.kind === "error"
                    ? deliveryState.message
                    : "线路名称需要重新登录后读取"}
                </strong>
                <p>
                  下方服务与开通状态仍是本次读取到的真实数据；仅线路名称未能读取，已按服务逐条标注，不使用缓存或示例线路顶替。
                </p>
              </div>
              <div className="cc-net-warning-actions">
                <button type="button" className="cc-net-ghost" onClick={onRetryDeliveryLines}>
                  重试读取线路名称
                </button>
                {deliveryState.kind === "unauthorized" && (
                  <a className="cc-net-ghost" href="/login">重新登录</a>
                )}
              </div>
            </div>
          )}

          <ul className="cc-net-lines">
            {accountServices.map((service) => {
              const isOpen = service.serviceStatus === "open";
              const attributes = [service.region, service.isp, service.type].filter(
                (value): value is string => value !== null,
              );
              const attributeLabel =
                ordersState.kind === "loading"
                  ? "套餐属性读取中"
                  : ordersState.kind === "ready"
                    ? "套餐目录未匹配"
                    : "套餐属性待读取";
              return (
                <li className="cc-net-line" key={service.orderRef}>
                  <div className="cc-net-line-top">
                    <span className={`cc-net-line-dot ${isOpen ? "is-open" : ""}`} aria-hidden="true" />
                    <div className="cc-net-line-id">
                      <strong>{service.orderRef}</strong>
                      <small>
                        {attributes.length > 0 ? attributes.join(" · ") : attributeLabel}
                        <i aria-hidden="true" />
                        {formatDate(service.createdAt)}
                      </small>
                    </div>
                    <div className="cc-net-line-meta">
                      <span className={`cc-net-badge ${isOpen ? "is-open" : ""}`}>
                        {isOpen ? "已开通" : "待开通"}
                      </span>
                      {!isOpen && <span className="cc-net-badge is-waiting">等待人工交付</span>}
                      <span className="cc-net-badge is-unknown">运行状态待接入</span>
                    </div>
                  </div>
                  <div className="cc-net-line-delivery">
                    <span className="cc-net-line-delivery-label">交付线路名称</span>
                    <ServiceDeliveryLines service={service} deliveryState={deliveryState} />
                  </div>
                </li>
              );
            })}
          </ul>

          {orphanLineGroups.length > 0 && (
            <div className="cc-net-orphan">
              <strong>未匹配到账户服务的已交付线路</strong>
              <p>以下线路名称属于当前账户，但本次读到的服务列表里没有对应记录；刷新后通常会归入对应服务。</p>
              {orphanLineGroups.map((group) => (
                <div className="cc-net-orphan-group" key={group.orderRef}>
                  <small>关联订单 {group.orderRef}</small>
                  <DeliveryLineLinks lines={group.lines} orderRef={group.orderRef} />
                </div>
              ))}
            </div>
          )}

          <p className="cc-net-panel-foot">
            以上仅为关联账户服务与其买家可见线路名称，不等于节点清单：线路条数不是在线节点数，
            节点总数、在线、超时与离线状态均保持未知态。线路名称不包含订阅地址、主机名、IP、面板地址或任何连接信息。
          </p>
        </>
      )}
    </section>
  );
}

const TRAFFIC_FACTS = [
  { label: "已用流量", hint: "用量接口待接入" },
  { label: "剩余流量", hint: "配额接口待接入" },
  { label: "重置周期", hint: "周期数据待接入" },
] as const;

function TrafficPanel({
  servicesState,
  ordersState,
  accountServices,
}: {
  servicesState: Resource<readonly MyServiceItem[]>;
  ordersState: Resource<readonly MyOrderItem[]>;
  accountServices: readonly AccountServiceView[];
}) {
  const ready = servicesState.kind === "ready";

  return (
    <section className="cc-net-panel" aria-labelledby="cc-net-traffic-title">
      <PanelHead
        eyebrow="TRAFFIC"
        title="流量明细"
        titleId="cc-net-traffic-title"
        subline="查看你的流量使用记录与套餐标称"
        tag="统计待接入"
        icon={<TrafficIcon />}
      />

      <div className="cc-net-traffic-summary" aria-label="流量统计">
        {TRAFFIC_FACTS.map((fact) => (
          <div key={fact.label}>
            <span>{fact.label}</span>
            <strong>{UNKNOWN}</strong>
            <small>{fact.hint}</small>
          </div>
        ))}
      </div>

      {/* 未知态用斜纹轨道表达，不用任何会被误读为 0% 或健康值的实心进度条。 */}
      <div className="cc-net-meter">
        <div className="cc-net-meter-track" aria-hidden="true" />
        <small>用量与配额均未接入，此处不显示任何推算值或 0 值。</small>
      </div>

      {servicesState.kind === "loading" && <Skeleton rows={2} label="正在读取关联账户服务…" />}

      {(servicesState.kind === "unauthorized" || servicesState.kind === "error") && (
        <StateBlock
          tone="alert"
          icon={<TrafficIcon />}
          title="暂无法显示流量明细"
          hint="账户服务不可读取时，不展示任何服务标称或用量数据。"
        />
      )}

      {ready && accountServices.length === 0 && (
        <StateBlock
          tone="empty"
          icon={<TrafficIcon />}
          title="暂无流量记录"
          hint="账户还没有关联服务，也没有可展示的用量记录；开通服务后这里会显示对应服务的目录标称。"
        />
      )}

      {ready && accountServices.length > 0 && ordersState.kind === "loading" && (
        <Skeleton rows={2} label="正在读取服务目录标称…" />
      )}

      {ready && accountServices.length > 0 &&
        (ordersState.kind === "error" || ordersState.kind === "unauthorized") && (
        <StateBlock
          tone="alert"
          icon={<TrafficIcon />}
          title="套餐目录暂不可读取"
          hint="目录读取失败时不会显示推算标称，也不会把缺失数据误报为 0。"
        />
      )}

      {ready && accountServices.length > 0 && ordersState.kind === "ready" && (
        <>
          <div className="cc-net-subhead">
            <strong>各服务目录标称</strong>
            <span>来自已冻结套餐目录，非实测用量</span>
          </div>
          <ul className="cc-net-traffic-rows">
            <li className="cc-net-traffic-row is-head" aria-hidden="true">
              <span>服务</span>
              <span>目录标称流量</span>
              <span>目录标称带宽</span>
              <span>实际用量</span>
            </li>
            {accountServices.map((service) => (
              <li className="cc-net-traffic-row" key={service.orderRef}>
                <span className="cc-net-traffic-ref">
                  <strong>{service.orderRef}</strong>
                  <small>{service.region ?? "套餐目录未匹配"}</small>
                </span>
                {/* 表头行是纯视觉的（aria-hidden），字段名因此写进每个单元格：
                    桌面视觉隐藏但可被读屏读到，窄屏直接显示为行内标签。 */}
                <span>
                  <i className="cc-net-cell-label">目录标称流量</i>
                  {service.traffic ?? "目录未收录"}
                </span>
                <span>
                  <i className="cc-net-cell-label">目录标称带宽</i>
                  {service.bandwidth ?? "目录未收录"}
                </span>
                <span className="cc-net-traffic-unknown">
                  <i className="cc-net-cell-label">实际用量</i>
                  待接入
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="cc-net-monitor-note">
        <span className="cc-net-monitor-icon"><MonitorIcon /></span>
        <div>
          <strong>账户数据与公开监控相互独立</strong>
          <p>本页只展示关联账户服务；公开实时监控展示三网线路运行状态，不代表你的节点或账户用量。</p>
        </div>
        <Link className="cc-net-ghost" to="/monitor">查看公开实时监控</Link>
      </div>
    </section>
  );
}

export function BuyerNetworkPage() {
  const [servicesState, setServicesState] = useState<Resource<readonly MyServiceItem[]>>({ kind: "loading" });
  const [ordersState, setOrdersState] = useState<Resource<readonly MyOrderItem[]>>({ kind: "loading" });
  const [deliveryState, setDeliveryState] = useState<Resource<readonly MyDeliveryLineItem[]>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [deliveryToken, setDeliveryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setServicesState({ kind: "loading" });
    setOrdersState({ kind: "loading" });

    void getMyServices(controller.signal)
      .then((items) => {
        if (!stopped) setServicesState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setServicesState({ kind: "unauthorized" });
          return;
        }
        setServicesState({ kind: "error", message: resourceErrorMessage("服务", error) });
      });

    void getMyOrders(controller.signal)
      .then((items) => {
        if (!stopped) setOrdersState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setOrdersState({ kind: "unauthorized" });
          return;
        }
        setOrdersState({ kind: "error", message: resourceErrorMessage("订单", error) });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  /* 交付线路单独一个 effect 和单独一个 token：局部重试只重新读取线路名称，
     不会把已经读到的服务与订单打回 loading，避免有效数据在重试时闪没。
     整页刷新（reloadToken）同样会触发这里，保持三份数据同一次刷新。 */
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setDeliveryState({ kind: "loading" });

    void getMyDeliveryLines(controller.signal)
      .then((items) => {
        if (!stopped) setDeliveryState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setDeliveryState({ kind: "unauthorized" });
          return;
        }
        setDeliveryState({ kind: "error", message: resourceErrorMessage("交付线路", error) });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken, deliveryToken]);

  const services = servicesState.kind === "ready" ? servicesState.items : null;
  const orders = ordersState.kind === "ready" ? ordersState.items : null;
  const deliveryLines = deliveryState.kind === "ready" ? deliveryState.items : null;
  const linesByOrder = groupLinesByOrder(deliveryLines);
  const accountServices: readonly AccountServiceView[] =
    services === null ? [] : buildAccountServices(services, orders, linesByOrder);
  const orphanLineGroups: readonly OrphanLineGroup[] =
    services === null ? [] : collectOrphanLineGroups(linesByOrder, services);
  const isLoading =
    servicesState.kind === "loading" ||
    ordersState.kind === "loading" ||
    deliveryState.kind === "loading";
  const reload = () => setReloadToken((token) => token + 1);
  const reloadDeliveryLines = () => setDeliveryToken((token) => token + 1);

  return (
    <main className="cc-net-page">
      <div className="cc-net-layout">
        <header className="cc-net-head">
          <span className="cc-net-head-icon"><NodesIcon /></span>
          <div>
            <h1>可用节点与流量明细</h1>
            <p>关联服务、开通状态与已交付线路名称来自你的真实账户数据；节点清单、在线状态与流量统计尚未接入，保持未知态而不显示为 0。</p>
          </div>
          <button type="button" onClick={reload} disabled={isLoading}>
            <RefreshIcon />
            {isLoading ? "读取中…" : "刷新账户数据"}
          </button>
        </header>

        <div className="cc-net-grid">
          <NodesPanel
            servicesState={servicesState}
            accountServices={accountServices}
            ordersState={ordersState}
            deliveryState={deliveryState}
            orphanLineGroups={orphanLineGroups}
            onRetry={reload}
            onRetryDeliveryLines={reloadDeliveryLines}
          />
          <TrafficPanel
            servicesState={servicesState}
            ordersState={ordersState}
            accountServices={accountServices}
          />
        </div>
      </div>
    </main>
  );
}
