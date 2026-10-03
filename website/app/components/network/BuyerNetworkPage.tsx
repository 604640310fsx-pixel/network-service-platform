import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useCatalogText, useT, type Messages } from "../../lib/i18n";
import {
  PaymentApiError,
  getMyDeliveryLineListing,
  getMyOrders,
  getMyServiceListing,
  type MyDeliveryLineItem,
  type MyGrantDeliveryLineItem,
  type MyGrantItem,
  type MyOrderItem,
  type MyServiceItem,
  type ServiceStatus,
} from "../../lib/payment-api";
import { groupGiftLines, type GiftLineGroup } from "./giftLines";
import {
  buyerLineStatusHref,
  lineSelector,
  primaryLineStatusHref,
  type BuyerLineRef,
} from "../../lib/buyerStatusLink";
import { getSubscriptionInfo, type SubscriptionInfo } from "../../lib/subscription-info-api";
import { aggregateUsage, formatBytes, usageFacts, type UsageFacts } from "./trafficUsage";
import { resolveSelection } from "../../lib/resolveSelection";
import {
  getMyNodeStatus,
  nodeStatusCounts,
  type NodeLineStatus,
  type NodeStatusItem,
  type NodeStatusResult,
} from "../../lib/node-status-api";
import "./buyer-network.css";

/* /network 买家「节点与流量」页。
   真实数据只来自既有 GET /api/me/services、GET /api/me/orders 与 GET /api/me/delivery-lines；
   赠送套餐（services 中 source=grant）与其交付线路（delivery-lines 中 source=grant）按赠送 id
   单独成组，计入「关联服务」，同样只显示线路名称；
   服务属性名称来自已冻结的 SUBSCRIBE-CATALOG-V1（目录标称，非实测值）。节点在线 / 超时 /
   离线、实际用量、配额与重置周期没有公共契约，一律显示「待接入」的未知态：参考稿里的
   0 在本页一律写成 —，绝不渲染伪造的 0 值或 Mock 生产数据。
   交付线路只展示后端已脱敏的 orderRef / position / label 三项，绝不展示订阅地址、主机名、
   IP、面板地址、凭据、监控 ID 或供应商身份；线路条数也不当作在线节点数使用。
   三个接口相互独立：交付线路读取失败时保留仍然有效的服务与订单，只降级为局部警告 + 重试。
   视觉语言：真实数据用 --cc-text 强调，未知数据用 --cc-text-4 弱化，二者一眼可分。
   账户内线路入口统一进入不带目标参数的 /status；目标只由 Auth 按所有权选择。
   公开 /monitor 仍保持独立，但不再从本账户数据卡片跳转。 */

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

/* 节点状态：loading / ready(available|unavailable) / error。只有 ready+available 才给出真实计数。 */
type NodeStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: NodeStatusResult }
  | { readonly kind: "error" };

type StatusLookup = (ref: string, position: number) => NodeLineStatus | null;

function NodeStatusBadge({ status }: { status: NodeLineStatus }) {
  const t = useT();
  return <span className={`cc-net-status is-${status}`}>{t.network.nodeStatus[status]}</span>;
}

function resourceErrorMessage(resource: string, error: unknown, messages: Messages["dashboard"]): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return messages.resourceInvalid(resource);
  }
  return messages.resourceUnavailable(resource);
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
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

/* 每条买家可见线路名称只指向同源 /status，不携带目标、订单或线路参数。
   Auth 依据当前 Session 和所有权在服务端选择目标。长名称仍完整换行显示。 */
/* 每条交付线路进入它自己绑定的服务器状态页（/status?line=…，由 Auth 校验所有权并解析绑定）。
   已确知未绑定监控的线路（在线状态为 unbound）不是链接，直接标注「未绑定监控」；
   状态未知时仍可点击，由状态页给出明确结果。 */
function LineStatusLink({
  line,
  label,
  ariaLabel,
  status,
}: {
  line: BuyerLineRef;
  label: string;
  ariaLabel: string;
  status: NodeLineStatus | null;
}) {
  const t = useT();
  const body = (
    <>
      <span className="cc-net-line-label-index" aria-hidden="true">{line.position}</span>
      <span className="cc-net-line-label-text">{label}</span>
      {status !== null && <NodeStatusBadge status={status} />}
    </>
  );
  if (status === "unbound") {
    return (
      <div className="cc-net-line-label is-static">
        {body}
        <span className="cc-net-line-label-go">{t.network.lineUnmonitored}</span>
      </div>
    );
  }
  return (
    <Link className="cc-net-line-label" to={buyerLineStatusHref(line)} aria-label={ariaLabel}>
      {body}
      <span className="cc-net-line-label-go" aria-hidden="true">{t.network.lineGo}</span>
    </Link>
  );
}

function DeliveryLineLinks({
  lines,
  orderRef,
  statusFor,
}: {
  lines: readonly MyDeliveryLineItem[];
  orderRef: string;
  statusFor?: StatusLookup;
}) {
  const t = useT();
  return (
    <ul className="cc-net-line-labels">
      {lines.map((line) => (
        <li key={line.position}>
          <LineStatusLink
            line={{ kind: "service", ref: orderRef, position: line.position }}
            label={line.label}
            ariaLabel={t.network.lineAria(line.position, line.label, orderRef)}
            status={statusFor?.(orderRef, line.position) ?? null}
          />
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
  statusFor,
}: {
  service: AccountServiceView;
  deliveryState: Resource<readonly MyDeliveryLineItem[]>;
  statusFor?: StatusLookup;
}) {
  const t = useT();
  if (service.serviceStatus === "pending_open") {
    return (
      <p className="cc-net-line-note">
        {t.network.awaitingDelivery}
      </p>
    );
  }
  if (service.lines.length > 0) {
    return <DeliveryLineLinks lines={service.lines} orderRef={service.orderRef} statusFor={statusFor} />;
  }
  if (deliveryState.kind === "loading") {
    return <p className="cc-net-line-note">{t.network.linesLoading}</p>;
  }
  if (deliveryState.kind === "ready") {
    return (
      <p className="cc-net-line-note is-unknown">
        {t.network.linesNotConfigured}
      </p>
    );
  }
  return (
    <p className="cc-net-line-note is-unknown">
      {t.network.linesUnavailable}
    </p>
  );
}

function NodesPanel({
  servicesState,
  accountServices,
  ordersState,
  deliveryState,
  orphanLineGroups,
  giftGroups,
  giftOpenCount,
  giftLineCount,
  nodeStatus,
  onRetry,
  onRetryDeliveryLines,
  onRetryStatus,
}: {
  servicesState: Resource<readonly MyServiceItem[]>;
  accountServices: readonly AccountServiceView[];
  /** One group per active gift (plus any gift line whose gift is not listed). */
  giftGroups: readonly GiftLineGroup[];
  giftOpenCount: number;
  giftLineCount: number;
  ordersState: Resource<readonly MyOrderItem[]>;
  deliveryState: Resource<readonly MyDeliveryLineItem[]>;
  orphanLineGroups: readonly OrphanLineGroup[];
  nodeStatus: NodeStatusState;
  onRetry: () => void;
  onRetryDeliveryLines: () => void;
  onRetryStatus: () => void;
}) {
  const t = useT();
  const ct = useCatalogText();
  const openCount = accountServices.filter((service) => service.serviceStatus === "open").length;
  const ready = servicesState.kind === "ready";
  /* 线路条数只作为「名称记录数」出现在说明文字里，并且始终与「不代表节点数量」同句，
     绝不进入四格统计，也绝不被读成在线节点数。 */
  const lineCountText =
    deliveryState.kind === "ready" ? t.network.lineCount(deliveryState.items.length + giftLineCount) : "";
  const subline = ready
    ? t.network.nodesSubline(accountServices.length + giftGroups.length, openCount + giftOpenCount, lineCountText)
    : servicesState.kind === "loading"
      ? t.network.servicesLoading
      : t.network.servicesUnavailable;
  const live = nodeStatus.kind === "ready" && nodeStatus.result.monitor === "available";
  const statusItems: readonly NodeStatusItem[] = live ? nodeStatus.result.items : [];
  const statusUnavailable =
    nodeStatus.kind === "error" || (nodeStatus.kind === "ready" && nodeStatus.result.monitor === "unavailable");
  const tag =
    servicesState.kind === "loading" || nodeStatus.kind === "loading"
      ? t.network.loadingTag
      : live
        ? t.network.nodesLiveTag
        : t.network.nodesPendingTag;
  const statusByLine = new Map(
    statusItems.filter((item) => item.kind === "service").map((item) => [`${item.ref}#${item.position}`, item.status] as const),
  );
  const statusFor: StatusLookup | undefined = live ? (ref, position) => statusByLine.get(`${ref}#${position}`) ?? null : undefined;
  const giftStatusByLine = new Map(
    statusItems.filter((item) => item.kind === "grant").map((item) => [`${item.ref}#${item.position}`, item.status] as const),
  );

  /* 四格：全部 / 在线 / 超时 / 离线。只有私有监控可用时显示真实计数；全部 = 全部交付线路，
     未绑定与未知只计入「全部」并在其提示里单列（待接入组）。监控不可用 / 读取中保持 — 未知态。 */
  const counts = nodeStatusCounts(statusItems);
  const unknownHint = nodeStatus.kind === "loading" ? t.network.statusLoading : t.network.statusUnavailable;
  const metrics = live
    ? [
        { label: t.network.metrics.all, value: String(counts.all), hint: t.network.metricHints.all(counts.unbound, counts.unknown), unknown: false, tone: "" },
        { label: t.network.metrics.online, value: String(counts.online), hint: t.network.metricHints.online, unknown: false, tone: "is-online" },
        { label: t.network.metrics.timeout, value: String(counts.stale), hint: t.network.metricHints.timeout, unknown: false, tone: "is-stale" },
        { label: t.network.metrics.offline, value: String(counts.offline), hint: t.network.metricHints.offline, unknown: false, tone: "is-offline" },
      ]
    : [
        { label: t.network.metrics.all, value: UNKNOWN, hint: unknownHint, unknown: true, tone: "" },
        { label: t.network.metrics.online, value: UNKNOWN, hint: unknownHint, unknown: true, tone: "" },
        { label: t.network.metrics.timeout, value: UNKNOWN, hint: unknownHint, unknown: true, tone: "" },
        { label: t.network.metrics.offline, value: UNKNOWN, hint: unknownHint, unknown: true, tone: "" },
      ];

  return (
    <section className="cc-net-panel" aria-labelledby="cc-net-nodes-title">
      <PanelHead
        eyebrow="NODES"
        title={t.network.nodesTitle}
        titleId="cc-net-nodes-title"
        subline={subline}
        tag={tag}
        icon={<NodesIcon />}
      />

      <div className="cc-net-metrics" aria-label={t.network.metricsLabel}>
        {metrics.map((metric) => (
          <article className={[metric.unknown ? "is-unknown" : "", metric.tone].filter(Boolean).join(" ")} key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
            <small>{metric.hint}</small>
          </article>
        ))}
      </div>

      {statusUnavailable && (
        <div className="cc-net-warning cc-net-status-warning" role="status">
          <div>
            <strong>{t.network.statusUnavailable}</strong>
            <p>{t.network.statusUnavailableHint}</p>
          </div>
          <div className="cc-net-warning-actions">
            <button type="button" className="cc-net-ghost" onClick={onRetryStatus}>{t.network.retryStatus}</button>
          </div>
        </div>
      )}

      {servicesState.kind === "loading" && <Skeleton rows={3} label={t.network.loadingServices} />}

      {/* 会话失效必须整页导航；SPA Link 会被旧的 authenticated 状态弹回 /dashboard。 */}
      {servicesState.kind === "unauthorized" && (
        <StateBlock
          tone="alert"
          icon={<NodesIcon />}
          title={t.network.signedOutTitle}
          hint={t.network.signedOutHint}
          action={<a className="cc-net-primary" href="/login">{t.account.signInAgain}</a>}
        />
      )}

      {servicesState.kind === "error" && (
        <StateBlock
          tone="alert"
          icon={<NodesIcon />}
          title={servicesState.message}
          hint={t.network.errorHint}
          action={
            <button type="button" className="cc-net-primary" onClick={onRetry}>
              {t.account.reload}
            </button>
          }
        />
      )}

      {ready && accountServices.length === 0 && giftGroups.length === 0 && (
        <StateBlock
          tone="empty"
          icon={<NodesIcon />}
          title={t.network.emptyTitle}
          hint={t.network.emptyHint}
          action={<Link className="cc-net-primary" to="/subscribe">{t.account.goSubscribe}</Link>}
        />
      )}

      {ready && (accountServices.length > 0 || giftGroups.length > 0) && (
        <>
          {(ordersState.kind === "error" || ordersState.kind === "unauthorized") && (
            <p className="cc-net-inline-note" role="status">
              {t.network.attributesUnavailable}
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
                    : t.network.linesNeedLogin}
                </strong>
                <p>
                  {t.network.linesPartialFailure}
                </p>
              </div>
              <div className="cc-net-warning-actions">
                <button type="button" className="cc-net-ghost" onClick={onRetryDeliveryLines}>
                  {t.network.retryLines}
                </button>
                {deliveryState.kind === "unauthorized" && (
                  <a className="cc-net-ghost" href="/login">{t.account.signInAgain}</a>
                )}
              </div>
            </div>
          )}

          {accountServices.length > 0 && <ul className="cc-net-lines">
            {accountServices.map((service) => {
              const isOpen = service.serviceStatus === "open";
              const attributes = [service.region, service.isp, service.type]
                .filter((value): value is string => value !== null)
                .map(ct);
              const attributeLabel =
                ordersState.kind === "loading"
                  ? t.network.attributesLoading
                  : ordersState.kind === "ready"
                    ? t.network.catalogUnmatched
                    : t.network.attributesPending;
              return (
                <li className="cc-net-line" key={service.orderRef}>
                  <div className="cc-net-line-top">
                    <span className={`cc-net-line-dot ${isOpen ? "is-open" : ""}`} aria-hidden="true" />
                    <div className="cc-net-line-id">
                      <strong>{service.orderRef}</strong>
                      <small>
                        {attributes.length > 0 ? attributes.join(" · ") : attributeLabel}
                        <i aria-hidden="true" />
                        {formatDate(service.createdAt, t.account.dateLocale)}
                      </small>
                    </div>
                    <div className="cc-net-line-meta">
                      <span className={`cc-net-badge ${isOpen ? "is-open" : ""}`}>
                        {isOpen ? t.account.serviceStatus.open : t.account.serviceStatus.pending}
                      </span>
                      {!isOpen && <span className="cc-net-badge is-waiting">{t.network.waitingDelivery}</span>}
                      {!live && <span className="cc-net-badge is-unknown">{t.network.runtimePending}</span>}
                    </div>
                  </div>
                  <div className="cc-net-line-delivery">
                    <span className="cc-net-line-delivery-label">{t.network.deliveryLines}</span>
                    <ServiceDeliveryLines service={service} deliveryState={deliveryState} statusFor={statusFor} />
                  </div>
                  {isOpen && service.orderRef.trim() !== "" && (
                    <div className="cc-net-line-actions">
                      <Link
                        className="cc-net-ghost"
                        to={`/subscribe/request?orderRef=${encodeURIComponent(service.orderRef)}`}
                      >
                        {t.network.viewSubscription}
                      </Link>
                      <Link className="cc-net-ghost" to="/docs">{t.network.importGuide}</Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>}

          {orphanLineGroups.length > 0 && (
            <div className="cc-net-orphan">
              <strong>{t.network.orphanTitle}</strong>
              <p>{t.network.orphanBody}</p>
              {orphanLineGroups.map((group) => (
                <div className="cc-net-orphan-group" key={group.orderRef}>
                  <small>{t.network.orphanOrder(group.orderRef)}</small>
                  <DeliveryLineLinks lines={group.lines} orderRef={group.orderRef} statusFor={statusFor} />
                </div>
              ))}
            </div>
          )}

          {giftGroups.length > 0 && (
            <div className="cc-net-gift-lines">
              <strong>{t.network.giftLinesTitle}</strong>
              {giftGroups.map((group) => {
                const delivered = group.deliveryStatus === "open";
                return (
                  <div className="cc-net-gift-group" key={group.grantId}>
                    <div className="cc-net-gift-head">
                      <span className="cc-net-gift-name">{group.label ?? t.network.giftRef(group.grantId)}</span>
                      <span className="cc-net-badge is-open">{t.services.gift}</span>
                      <span className={`cc-net-badge ${delivered ? "is-open" : "is-waiting"}`}>
                        {delivered ? t.dashboard.giftDelivered : t.dashboard.giftAwaitingDelivery}
                      </span>
                    </div>
                    {group.lines.length > 0 ? (
                      <ul className="cc-net-line-labels">
                        {group.lines.map((line) => {
                          const status = live ? giftStatusByLine.get(`${group.grantId}#${line.position}`) ?? null : null;
                          return (
                            <li key={`${group.grantId}-${line.position}`}>
                              <LineStatusLink
                                line={{ kind: "grant", ref: group.grantId, position: line.position }}
                                label={line.label}
                                ariaLabel={t.network.giftLineAria(line.position, line.label)}
                                status={status}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    ) : !delivered ? (
                      <p className="cc-net-line-note">{t.network.giftAwaitingLines}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <p className="cc-net-panel-foot">
            {t.network.nodesFoot}
          </p>
        </>
      )}
    </section>
  );
}

const TRAFFIC_FACTS = ["used", "remaining", "reset"] as const;

/** One delivered line whose subscription usage the traffic panel reads (names only, no URL). */
type UsageLine = { readonly selector: string; readonly label: string; readonly owner: string };

type UsageState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly info: SubscriptionInfo } | { readonly kind: "failed" };

/* 每条交付线路独立读取订阅用量（服务端代取 subscription-userinfo，订阅地址不出服务端）：
   单行失败只影响该行并可单独重试；不支持用量的订阅如实显示「不提供用量」。 */
function useLineUsage(lines: readonly UsageLine[], reloadToken: number) {
  const [states, setStates] = useState<Readonly<Record<string, UsageState>>>({});
  const key = lines.map((line) => line.selector).join("|");

  function load(selector: string, signal?: AbortSignal) {
    setStates((current) => ({ ...current, [selector]: { kind: "loading" } }));
    void getSubscriptionInfo(selector, signal)
      .then((info) => {
        if (!signal?.aborted) setStates((current) => ({ ...current, [selector]: { kind: "ready", info } }));
      })
      .catch(() => {
        if (!signal?.aborted) setStates((current) => ({ ...current, [selector]: { kind: "failed" } }));
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    setStates({});
    for (const line of lines) load(line.selector, controller.signal);
    return () => controller.abort();
    // Lines are identified by their selectors; reloadToken forces a refresh.
  }, [key, reloadToken]);

  return { states, retry: (selector: string) => load(selector) };
}

function LineUsageRow({ line, state, onRetry }: { line: UsageLine; state: UsageState | undefined; onRetry: () => void }) {
  const t = useT();
  const copy = t.network.usage;
  const facts = state?.kind === "ready" && state.info.kind === "usage" ? usageFacts(state.info.usage) : null;
  return (
    <li className="cc-net-usage-row" aria-label={copy.lineAria(line.label)}>
      <span className="cc-net-traffic-ref">
        <strong>{line.label}</strong>
        <small>{line.owner}</small>
      </span>
      {facts !== null ? (
        <div className="cc-net-usage-facts">
          <span>
            <i className="cc-net-usage-label">{copy.used}</i>
            {facts.used === null ? UNKNOWN : formatBytes(facts.used)}
            {facts.total !== null && <small>{copy.total(formatBytes(facts.total))}</small>}
          </span>
          <span>
            <i className="cc-net-usage-label">{copy.remaining}</i>
            {facts.remaining === null ? UNKNOWN : formatBytes(facts.remaining)}
          </span>
          <span>
            <i className="cc-net-usage-label">{copy.expire}</i>
            {facts.expireAt === null ? copy.expireNone : formatDate(facts.expireAt.toISOString(), t.account.dateLocale)}
          </span>
          {facts.ratio !== null && (
            <div className="cc-net-usage-bar" role="img" aria-label={`${Math.round(facts.ratio * 100)}%`}>
              <span style={{ width: `${Math.max(facts.ratio * 100, facts.ratio > 0 ? 2 : 0)}%` }} />
            </div>
          )}
        </div>
      ) : state === undefined || state.kind === "loading" ? (
        <span className="cc-net-usage-note">{copy.loading}</span>
      ) : state.kind === "ready" && state.info.kind === "no_userinfo" ? (
        <span className="cc-net-usage-note">{copy.noUserinfo}</span>
      ) : (
        <span className="cc-net-usage-note is-failed">
          {copy.unreachable}
          <button type="button" className="cc-net-ghost" onClick={onRetry}>{copy.retry}</button>
        </span>
      )}
    </li>
  );
}

function TrafficPanel({
  servicesState,
  ordersState,
  accountServices,
  usageLines,
  reloadToken,
  statusHref,
}: {
  servicesState: Resource<readonly MyServiceItem[]>;
  ordersState: Resource<readonly MyOrderItem[]>;
  accountServices: readonly AccountServiceView[];
  usageLines: readonly UsageLine[];
  reloadToken: number;
  /** /status?line=… of the account's first bound line, or plain /status. */
  statusHref: string;
}) {
  const t = useT();
  const ct = useCatalogText();
  const ready = servicesState.kind === "ready";
  const usage = useLineUsage(usageLines, reloadToken);
  const reported: UsageFacts[] = usageLines.flatMap((line) => {
    const state = usage.states[line.selector];
    return state?.kind === "ready" && state.info.kind === "usage" ? [usageFacts(state.info.usage)] : [];
  });
  const totals = aggregateUsage(reported);
  const summary = {
    used: totals.used === null ? null : formatBytes(totals.used),
    remaining: totals.remaining === null ? null : formatBytes(totals.remaining),
    reset: null,
  } as const;

  return (
    <section className="cc-net-panel" aria-labelledby="cc-net-traffic-title">
      <PanelHead
        eyebrow="TRAFFIC"
        title={t.network.trafficTitle}
        titleId="cc-net-traffic-title"
        subline={t.network.trafficSubline}
        tag={totals.lines > 0 ? t.network.usage.tagLive : t.network.trafficTag}
        icon={<TrafficIcon />}
      />

      {/* 汇总只累加有订阅商数据的线路，并在提示里写明条数；重置周期订阅头不提供，如实显示 —。 */}
      <div className="cc-net-traffic-summary" aria-label={t.network.trafficLabel}>
        {TRAFFIC_FACTS.map((fact) => (
          <div key={fact} className={summary[fact] === null ? "" : "is-known"}>
            <span>{t.network.trafficFacts[fact].label}</span>
            <strong>{summary[fact] ?? UNKNOWN}</strong>
            <small>
              {fact === "reset"
                ? (usageLines.length > 0 ? t.network.usage.resetHint : t.network.trafficFacts.reset.hint)
                : summary[fact] !== null
                  ? t.network.usage.aggregateHint(totals.lines)
                  : t.network.trafficFacts[fact].hint}
            </small>
          </div>
        ))}
      </div>

      {usageLines.length > 0 ? (
        <div className="cc-net-usage">
          <div className="cc-net-subhead">
            <strong>{t.network.usage.title}</strong>
            <span>{t.network.usage.note}</span>
          </div>
          <ul className="cc-net-usage-rows">
            {usageLines.map((line) => (
              <LineUsageRow key={line.selector} line={line} state={usage.states[line.selector]} onRetry={() => usage.retry(line.selector)} />
            ))}
          </ul>
        </div>
      ) : (
        /* 未知态用斜纹轨道表达，不用任何会被误读为 0% 或健康值的实心进度条。 */
        <div className="cc-net-meter">
          <div className="cc-net-meter-track" aria-hidden="true" />
          <small>{t.network.meterNote}</small>
        </div>
      )}

      {servicesState.kind === "loading" && <Skeleton rows={2} label={t.network.loadingServices} />}

      {(servicesState.kind === "unauthorized" || servicesState.kind === "error") && (
        <StateBlock
          tone="alert"
          icon={<TrafficIcon />}
          title={t.network.trafficUnavailableTitle}
          hint={t.network.trafficUnavailableHint}
        />
      )}

      {ready && accountServices.length === 0 && usageLines.length === 0 && (
        <StateBlock
          tone="empty"
          icon={<TrafficIcon />}
          title={t.network.trafficEmptyTitle}
          hint={t.network.trafficEmptyHint}
        />
      )}

      {ready && accountServices.length > 0 && ordersState.kind === "loading" && (
        <Skeleton rows={2} label={t.network.catalogLoading} />
      )}

      {ready && accountServices.length > 0 &&
        (ordersState.kind === "error" || ordersState.kind === "unauthorized") && (
        <StateBlock
          tone="alert"
          icon={<TrafficIcon />}
          title={t.network.catalogUnavailableTitle}
          hint={t.network.catalogUnavailableHint}
        />
      )}

      {ready && accountServices.length > 0 && ordersState.kind === "ready" && (
        <>
          <div className="cc-net-subhead">
            <strong>{t.network.catalogTitle}</strong>
            <span>{t.network.catalogNote}</span>
          </div>
          <ul className="cc-net-traffic-rows">
            <li className="cc-net-traffic-row is-head" aria-hidden="true">
              <span>{t.network.columns.service}</span>
              <span>{t.network.columns.traffic}</span>
              <span>{t.network.columns.bandwidth}</span>
              <span>{t.network.columns.usage}</span>
            </li>
            {accountServices.map((service) => (
              <li className="cc-net-traffic-row" key={service.orderRef}>
                <span className="cc-net-traffic-ref">
                  <strong>{service.orderRef}</strong>
                  <small>{service.region === null ? t.network.catalogUnmatched : ct(service.region)}</small>
                </span>
                {/* 表头行是纯视觉的（aria-hidden），字段名因此写进每个单元格：
                    桌面视觉隐藏但可被读屏读到，窄屏直接显示为行内标签。 */}
                <span>
                  <i className="cc-net-cell-label">{t.network.columns.traffic}</i>
                  {service.traffic ?? t.network.notInCatalog}
                </span>
                <span>
                  <i className="cc-net-cell-label">{t.network.columns.bandwidth}</i>
                  {service.bandwidth ?? t.network.notInCatalog}
                </span>
                <span className="cc-net-traffic-unknown">
                  <i className="cc-net-cell-label">{t.network.columns.usage}</i>
                  {t.network.pending}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="cc-net-monitor-note">
        <span className="cc-net-monitor-icon"><MonitorIcon /></span>
        <div>
          <strong>{t.network.statusTitle}</strong>
          <p>{t.network.statusBody}</p>
        </div>
        <Link className="cc-net-ghost" to={statusHref}>{t.network.viewStatus}</Link>
      </div>
    </section>
  );
}

export function BuyerNetworkPage() {
  const t = useT();
  const [servicesState, setServicesState] = useState<Resource<readonly MyServiceItem[]>>({ kind: "loading" });
  const [ordersState, setOrdersState] = useState<Resource<readonly MyOrderItem[]>>({ kind: "loading" });
  const [deliveryState, setDeliveryState] = useState<Resource<readonly MyDeliveryLineItem[]>>({ kind: "loading" });
  const [grants, setGrants] = useState<readonly MyGrantItem[]>([]);
  const [giftDeliveryLines, setGiftDeliveryLines] = useState<readonly MyGrantDeliveryLineItem[] | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [deliveryToken, setDeliveryToken] = useState(0);
  const [nodeStatus, setNodeStatus] = useState<NodeStatusState>({ kind: "loading" });
  const [statusToken, setStatusToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setServicesState({ kind: "loading" });
    setOrdersState({ kind: "loading" });

    void getMyServiceListing(controller.signal)
      .then((listing) => {
        if (stopped) return;
        setServicesState({ kind: "ready", items: listing.services });
        setGrants(listing.grants);
      })
      .catch((error: unknown) => {
        if (stopped) return;
        setGrants([]);
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setServicesState({ kind: "unauthorized" });
          return;
        }
        setServicesState({ kind: "error", message: resourceErrorMessage(t.network.resources.services, error, t.dashboard) });
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
        setOrdersState({ kind: "error", message: resourceErrorMessage(t.network.resources.orders, error, t.dashboard) });
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

    setGiftDeliveryLines(null);
    void getMyDeliveryLineListing(controller.signal)
      .then((listing) => {
        if (stopped) return;
        setDeliveryState({ kind: "ready", items: listing.services });
        setGiftDeliveryLines(listing.grants);
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setDeliveryState({ kind: "unauthorized" });
          return;
        }
        setDeliveryState({ kind: "error", message: resourceErrorMessage(t.network.resources.lines, error, t.dashboard) });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken, deliveryToken]);

  /* 在线状态独立读取：失败只把四格与徽标降级为「状态暂不可用」，不影响服务与线路数据。 */
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setNodeStatus({ kind: "loading" });
    void getMyNodeStatus(controller.signal)
      .then((result) => {
        if (!stopped) setNodeStatus({ kind: "ready", result });
      })
      .catch(() => {
        if (!stopped) setNodeStatus({ kind: "error" });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken, statusToken]);

  const services = servicesState.kind === "ready" ? servicesState.items : null;
  const orders = ordersState.kind === "ready" ? ordersState.items : null;
  const deliveryLines = deliveryState.kind === "ready" ? deliveryState.items : null;
  const linesByOrder = groupLinesByOrder(deliveryLines);
  const accountServices: readonly AccountServiceView[] =
    services === null ? [] : buildAccountServices(services, orders, linesByOrder);
  const orphanLineGroups: readonly OrphanLineGroup[] =
    services === null ? [] : collectOrphanLineGroups(linesByOrder, services);
  const giftGroups: readonly GiftLineGroup[] = services === null ? [] : groupGiftLines(grants, giftDeliveryLines);
  const giftOpenCount = grants.filter((grant) => grant.deliveryStatus === "open").length;
  const statusLines: BuyerLineRef[] = [
    ...(deliveryLines ?? []).map((line): BuyerLineRef => ({ kind: "service", ref: line.orderRef, position: line.position })),
    ...(giftDeliveryLines ?? []).map((line): BuyerLineRef => ({ kind: "grant", ref: line.grantId, position: line.position })),
  ];
  const knownStatus = nodeStatus.kind === "ready" && nodeStatus.result.monitor === "available"
    ? new Map<string, NodeLineStatus>(nodeStatus.result.items.map((item) => [`${item.kind}:${item.ref}:${item.position}`, item.status]))
    : null;
  const statusHref = primaryLineStatusHref(statusLines, (line) => knownStatus?.get(lineSelector(line)) === "unbound");
  const usageLines: readonly UsageLine[] = [
    ...(deliveryLines ?? []).map((line) => ({
      selector: lineSelector({ kind: "service", ref: line.orderRef, position: line.position }),
      label: line.label,
      owner: line.orderRef,
    })),
    ...(giftDeliveryLines ?? []).map((line) => ({
      selector: lineSelector({ kind: "grant", ref: line.grantId, position: line.position }),
      label: line.label,
      owner: grants.find((grant) => grant.grantId === line.grantId)?.label ?? t.network.giftRef(line.grantId),
    })),
  ];
  const isLoading =
    servicesState.kind === "loading" ||
    ordersState.kind === "loading" ||
    deliveryState.kind === "loading" ||
    nodeStatus.kind === "loading";
  const reload = () => setReloadToken((token) => token + 1);
  const reloadDeliveryLines = () => setDeliveryToken((token) => token + 1);

  return (
    <main className="cc-net-page">
      <div className="cc-net-layout">
        <header className="cc-net-head">
          <span className="cc-net-head-icon"><NodesIcon /></span>
          <div>
            <h1>{t.network.pageTitle}</h1>
            <p>{t.network.pageLead}</p>
          </div>
          <button type="button" onClick={reload} disabled={isLoading}>
            <RefreshIcon />
            {isLoading ? t.network.refreshing : t.network.refresh}
          </button>
        </header>

        <div className="cc-net-grid">
          <NodesPanel
            servicesState={servicesState}
            accountServices={accountServices}
            ordersState={ordersState}
            deliveryState={deliveryState}
            orphanLineGroups={orphanLineGroups}
            giftGroups={giftGroups}
            giftOpenCount={giftOpenCount}
            giftLineCount={giftDeliveryLines?.length ?? 0}
            nodeStatus={nodeStatus}
            onRetry={reload}
            onRetryDeliveryLines={reloadDeliveryLines}
            onRetryStatus={() => setStatusToken((token) => token + 1)}
          />
          <TrafficPanel
            servicesState={servicesState}
            ordersState={ordersState}
            accountServices={accountServices}
            usageLines={usageLines}
            reloadToken={reloadToken}
            statusHref={statusHref}
          />
        </div>
      </div>
    </main>
  );
}
