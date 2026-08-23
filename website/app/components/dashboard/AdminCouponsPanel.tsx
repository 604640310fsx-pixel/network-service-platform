import { useEffect, useId, useState, type FormEvent } from "react";
import {
  createAdminCoupon,
  getAdminCoupons,
  getAdminCouponRedemptions,
  updateAdminCoupon,
  type AdminCouponItem,
  type CouponRedemptionItem,
} from "../../lib/admin-commerce-api";
import { PaymentApiError } from "../../lib/payment-api";

function couponErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法处理优惠券，请稍后重试。";
  switch (error.code) {
    case "unauthorized": return "管理员登录状态已失效。";
    case "forbidden": return "当前账户没有优惠券管理权限。";
    case "csrf_invalid": return "安全校验已失效，请刷新页面后重试。";
    case "not_found": return "该优惠券不存在，请刷新后重试。";
    case "invalid_coupon_code": return "优惠码需为 3-32 位字母、数字、下划线或短横线。";
    case "coupon_code_taken": return "该优惠码已存在，请更换后重试。";
    case "invalid_coupon_amount": return "满减金额或折扣比例不合法。";
    case "invalid_coupon_scope": return "选择\"指定套餐\"时需至少填写一个套餐 ID。";
    case "invalid_coupon_window": return "结束时间必须晚于开始时间。";
    case "invalid_max_redemptions": return "使用上限不能低于已核销次数。";
    case "invalid_coupon": case "invalid_coupon_patch": return "提交的优惠券信息格式不正确。";
    case "invalid_response": return "优惠券数据返回异常。";
    default: return "暂时无法处理优惠券，请稍后重试。";
  }
}

function formatFen(amountFen: number): string {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function toDatetimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function couponValueLabel(item: AdminCouponItem): string {
  return item.kind === "fixed" ? `满减 ${formatFen(item.amountOffFen ?? 0)}` : `${item.percentOff ?? 0}% 折扣`;
}

const EMPTY_CREATE_DRAFT = {
  code: "",
  kind: "fixed" as "fixed" | "percent",
  amountOffYuan: "",
  percentOff: "",
  minAmountYuan: "",
  scope: "all" as "all" | "plans",
  planIds: "",
  startsAt: "",
  endsAt: "",
  maxRedemptions: "",
};

export function AdminCouponsPanel({ csrfToken }: { csrfToken: string | null }) {
  const [items, setItems] = useState<AdminCouponItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState(EMPTY_CREATE_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const [endsAtDrafts, setEndsAtDrafts] = useState<Record<number, string>>({});
  const [maxRedemptionsDrafts, setMaxRedemptionsDrafts] = useState<Record<number, string>>({});
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [redemptions, setRedemptions] = useState<Record<number, CouponRedemptionItem[]>>({});
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const codeId = useId();

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void getAdminCoupons(controller.signal)
      .then((nextItems) => {
        if (stopped) return;
        setItems(nextItems);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!stopped) setError(couponErrorMessage(loadError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    if (csrfToken === null) {
      setCreateError("安全校验尚未就绪，请刷新页面后重试。");
      return;
    }
    if (creating) return;
    const amountOffYuan = createDraft.amountOffYuan.trim() === "" ? null : Number(createDraft.amountOffYuan);
    const percentOff = createDraft.percentOff.trim() === "" ? null : Number(createDraft.percentOff);
    const minAmountYuan = createDraft.minAmountYuan.trim() === "" ? null : Number(createDraft.minAmountYuan);
    const maxRedemptions = createDraft.maxRedemptions.trim() === "" ? null : Number(createDraft.maxRedemptions);
    const planIds = createDraft.planIds
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => Number(item));
    if (createDraft.startsAt === "" || createDraft.endsAt === "") {
      setCreateError("请填写开始与结束时间。");
      return;
    }
    setCreating(true);
    try {
      const created = await createAdminCoupon(csrfToken, {
        code: createDraft.code,
        kind: createDraft.kind,
        amountOffFen: amountOffYuan === null ? null : Math.round(amountOffYuan * 100),
        percentOff,
        minAmountFen: minAmountYuan === null ? null : Math.round(minAmountYuan * 100),
        scope: createDraft.scope,
        planIds,
        startsAt: new Date(createDraft.startsAt).toISOString(),
        endsAt: new Date(createDraft.endsAt).toISOString(),
        maxRedemptions,
      });
      setItems((current) => [created, ...current]);
      setCreateDraft(EMPTY_CREATE_DRAFT);
    } catch (createErr) {
      setCreateError(couponErrorMessage(createErr));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(item: AdminCouponItem) {
    if (csrfToken === null) {
      setRowError((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }
    setBusyId(item.id);
    setRowError((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const updated = await updateAdminCoupon(item.id, csrfToken, { isActive: !item.isActive });
      setItems((current) => current.map((existing) => (existing.id === item.id ? updated : existing)));
    } catch (toggleError) {
      setRowError((current) => ({ ...current, [item.id]: couponErrorMessage(toggleError) }));
    } finally {
      setBusyId(null);
    }
  }

  async function extendEndsAt(item: AdminCouponItem) {
    const draftValue = endsAtDrafts[item.id];
    if (!draftValue) return;
    if (csrfToken === null) {
      setRowError((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }
    setBusyId(item.id);
    setRowError((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const updated = await updateAdminCoupon(item.id, csrfToken, { endsAt: new Date(draftValue).toISOString() });
      setItems((current) => current.map((existing) => (existing.id === item.id ? updated : existing)));
      setEndsAtDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (extendError) {
      setRowError((current) => ({ ...current, [item.id]: couponErrorMessage(extendError) }));
    } finally {
      setBusyId(null);
    }
  }

  async function updateMaxRedemptions(item: AdminCouponItem) {
    const draftValue = maxRedemptionsDrafts[item.id];
    if (draftValue === undefined) return;
    if (csrfToken === null) {
      setRowError((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }
    const maxRedemptions = draftValue.trim() === "" ? null : Number(draftValue);
    if (maxRedemptions !== null && (!Number.isSafeInteger(maxRedemptions) || maxRedemptions < 0)) {
      setRowError((current) => ({ ...current, [item.id]: "使用上限需为非负整数，留空表示不限次数。" }));
      return;
    }
    setBusyId(item.id);
    setRowError((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const updated = await updateAdminCoupon(item.id, csrfToken, { maxRedemptions });
      setItems((current) => current.map((existing) => (existing.id === item.id ? updated : existing)));
      setMaxRedemptionsDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (limitError) {
      setRowError((current) => ({ ...current, [item.id]: couponErrorMessage(limitError) }));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRedemptions(item: AdminCouponItem) {
    if (expandedId === item.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(item.id);
    if (redemptions[item.id] !== undefined) return;
    setRedemptionsLoading(true);
    try {
      const items = await getAdminCouponRedemptions(item.id);
      setRedemptions((current) => ({ ...current, [item.id]: items }));
    } catch (loadError) {
      setRowError((current) => ({ ...current, [item.id]: couponErrorMessage(loadError) }));
    } finally {
      setRedemptionsLoading(false);
    }
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-coupons-title">
      <h2 id="dash-admin-coupons-title"><em>COMMERCE</em>优惠券管理<span>{loading ? "读取中" : `${items.length} 项`}</span></h2>
      {error && <p className="dash-inline-error" role="alert">{error}</p>}

      <form className="dash-coupon-create" onSubmit={handleCreate}>
        <div className="dash-coupon-create-grid">
          <label>
            <span>优惠码</span>
            <input id={codeId} type="text" value={createDraft.code} onChange={(event) => setCreateDraft((d) => ({ ...d, code: event.target.value }))} placeholder="SUMMER2026" disabled={creating} required />
          </label>
          <label>
            <span>类型</span>
            <select value={createDraft.kind} onChange={(event) => setCreateDraft((d) => ({ ...d, kind: event.target.value as "fixed" | "percent" }))} disabled={creating}>
              <option value="fixed">固定满减（元）</option>
              <option value="percent">百分比折扣</option>
            </select>
          </label>
          {createDraft.kind === "fixed" ? (
            <label>
              <span>满减金额（元）</span>
              <input type="number" min="0.01" step="0.01" value={createDraft.amountOffYuan} onChange={(event) => setCreateDraft((d) => ({ ...d, amountOffYuan: event.target.value }))} disabled={creating} required />
            </label>
          ) : (
            <label>
              <span>折扣比例（1-99）</span>
              <input type="number" min="1" max="99" step="1" value={createDraft.percentOff} onChange={(event) => setCreateDraft((d) => ({ ...d, percentOff: event.target.value }))} disabled={creating} required />
            </label>
          )}
          <label>
            <span>最低消费（元，可选）</span>
            <input type="number" min="0.01" step="0.01" value={createDraft.minAmountYuan} onChange={(event) => setCreateDraft((d) => ({ ...d, minAmountYuan: event.target.value }))} disabled={creating} />
          </label>
          <label>
            <span>适用范围</span>
            <select value={createDraft.scope} onChange={(event) => setCreateDraft((d) => ({ ...d, scope: event.target.value as "all" | "plans" }))} disabled={creating}>
              <option value="all">全部套餐</option>
              <option value="plans">指定套餐</option>
            </select>
          </label>
          {createDraft.scope === "plans" && (
            <label>
              <span>适用套餐 ID（逗号分隔）</span>
              <input type="text" value={createDraft.planIds} onChange={(event) => setCreateDraft((d) => ({ ...d, planIds: event.target.value }))} placeholder="例如 12, 45" disabled={creating} />
            </label>
          )}
          <label>
            <span>开始时间</span>
            <input type="datetime-local" value={createDraft.startsAt} onChange={(event) => setCreateDraft((d) => ({ ...d, startsAt: event.target.value }))} disabled={creating} required />
          </label>
          <label>
            <span>结束时间</span>
            <input type="datetime-local" value={createDraft.endsAt} onChange={(event) => setCreateDraft((d) => ({ ...d, endsAt: event.target.value }))} disabled={creating} required />
          </label>
          <label>
            <span>使用上限（可选，留空不限）</span>
            <input type="number" min="0" step="1" value={createDraft.maxRedemptions} onChange={(event) => setCreateDraft((d) => ({ ...d, maxRedemptions: event.target.value }))} disabled={creating} />
          </label>
        </div>
        <div className="dash-coupon-create-foot">
          <button type="submit" className="dash-primary-link" disabled={creating} aria-busy={creating}>{creating ? "创建中…" : "新增优惠券"}</button>
          {createError && <p className="dash-inline-error" role="alert">{createError}</p>}
        </div>
      </form>

      <div className="dash-admin-list">
        {!loading && items.length === 0 && error === null && (
          <div className="dash-service"><div className="dash-service-head"><div><strong>—</strong><small>当前没有优惠券</small></div></div></div>
        )}
        {items.map((item) => {
          const busy = busyId === item.id;
          const expanded = expandedId === item.id;
          return (
            <article className="dash-service" key={item.id}>
              <div className="dash-service-head">
                <div><strong>{item.code}</strong><small>{couponValueLabel(item)}</small></div>
                <span className={`dash-tag dash-plan-status ${item.isActive ? "is-active" : ""}`}>{item.isActive ? "已启用" : "已停用"}</span>
              </div>
              <dl className="dash-service-facts">
                <div><dt>适用范围</dt><dd>{item.scope === "all" ? "全部套餐" : `指定套餐（${item.planIds.length} 项）`}</dd></div>
                <div><dt>最低消费</dt><dd>{item.minAmountFen === null ? "不限" : formatFen(item.minAmountFen)}</dd></div>
                <div><dt>开始时间</dt><dd>{formatDate(item.startsAt)}</dd></div>
                <div><dt>结束时间</dt><dd>{formatDate(item.endsAt)}</dd></div>
                <div><dt>已使用 / 上限</dt><dd>{item.redeemedCount} / {item.maxRedemptions === null ? "不限" : item.maxRedemptions}</dd></div>
              </dl>
              <div className="dash-coupon-controls">
                <button type="button" className="dash-primary-link" disabled={busy} aria-busy={busy} onClick={() => void toggleActive(item)}>
                  {item.isActive ? "停用" : "启用"}
                </button>
                <div className="dash-coupon-inline-edit">
                  <input
                    type="datetime-local"
                    value={endsAtDrafts[item.id] ?? toDatetimeLocal(item.endsAt)}
                    onChange={(event) => setEndsAtDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                    disabled={busy}
                  />
                  <button type="button" disabled={busy} onClick={() => void extendEndsAt(item)}>延长结束时间</button>
                </div>
                <div className="dash-coupon-inline-edit">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="不限"
                    value={maxRedemptionsDrafts[item.id] ?? (item.maxRedemptions === null ? "" : String(item.maxRedemptions))}
                    onChange={(event) => setMaxRedemptionsDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                    disabled={busy}
                  />
                  <button type="button" disabled={busy} onClick={() => void updateMaxRedemptions(item)}>更新使用上限</button>
                </div>
                <button type="button" disabled={busy} onClick={() => void toggleRedemptions(item)}>
                  {expanded ? "收起使用记录" : "查看使用记录"}
                </button>
              </div>
              {rowError[item.id] && <p className="dash-inline-error" role="alert">{rowError[item.id]}</p>}
              {expanded && (
                <div className="dash-coupon-redemptions">
                  {redemptionsLoading && redemptions[item.id] === undefined ? (
                    <p>读取中…</p>
                  ) : (redemptions[item.id]?.length ?? 0) === 0 ? (
                    <p>暂无使用记录</p>
                  ) : (
                    <table className="dash-plans-table">
                      <thead><tr><th>订单</th><th>优惠金额</th><th>核销时间</th><th>状态</th></tr></thead>
                      <tbody>
                        {redemptions[item.id]!.map((redemption) => (
                          <tr key={redemption.orderRef}>
                            <td>{redemption.orderRef}</td>
                            <td>{formatFen(redemption.discountFen)}</td>
                            <td>{formatDate(redemption.redeemedAt)}</td>
                            <td>{redemption.releasedAt === null ? "生效中" : "已释放"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
