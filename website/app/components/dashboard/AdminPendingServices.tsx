import { useCallback, useEffect, useRef, useState } from "react";
import {
  PaymentApiError,
  getAdminMonitorTargets,
  getAdminPendingServices,
  openAdminService,
  type AdminMonitorTarget,
  type AdminPendingServiceItem,
  type DeliveryItemInput,
} from "../../lib/payment-api";
import { useT } from "../../lib/i18n";
import { resolveSelection } from "../../lib/resolveSelection";

const SCENARIO_LABELS: Record<string, string> = {
  ai: "AI 工具",
  social: "TikTok / 社媒",
  work: "跨境办公",
  other: "其他",
};
const MONITOR_TARGET_REFRESH_MS = 15_000;

function monitorTargetOptionLabel(target: AdminMonitorTarget) {
  if (target.state === "disabled") return `${target.label}（已停用）`;
  if (target.state === "retired") return `${target.label}（已退役）`;
  return target.label;
}

function formatFen(amountFen: number) {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function adminErrorMessage(error: unknown) {
  if (!(error instanceof PaymentApiError)) return "暂时无法读取待开通服务，请稍后重试。";
  switch (error.code) {
    case "unauthorized": return "管理员登录状态已失效。";
    case "forbidden": return "当前账户没有人工开通权限。";
    case "csrf_invalid": return "安全校验已失效，请刷新页面后重试。";
    case "invalid_transition": return "该服务状态已变化，请刷新后确认。";
    case "items_required": return "请至少填写一条订阅链接。";
    case "invalid_item": return "请检查买家可见线路名称与 HTTPS 订阅链接。";
    case "invalid_monitor_target": return "选择的 VPS 已不可用，请刷新目标列表后重试。";
    case "monitor_unavailable": return "暂时无法读取 3002 VPS 列表。";
    case "invalid_response": return "待开通服务数据返回异常。";
    default: return "暂时无法处理待开通服务，请稍后重试。";
  }
}

export function AdminPendingServices({ csrfToken }: { csrfToken: string | null }) {
  const copy = useT().adminDelivery;
  const [items, setItems] = useState<AdminPendingServiceItem[]>([]);
  // Per-service explicit confirmation to open without a VPS while the VPS list is unavailable.
  const [allowUnbound, setAllowUnbound] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, DeliveryItemInput[]>>({});
  const [monitorTargets, setMonitorTargets] = useState<AdminMonitorTarget[]>([]);
  const [monitorTargetsLoading, setMonitorTargetsLoading] = useState(true);
  const [monitorTargetsError, setMonitorTargetsError] = useState<string | null>(null);
  const monitorTargetsRequest = useRef(0);
  const monitorTargetsController = useRef<AbortController | null>(null);

  const refreshMonitorTargets = useCallback(async (showLoading: boolean) => {
    const requestId = ++monitorTargetsRequest.current;
    monitorTargetsController.current?.abort();
    const controller = new AbortController();
    monitorTargetsController.current = controller;
    if (showLoading) setMonitorTargetsLoading(true);
    try {
      const targets = await getAdminMonitorTargets(controller.signal);
      if (requestId !== monitorTargetsRequest.current) return;
      setMonitorTargets(targets);
      setMonitorTargetsError(null);
    } catch (loadError) {
      if (requestId !== monitorTargetsRequest.current) return;
      setMonitorTargetsError(adminErrorMessage(loadError));
    } finally {
      if (requestId === monitorTargetsRequest.current) {
        setMonitorTargetsLoading(false);
        monitorTargetsController.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void getAdminPendingServices(controller.signal)
      .then((nextItems) => {
        if (stopped) return;
        setItems(nextItems);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!stopped) setError(adminErrorMessage(loadError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    void refreshMonitorTargets(true);
    const interval = window.setInterval(
      () => void refreshMonitorTargets(false),
      MONITOR_TARGET_REFRESH_MS,
    );
    return () => {
      window.clearInterval(interval);
      monitorTargetsController.current?.abort();
      monitorTargetsController.current = null;
      monitorTargetsRequest.current += 1;
    };
  }, [refreshMonitorTargets]);

  async function markOpen(serviceId: number) {
    if (openingId !== null) return;
    if (csrfToken === null) {
      setError("安全校验尚未就绪，请刷新页面后重试。");
      return;
    }
    setOpeningId(serviceId);
    setError(null);
    try {
      await openAdminService(serviceId, csrfToken, drafts[serviceId] ?? defaultDeliveryItems(), {
        allowUnbound: monitorUnavailable && allowUnbound[serviceId] === true,
      });
      setItems((current) => current.filter((item) => item.serviceId !== serviceId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[serviceId];
        return next;
      });
    } catch (openError) {
      setError(adminErrorMessage(openError));
      if (openError instanceof PaymentApiError && openError.code === "invalid_monitor_target") {
        void refreshMonitorTargets(false);
      }
    } finally {
      setOpeningId(null);
    }
  }

  function defaultDeliveryItems(): DeliveryItemInput[] {
    return [{ label: "", subscriptionUrl: "", monitorTargetKey: "" }];
  }

  function deliveryItems(serviceId: number): DeliveryItemInput[] {
    return drafts[serviceId] ?? defaultDeliveryItems();
  }

  function updateDeliveryItem(
    serviceId: number,
    index: number,
    field: keyof DeliveryItemInput,
    value: string,
  ) {
    setDrafts((current) => {
      const nextItems = [...(current[serviceId] ?? defaultDeliveryItems())];
      nextItems[index] = { ...nextItems[index], [field]: value };
      return { ...current, [serviceId]: nextItems };
    });
  }

  /* NSP-LINE-NAME-10：选了 VPS 的线路，买家可见名即 VPS 名（只读）；未选 VPS 时名称可自由填写。 */
  function chooseDeliveryTarget(serviceId: number, index: number, key: string) {
    const target = monitorTargets.find((candidate) => candidate.key === key);
    setDrafts((current) => {
      const nextItems = [...(current[serviceId] ?? defaultDeliveryItems())];
      const previous = nextItems[index];
      if (previous === undefined) return current;
      nextItems[index] = { ...previous, monitorTargetKey: key, label: target === undefined ? previous.label : target.label };
      return { ...current, [serviceId]: nextItems };
    });
  }

  function addDeliveryItem(serviceId: number) {
    setDrafts((current) => {
      const nextItems = [...(current[serviceId] ?? defaultDeliveryItems())];
      if (nextItems.length >= 20) return current;
      nextItems.push({ label: "", subscriptionUrl: "", monitorTargetKey: "" });
      return { ...current, [serviceId]: nextItems };
    });
  }

  function removeDeliveryItem(serviceId: number, index: number) {
    setDrafts((current) => {
      const nextItems = [...(current[serviceId] ?? defaultDeliveryItems())];
      if (nextItems.length <= 1) return current;
      nextItems.splice(index, 1);
      return { ...current, [serviceId]: nextItems };
    });
  }

  const activeMonitorTargets = monitorTargets.filter((target) => target.state === "active");
  /* VPS 列表读取失败（监控私有通道不可用）：下拉禁用，改为需要逐单勾选「暂不绑定 VPS 开通」。 */
  const monitorUnavailable = !monitorTargetsLoading && monitorTargetsError !== null;

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-services-title">
      <h2 id="dash-admin-services-title"><em>DELIVERY</em>待开通服务<span>{loading ? "读取中" : `${items.length} 项`}</span></h2>
      {(error ?? monitorTargetsError) && (
        <p className="dash-inline-error" role="alert">{error ?? monitorTargetsError}</p>
      )}
      {!loading && items.length === 0 && error === null && (
        <div className="dash-service"><div className="dash-service-head"><div><strong>—</strong><small>当前没有待开通服务</small></div><span className="dash-tag">已处理</span></div></div>
      )}
      <div className="dash-admin-list">
        {items.map((item) => {
          const { summary } = resolveSelection({
            typeId: item.typeId,
            regionId: item.regionId,
            ispId: item.ispId,
            specId: item.specId,
            durationId: item.durationId,
          });
          const scenarios = item.scenarios.length === 0
            ? "—"
            : item.scenarios.map((scenario) => SCENARIO_LABELS[scenario] ?? scenario).join("、");
          const serviceDeliveryItems = deliveryItems(item.serviceId);
          return (
            <article className="dash-service" key={item.serviceId}>
              <div className="dash-service-head">
                <div><strong>{item.orderRef}</strong><small>{formatDate(item.createdAt)}</small></div>
                <span className="dash-tag">待开通</span>
              </div>
              <dl className="dash-service-facts">
                <div><dt>网络类型</dt><dd>{summary.type}</dd></div>
                <div><dt>国家/地区</dt><dd>{summary.region}</dd></div>
                <div><dt>运营商</dt><dd>{summary.isp}</dd></div>
                <div><dt>规格</dt><dd>{summary.spec}</dd></div>
                <div><dt>周期</dt><dd>{summary.duration}</dd></div>
                <div><dt>支付金额</dt><dd>{formatFen(item.amountFen)}</dd></div>
                <div><dt>联系方式</dt><dd>{item.contact}</dd></div>
                <div><dt>使用场景</dt><dd>{scenarios}</dd></div>
                <div><dt>补充说明</dt><dd>{item.notes?.trim() || "—"}</dd></div>
              </dl>
              <fieldset className="dash-delivery-form">
                <legend>交付订阅线路</legend>
                {serviceDeliveryItems.map((deliveryItem, index) => (
                  <div className="dash-delivery-row" key={index}>
                    <label className="dash-delivery-field">
                      <span>买家可见线路名称</span>
                      <input
                        type="text"
                        maxLength={200}
                        value={deliveryItem.label}
                        readOnly={deliveryItem.monitorTargetKey !== ""}
                        aria-describedby={deliveryItem.monitorTargetKey !== "" ? `dash-name-follows-${item.serviceId}-${index}` : undefined}
                        onChange={(event) => updateDeliveryItem(item.serviceId, index, "label", event.target.value)}
                        placeholder="例如：日本中转 A"
                        autoComplete="off"
                      />
                      {deliveryItem.monitorTargetKey !== "" && (
                        <small className="dash-delivery-name-hint" id={`dash-name-follows-${item.serviceId}-${index}`}>{copy.nameFollowsVps}</small>
                      )}
                    </label>
                    <label className="dash-delivery-field dash-delivery-target-field">
                      <span>对应 VPS 线路服务器</span>
                      <select
                        value={deliveryItem.monitorTargetKey}
                        disabled={monitorTargetsLoading || monitorUnavailable || activeMonitorTargets.length === 0}
                        onChange={(event) => chooseDeliveryTarget(item.serviceId, index, event.target.value)}
                      >
                        <option value="">
                          {monitorTargetsLoading
                            ? "正在读取 3002 VPS…"
                            : monitorUnavailable
                              ? copy.monitorUnavailableOption
                              : activeMonitorTargets.length === 0
                              ? "暂无可用 VPS"
                              : "请选择 VPS"}
                        </option>
                        {deliveryItem.monitorTargetKey !== "" &&
                          !monitorTargets.some((target) => target.key === deliveryItem.monitorTargetKey) && (
                            <option value={deliveryItem.monitorTargetKey} disabled>
                              原 VPS 已移除（请重新选择）
                            </option>
                          )}
                        {monitorTargets
                          .filter((target) => (
                            target.state !== "retired" ||
                            target.key === deliveryItem.monitorTargetKey
                          ))
                          .map((target) => (
                          <option
                            key={target.key}
                            value={target.key}
                            disabled={target.state !== "active"}
                          >
                            {monitorTargetOptionLabel(target)}
                          </option>
                          ))}
                      </select>
                    </label>
                    <label className="dash-delivery-field dash-delivery-url-field">
                      <span>HTTPS 订阅链接</span>
                      <input
                        type="url"
                        inputMode="url"
                        value={deliveryItem.subscriptionUrl}
                        onChange={(event) => updateDeliveryItem(item.serviceId, index, "subscriptionUrl", event.target.value)}
                        placeholder="https://"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <button
                      type="button"
                      className="dash-delivery-remove"
                      disabled={serviceDeliveryItems.length === 1 || openingId !== null}
                      onClick={() => removeDeliveryItem(item.serviceId, index)}
                      aria-label={`删除第 ${index + 1} 条订阅链接`}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <div className="dash-delivery-actions">
                  <button
                    type="button"
                    disabled={serviceDeliveryItems.length >= 20 || openingId !== null}
                    onClick={() => addDeliveryItem(item.serviceId)}
                  >
                    添加订阅链接
                  </button>
                  <button
                    type="button"
                    disabled={monitorTargetsLoading}
                    onClick={() => void refreshMonitorTargets(true)}
                  >
                    {monitorTargetsLoading ? "同步中…" : "刷新 VPS 列表"}
                  </button>
                  <small>每 15 秒从 3002 自动同步；停用或退役目标不能新分配，提交时服务端会再次校验 · {serviceDeliveryItems.length}/20</small>
                </div>
              </fieldset>
              {monitorUnavailable && (
                <label className="dash-delivery-unbound">
                  <input
                    type="checkbox"
                    checked={allowUnbound[item.serviceId] === true}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setAllowUnbound((current) => ({ ...current, [item.serviceId]: checked }));
                    }}
                    disabled={openingId !== null}
                  />
                  <span>
                    <strong>{copy.allowUnbound}</strong>
                    <small>{copy.allowUnboundHint}</small>
                  </span>
                </label>
              )}
              <div className="dash-service-foot">
                <p>填写买家可见的脱敏线路名称并核对订阅链接后，再保存并开通服务。</p>
                <button
                  type="button"
                  className="dash-primary-link"
                  disabled={
                    openingId !== null ||
                    monitorTargetsLoading ||
                    (monitorUnavailable ? allowUnbound[item.serviceId] !== true : activeMonitorTargets.length === 0)
                  }
                  aria-busy={openingId === item.serviceId}
                  onClick={() => void markOpen(item.serviceId)}
                >
                  {openingId === item.serviceId ? "正在保存…" : "保存并开通"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
