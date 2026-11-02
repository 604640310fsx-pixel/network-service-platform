import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError, cancelServiceDowngrade, createOrderCredentials,
  getServiceChangeOptions, orderServiceUpgrade, quoteServiceUpgrade,
  scheduleServiceDowngrade, simulateServiceFulfillment, simulateServicePayment,
  type MyServiceItem, type OrderCredentials, type ServiceChangeOption,
  type ServiceEntitlement, type ServiceUpgradeQuote,
} from "../../lib/payment-api";
import {
  ispsByTypeAndRegion, networkTypes, packageLinesByTypeAndRegion,
  packageSpecsByTypeAndRegion, regionsByType, trafficOptions,
} from "../../lib/subscribeCatalog";
import "./service-change-card.css";

type Target = { line: string; traffic: string };
type QuoteState = { key: string; quote: ServiceUpgradeQuote };

function fen(value: number): string { return `¥${(value / 100).toFixed(2).replace(/\.00$/, "")}`; }
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(parsed) : value;
}
function dateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(parsed) : value;
}
function typeName(id: string): string { return networkTypes.find((item) => item.id === id)?.name ?? id; }
function placeName(typeId: string, regionId: string, ispId: string): string {
  const region = regionsByType[typeId]?.find((item) => item.id === regionId);
  const isp = ispsByTypeAndRegion[typeId]?.[regionId]?.find((item) => item.id === ispId);
  return `${region?.cardName ?? region?.name ?? regionId} · ${isp?.name ?? ispId}`;
}
function splitSpec(specId: string | null): Target {
  if (specId === null) return { line: "ordinary", traffic: "200g" };
  const traffic = specId.split("-").at(-1) ?? "200g";
  return { line: specId.slice(0, -(traffic.length + 1)), traffic };
}
function planName(entitlement: ServiceEntitlement, target: Target): string {
  const line = packageLinesByTypeAndRegion[entitlement.typeId]?.[entitlement.regionId]
    ?.find((item) => item.id === target.line)?.name ?? target.line;
  const traffic = trafficOptions.find((item) => item.id === target.traffic)?.name ?? target.traffic;
  return `${line} ${traffic}`;
}
function specIdFor(entitlement: ServiceEntitlement, target: Target): string | null | undefined {
  if (entitlement.typeId === "local-isp" && target.line === "ordinary" && target.traffic === "200g") return null;
  return packageSpecsByTypeAndRegion[entitlement.typeId]?.[entitlement.regionId]
    ?.find((item) => item.lineId === target.line && item.trafficId === target.traffic)?.id;
}
function errorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "操作未完成，请检查连接后重试。";
  const labels: Record<string, string> = {
    unauthorized: "登录已失效，请重新登录。", csrf_invalid: "安全校验已失效，请刷新页面。",
    invalid_response: "服务数据返回异常，请稍后重试。", network_error: "网络中断，请确认状态后重试。",
    stale_change_quote: "报价已变化，请重新核对服务器报价。",
    change_already_pending: "当前变更尚未结束，请先处理或取消预约。",
    invalid_change_target: "这个组合不能一次调整，请换一个线路或流量档。",
    plan_unavailable: "目标组合当前不可售。", service_not_quotable: "当前权益资料不足，暂不能报价或收费。",
  };
  return labels[error.code] ?? "操作未完成，请刷新状态后重试。";
}
function useSmallScreen(): boolean {
  const [small, setSmall] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setSmall(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return small;
}

function OrderDetails({ item, compact = false }: { item: MyServiceItem; compact?: boolean }) {
  return <details className="cc-svc-order-details">
    <summary>{compact ? "说明与订单" : "订单信息"}</summary>
    <dl><dt>订单号</dt><dd>{item.orderRef}</dd><dt>创建时间</dt><dd>{dateTime(item.createdAt)}</dd>
      <dt>原订单金额</dt><dd>{fen(item.amountFen)}</dd><dt>订单状态</dt>
      <dd>{item.orderStatus === "paid" ? "已支付" : item.orderStatus === "pending" ? "待支付" : "已关闭"}</dd></dl>
    <Link to="/orders">查看订单列表</Link>
  </details>;
}

function DemoControls({ entitlement, csrfToken, reload }: {
  entitlement: ServiceEntitlement; csrfToken: string | null; reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = entitlement.change?.status;
  const canPay = status === "pending_payment";
  const canFulfill = status === "pending_fulfillment" || status === "fulfillment_failed";
  if (!canPay && !canFulfill) return null;
  async function run(action: () => Promise<void>) {
    if (busy || csrfToken === null) return;
    setBusy(true); setError("");
    try { await action(); reload(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="cc-svc-demo-actions"><p>只改变隔离合成服务状态；不连接真实支付或服务商。</p>
    {canPay && <button type="button" disabled={busy || csrfToken === null}
      onClick={() => void run(() => simulateServicePayment(entitlement.serviceId, csrfToken!))}>模拟权威支付查询</button>}
    {canFulfill && <><button type="button" disabled={busy || csrfToken === null}
      onClick={() => void run(() => simulateServiceFulfillment(entitlement.serviceId, csrfToken!, true, `demo-${crypto.randomUUID()}`))}>模拟履约成功</button>
      <button type="button" disabled={busy || csrfToken === null}
        onClick={() => void run(() => simulateServiceFulfillment(entitlement.serviceId, csrfToken!, false, `demo-${crypto.randomUUID()}`))}>模拟履约失败</button></>}
    {error && <p role="alert">{error}</p>}
  </div>;

}

export function ServiceChangeCard({ item, entitlement, csrfToken, reload, openServiceId, setOpenServiceId, children }: {
  item: MyServiceItem; entitlement: ServiceEntitlement; csrfToken: string | null;
  reload: () => void; children?: ReactNode;
  openServiceId: number | null; setOpenServiceId: (serviceId: number | null) => void;
}) {
  const current = splitSpec(entitlement.specId);
  const editorOpen = openServiceId === entitlement.serviceId;
  const [target, setTarget] = useState<Target>(current);
  const [options, setOptions] = useState<ServiceChangeOption[] | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [quoteState, setQuoteState] = useState<QuoteState | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const small = useSmallScreen();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const demoPanelRef = useRef<HTMLDetailsElement>(null);
  const inlineRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const quoteSeq = useRef(0);
  const attemptRef = useRef<{ quoteRef: string; credentials: OrderCredentials } | null>(null);
  const actionLock = useRef(false);
  const lines = packageLinesByTypeAndRegion[entitlement.typeId]?.[entitlement.regionId] ?? [];
  const selectedSpecId = specIdFor(entitlement, target);
  const selectedOption = options?.find((option) => option.specId === selectedSpecId);
  const currentLineIndex = lines.findIndex((line) => line.id === current.line);
  const targetLineIndex = lines.findIndex((line) => line.id === target.line);
  const currentTrafficIndex = trafficOptions.findIndex((traffic) => traffic.id === current.traffic);
  const targetTrafficIndex = trafficOptions.findIndex((traffic) => traffic.id === target.traffic);
  const mixed = targetLineIndex >= 0 && targetLineIndex < currentLineIndex && targetTrafficIndex > currentTrafficIndex;
  const quoteKey = `${entitlement.version}:${target.line}:${target.traffic}:${selectedSpecId ?? "base"}`;
  const quote = quoteState?.key === quoteKey ? quoteState.quote : null;
  const change = entitlement.change;
  const changeTargetName = change ? planName(entitlement, splitSpec(change.targetSpecId)) : "";
  const active = entitlement.paidConflict || (change !== null && [
    "pending_payment", "pending_fulfillment", "fulfillment_failed", "paid_conflict", "scheduled",
  ].includes(change.status));

  useEffect(() => {
    const controller = new AbortController();
    setOptions(null); setOptionsError("");
    void getServiceChangeOptions(entitlement.serviceId, controller.signal)
      .then((items) => { if (!controller.signal.aborted) setOptions(items); })
      .catch((cause) => { if (!controller.signal.aborted) setOptionsError(errorMessage(cause)); });
    return () => controller.abort();
  }, [entitlement.serviceId, entitlement.version]);

  useEffect(() => {
    const seq = ++quoteSeq.current;
    const controller = new AbortController();
    setQuoteState(null); setQuoteError(""); setQuoteLoading(false);
    if (!editorOpen || active || selectedOption?.direction !== "upgrade" || selectedSpecId === undefined || csrfToken === null) {
      return () => controller.abort();
    }
    setQuoteLoading(true);
    void quoteServiceUpgrade(entitlement.serviceId, selectedSpecId, csrfToken, controller.signal)
      .then((serverQuote) => {
        if (!controller.signal.aborted && seq === quoteSeq.current) setQuoteState({ key: quoteKey, quote: serverQuote });
      })
      .catch((cause) => {
        if (!controller.signal.aborted && seq === quoteSeq.current) setQuoteError(errorMessage(cause));
      })
      .finally(() => { if (!controller.signal.aborted && seq === quoteSeq.current) setQuoteLoading(false); });
    return () => controller.abort();
  }, [editorOpen, active, entitlement.serviceId, entitlement.version, selectedSpecId, selectedOption?.direction, csrfToken, quoteKey]);

  useEffect(() => {
    if (!editorOpen || !small) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    document.documentElement.classList.add("cc-svc-modal-lock");
    if (!dialog.open) dialog.showModal();
    return () => {
      document.documentElement.classList.remove("cc-svc-modal-lock");
      if (dialog.open) dialog.close();
    };
  }, [editorOpen, small]);

  useEffect(() => {
    if (!editorOpen || small) return;
    const frame = requestAnimationFrame(() => inlineRef.current
      ?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [editorOpen, small]);

  function showDemoControls() {
    const panel = demoPanelRef.current;
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(() => panel.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true }));
  }

  function closeEditor() {
    setOpenServiceId(null);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }
  function openEditor() { setTarget(current); setActionError(""); setOpenServiceId(entitlement.serviceId); }

  async function confirm() {
    if (actionLock.current || busy || csrfToken === null || !selectedOption) return;
    actionLock.current = true; setBusy(true); setActionError("");
    try {
      if (selectedOption.direction === "upgrade") {
        if (!quote || new Date(quote.expiresAt).getTime() <= Date.now()) throw new PaymentApiError("stale_change_quote", 409);
        if (attemptRef.current?.quoteRef !== quote.quoteRef) {
          attemptRef.current = { quoteRef: quote.quoteRef, credentials: createOrderCredentials() };
        }
        await orderServiceUpgrade(entitlement.serviceId, quote, csrfToken, attemptRef.current.credentials);
      } else if (selectedOption.direction === "downgrade" && selectedSpecId !== undefined) {
        await scheduleServiceDowngrade(entitlement.serviceId, selectedSpecId, csrfToken);
      } else return;
      closeEditor(); reload();
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function cancelDowngrade() {
    if (busy || csrfToken === null) return;
    setBusy(true); setActionError("");
    try { await cancelServiceDowngrade(entitlement.serviceId, csrfToken); reload(); }
    catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  const remaining = Math.max(0, entitlement.usageQuotaGb - entitlement.usageUsedGb);
  const flowPercent = Math.min(100, (remaining / entitlement.usageQuotaGb) * 100);
  const trafficChoices = trafficOptions.filter((_, index) => index >= currentTrafficIndex);

  function moveOption(event: KeyboardEvent<HTMLButtonElement>, values: readonly string[], value: string,
    field: keyof Target) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 :
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (values.indexOf(value) + delta + values.length) % values.length;
    setTarget((previous) => ({ ...previous, [field]: values[next] }));
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  const optionGroups = <div className="cc-svc-editor-groups">
    <div className="cc-svc-editor-group"><h5>线路</h5><div className="cc-svc-options" role="radiogroup" aria-label="选择线路">
      {lines.map((line) => <button key={line.id} type="button" role="radio" aria-checked={target.line === line.id}
        tabIndex={target.line === line.id ? 0 : -1} className="cc-svc-option" disabled={busy}
        onClick={() => setTarget((value) => ({ ...value, line: line.id }))}
        onKeyDown={(event) => moveOption(event, lines.map((item) => item.id), line.id, "line")}>
        {line.name}{line.id === current.line && <small>当前</small>}
      </button>)}
    </div></div>
    <div className="cc-svc-editor-group"><h5>月流量</h5><div className="cc-svc-options cc-svc-traffic-options"
      role="radiogroup" aria-label="选择月流量">
      {trafficChoices.map((traffic) => <button key={traffic.id} type="button" role="radio"
        aria-checked={target.traffic === traffic.id} tabIndex={target.traffic === traffic.id ? 0 : -1}
        className="cc-svc-option" disabled={busy}
        onClick={() => setTarget((value) => ({ ...value, traffic: traffic.id }))}
        onKeyDown={(event) => moveOption(event, trafficChoices.map((item) => item.id), traffic.id, "traffic")}>
        {traffic.name}{traffic.id === current.traffic && <small>当前</small>}
      </button>)}
    </div><p>{currentTrafficIndex === trafficOptions.length - 1 ? "已是最高流量档，可以更换线路。" : "月流量只能升级，不能降低。"}</p></div>
  </div>;

  const quoteArea = <div className="cc-svc-quote-area">
    <p className="cc-svc-target-summary">调整后 <strong>{planName(entitlement, target)}</strong>
      {selectedOption && <span>目录月费 {fen(selectedOption.monthlyFen)}/月</span>}</p>
    {mixed ? <p className="cc-svc-reason" role="status">降低线路要到下期才生效，升级流量需本期付款后履约，两者不能合并。请先保持当前线路升级流量，完成后再预约下期降线路。</p>
      : target.line === current.line && target.traffic === current.traffic ? <p className="cc-svc-reason" role="status">请选择不同线路或更高月流量。</p>
      : optionsError ? <p className="cc-svc-reason" role="alert">{optionsError}</p>
      : options === null ? <p role="status">正在读取服务器合法组合…</p>
      : !selectedOption ? <p className="cc-svc-reason" role="status">这个组合当前不能一次调整或不可售；不会生成收费订单。</p>
      : selectedOption.direction === "upgrade" ? <>
        <p className="cc-svc-due">{quoteLoading ? "正在计算服务器补差…" : quote ? <>
          本期补差 <strong>{fen(quote.amountFen)}</strong><small>报价有效至 {dateTime(quote.expiresAt)}</small>
        </> : "等待服务器报价"}</p>
        <p className="cc-svc-rule">按原付费期剩余实际时间补差；到期日仍为 {date(entitlement.periodEnd)}，本月已用 {entitlement.usageUsedGb}G 不清零。</p>
        <p className="cc-svc-rule">仅创建本地模拟待付单。模拟付款确认后，还需模拟履约成功才更新当前权益；此月费作为未来续期输入。</p>
      </> : selectedOption.direction === "downgrade" ? <>
        <p className="cc-svc-due">本期 <strong>¥0</strong><small>下期付费续期时才采用新线路</small></p>
        <p className="cc-svc-rule">不退差价，到期前继续使用当前方案。不会自动扣款，也不会免费延长服务。本地到期应用仅作模拟，不代表线上自动执行。</p>
      </> : <p className="cc-svc-reason" role="status">这个组合与当前档位相同。</p>}
    {quoteError && <p className="cc-svc-reason" role="alert">{quoteError}</p>}
    {actionError && <p className="cc-svc-reason" role="alert">{actionError}</p>}
    <div className="cc-svc-editor-actions">
      <button type="button" className="cc-svc-btn cc-svc-btn-primary" disabled={busy || csrfToken === null || mixed ||
        !selectedOption || selectedOption.direction === "current" ||
        (selectedOption.direction === "upgrade" && (!quote || quoteLoading || new Date(quote.expiresAt).getTime() <= Date.now()))}
        onClick={() => void confirm()}>{busy ? "提交中…" : selectedOption?.direction === "downgrade"
          ? "预约下期更换" : "确认升级并创建本地待付单"}</button>
      <button type="button" className="cc-svc-btn cc-svc-btn-text" onClick={closeEditor}>取消</button>
    </div>
  </div>;

  return <li className="cc-svc-card">
    <div className="cc-svc-card-main">
      <div className="cc-svc-identity"><div className="cc-svc-who">
        <h3>{typeName(entitlement.typeId)}</h3>
        <span className="cc-svc-place">{placeName(entitlement.typeId, entitlement.regionId, entitlement.ispId)}</span>
        <span className="cc-svc-live">{item.serviceStatus === "open" ? "使用中" : "待开通"}</span>
      </div>
        <p className="cc-svc-plan">{planName(entitlement, current)}</p>
        <p className="cc-svc-billing">月费 <strong>{fen(entitlement.monthlyPriceFen)}</strong>/月
          <span><strong>{date(entitlement.periodEnd)}</strong> 到期，{entitlement.periodMonths === 1 ? "月付" : entitlement.periodMonths === 6 ? "半年付" : "年付"}</span></p>
      </div>
      <div className="cc-svc-flow"><span>本月剩余流量</span>
        <strong>{remaining}G <small>/ {entitlement.usageQuotaGb}G</small></strong>
        <div className="cc-svc-flow-bar" role="meter" aria-label="本月剩余流量" aria-valuenow={remaining}
          aria-valuemin={0} aria-valuemax={entitlement.usageQuotaGb}><i style={{ width: `${flowPercent}%` }} /></div>
      </div>
    </div>
    <div className="cc-svc-next">
      {active ? <><div className="cc-svc-change-summary" role="status">
        <strong>{change?.status === "pending_payment" ? "待付款" : change?.status === "pending_fulfillment" ? "处理中" :
          change?.status === "scheduled" ? "已预约下期" : change?.status === "fulfillment_failed" ? "处理未完成" : "需人工处理"}</strong>
        <span>{change?.status === "pending_payment" ? `升级至 ${changeTargetName}，本地待付补差 ${fen(change.amountFen)}；尚未确认付款。` :
          change?.status === "pending_fulfillment" ? `正在调整为 ${changeTargetName}；模拟付款已确认，待履约回执。` :
          change?.status === "scheduled" ? `下次付费续期报价采用 ${changeTargetName}；${date(entitlement.periodEnd)} 到期前当前权益不变。本地到期应用仅作模拟，不代表线上自动执行。` :
          change?.status === "fulfillment_failed" ? `调整为 ${changeTargetName} 未完成，当前方案不变；可在演示区重试。` :
          "迟到付款冲突，当前权益未改变，需人工处理。"}</span>
      </div>
        {change?.status === "pending_payment" && <button type="button" className="cc-svc-btn cc-svc-btn-small"
          onClick={showDemoControls}>查看本地模拟付款操作</button>}
        {change?.status === "scheduled" && <button type="button" className="cc-svc-btn cc-svc-btn-small"
          disabled={busy || csrfToken === null} onClick={() => void cancelDowngrade()}>取消预约</button>}</> : <>
        <button ref={triggerRef} type="button" className="cc-svc-btn" aria-expanded={editorOpen}
          aria-controls={`cc-svc-editor-${entitlement.serviceId}`} onClick={() => editorOpen ? closeEditor() : openEditor()}>
          <span aria-hidden="true">☷</span> 调整套餐 <span aria-hidden="true">⌄</span></button>
        <span className="cc-svc-next-hint">可更换线路或升级月流量</span>
      </>}
      <OrderDetails item={item} />
    </div>
    {entitlement.paidConflict && <p className="cc-svc-alert" role="alert">存在迟到付款冲突，暂不能发起新变更。</p>}
    {actionError && !editorOpen && <p className="cc-svc-alert" role="alert">{actionError}</p>}
    {!active && editorOpen && !small && <div ref={inlineRef} className="cc-svc-editor" id={`cc-svc-editor-${entitlement.serviceId}`}>
      <h4>调整套餐 <small>产品类型、地区和运营商不变</small></h4>{optionGroups}{quoteArea}
    </div>}
    {children && <section className="cc-svc-existing-section" aria-label="订阅交付与续费设置">
      <h4>订阅交付与续费设置</h4>
      <div>{children}</div>
    </section>}
    {(change?.status === "pending_payment" || change?.status === "pending_fulfillment" ||
      change?.status === "fulfillment_failed") && <details ref={demoPanelRef} className="cc-svc-demo-panel">
      <summary>本地演示测试 · 仅合成服务</summary>
      <DemoControls entitlement={entitlement} csrfToken={csrfToken} reload={reload} />
    </details>}
    <dialog ref={dialogRef} className="cc-svc-sheet" aria-labelledby={`cc-svc-sheet-title-${entitlement.serviceId}`}
      onCancel={(event) => { event.preventDefault(); closeEditor(); }}>
      {editorOpen && small && <div className="cc-svc-sheet-inner" id={`cc-svc-editor-${entitlement.serviceId}`}>
        <div className="cc-svc-sheet-head"><div><h4 id={`cc-svc-sheet-title-${entitlement.serviceId}`}>调整套餐</h4>
          <p>{typeName(entitlement.typeId)} · 产品类型、地区和运营商不变</p></div>
          <button type="button" aria-label="关闭调整面板" onClick={closeEditor}>×</button></div>
        <div className="cc-svc-sheet-body">{optionGroups}</div><div className="cc-svc-sheet-foot">{quoteArea}</div>
      </div>}
    </dialog>
  </li>;
}
