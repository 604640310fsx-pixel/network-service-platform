import { useEffect, useMemo, useState } from "react";
import {
  getAdminPlans,
  updateAdminPlan,
  type AdminPlanItem,
} from "../../lib/admin-commerce-api";
import { PaymentApiError } from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";

function planErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法处理套餐，请稍后重试。";
  switch (error.code) {
    case "unauthorized": return "管理员登录状态已失效。";
    case "forbidden": return "当前账户没有套餐管理权限。";
    case "csrf_invalid": return "安全校验已失效，请刷新页面后重试。";
    case "not_found": return "该套餐不存在，请刷新后重试。";
    case "invalid_slots": return "库存名额不能低于已占用数量。";
    case "invalid_plan_patch": return "提交的价格或库存格式不正确。";
    case "invalid_response": return "套餐数据返回异常。";
    default: return "暂时无法处理套餐，请稍后重试。";
  }
}

function planLabel(item: AdminPlanItem): { type: string; region: string; isp: string; spec: string; duration: string } {
  const { summary } = resolveSelection({
    typeId: item.typeId,
    regionId: item.regionId,
    ispId: item.ispId,
    specId: item.specId,
    durationId: item.durationId,
  });
  return { type: summary.type, region: summary.region, isp: summary.isp, spec: summary.spec, duration: summary.duration };
}

function formatFen(amountFen: number): string {
  const amount = amountFen / 100;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

type PlanDraft = {
  readonly priceYuan: string;
  readonly totalSlots: string;
};

function draftFromItem(item: AdminPlanItem): PlanDraft {
  return { priceYuan: formatFen(item.priceFen), totalSlots: item.totalSlots === null ? "" : String(item.totalSlots) };
}

export function AdminPlansPanel({ csrfToken }: { csrfToken: string | null }) {
  const [items, setItems] = useState<AdminPlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [drafts, setDrafts] = useState<Record<number, PlanDraft>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void getAdminPlans(controller.signal)
      .then((nextItems) => {
        if (stopped) return;
        setItems(nextItems);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!stopped) setError(planErrorMessage(loadError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter === "active" && !item.isActive) return false;
      if (statusFilter === "inactive" && item.isActive) return false;
      if (query === "") return true;
      const label = planLabel(item);
      const haystack = [
        item.typeId, item.regionId, item.ispId, item.specId ?? "", item.durationId,
        label.type, label.region, label.isp, label.spec, label.duration,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search, statusFilter]);

  function draftFor(item: AdminPlanItem): PlanDraft {
    return drafts[item.id] ?? draftFromItem(item);
  }

  function setDraft(planId: number, next: Partial<PlanDraft>) {
    setDrafts((current) => ({ ...current, [planId]: { ...(current[planId] ?? draftFromItem(items.find((item) => item.id === planId)!)), ...next } }));
  }

  function isDirty(item: AdminPlanItem): boolean {
    const draft = draftFor(item);
    return draft.priceYuan !== draftFromItem(item).priceYuan || draft.totalSlots !== draftFromItem(item).totalSlots;
  }

  async function savePrice(item: AdminPlanItem) {
    if (csrfToken === null) {
      setRowError((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }
    const draft = draftFor(item);
    const priceYuan = Number(draft.priceYuan);
    if (!Number.isFinite(priceYuan) || priceYuan <= 0) {
      setRowError((current) => ({ ...current, [item.id]: "请输入有效的价格（元）。" }));
      return;
    }
    const totalSlots = draft.totalSlots.trim() === "" ? null : Number(draft.totalSlots);
    if (totalSlots !== null && (!Number.isSafeInteger(totalSlots) || totalSlots < 0)) {
      setRowError((current) => ({ ...current, [item.id]: "库存名额需为非负整数，留空表示不限量。" }));
      return;
    }
    setSavingId(item.id);
    setRowError((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const updated = await updateAdminPlan(item.id, csrfToken, {
        priceFen: Math.round(priceYuan * 100),
        totalSlots,
      });
      setItems((current) => current.map((existing) => (existing.id === item.id ? updated : existing)));
      setDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (saveError) {
      setRowError((current) => ({ ...current, [item.id]: planErrorMessage(saveError) }));
    } finally {
      setSavingId(null);
    }
  }

  async function toggleActive(item: AdminPlanItem) {
    if (csrfToken === null) {
      setRowError((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }
    setSavingId(item.id);
    setRowError((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const updated = await updateAdminPlan(item.id, csrfToken, { isActive: !item.isActive });
      setItems((current) => current.map((existing) => (existing.id === item.id ? updated : existing)));
    } catch (saveError) {
      setRowError((current) => ({ ...current, [item.id]: planErrorMessage(saveError) }));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-plans-title">
      <h2 id="dash-admin-plans-title"><em>COMMERCE</em>套餐管理<span>{loading ? "读取中" : `${filteredItems.length} / ${items.length} 项`}</span></h2>
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      <div className="dash-plans-toolbar">
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索类型 / 地区 / 运营商 / 规格 / 周期"
          autoComplete="off"
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "inactive")}>
          <option value="all">全部状态</option>
          <option value="active">仅可售</option>
          <option value="inactive">仅停售</option>
        </select>
      </div>
      <div className="dash-plans-table-wrap">
        <table className="dash-plans-table">
          <thead>
            <tr>
              <th>ID</th><th>网络类型</th><th>地区</th><th>运营商</th><th>规格</th><th>周期</th>
              <th>价格（元）</th><th>状态</th><th>总名额</th><th>已占用</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const label = planLabel(item);
              const draft = draftFor(item);
              const dirty = isDirty(item);
              const saving = savingId === item.id;
              return (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td>{label.type}</td>
                  <td>{label.region}</td>
                  <td>{label.isp}</td>
                  <td>{label.spec}</td>
                  <td>{label.duration}</td>
                  <td>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={draft.priceYuan}
                      onChange={(event) => setDraft(item.id, { priceYuan: event.target.value })}
                      disabled={saving}
                      className="dash-plans-input"
                    />
                  </td>
                  <td>
                    <button type="button" className={`dash-tag dash-plan-status ${item.isActive ? "is-active" : ""}`} onClick={() => void toggleActive(item)} disabled={saving}>
                      {item.isActive ? "可售" : "停售"}
                    </button>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.totalSlots}
                      onChange={(event) => setDraft(item.id, { totalSlots: event.target.value })}
                      placeholder="不限"
                      disabled={saving}
                      className="dash-plans-input dash-plans-input-slots"
                    />
                  </td>
                  <td>{item.occupiedSlots}</td>
                  <td>
                    <button type="button" className="dash-primary-link" disabled={!dirty || saving} aria-busy={saving} onClick={() => void savePrice(item)}>
                      {saving ? "保存中…" : "保存"}
                    </button>
                    {rowError[item.id] && <p className="dash-inline-error dash-plans-row-error" role="alert">{rowError[item.id]}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
