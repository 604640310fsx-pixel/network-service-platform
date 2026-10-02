import { useEffect, useState, type FormEvent } from "react";
import {
  createAdminGrant,
  getAdminUserServices,
  searchAdminUsers,
  updateAdminGrant,
  updateAdminService,
  type AdminGrant,
  type AdminUserService,
  type AdminUserSummary,
} from "../../lib/admin-services-api";
import { useT, type Messages } from "../../lib/i18n";
import { PaymentApiError } from "../../lib/payment-api";
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
    </li>
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
  const term = serviceTerm(grant.endsAt, new Date());

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

  return (
    <li className={`dash-usvc-item${grant.status === "revoked" ? " is-revoked" : ""}`}>
      <div className="dash-usvc-head">
        <strong>{grant.label}</strong>
        <span className={`dash-tag${grant.status === "active" ? " is-accent" : ""}`}>{copy.grantStatus[grant.status]}</span>
        <span className="dash-usvc-meta">
          {copy.startedAt(new Date(grant.startsAt).toLocaleDateString(locale, { timeZone: "UTC" }))}
          {" · "}
          {grant.endsAt === null ? copy.longTerm : `${utcDateInput(grant.endsAt)} UTC`}
          {term.kind === "expired" ? ` · ${expiredLabel}` : ""}
        </span>
      </div>
      {grant.reason && <p className="dash-usvc-meta">{copy.grantReason}: {grant.reason}</p>}
      {grant.status === "active" && (
        <div className="dash-usvc-foot">
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
  const [label, setLabel] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (csrfToken === null || label.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const grant = await createAdminGrant(
        { userId, label: label.trim(), endsAt: endOfUtcDay(endsAt), reason: reason.trim() === "" ? null : reason.trim() },
        csrfToken,
      );
      onCreated(grant);
      setLabel("");
      setEndsAt("");
      setReason("");
    } catch (caught) {
      setError(caught instanceof RangeError ? copy.errors.invalid_grant : errorMessage(caught, copy));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-coupon-create dash-usvc-grant-form" onSubmit={(event) => void submit(event)}>
      <h3>{copy.grantFormTitle}</h3>
      <div className="dash-usvc-grid">
        <label>
          {copy.grantLabel}
          <input type="text" required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} />
        </label>
        <label>
          {copy.grantEndsAt}
          <input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} />
        </label>
        <label className="dash-usvc-wide">
          {copy.grantReason}
          <textarea maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
        </label>
      </div>
      <div className="dash-usvc-foot">
        <button type="submit" className="dash-primary-link" disabled={busy || label.trim() === "" || csrfToken === null} aria-busy={busy}>
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
