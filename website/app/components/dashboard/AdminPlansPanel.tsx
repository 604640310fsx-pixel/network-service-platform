import { useEffect, useMemo, useState } from "react";
import {
  getAdminPlans,
  getAdminCatalogDirectory,
  updateAdminDirectoryRegion,
  updateAdminDirectoryOperator,
  updateAdminPlan,
  type AdminPlanItem,
  type AdminCatalogDirectory,
  type AdminRegionItem,
  type AdminOperatorItem,
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
  const [directoryStatus, setDirectoryStatus] = useState<AdminCatalogDirectory | null>(null);
  const [directorySaving, setDirectorySaving] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"directory" | "prices">("directory");
  const [directoryType, setDirectoryType] = useState("");
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [typeFilter, setTypeFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [ispFilter, setIspFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<number, PlanDraft>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void Promise.all([getAdminPlans(controller.signal), getAdminCatalogDirectory(controller.signal)])
      .then(([nextItems, nextDirectory]) => {
        if (stopped) return;
        setItems(nextItems);
        setDirectoryStatus(nextDirectory);
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
      if (typeFilter !== "" && item.typeId !== typeFilter) return false;
      if (regionFilter !== "" && item.regionId !== regionFilter) return false;
      if (ispFilter !== "" && item.ispId !== ispFilter) return false;
      if (query === "") return true;
      const label = planLabel(item);
      const haystack = [
        item.typeId, item.regionId, item.ispId, item.specId ?? "", item.durationId,
        label.type, label.region, label.isp, label.spec, label.duration,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search, statusFilter, typeFilter, regionFilter, ispFilter]);

  const directory = useMemo(() => {
    const groups = new Map<string, { typeId: string; regionId: string; ispId: string; label: ReturnType<typeof planLabel>; total: number; active: number }>();
    for (const item of items) {
      const key = JSON.stringify([item.typeId, item.regionId, item.ispId]);
      const group = groups.get(key) ?? {
        typeId: item.typeId, regionId: item.regionId, ispId: item.ispId,
        label: planLabel(item), total: 0, active: 0,
      };
      group.total += 1;
      if (item.isActive) group.active += 1;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) =>
      `${a.label.type} ${a.label.region} ${a.label.isp}`.localeCompare(`${b.label.type} ${b.label.region} ${b.label.isp}`, "zh-Hans-CN"));
  }, [items]);

  const types = [...new Map(directory.map((entry) => [entry.typeId, entry.label.type])).entries()];
  const regions = [...new Map(directory.filter((entry) => typeFilter === "" || entry.typeId === typeFilter)
    .map((entry) => [entry.regionId, entry.label.region])).entries()];
  const isps = [...new Map(directory.filter((entry) =>
    (typeFilter === "" || entry.typeId === typeFilter) && (regionFilter === "" || entry.regionId === regionFilter))
    .map((entry) => [entry.ispId, entry.label.isp])).entries()];
  const scopedItems = typeFilter && regionFilter && ispFilter ? filteredItems : [];
  const visibleItems = scopedItems.slice(0, visibleCount);

  useEffect(() => setVisibleCount(12), [search, statusFilter, typeFilter, regionFilter, ispFilter]);

  async function toggleRegion(item: AdminRegionItem) {
    if (csrfToken === null || directorySaving !== null) return;
    const key = JSON.stringify([item.typeId, item.regionId]);
    setDirectorySaving(key);
    setDirectoryError(null);
    try {
      const updated = await updateAdminDirectoryRegion(item, csrfToken);
      setDirectoryStatus((current) => current === null ? null : { ...current,
        regions: current.regions.map((existing) => existing.typeId === item.typeId && existing.regionId === item.regionId ? updated : existing) });
    } catch (caught) { setDirectoryError(planErrorMessage(caught)); }
    finally { setDirectorySaving(null); }
  }

  async function toggleOperator(item: AdminOperatorItem) {
    if (csrfToken === null || directorySaving !== null) return;
    const key = JSON.stringify([item.typeId, item.regionId, item.ispId]);
    setDirectorySaving(key);
    setDirectoryError(null);
    try {
      const updated = await updateAdminDirectoryOperator(item, csrfToken);
      setDirectoryStatus((current) => current === null ? null : { ...current,
        operators: current.operators.map((existing) => existing.typeId === item.typeId && existing.regionId === item.regionId && existing.ispId === item.ispId ? updated : existing) });
    } catch (caught) { setDirectoryError(planErrorMessage(caught)); }
    finally { setDirectorySaving(null); }
  }

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
    const priceText = draft.priceYuan.trim();
    const validPrice = /^\d+(?:\.\d{1,2})?$/.test(priceText);
    const [yuan = "", cents = ""] = priceText.split(".");
    const priceFen = Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
    if (!validPrice || !Number.isSafeInteger(priceFen) || priceFen <= 0) {
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
        priceFen,
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
      <h2 id="dash-admin-plans-title"><em>COMMERCE</em>套餐管理</h2>
      <nav className="dash-plan-subviews" aria-label="套餐管理内容">
        <button type="button" className={view === "directory" ? "is-active" : undefined} aria-current={view === "directory" ? "page" : undefined} onClick={() => setView("directory")}>国家与运营商启停</button>
        <button type="button" className={view === "prices" ? "is-active" : undefined} aria-current={view === "prices" ? "page" : undefined} onClick={() => setView("prices")}>套餐价格与库存</button>
      </nav>
      {loading && <p className="dash-usvc-meta" role="status">正在读取套餐与目录…</p>}
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      {view === "directory" && !loading && !error && directoryStatus && <div className="dash-plan-directory" aria-label="国家和运营商目录">
        <div className="dash-plan-directory-heading">
          <span>独立启停仅影响新报价和新订单；套餐的逐项停售与库存仍单独生效</span>
        </div>
        {directoryError && <p className="dash-inline-error" role="alert">{directoryError}</p>}
        <div className="dash-plan-type-list" role="group" aria-label="先选择网络类型">
          {types.map(([id, label]) => <button key={id} type="button" className={directoryType === id ? "is-active" : undefined}
            aria-pressed={directoryType === id} onClick={() => { setDirectoryType(id); setExpandedRegion(null); }}>{label}</button>)}
        </div>
        {directoryStatus.regions.length === 0 ? <p>暂无已配置套餐。</p> : directoryType === "" ?
          <p className="dash-plan-empty">先选择网络类型，再查看国家与运营商开关。</p> : <div className="dash-plan-directory-list">
          {directoryStatus.regions.filter((entry) => entry.typeId === directoryType).map((region) => {
            const regionPlans = directory.filter((entry) => entry.typeId === region.typeId && entry.regionId === region.regionId);
            const label = regionPlans[0]?.label;
            const operators = directoryStatus.operators.filter((entry) => entry.typeId === region.typeId && entry.regionId === region.regionId);
            const key = JSON.stringify([region.typeId, region.regionId]);
            const expanded = expandedRegion === key;
            return <div className="dash-plan-directory-card" key={JSON.stringify([region.typeId, region.regionId])}>
              <div className="dash-plan-region-head"><button type="button" aria-expanded={expanded} onClick={() => setExpandedRegion(expanded ? null : key)}>
                <strong>{label?.region ?? region.regionId}</strong><small>{operators.length} 个运营商 · {expanded ? "收起" : "展开"}</small>
              </button><button type="button" className={region.isActive ? "is-active" : undefined} disabled={csrfToken === null || directorySaving !== null}
                aria-busy={directorySaving === key} onClick={() => void toggleRegion(region)}>{region.isActive ? "地区已启用 · 停用" : "地区已停用 · 启用"}</button></div>
              {expanded && operators.map((operator) => {
                const plans = regionPlans.find((entry) => entry.ispId === operator.ispId);
                return <div key={operator.ispId} className="dash-plan-directory-operator">
                  <button type="button" onClick={() => { setTypeFilter(operator.typeId); setRegionFilter(operator.regionId); setIspFilter(operator.ispId); setView("prices"); }}>
                    {plans?.label.isp ?? operator.ispId} · 查看套餐
                  </button>
                  <small>{plans?.active ?? 0}/{plans?.total ?? 0} 项套餐自身启用</small>
                  <button type="button" disabled={csrfToken === null || directorySaving !== null} aria-busy={directorySaving === JSON.stringify([operator.typeId, operator.regionId, operator.ispId])}
                    onClick={() => void toggleOperator(operator)}>{operator.isActive ? "运营商已启用 · 停用" : "运营商已停用 · 启用"}</button>
                </div>;
              })}
            </div>;
          })}
        </div>}
      </div>}
      {view === "prices" && !loading && !error && <>
      <div className="dash-plans-toolbar">
        <select aria-label="网络类型" value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setRegionFilter(""); setIspFilter(""); }}>
          <option value="">选择网络类型</option>
          {types.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select aria-label="国家或地区" value={regionFilter} disabled={!typeFilter} onChange={(event) => { setRegionFilter(event.target.value); setIspFilter(""); }}>
          <option value="">选择国家或地区</option>
          {regions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select aria-label="运营商" value={ispFilter} disabled={!regionFilter} onChange={(event) => setIspFilter(event.target.value)}>
          <option value="">选择运营商</option>
          {isps.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <input type="text" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="筛选规格 / 周期" autoComplete="off" disabled={!ispFilter} />
        <select aria-label="套餐状态" value={statusFilter} disabled={!ispFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "inactive")}>
          <option value="all">全部状态</option>
          <option value="active">仅套餐启用</option>
          <option value="inactive">仅套餐停售</option>
        </select>
      </div>
      {(typeFilter || regionFilter || ispFilter || search || statusFilter !== "all") &&
        <button type="button" className="dash-usvc-ghost" onClick={() => {
          setTypeFilter(""); setRegionFilter(""); setIspFilter(""); setSearch(""); setStatusFilter("all");
        }}>清除筛选</button>}
      {!ispFilter ? <p className="dash-plan-empty">按网络类型 → 国家或地区 → 运营商选择后，再编辑该范围内的套餐。</p> : <>
        <p className="dash-usvc-meta" role="status">显示 {visibleItems.length} / {scopedItems.length} 项套餐</p>
        {scopedItems.length === 0 && <p className="dash-plan-empty">当前筛选下没有套餐。</p>}
        <div className="dash-plan-cards">
            {visibleItems.map((item) => {
              const label = planLabel(item);
              const draft = draftFor(item);
              const dirty = isDirty(item);
              const saving = savingId === item.id;
              const region = directoryStatus?.regions.find((entry) => entry.typeId === item.typeId && entry.regionId === item.regionId);
              const operator = directoryStatus?.operators.find((entry) => entry.typeId === item.typeId && entry.regionId === item.regionId && entry.ispId === item.ispId);
              const reason = !region?.isActive ? "地区停用" : !operator?.isActive ? "运营商停用" :
                item.totalSlots !== null && item.occupiedSlots >= item.totalSlots ? "库存已满" : null;
              return (
                <article key={item.id} className="dash-plan-card">
                  <div className="dash-plan-card-head"><strong>{label.spec} · {label.duration}</strong><small>套餐 #{item.id}</small></div>
                  <p className="dash-plan-card-path">{label.type} / {label.region} / {label.isp}</p>
                  <div className="dash-plan-card-fields">
                    <label>价格（元）<input type="number" min="0.01" step="0.01" value={draft.priceYuan}
                      onChange={(event) => setDraft(item.id, { priceYuan: event.target.value })} disabled={saving} /></label>
                    <label>总名额<input type="number" min="0" step="1" value={draft.totalSlots} placeholder="不限"
                      onChange={(event) => setDraft(item.id, { totalSlots: event.target.value })} disabled={saving} /></label>
                  </div>
                  <p className="dash-usvc-meta">已占用 {item.occupiedSlots} · {item.totalSlots === null ? "不限量" : `共 ${item.totalSlots} 名额`}</p>
                  <div className="dash-plan-card-actions"><button type="button" className={`dash-tag dash-plan-status ${item.isActive ? "is-active" : ""}`}
                    onClick={() => void toggleActive(item)} disabled={saving}>{item.isActive ? "套餐启用 · 停售" : "套餐停售 · 启用"}</button>
                    <button type="button" className="dash-primary-link" disabled={!dirty || saving} aria-busy={saving} onClick={() => void savePrice(item)}>
                      {saving ? "保存中…" : "保存价格与库存"}</button></div>
                  {item.isActive && reason && <small className="dash-plan-reason">新购不可用：{reason}</small>}
                  {rowError[item.id] && <p className="dash-inline-error dash-plans-row-error" role="alert">{rowError[item.id]}</p>}
                </article>
              );
            })}
        </div>
        {visibleItems.length < scopedItems.length && <button type="button" className="dash-usvc-ghost dash-plan-more" onClick={() => setVisibleCount((count) => count + 12)}>显示更多套餐</button>}
      </>}
      </>}
    </section>
  );
}
