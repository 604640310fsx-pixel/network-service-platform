import { useEffect, useState, type FormEvent } from "react";
import { getAdminPlans, type AdminPlanItem } from "../../lib/admin-commerce-api";
import {
  bindAdminGrantDelivery,
  bindAdminServiceDelivery,
  createAdminGrant,
  getAdminUserServices,
  openAdminGrant,
  searchAdminUsers,
  updateAdminGrant,
  updateAdminService,
  type AdminDeliveryLine,
  type AdminGrant,
  type AdminUserService,
  type AdminUserSummary,
  type GrantSelection,
} from "../../lib/admin-services-api";
import { useCatalogText, useT, type Messages } from "../../lib/i18n";
import { PaymentApiError, getAdminMonitorTargets, type AdminMonitorTarget } from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";
import { endOfUtcDay, serviceTerm, utcDateInput } from "../../lib/serviceTerm";

/* 用户服务管理（Migration 022）：按邮箱找买家 → 调整已购服务的到期日 / 套餐名 / 内部备注，
   或赠送、撤销不经支付的套餐。日期输入是 UTC 日历日，保存为当天 23:59:59.999Z。
   内部备注与赠送原因只在本面板显示，买家接口不返回。 */

type Copy = Messages["adminServices"];

function errorMessage(error: unknown, copy: Copy): string {
  if (error instanceof PaymentApiError && Object.hasOwn(copy.errors, error.code)) {
    return copy.errors[error.code as keyof Copy["errors"]];
  }
  return copy.errors.generic;
}

type ServiceDraft = { readonly endsAt: string; readonly planLabel: string; readonly note: string };

function draftOf(service: AdminUserService): ServiceDraft {
  return { endsAt: utcDateInput(service.endsAt), planLabel: service.planLabel ?? "", note: service.adminNote ?? "" };
}

function snapshotLabel(service: AdminUserService): string {
  const { summary } = resolveSelection({
    typeId: service.typeId,
    regionId: service.regionId,
    ispId: service.ispId,
    specId: service.specId,
    durationId: service.durationId,
  });
  return [summary.type, summary.region, summary.isp, summary.spec, summary.duration].filter((part) => part && part !== "—").join(" · ");
}

/* 交付线路的 VPS 绑定（服务与赠送共用）：未绑定的线路可「绑定 VPS」，已绑定的可「换绑 VPS」或
   「解除绑定」。VPS 列表按需读取，读取失败即显示「监控暂不可用」，不提交；解绑不需要 VPS 列表。 */
function DeliveryBindings({
  lines,
  csrfToken,
  copy,
  onBind,
}: {
  lines: ReadonlyArray<AdminDeliveryLine>;
  csrfToken: string | null;
  copy: Copy;
  onBind: (position: number, monitorTargetKey: string | null) => Promise<void>;
}) {
  const delivery = useT().adminDelivery;
  const [editing, setEditing] = useState<number | null>(null);
  const [targets, setTargets] = useState<AdminMonitorTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Names for already-bound lines; a failure only falls back to showing the key.
    const controller = new AbortController();
    if (lines.some((line) => line.monitorTargetKey !== null)) {
      getAdminMonitorTargets(controller.signal).then(setTargets, () => undefined);
    }
    return () => controller.abort();
  }, [lines]);

  async function startBinding(position: number, current: string | null) {
    setEditing(position);
    setChoice(current ?? "");
    setError(null);
    setTargetsError(false);
    try {
      setTargets(await getAdminMonitorTargets());
    } catch {
      setTargetsError(true);
    }
  }

  async function apply(position: number, key: string | null) {
    if (csrfToken === null) return;
    setBusy(position);
    setError(null);
    try {
      await onBind(position, key);
      setEditing(null);
    } catch (caught) {
      setError(errorMessage(caught, copy));
    } finally {
      setBusy(null);
    }
  }

  function unbind(line: AdminDeliveryLine) {
    if (!window.confirm(delivery.unbindConfirm(line.label))) return;
    void apply(line.position, null);
  }

  if (lines.length === 0) return null;
  const label = (key: string) => targets?.find((target) => target.key === key)?.label ?? key;
  return (
    <div className="dash-usvc-open">
      <p className="dash-usvc-meta">{delivery.deliveryLines}</p>
      {lines.map((line) => {
        const lineBusy = busy === line.position;
        return (
          <div className="dash-usvc-line" key={line.position}>
            <span>{line.position}. {line.label}</span>
            <span className={`dash-tag${line.monitorTargetKey === null ? " is-warn" : " is-accent"}`}>
              {line.monitorTargetKey === null ? delivery.unbound : delivery.bound(label(line.monitorTargetKey))}
            </span>
            {editing === line.position ? (
              targetsError ? (
                <span className="dash-usvc-meta">{delivery.bindUnavailable}</span>
              ) : targets === null ? (
                <span className="dash-usvc-meta">{delivery.loadingTargets}</span>
              ) : (
                <>
                  <select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={lineBusy} aria-label={delivery.vpsServer}>
                    <option value="">{delivery.chooseVps}</option>
                    {targets.filter((target) => target.state === "active").map((target) => (
                      <option key={target.key} value={target.key}>{target.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="dash-primary-link"
                    disabled={lineBusy || choice === "" || choice === line.monitorTargetKey || csrfToken === null}
                    aria-busy={lineBusy}
                    onClick={() => void apply(line.position, choice)}
                  >
                    {lineBusy ? delivery.binding : delivery.saveBinding}
                  </button>
                </>
              )
            ) : (
              <>
                <button type="button" className="dash-usvc-ghost" disabled={busy !== null || csrfToken === null} onClick={() => void startBinding(line.position, line.monitorTargetKey)}>
                  {line.monitorTargetKey === null ? delivery.bindVps : delivery.rebindVps}
                </button>
                {line.monitorTargetKey !== null && (
                  <button type="button" className="dash-usvc-ghost" disabled={busy !== null || csrfToken === null} aria-busy={lineBusy} onClick={() => unbind(line)}>
                    {lineBusy ? delivery.unbinding : delivery.unbindVps}
                  </button>
                )}
              </>
            )}
            {editing === line.position && (
              <button type="button" className="dash-usvc-ghost" onClick={() => setEditing(null)} disabled={lineBusy}>{delivery.cancel}</button>
            )}
          </div>
        );
      })}
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
    </div>
  );
}

function ServiceRow({
  service,
  csrfToken,
  copy,
  expiredLabel,
  onSaved,
}: {
  service: AdminUserService;
  csrfToken: string | null;
  copy: Copy;
  expiredLabel: string;
  onSaved: (service: AdminUserService) => void;
}) {
  const [draft, setDraft] = useState<ServiceDraft>(() => draftOf(service));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const original = draftOf(service);
  const dirty = draft.endsAt !== original.endsAt || draft.planLabel.trim() !== original.planLabel || draft.note.trim() !== original.note;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (csrfToken === null || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateAdminService(
        service.id,
        {
          endsAt: endOfUtcDay(draft.endsAt),
          planLabel: draft.planLabel.trim() === "" ? null : draft.planLabel.trim(),
          note: draft.note.trim() === "" ? null : draft.note.trim(),
        },
        csrfToken,
      );
      onSaved(updated);
      setDraft(draftOf(updated));
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof RangeError ? copy.errors.invalid_service_patch : errorMessage(caught, copy));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="dash-usvc-item">
      <form onSubmit={(event) => void save(event)}>
        <div className="dash-usvc-head">
          <strong>{service.planLabel ?? snapshotLabel(service)}</strong>
          <span className={`dash-tag${service.serviceStatus === "open" ? " is-accent" : ""}`}>{copy.serviceStatus[service.serviceStatus]}</span>
          <span className="dash-usvc-meta">
            {copy.orderRef} {service.orderRef}
            {" · "}
            {service.endsAt === null ? copy.longTerm : `${utcDateInput(service.endsAt)} UTC`}
            {serviceTerm(service.endsAt, new Date()).kind === "expired" ? ` · ${expiredLabel}` : ""}
          </span>
        </div>
        <p className="dash-usvc-meta">{copy.snapshot}: {snapshotLabel(service)}</p>
        <div className="dash-usvc-grid">
          <label>
            {copy.endsAt}
            <input type="date" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} disabled={saving} />
          </label>
          <label>
            {copy.planLabel}
            <input type="text" maxLength={80} value={draft.planLabel} onChange={(event) => setDraft({ ...draft, planLabel: event.target.value })} disabled={saving} />
          </label>
          <label className="dash-usvc-wide">
            {copy.note}
            <textarea maxLength={500} rows={2} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} disabled={saving} />
          </label>
        </div>
        <div className="dash-usvc-foot">
          <button type="submit" className="dash-primary-link" disabled={!dirty || saving || csrfToken === null} aria-busy={saving}>
            {saving ? copy.saving : copy.save}
          </button>
          {saved && !dirty && <span className="dash-usvc-meta" role="status">{copy.saved}</span>}
          {error && <p className="dash-inline-error" role="alert">{error}</p>}
        </div>
      </form>
      <DeliveryBindings
        lines={service.deliveryLines}
        csrfToken={csrfToken}
        copy={copy}
        onBind={async (position, key) => {
          if (csrfToken !== null) onSaved(await bindAdminServiceDelivery(service.id, position, key, csrfToken));
        }}
      />
    </li>
  );
}

function yuan(fen: number): string {
  const amount = fen / 100;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function durationMonths(durationId: string): number {
  const match = /^month-(\d+)$/.exec(durationId);
  return match ? Number(match[1]) : 1;
}

/** Catalog name of a selection in the current language, e.g. "Local ISP · US · Verizon". */
function useSelectionName(): (selection: GrantSelection) => string {
  const catalogText = useCatalogText();
  return (selection) => {
    const { summary, requiresSpec } = resolveSelection(selection);
    const parts = [summary.type, summary.region, summary.isp, ...(requiresSpec ? [summary.spec] : [])];
    return parts.filter((part) => part && part !== "—").map(catalogText).join(" · ");
  };
}

function selectionOf(grant: AdminGrant): GrantSelection | null {
  return grant.typeId && grant.regionId && grant.ispId && grant.durationId
    ? { typeId: grant.typeId, regionId: grant.regionId, ispId: grant.ispId, specId: grant.specId, durationId: grant.durationId }
    : null;
}

/* 选择值："" = 尚未选择；NO_VPS = 明确不绑定；其它 = VPS key。选 VPS 时，名称为空或仍是上次自动带出的
   名称则自动带出 VPS 名称，可再修改。VPS 列表读取失败时与「待开通服务」一致：提示不可用，勾选
   「暂不绑定 VPS 开通」后才能提交（全部线路不绑定）。 */
const NO_VPS = "__none__";

type GrantLineDraft = { readonly label: string; readonly subscriptionUrl: string; readonly target: string; readonly autoLabel: string | null };

const EMPTY_GRANT_LINE: GrantLineDraft = { label: "", subscriptionUrl: "", target: "", autoLabel: null };

function OpenGrantForm({
  grant,
  csrfToken,
  copy,
  onDone,
  onCancel,
}: {
  grant: AdminGrant;
  csrfToken: string | null;
  copy: Copy;
  onDone: (grant: AdminGrant) => void;
  onCancel: () => void;
}) {
  const delivery = useT().adminDelivery;
  const [lines, setLines] = useState<GrantLineDraft[]>([EMPTY_GRANT_LINE]);
  const [targets, setTargets] = useState<AdminMonitorTarget[] | null>(null);
  const [targetsFailed, setTargetsFailed] = useState(false);
  const [allowUnbound, setAllowUnbound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAdminMonitorTargets(controller.signal).then(setTargets, () => {
      if (!controller.signal.aborted) setTargetsFailed(true);
    });
    return () => controller.abort();
  }, []);

  const activeTargets = (targets ?? []).filter((target) => target.state === "active");
  const loading = targets === null && !targetsFailed;
  const filled = lines.every((line) => line.label.trim() !== "" && line.subscriptionUrl.trim() !== "");
  const ready = filled && (targetsFailed ? allowUnbound : !loading && lines.every((line) => line.target !== ""));

  function update(index: number, patch: Partial<GrantLineDraft>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function chooseTarget(index: number, value: string) {
    const line = lines[index];
    if (line === undefined) return;
    const target = activeTargets.find((candidate) => candidate.key === value);
    const keepsAuto = line.label.trim() === "" || line.label === line.autoLabel;
    update(index, target !== undefined && keepsAuto
      ? { target: value, label: target.label, autoLabel: target.label }
      : { target: value });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (csrfToken === null || !ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await openAdminGrant(
        grant.id,
        lines.map((line) => ({
          label: line.label.trim(),
          subscriptionUrl: line.subscriptionUrl.trim(),
          monitorTargetKey: targetsFailed || line.target === NO_VPS ? null : line.target,
        })),
        csrfToken,
      ));
    } catch (caught) {
      setError(errorMessage(caught, copy));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-usvc-open" onSubmit={(event) => void submit(event)}>
      <p className="dash-usvc-meta">{copy.openTitle}</p>
      {lines.map((line, index) => (
        <div className="dash-usvc-grid" key={index}>
          <label>
            {delivery.vpsServer}
            <select
              value={targetsFailed ? "" : line.target}
              disabled={busy || loading || targetsFailed}
              onChange={(event) => chooseTarget(index, event.target.value)}
            >
              <option value="">
                {loading ? delivery.loadingTargets : targetsFailed ? delivery.monitorUnavailableOption : activeTargets.length === 0 ? delivery.noActiveVps : delivery.chooseVps}
              </option>
              {!targetsFailed && !loading && <option value={NO_VPS}>{delivery.noVpsOption}</option>}
              {activeTargets.map((target) => (
                <option key={target.key} value={target.key}>{target.label}</option>
              ))}
            </select>
          </label>
          <label>
            {copy.lineLabel} {index + 1}
            <input type="text" maxLength={200} value={line.label} disabled={busy}
              onChange={(event) => update(index, { label: event.target.value })} />
          </label>
          <label>
            {copy.lineUrl}
            <input type="url" inputMode="url" value={line.subscriptionUrl} disabled={busy} autoComplete="off"
              onChange={(event) => update(index, { subscriptionUrl: event.target.value })} />
          </label>
          {lines.length > 1 && (
            <button type="button" className="dash-usvc-ghost dash-usvc-line-remove" disabled={busy}
              onClick={() => setLines(lines.filter((_, i) => i !== index))}>
              {copy.removeLine}
            </button>
          )}
        </div>
      ))}
      {targetsFailed && (
        <label className="dash-delivery-unbound">
          <input type="checkbox" checked={allowUnbound} disabled={busy} onChange={(event) => setAllowUnbound(event.target.checked)} />
          <span>
            <strong>{delivery.allowUnbound}</strong>
            <small>{delivery.giftUnavailableHint}</small>
          </span>
        </label>
      )}
      <div className="dash-usvc-foot">
        <button type="button" className="dash-usvc-ghost" disabled={busy || lines.length >= 20}
          onClick={() => setLines([...lines, EMPTY_GRANT_LINE])}>
          {copy.addLine}
        </button>
        <button type="submit" className="dash-primary-link" disabled={busy || !ready || csrfToken === null} aria-busy={busy}>
          {busy ? copy.opening : copy.open}
        </button>
        <button type="button" className="dash-usvc-ghost" onClick={onCancel} disabled={busy}>{copy.cancel}</button>
        {error && <p className="dash-inline-error" role="alert">{error}</p>}
      </div>
    </form>
  );
}

function EditGrantForm({
  grant,
  csrfToken,
  copy,
  onDone,
  onCancel,
}: {
  grant: AdminGrant;
  csrfToken: string | null;
  copy: Copy;
  onDone: (grant: AdminGrant) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(grant.label);
  const [months, setMonths] = useState(grant.months === null ? "" : String(grant.months));
  const [value, setValue] = useState(grant.valueFen === null ? "" : yuan(grant.valueFen));
  const [endsAt, setEndsAt] = useState(utcDateInput(grant.endsAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (csrfToken === null) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof updateAdminGrant>[1] = {
        label: label.trim(),
        endsAt: endOfUtcDay(endsAt),
        ...(months.trim() === "" ? {} : { months: Number(months) }),
        ...(value.trim() === "" ? {} : { valueFen: Math.round(Number(value) * 100) }),
      };
      onDone(await updateAdminGrant(grant.id, patch, csrfToken));
    } catch (caught) {
      setError(caught instanceof RangeError ? copy.errors.invalid_grant_patch : errorMessage(caught, copy));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-usvc-open" onSubmit={(event) => void submit(event)}>
      <div className="dash-usvc-grid">
        <label>{copy.grantLabel}<input type="text" required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} /></label>
        <label>{copy.grantMonths}<input type="number" min={1} max={120} step={1} value={months} onChange={(event) => setMonths(event.target.value)} disabled={busy} /></label>
        <label>{copy.grantValue}<input type="number" min={0} step={0.01} value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} /></label>
        <label>{copy.grantEndsAt}<input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} /></label>
      </div>
      <div className="dash-usvc-foot">
        <button type="submit" className="dash-primary-link" disabled={busy || label.trim() === "" || csrfToken === null} aria-busy={busy}>
          {busy ? copy.saving : copy.save}
        </button>
        <button type="button" className="dash-usvc-ghost" onClick={onCancel} disabled={busy}>{copy.cancel}</button>
        {error && <p className="dash-inline-error" role="alert">{error}</p>}
      </div>
    </form>
  );
}

function GrantRow({
  grant,
  csrfToken,
  copy,
  locale,
  expiredLabel,
  onChanged,
}: {
  grant: AdminGrant;
  csrfToken: string | null;
  copy: Copy;
  locale: string;
  expiredLabel: string;
  onChanged: (grant: AdminGrant) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "open" | "edit">("view");
  const selectionName = useSelectionName();
  const selection = selectionOf(grant);
  const term = serviceTerm(grant.endsAt, new Date());
  const active = grant.status === "active";

  async function revoke() {
    if (csrfToken === null || !window.confirm(copy.revokeConfirm(grant.label))) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await updateAdminGrant(grant.id, { status: "revoked" }, csrfToken));
    } catch (caught) {
      setError(errorMessage(caught, copy));
    } finally {
      setBusy(false);
    }
  }

  const done = (updated: AdminGrant) => {
    setMode("view");
    onChanged(updated);
  };

  return (
    <li className={`dash-usvc-item${active ? "" : " is-revoked"}`}>
      <div className="dash-usvc-head">
        <strong>{grant.label}</strong>
        <span className={`dash-tag${active ? " is-accent" : ""}`}>{copy.grantStatus[grant.status]}</span>
        {active && <span className={`dash-tag${grant.deliveryStatus === "open" ? " is-accent" : ""}`}>{copy.deliveryStatus[grant.deliveryStatus]}</span>}
        <span className="dash-usvc-meta">
          {copy.startedAt(new Date(grant.startsAt).toLocaleDateString(locale, { timeZone: "UTC" }))}
          {" · "}
          {grant.endsAt === null ? copy.longTerm : `${utcDateInput(grant.endsAt)} UTC`}
          {term.kind === "expired" ? ` · ${expiredLabel}` : ""}
        </span>
      </div>
      <p className="dash-usvc-meta">
        {selection === null
          ? copy.legacyGift
          : [selectionName(selection),
            grant.months === null ? null : copy.monthsValue(grant.months),
            grant.valueFen === null ? null : copy.valueAmount(yuan(grant.valueFen))].filter(Boolean).join(" · ")}
      </p>
      {grant.deliveryLines.length > 0 && !(active && grant.deliveryStatus === "open") && (
        <p className="dash-usvc-meta">{copy.deliveredLines(grant.deliveryLines.length)}: {grant.deliveryLines.map((line) => line.label).join(" / ")}</p>
      )}
      {active && grant.deliveryStatus === "open" && (
        <DeliveryBindings
          lines={grant.deliveryLines}
          csrfToken={csrfToken}
          copy={copy}
          onBind={async (position, key) => {
            if (csrfToken !== null) onChanged(await bindAdminGrantDelivery(grant.id, position, key, csrfToken));
          }}
        />
      )}
      {grant.reason && <p className="dash-usvc-meta">{copy.grantReason}: {grant.reason}</p>}
      {active && mode === "open" && <OpenGrantForm grant={grant} csrfToken={csrfToken} copy={copy} onDone={done} onCancel={() => setMode("view")} />}
      {active && mode === "edit" && <EditGrantForm grant={grant} csrfToken={csrfToken} copy={copy} onDone={done} onCancel={() => setMode("view")} />}
      {active && mode === "view" && (
        <div className="dash-usvc-foot">
          {grant.deliveryStatus === "pending_open" && (
            <button type="button" className="dash-primary-link" onClick={() => setMode("open")} disabled={busy || csrfToken === null}>{copy.open}</button>
          )}
          <button type="button" className="dash-usvc-ghost" onClick={() => setMode("edit")} disabled={busy || csrfToken === null}>{copy.edit}</button>
          <button type="button" className="dash-usvc-ghost" onClick={() => void revoke()} disabled={busy || csrfToken === null} aria-busy={busy}>
            {busy ? copy.revoking : copy.revoke}
          </button>
          {error && <p className="dash-inline-error" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

function GrantForm({
  userId,
  csrfToken,
  copy,
  onCreated,
}: {
  userId: number;
  csrfToken: string | null;
  copy: Copy;
  onCreated: (grant: AdminGrant) => void;
}) {
  const selectionName = useSelectionName();
  const catalogText = useCatalogText();
  const [plans, setPlans] = useState<AdminPlanItem[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [months, setMonths] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getAdminPlans(controller.signal)
      .then((items) => setPlans(items))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(caught, copy));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plan = plans?.find((item) => String(item.id) === planId) ?? null;
  const planName = (item: AdminPlanItem) => selectionName(item);
  const suggestedLabel = plan === null || months.trim() === "" ? "" : `${planName(plan)} · ${copy.monthsValue(Number(months))}`;

  function choosePlan(id: string) {
    setPlanId(id);
    const chosen = plans?.find((item) => String(item.id) === id);
    if (chosen) {
      setMonths(String(durationMonths(chosen.durationId)));
      setValue(yuan(chosen.priceFen));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (csrfToken === null || plan === null) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await createAdminGrant(
        {
          userId,
          typeId: plan.typeId,
          regionId: plan.regionId,
          ispId: plan.ispId,
          specId: plan.specId,
          durationId: plan.durationId,
          months: Number(months),
          valueFen: Math.round(Number(value) * 100),
          label: label.trim() !== "" ? label.trim() : suggestedLabel !== "" ? suggestedLabel.slice(0, 80) : null,
          endsAt: endOfUtcDay(endsAt),
          reason: reason.trim() === "" ? null : reason.trim(),
        },
        csrfToken,
      );
      onCreated(grant);
      setPlanId("");
      setMonths("");
      setValue("");
      setLabel("");
      setEndsAt("");
      setReason("");
    } catch (caught) {
      setError(caught instanceof RangeError ? copy.errors.invalid_grant : errorMessage(caught, copy));
    } finally {
      setBusy(false);
    }
  }

  const monthsValid = /^[1-9]\d*$/.test(months) && Number(months) <= 120;
  const valueValid = value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;

  return (
    <form className="dash-coupon-create dash-usvc-grant-form" onSubmit={(event) => void submit(event)}>
      <h3>{copy.grantFormTitle}</h3>
      <div className="dash-usvc-grid">
        <label className="dash-usvc-wide">
          {copy.grantPlan}
          <select value={planId} onChange={(event) => choosePlan(event.target.value)} disabled={busy || plans === null} required>
            <option value="">{plans === null ? copy.plansLoading : copy.grantPlanPlaceholder}</option>
            {(plans ?? []).map((item) => (
              <option key={item.id} value={String(item.id)}>
                {planName(item)} · {catalogText(resolveSelection(item).summary.duration)} · ¥{yuan(item.priceFen)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.grantMonths}
          <input type="number" min={1} max={120} step={1} required value={months} onChange={(event) => setMonths(event.target.value)} disabled={busy} />
        </label>
        <label>
          {copy.grantValue}
          <input type="number" min={0} step={0.01} required value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} />
        </label>
        <label>
          {copy.grantEndsAt}
          <input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} />
        </label>
        <label className="dash-usvc-wide">
          {copy.grantLabelOptional}
          <input type="text" maxLength={80} value={label} placeholder={suggestedLabel} onChange={(event) => setLabel(event.target.value)} disabled={busy} />
        </label>
        <label className="dash-usvc-wide">
          {copy.grantReason}
          <textarea maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
        </label>
      </div>
      <div className="dash-usvc-foot">
        <button type="submit" className="dash-primary-link" disabled={busy || plan === null || !monthsValid || !valueValid || csrfToken === null} aria-busy={busy}>
          {busy ? copy.creatingGrant : copy.createGrant}
        </button>
        {error && <p className="dash-inline-error" role="alert">{error}</p>}
      </div>
    </form>
  );
}

export function AdminUserServicesPanel({ csrfToken }: { csrfToken: string | null }) {
  const t = useT();
  const copy = t.adminServices;
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<AdminUserSummary[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUserSummary | null>(null);
  const [detail, setDetail] = useState<{ services: AdminUserService[]; grants: AdminGrant[] } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    void getAdminUserServices(selected.id, controller.signal)
      .then((value) => setDetail(value))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(error, copy));
      });
    return () => controller.abort();
    // copy changes with the language only; the loaded data does not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function search(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed === "") return;
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await searchAdminUsers(trimmed));
    } catch (error) {
      setResults(null);
      setSearchError(errorMessage(error, copy));
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="dash-panel dash-usvc" aria-labelledby="dash-admin-usvc-title">
      <h2 id="dash-admin-usvc-title">
        <em>{copy.eyebrow}</em>
        {copy.title}
        {selected && <span>{copy.selectedUser(selected.email)}</span>}
      </h2>
      <p className="dash-usvc-lead">{copy.lead}</p>
      <form className="dash-plans-toolbar dash-usvc-search" onSubmit={(event) => void search(event)}>
        <label className="dash-usvc-visually-hidden" htmlFor="dash-usvc-query">{copy.searchLabel}</label>
        <input
          id="dash-usvc-query"
          type="search"
          value={query}
          maxLength={100}
          placeholder={copy.searchPlaceholder}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="dash-primary-link" disabled={searching || query.trim() === ""} aria-busy={searching}>
          {searching ? copy.searching : copy.search}
        </button>
      </form>
      {searchError && <p className="dash-inline-error" role="alert">{searchError}</p>}
      {results !== null && (
        results.length === 0 ? (
          <p className="dash-usvc-meta" role="status">{copy.noUsers}</p>
        ) : (
          <ul className="dash-usvc-users">
            {results.map((user) => (
              <li key={user.id} className={selected?.id === user.id ? "is-selected" : undefined}>
                <span className="dash-usvc-email">{user.email}</span>
                {user.role === "admin" && <span className="dash-tag">admin</span>}
                {user.status === "disabled" && <span className="dash-tag">disabled</span>}
                <button type="button" className="dash-usvc-ghost" onClick={() => setSelected(user)} aria-pressed={selected?.id === user.id}>
                  {copy.selectUser}
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {selected && (
        <div className="dash-usvc-detail">
          {detailError && <p className="dash-inline-error" role="alert">{detailError}</p>}
          {detail === null && !detailError && <p className="dash-usvc-meta" role="status">{copy.loading}</p>}
          {detail && (
            <>
              <h3>{copy.servicesTitle}</h3>
              {detail.services.length === 0 ? (
                <p className="dash-usvc-meta">{copy.servicesEmpty}</p>
              ) : (
                <ul className="dash-usvc-list">
                  {detail.services.map((service) => (
                    <ServiceRow
                      key={service.id}
                      service={service}
                      csrfToken={csrfToken}
                      copy={copy}
                      expiredLabel={t.services.termExpired}
                      onSaved={(updated) =>
                        setDetail((current) => current && { ...current, services: current.services.map((item) => (item.id === updated.id ? updated : item)) })
                      }
                    />
                  ))}
                </ul>
              )}
              <h3>{copy.grantsTitle}</h3>
              {detail.grants.length === 0 ? (
                <p className="dash-usvc-meta">{copy.grantsEmpty}</p>
              ) : (
                <ul className="dash-usvc-list">
                  {detail.grants.map((grant) => (
                    <GrantRow
                      key={grant.id}
                      grant={grant}
                      csrfToken={csrfToken}
                      copy={copy}
                      locale={t.account.dateLocale}
                      expiredLabel={t.services.termExpired}
                      onChanged={(updated) =>
                        setDetail((current) => current && { ...current, grants: current.grants.map((item) => (item.id === updated.id ? updated : item)) })
                      }
                    />
                  ))}
                </ul>
              )}
              <GrantForm
                userId={selected.id}
                csrfToken={csrfToken}
                copy={copy}
                onCreated={(grant) => setDetail((current) => current && { ...current, grants: [grant, ...current.grants] })}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
