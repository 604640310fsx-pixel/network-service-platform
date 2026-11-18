import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ALL_MONTHS,
  WITHDRAW_MIN_FEN,
  formatYuan,
  groupOrders,
  monthFilterModel,
  ordersMonths,
  type ReferralCenterData,
  type ReferralCandidatesState,
  type ReferralOrder,
  type ReferralOrderStatus,
  type ReferralSnapshot,
} from "./referralModel";
import { useT, type Messages } from "../../lib/i18n";
import { ReferralDialog } from "./ReferralDialog";
import { Money, WithdrawButton } from "./referralParts";

type TabKey = "commission" | "customers" | "settlement";
const TABS: readonly { key: TabKey }[] = [{ key: "commission" }, { key: "customers" }, { key: "settlement" }];

type ReferralCopy = Messages["referral"];
type RecordsCopy = ReferralCopy["records"];

function rateText(copy: ReferralCopy, rate: number | null): string {
  return rate === null ? copy.pending : `${rate}%`;
}

function tierText(copy: ReferralCopy, name: string | null, rate: number | null): string {
  return name ? `${copy.tierNames[name] ?? name} ${rateText(copy, rate)}` : copy.pending;
}

function statusText(copy: ReferralCopy, status: string): string {
  return copy.statuses[status] ?? status;
}

export function statusClass(status: ReferralOrderStatus): string {
  if (status === "可提现") return " is-ok";
  if (status === "待结算") return " is-pending";
  if (status === "调整记录") return " is-warn";
  return "";
}

/** 页签键盘导航：左右方向键循环，Home / End 跳到首尾。 */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function ReferralRecords({ data, candidates = { status: "pending" }, onCandidatePageChange }: {
  data: ReferralCenterData;
  candidates?: ReferralCandidatesState;
  onCandidatePageChange?: (page: number) => void;
}) {
  const baseId = useId();
  const copy = useT().referral.records;
  const [tab, setTab] = useState<TabKey>("commission");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextTabIndex(event.key, index, TABS.length);
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next].key);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="rfc-card rfc-records">
      <div className="rfc-tablist" role="tablist" aria-label={copy.tabsLabel}>
        {TABS.map((item, index) => (
          <button
            key={item.key}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            className="rfc-tab"
            role="tab"
            id={`${baseId}-tab-${item.key}`}
            aria-controls={`${baseId}-panel-${item.key}`}
            aria-selected={tab === item.key}
            tabIndex={tab === item.key ? 0 : -1}
            onClick={() => setTab(item.key)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {copy.tabs[item.key]}
          </button>
        ))}
      </div>
      {TABS.map((item) => (
        <div
          key={item.key}
          role="tabpanel"
          id={`${baseId}-panel-${item.key}`}
          aria-labelledby={`${baseId}-tab-${item.key}`}
          tabIndex={0}
          hidden={tab !== item.key}
        >
          {tab === item.key ? (
            <>
              {item.key === "customers" ? (
                <CandidatePanel candidates={candidates} onPageChange={onCandidatePageChange} />
              ) : null}
              <RecordsPanel tab={item.key} data={data} />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CandidatePanel({ candidates, onPageChange }: {
  candidates: ReferralCandidatesState;
  onPageChange?: (page: number) => void;
}) {
  const copy = useT().referral.records;
  return (
    <section className="rfc-candidates" aria-label={copy.candidates}>
      <h3>{copy.candidates}</h3>
      <p className="rfc-privacy">{copy.candidatesNote}</p>
      {candidates.status === "pending" ? <p className="rfc-privacy">{copy.candidatesPending}</p> : null}
      {candidates.status === "loading" ? <p className="rfc-privacy" aria-busy="true">{copy.candidatesLoading}</p> : null}
      {candidates.status === "error" ? <p className="rfc-privacy" role="alert">{copy.candidatesError}</p> : null}
      {candidates.status === "ready" && candidates.items.length === 0 ? (
        <p className="rfc-privacy">{copy.candidatesEmpty}</p>
      ) : null}
      {candidates.status === "ready" && candidates.items.length > 0 ? (
        <div className="rfc-table-wrap">
          <table className="rfc-table">
            <thead><tr><th>{copy.candidateId}</th><th>{copy.status}</th><th>{copy.registeredAt}</th></tr></thead>
            <tbody>
              {candidates.items.map((candidate) => (
                <tr key={candidate.displayId}>
                  <td data-label={copy.candidateId}>{candidate.displayId}</td>
                  <td data-label={copy.status}><span className="rfc-status is-pending">{copy.candidates}</span></td>
                  <td data-label={copy.registeredAt}>{new Date(candidate.createdAt).toLocaleString(copy.dateLocale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {candidates.status === "ready" && (candidates.page > 1 || candidates.hasMore) ? (
        <div className="rfc-candidate-pages">
          <button type="button" className="rfc-mini" disabled={candidates.page === 1} onClick={() => onPageChange?.(candidates.page - 1)}>{copy.prevPage}</button>
          <span>{copy.pageNumber(candidates.page)}</span>
          <button type="button" className="rfc-mini" disabled={!candidates.hasMore} onClick={() => onPageChange?.(candidates.page + 1)}>{copy.nextPage}</button>
        </div>
      ) : null}
    </section>
  );
}

function RecordsPanel({ tab, data }: { tab: TabKey; data: ReferralCenterData }) {
  const copy = useT().referral.records;
  if (data.status === "loading") {
    return (
      <div aria-busy="true">
        <span className="rfc-skeleton is-row" /><span className="rfc-skeleton is-row" /><span className="rfc-skeleton is-row" />
      </div>
    );
  }
  if (data.status === "error") {
    return (
      <div className="rfc-notice" role="alert">
        <h3>{copy.errorTitle}</h3>
        <p>{copy.errorBody}</p>
      </div>
    );
  }
  if (data.status === "pending") {
    return (
      <div className="rfc-notice">
        <h3>{tab === "customers" ? copy.customersPendingTitle : copy.commissionPendingTitle}</h3>
        <p>{tab === "customers" ? copy.customersPendingBody : copy.commissionPendingBody}</p>
      </div>
    );
  }
  if (tab === "commission") return <CommissionPanel snapshot={data.snapshot} />;
  if (tab === "customers") return <CustomersPanel snapshot={data.snapshot} />;
  return <SettlementPanel snapshot={data.snapshot} />;
}

function CommissionPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  const referralCopy = useT().referral;
  const copy = referralCopy.records;
  const months = ordersMonths(snapshot.orders);
  const [filter, setFilter] = useState<string>(snapshot.month);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<ReferralOrder | null>(null);
  const rowIdBase = useId();

  if (snapshot.orders.length === 0) {
    return (
      <div className="rfc-notice">
        <h3>{copy.noOrdersTitle}</h3>
        <p>{copy.noOrdersBody}</p>
      </div>
    );
  }

  const activeFilter = filter === ALL_MONTHS || months.includes(filter) ? filter : months[0];
  const filterModel = monthFilterModel(months, { year: referralCopy.yearLabel, month: referralCopy.monthLabel });
  const groups = groupOrders(snapshot.orders, activeFilter);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className="rfc-filter">
        <span className="rfc-filter-label">{filterModel.yearLabel ?? copy.monthFilter}</span>
        <div className="rfc-filter-options" role="group" aria-label={copy.monthFilterLabel}>
          <button type="button" className="rfc-chip" aria-pressed={activeFilter === ALL_MONTHS} onClick={() => setFilter(ALL_MONTHS)}>{copy.all}</button>
          {filterModel.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="rfc-chip"
              aria-pressed={activeFilter === option.value}
              aria-label={option.ariaLabel}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rfc-table-wrap">
        <table className="rfc-table">
          <colgroup>
            <col style={{ width: "34%" }} /><col style={{ width: "20%" }} /><col style={{ width: "14%" }} />
            <col style={{ width: "11%" }} /><col style={{ width: "14%" }} /><col style={{ width: "7%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>{copy.colCustomer}</th><th>{copy.status}</th><th className="is-num">{copy.colAmount}</th>
              <th className="is-num">{copy.colRate}</th><th className="is-num">{copy.colCommission}</th><th className="is-act">{copy.colDetail}</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.month}>
              <tr className="rfc-group">
                <td colSpan={6}>
                  {group.month}
                  <span>{group.month === snapshot.month ? copy.currentMonth : copy.pastMonth}</span>
                </td>
              </tr>
              {group.orders.map((order) => {
                const rowId = `${rowIdBase}-${order.id}`;
                const isOpen = expanded.has(order.id);
                return [
                  <OrderRow key={order.id} order={order} rowId={rowId} open={isOpen} onToggle={() => toggle(order.id)} />,
                  <tr key={`${order.id}-detail`} className="rfc-detail-row" id={rowId} hidden={!isOpen}>
                    <td colSpan={6}>
                      <OrderDetail order={order} snapshot={snapshot} />
                      <div className="rfc-detail-actions">
                        <button type="button" className="rfc-mini" onClick={() => setDetail(order)}>{copy.openPanel}</button>
                      </div>
                    </td>
                  </tr>,
                ];
              })}
              <tr className="rfc-sum">
                <td className="rfc-sum-title" colSpan={2}>{copy.total(group.month)}</td>
                <td className="is-num" data-label={copy.amountTotal}>{formatYuan(group.amountTotal)}</td>
                <td className="is-num is-empty-cell" />
                <td className="is-num" data-label={copy.commissionTotal}>{group.commissionTotal === null ? referralCopy.pending : formatYuan(group.commissionTotal)}</td>
                <td className="is-act is-empty-cell" />
              </tr>
            </tbody>
          ))}
        </table>
      </div>

      {snapshot.original ? (
        <p className="rfc-adjust-note">
          <b>{copy.adjustTitle}</b>{copy.adjustBody(
            formatYuan(snapshot.original.sales),
            referralCopy.tierNames[snapshot.original.tierName] ?? snapshot.original.tierName,
            snapshot.original.rate,
            formatYuan(snapshot.original.commission),
            formatYuan(snapshot.original.refund),
            formatYuan(snapshot.sales),
            snapshot.estimate === "unknown" ? referralCopy.pending : formatYuan(snapshot.estimate),
            formatYuan(snapshot.original.adjustment),
          )}
        </p>
      ) : null}

      <ReferralDialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail ? `${detail.adjustment ? copy.adjustRecord : copy.commissionDetail} · ${detail.month}` : copy.commissionDetail}
        title={detail ? detail.product : copy.commissionDetail}
      >
        {detail ? <OrderDialogBody order={detail} snapshot={snapshot} /> : null}
      </ReferralDialog>
    </>
  );
}

function OrderRow({ order, rowId, open, onToggle }: { order: ReferralOrder; rowId: string; open: boolean; onToggle: () => void }) {
  const referralCopy = useT().referral;
  const copy = referralCopy.records;
  return (
    <tr className={order.adjustment ? "rfc-adjust" : undefined}>
      <td className="rfc-cell-primary" data-label={copy.colCustomer}>
        <span className="rfc-cell-main">{order.customer}</span>
        <span className="rfc-cell-sub">{order.product} · {order.type}{order.refunded ? copy.refunded : ""}</span>
      </td>
      <td data-label={copy.status}>
        <span className={`rfc-status${statusClass(order.status)}`}>{statusText(referralCopy, order.status)}</span>
        {order.hint ? <span className="rfc-status-hint">{order.hint}</span> : null}
      </td>
      <td className="is-num" data-label={copy.colAmount}>
        <span className={order.amount < 0 ? "rfc-amount-neg" : undefined}>{formatYuan(order.amount)}</span>
      </td>
      <td className="is-num" data-label={copy.colRate}>
        {rateText(referralCopy, order.rate)}
        {order.capped ? <span className="rfc-rate-cap">{copy.capped}</span> : null}
      </td>
      <td className="is-num" data-label={copy.colCommission}>
        {order.commission === null
          ? referralCopy.pending
          : <span className={order.commission < 0 ? "rfc-amount-neg" : undefined}>{formatYuan(order.commission)}</span>}
      </td>
      <td className="is-act">
        <button
          type="button"
          className="rfc-expand"
          aria-expanded={open}
          aria-controls={rowId}
          aria-label={copy.expand(order.product)}
          onClick={onToggle}
        >
          <span className="rfc-expand-label">{copy.calcDetail}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </td>
    </tr>
  );
}

function calculation(order: ReferralOrder, snapshot: ReferralSnapshot, referralCopy: ReferralCopy): { code: string; note: string } {
  const copy: RecordsCopy = referralCopy.records;
  const formatRate = (rate: number | null) => rateText(referralCopy, rate);
  if (order.commission === null) {
    return {
      code: copy.calcBelowCode(formatYuan(snapshot.sales)),
      note: copy.calcBelowNote,
    };
  }
  if (order.adjustment) {
    const adjustment = order.adjustment;
    return {
      code: `${formatYuan(adjustment.original)} − ${formatYuan(adjustment.recalculated)} = ${formatYuan(Math.abs(order.commission))}`,
      note: copy.calcAdjustNote,
    };
  }
  return {
    code: `${formatYuan(order.amount)} × ${formatRate(order.rate)} = ${formatYuan(order.commission)}`,
    note: copy.calcRateNote(formatRate(order.tierRate), formatRate(order.cap), formatRate(order.rate)),
  };
}

function OrderDetail({ order, snapshot }: { order: ReferralOrder; snapshot: ReferralSnapshot }) {
  const referralCopy = useT().referral;
  const copy = referralCopy.records;
  const calc = calculation(order, snapshot, referralCopy);
  return (
    <>
      <dl className="rfc-detail-grid">
        <div><dt>{copy.orderNo}</dt><dd>{order.id}</dd></div>
        <div><dt>{copy.month}</dt><dd>{order.month}</dd></div>
        <div><dt>{copy.tierApplied}</dt><dd>{tierText(referralCopy, order.tierName, order.tierRate)}</dd></div>
        <div><dt>{copy.cap}</dt><dd>{order.cap === null ? "—" : rateText(referralCopy, order.cap)}</dd></div>
      </dl>
      <div className="rfc-detail-calc"><code>{calc.code}</code><p>{calc.note}</p></div>
      {order.note ? <div className="rfc-detail-calc"><p>{order.note}</p></div> : null}
    </>
  );
}

function OrderDialogBody({ order, snapshot }: { order: ReferralOrder; snapshot: ReferralSnapshot }) {
  const referralCopy = useT().referral;
  const copy = referralCopy.records;
  const calc = calculation(order, snapshot, referralCopy);
  const warn = Boolean(order.adjustment || order.refunded);
  return (
    <>
      <dl className="rfc-facts">
        <div><dt>{copy.orderMonth}</dt><dd>{order.month}</dd></div>
        <div><dt>{copy.orderNo}</dt><dd>{order.id}</dd></div>
        <div><dt>{copy.customerMasked}</dt><dd>{order.customer}<small>{copy.customerMaskedNote}</small></dd></div>
        <div><dt>{copy.type}</dt><dd>{order.type}</dd></div>
        <div><dt>{copy.effectiveAmount}</dt><dd>{formatYuan(order.amount)}</dd></div>
        <div><dt>{copy.tierApplied}</dt><dd>{tierText(referralCopy, order.tierName, order.tierRate)}</dd></div>
        <div><dt>{copy.cap}</dt><dd>{order.cap === null ? "—" : rateText(referralCopy, order.cap)}</dd></div>
        <div><dt>{copy.actualRate}</dt><dd>{rateText(referralCopy, order.rate)}{order.capped ? <small>{copy.cappedNote}</small> : null}</dd></div>
        <div><dt>{copy.colCommission}</dt><dd>{order.commission === null ? referralCopy.pending : formatYuan(order.commission)}</dd></div>
        <div><dt>{copy.ledgerStatus}</dt><dd>{statusText(referralCopy, order.status)}{order.hint ? <small>{order.hint}</small> : null}</dd></div>
      </dl>
      <div className="rfc-calc"><b>{order.adjustment ? copy.calcAdjust : order.commission === null ? copy.calcExplain : copy.calcProcess}</b><code>{calc.code}</code><p>{calc.note}</p></div>
      <div className={`rfc-block${warn ? " is-warn" : ""}`}>
        <h3>{copy.adjustNotes}</h3>
        <p>{order.note ?? copy.noAdjust}</p>
      </div>
      <div className="rfc-block">
        <h3>{copy.statusMeaning}</h3>
        <p>{copy.statusMeaningBody}</p>
      </div>
    </>
  );
}

function CustomersPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  const copy = useT().referral.records;
  if (snapshot.customers.length === 0) {
    return (
      <div className="rfc-notice">
        <h3>{copy.noCustomersTitle}</h3>
        <p>{copy.noCustomersBody}</p>
      </div>
    );
  }
  return (
    <>
      <div className="rfc-table-wrap">
        <table className="rfc-table">
          <colgroup>
            <col style={{ width: "32%" }} /><col style={{ width: "22%" }} /><col style={{ width: "16%" }} />
            <col style={{ width: "17%" }} /><col style={{ width: "13%" }} />
          </colgroup>
          <thead>
            <tr><th>{copy.customerMasked}</th><th>{copy.demoSince}</th><th>{copy.demoStatus}</th><th className="is-num">{copy.monthSpend}</th><th className="is-num">{copy.monthOrders}</th></tr>
          </thead>
          <tbody>
            {snapshot.customers.map((customer) => (
              <tr key={customer.id}>
                <td className="rfc-cell-primary" data-label={copy.customerMasked}>
                  <span className="rfc-cell-main">{customer.id}</span>
                  {customer.hint ? <span className="rfc-cell-sub">{customer.hint}</span> : null}
                </td>
                <td data-label={copy.demoSince}>{customer.since}</td>
                <td data-label={copy.demoStatus}><span className="rfc-status is-ok">{copy.synthetic}</span></td>
                <td className="is-num" data-label={copy.monthSpend}>{formatYuan(customer.monthAmount)}</td>
                <td className="is-num" data-label={copy.monthOrders}>{customer.monthOrders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rfc-privacy">{copy.customersPrivacy}</p>
    </>
  );
}

function SettlementPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  const referralCopy = useT().referral;
  const copy = referralCopy.records;
  const { ledger, periods } = snapshot;
  return (
    <>
      <div className="rfc-ledger">
        <article><span className="rfc-ledger-label">{referralCopy.settledBalance}</span><Money fen={ledger.withdrawable} size="md" /><small>{copy.ledgerSettledNote(formatYuan(WITHDRAW_MIN_FEN))}</small></article>
        <article><span className="rfc-ledger-label">{referralCopy.pendingSettlement}</span><Money fen={ledger.pending} size="md" /><small>{copy.ledgerPendingNote}</small></article>
        <article><span className="rfc-ledger-label">{referralCopy.withdrawn}</span><Money fen={ledger.withdrawn} size="md" /><small>{copy.ledgerWithdrawnNote}</small></article>
        <article>
          <span className="rfc-ledger-label">{copy.ledgerEstimate}</span>
          {snapshot.estimate === "unknown" ? <span className="rfc-plain">{referralCopy.pending}</span> : <Money fen={snapshot.estimate} size="md" />}
          <small>{copy.ledgerEstimateNote}</small>
        </article>
      </div>
      {periods.length === 0 ? (
        <div className="rfc-notice"><h3>{copy.noPeriodsTitle}</h3><p>{copy.noPeriodsBody}</p></div>
      ) : (
        <div className="rfc-table-wrap">
          <table className="rfc-table">
            <colgroup>
              <col style={{ width: "14%" }} /><col style={{ width: "19%" }} /><col style={{ width: "20%" }} />
              <col style={{ width: "17%" }} /><col style={{ width: "30%" }} />
            </colgroup>
            <thead>
              <tr><th>{copy.period}</th><th className="is-num">{referralCopy.effectiveSales}</th><th>{copy.periodTier}</th><th className="is-num">{copy.colCommission}</th><th>{copy.ledgerStatus}</th></tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.month}>
                  <td data-label={copy.period}>{period.month}</td>
                  <td className="is-num" data-label={referralCopy.effectiveSales}>{formatYuan(period.sales)}</td>
                  <td data-label={copy.periodTier}>{tierText(referralCopy, period.tierName, period.rate)}</td>
                  <td className="is-num" data-label={copy.colCommission}>{period.commission === null ? referralCopy.pending : formatYuan(period.commission)}</td>
                  <td data-label={copy.ledgerStatus}>
                    <span className={`rfc-status${statusClass(period.status)}`}>{statusText(referralCopy, period.status)}</span>
                    {period.hint ? <span className="rfc-status-hint">{period.hint}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rfc-withdraw-row">
        <p>{copy.withdrawRule(formatYuan(WITHDRAW_MIN_FEN))}</p>
        <WithdrawButton balance={ledger.withdrawable} />
      </div>
    </>
  );
}
