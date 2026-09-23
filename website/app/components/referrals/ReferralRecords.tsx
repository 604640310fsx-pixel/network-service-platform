import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ALL_MONTHS,
  WITHDRAW_MIN_FEN,
  formatRate,
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
import { ReferralDialog } from "./ReferralDialog";
import { Money, WithdrawButton } from "./referralParts";

type TabKey = "commission" | "customers" | "settlement";
const TABS: readonly { key: TabKey; label: string }[] = [
  { key: "commission", label: "佣金明细" },
  { key: "customers", label: "推荐客户" },
  { key: "settlement", label: "结算与提现" },
];

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
      <div className="rfc-tablist" role="tablist" aria-label="记录分类">
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
            {item.label}
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
  return (
    <section className="rfc-candidates" aria-label="待确认推荐">
      <h3>待确认推荐</h3>
      <p className="rfc-privacy">仅表示推荐注册候选，尚未建立正式客户归属，不计入月销、等级、佣金或余额。</p>
      {candidates.status === "pending" ? <p className="rfc-privacy">候选记录尚未接入。</p> : null}
      {candidates.status === "loading" ? <p className="rfc-privacy" aria-busy="true">正在读取候选记录…</p> : null}
      {candidates.status === "error" ? <p className="rfc-privacy" role="alert">候选记录读取失败，请重试。</p> : null}
      {candidates.status === "ready" && candidates.items.length === 0 ? (
        <p className="rfc-privacy">暂无待确认推荐。</p>
      ) : null}
      {candidates.status === "ready" && candidates.items.length > 0 ? (
        <div className="rfc-table-wrap">
          <table className="rfc-table">
            <thead><tr><th>推荐标识</th><th>状态</th><th>注册时间</th></tr></thead>
            <tbody>
              {candidates.items.map((candidate) => (
                <tr key={candidate.displayId}>
                  <td data-label="推荐标识">{candidate.displayId}</td>
                  <td data-label="状态"><span className="rfc-status is-pending">待确认推荐</span></td>
                  <td data-label="注册时间">{new Date(candidate.createdAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {candidates.status === "ready" && (candidates.page > 1 || candidates.hasMore) ? (
        <div className="rfc-candidate-pages">
          <button type="button" className="rfc-mini" disabled={candidates.page === 1} onClick={() => onPageChange?.(candidates.page - 1)}>上一页</button>
          <span>第 {candidates.page} 页</span>
          <button type="button" className="rfc-mini" disabled={!candidates.hasMore} onClick={() => onPageChange?.(candidates.page + 1)}>下一页</button>
        </div>
      ) : null}
    </section>
  );
}

function RecordsPanel({ tab, data }: { tab: TabKey; data: ReferralCenterData }) {
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
        <h3>暂时无法读取记录</h3>
        <p>读取失败与“暂无记录”不同：失败时不显示空列表或 ¥0.00，也不会回退到任何示例数据。</p>
      </div>
    );
  }
  if (data.status === "pending") {
    return (
      <div className="rfc-notice">
        <h3>{tab === "customers" ? "正式客户记录尚未接入" : "正式佣金与结算记录尚未接入"}</h3>
        <p>{tab === "customers"
          ? "上方展示待确认推荐候选；正式客户归属仍待确认。"
          : "正式金额尚未接入，此处显示“—”而不是 0。"}</p>
      </div>
    );
  }
  if (tab === "commission") return <CommissionPanel snapshot={data.snapshot} />;
  if (tab === "customers") return <CustomersPanel snapshot={data.snapshot} />;
  return <SettlementPanel snapshot={data.snapshot} />;
}

function CommissionPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  const months = ordersMonths(snapshot.orders);
  const [filter, setFilter] = useState<string>(snapshot.month);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<ReferralOrder | null>(null);
  const rowIdBase = useId();

  if (snapshot.orders.length === 0) {
    return (
      <div className="rfc-notice">
        <h3>本月暂无有效订单</h3>
        <p>这是真实零记录：账户可正常推荐，但本月尚无计入有效月销的消费。</p>
      </div>
    );
  }

  const activeFilter = filter === ALL_MONTHS || months.includes(filter) ? filter : months[0];
  const filterModel = monthFilterModel(months);
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
        <span className="rfc-filter-label">{filterModel.yearLabel ?? "所属月份"}</span>
        <div className="rfc-filter-options" role="group" aria-label="按所属月份筛选">
          <button type="button" className="rfc-chip" aria-pressed={activeFilter === ALL_MONTHS} onClick={() => setFilter(ALL_MONTHS)}>全部</button>
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
              <th>客户与商品</th><th>状态</th><th className="is-num">计佣金额</th>
              <th className="is-num">实际比例</th><th className="is-num">佣金</th><th className="is-act">详情</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.month}>
              <tr className="rfc-group">
                <td colSpan={6}>
                  {group.month}
                  <span>{group.month === snapshot.month ? "本月 · 预估" : "历史月份 · 按当期等级"}</span>
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
                        <button type="button" className="rfc-mini" onClick={() => setDetail(order)}>在面板中查看完整详情</button>
                      </div>
                    </td>
                  </tr>,
                ];
              })}
              <tr className="rfc-sum">
                <td className="rfc-sum-title" colSpan={2}>合计 · {group.month}</td>
                <td className="is-num" data-label="计佣金额合计">{formatYuan(group.amountTotal)}</td>
                <td className="is-num is-empty-cell" />
                <td className="is-num" data-label="佣金合计">{group.commissionTotal === null ? "待确认" : formatYuan(group.commissionTotal)}</td>
                <td className="is-act is-empty-cell" />
              </tr>
            </tbody>
          ))}
        </table>
      </div>

      {snapshot.original ? (
        <p className="rfc-adjust-note">
          <b>退款调整（保留原记录）</b>　原有效月销 {formatYuan(snapshot.original.sales)}（{snapshot.original.tierName} {snapshot.original.rate}%）
          原预估佣金 {formatYuan(snapshot.original.commission)}；退款 {formatYuan(snapshot.original.refund)} 后有效月销 {formatYuan(snapshot.sales)}，
          佣金 {snapshot.estimate === "unknown" ? "待确认" : formatYuan(snapshot.estimate)}，调整差额 {formatYuan(snapshot.original.adjustment)}。
          原始订单记录不删除，差额以独立调整记录呈现。
        </p>
      ) : null}

      <ReferralDialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail ? `${detail.adjustment ? "调整记录" : "佣金详情"} · ${detail.month}` : "佣金详情"}
        title={detail ? detail.product : "佣金详情"}
      >
        {detail ? <OrderDialogBody order={detail} snapshot={snapshot} /> : null}
      </ReferralDialog>
    </>
  );
}

function OrderRow({ order, rowId, open, onToggle }: { order: ReferralOrder; rowId: string; open: boolean; onToggle: () => void }) {
  return (
    <tr className={order.adjustment ? "rfc-adjust" : undefined}>
      <td className="rfc-cell-primary" data-label="客户与商品">
        <span className="rfc-cell-main">{order.customer}</span>
        <span className="rfc-cell-sub">{order.product} · {order.type}{order.refunded ? " · 已退款" : ""}</span>
      </td>
      <td data-label="状态">
        <span className={`rfc-status${statusClass(order.status)}`}>{order.status}</span>
        {order.hint ? <span className="rfc-status-hint">{order.hint}</span> : null}
      </td>
      <td className="is-num" data-label="计佣金额">
        <span className={order.amount < 0 ? "rfc-amount-neg" : undefined}>{formatYuan(order.amount)}</span>
      </td>
      <td className="is-num" data-label="实际比例">
        {formatRate(order.rate)}
        {order.capped ? <span className="rfc-rate-cap">按商品上限</span> : null}
      </td>
      <td className="is-num" data-label="佣金">
        {order.commission === null
          ? "待确认"
          : <span className={order.commission < 0 ? "rfc-amount-neg" : undefined}>{formatYuan(order.commission)}</span>}
      </td>
      <td className="is-act">
        <button
          type="button"
          className="rfc-expand"
          aria-expanded={open}
          aria-controls={rowId}
          aria-label={`展开「${order.product}」的计算详情`}
          onClick={onToggle}
        >
          <span className="rfc-expand-label">计算详情</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </td>
    </tr>
  );
}

function calculation(order: ReferralOrder, snapshot: ReferralSnapshot): { code: string; note: string } {
  if (order.commission === null) {
    return {
      code: `月销 ${formatYuan(snapshot.sales)} < ¥59.00 → 计佣方式待确认`,
      note: "低于 ¥59 的计佣方式尚未最终确认，因此不展示推测金额，也不按 0% 或 10% 处理。",
    };
  }
  if (order.adjustment) {
    const adjustment = order.adjustment;
    return {
      code: `${formatYuan(adjustment.original)} − ${formatYuan(adjustment.recalculated)} = ${formatYuan(Math.abs(order.commission))}`,
      note: "此处为隔离预览的合成调整示例；正式退款调整方式待确认。",
    };
  }
  return {
    code: `${formatYuan(order.amount)} × ${formatRate(order.rate)} = ${formatYuan(order.commission)}`,
    note: `实际比例 = min（当期等级 ${formatRate(order.tierRate)}，商品上限 ${formatRate(order.cap)}） = ${formatRate(order.rate)}。` +
      "历史订单保留当期等级，不套用其他月份的比例。",
  };
}

function OrderDetail({ order, snapshot }: { order: ReferralOrder; snapshot: ReferralSnapshot }) {
  const calc = calculation(order, snapshot);
  return (
    <>
      <dl className="rfc-detail-grid">
        <div><dt>订单号</dt><dd>{order.id}</dd></div>
        <div><dt>所属月份</dt><dd>{order.month}</dd></div>
        <div><dt>该期适用等级</dt><dd>{order.tierName ? `${order.tierName} ${formatRate(order.tierRate)}` : "待确认"}</dd></div>
        <div><dt>该单商品上限</dt><dd>{order.cap === null ? "—" : formatRate(order.cap)}</dd></div>
      </dl>
      <div className="rfc-detail-calc"><code>{calc.code}</code><p>{calc.note}</p></div>
      {order.note ? <div className="rfc-detail-calc"><p>{order.note}</p></div> : null}
    </>
  );
}

function OrderDialogBody({ order, snapshot }: { order: ReferralOrder; snapshot: ReferralSnapshot }) {
  const calc = calculation(order, snapshot);
  const warn = Boolean(order.adjustment || order.refunded);
  return (
    <>
      <dl className="rfc-facts">
        <div><dt>订单所属月份</dt><dd>{order.month}</dd></div>
        <div><dt>订单号</dt><dd>{order.id}</dd></div>
        <div><dt>客户（脱敏）</dt><dd>{order.customer}<small>不含姓名、联系方式或交付配置</small></dd></div>
        <div><dt>类型</dt><dd>{order.type}</dd></div>
        <div><dt>有效计佣金额</dt><dd>{formatYuan(order.amount)}</dd></div>
        <div><dt>该期适用等级</dt><dd>{order.tierName ? `${order.tierName} ${formatRate(order.tierRate)}` : "待确认"}</dd></div>
        <div><dt>该单商品上限</dt><dd>{order.cap === null ? "—" : formatRate(order.cap)}</dd></div>
        <div><dt>实际返佣比例</dt><dd>{formatRate(order.rate)}{order.capped ? <small>受商品上限约束</small> : null}</dd></div>
        <div><dt>佣金</dt><dd>{order.commission === null ? "待确认" : formatYuan(order.commission)}</dd></div>
        <div><dt>账务状态</dt><dd>{order.status}{order.hint ? <small>{order.hint}</small> : null}</dd></div>
      </dl>
      <div className="rfc-calc"><b>{order.adjustment ? "调整计算" : order.commission === null ? "计算说明" : "计算过程"}</b><code>{calc.code}</code><p>{calc.note}</p></div>
      <div className={`rfc-block${warn ? " is-warn" : ""}`}>
        <h3>调整与说明</h3>
        <p>{order.note ?? "无调整记录。"}</p>
      </div>
      <div className="rfc-block">
        <h3>状态含义</h3>
        <p>“预估”只是准确性提示，不是新的账务状态。账务状态仍为待结算 → 可提现 → 已提现；退款与拒付以调整记录解释，不会把已支付历史改写成从未支付。</p>
      </div>
    </>
  );
}

function CustomersPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  if (snapshot.customers.length === 0) {
    return (
      <div className="rfc-notice">
        <h3>暂无推荐客户</h3>
        <p>这是真实空列表：还没有客户通过你的推荐完成首次有效成交。</p>
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
            <tr><th>客户（脱敏）</th><th>演示记录时间</th><th>演示状态</th><th className="is-num">本月有效消费</th><th className="is-num">本月订单数</th></tr>
          </thead>
          <tbody>
            {snapshot.customers.map((customer) => (
              <tr key={customer.id}>
                <td className="rfc-cell-primary" data-label="客户（脱敏）">
                  <span className="rfc-cell-main">{customer.id}</span>
                  {customer.hint ? <span className="rfc-cell-sub">{customer.hint}</span> : null}
                </td>
                <td data-label="演示记录时间">{customer.since}</td>
                <td data-label="演示状态"><span className="rfc-status is-ok">合成示例</span></td>
                <td className="is-num" data-label="本月有效消费">{formatYuan(customer.monthAmount)}</td>
                <td className="is-num" data-label="本月订单数">{customer.monthOrders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rfc-privacy">列表只包含返佣所需的最小信息，不展示姓名、手机号、邮箱、真实资源、节点或交付配置。</p>
    </>
  );
}

function SettlementPanel({ snapshot }: { snapshot: ReferralSnapshot }) {
  const { ledger, periods } = snapshot;
  return (
    <>
      <div className="rfc-ledger">
        <article><span className="rfc-ledger-label">已结算佣金余额</span><Money fen={ledger.withdrawable} size="md" /><small>仅来自已结算期间；达 {formatYuan(WITHDRAW_MIN_FEN)} 才可申请提现</small></article>
        <article><span className="rfc-ledger-label">待结算</span><Money fen={ledger.pending} size="md" /><small>已核算、观察期中；不计入佣金余额</small></article>
        <article><span className="rfc-ledger-label">已提现</span><Money fen={ledger.withdrawn} size="md" /><small>历史已完成提现</small></article>
        <article>
          <span className="rfc-ledger-label">本月预估（另计）</span>
          {snapshot.estimate === "unknown" ? <span className="rfc-plain">待确认</span> : <Money fen={snapshot.estimate} size="md" />}
          <small>月末核算后才可能进入待结算，不计入佣金余额</small>
        </article>
      </div>
      {periods.length === 0 ? (
        <div className="rfc-notice"><h3>暂无结算记录</h3><p>这是真实零记录：还没有进入月度核算的期间。</p></div>
      ) : (
        <div className="rfc-table-wrap">
          <table className="rfc-table">
            <colgroup>
              <col style={{ width: "14%" }} /><col style={{ width: "19%" }} /><col style={{ width: "20%" }} />
              <col style={{ width: "17%" }} /><col style={{ width: "30%" }} />
            </colgroup>
            <thead>
              <tr><th>期间</th><th className="is-num">有效月销</th><th>当期等级</th><th className="is-num">佣金</th><th>账务状态</th></tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.month}>
                  <td data-label="期间">{period.month}</td>
                  <td className="is-num" data-label="有效月销">{formatYuan(period.sales)}</td>
                  <td data-label="当期等级">{period.tierName ? `${period.tierName} ${formatRate(period.rate)}` : "待确认"}</td>
                  <td className="is-num" data-label="佣金">{period.commission === null ? "待确认" : formatYuan(period.commission)}</td>
                  <td data-label="账务状态">
                    <span className={`rfc-status${statusClass(period.status)}`}>{period.status}</span>
                    {period.hint ? <span className="rfc-status-hint">{period.hint}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rfc-withdraw-row">
        <p>
          已结算佣金余额达到 {formatYuan(WITHDRAW_MIN_FEN)} 才具备申请提现资格；本月预估与待结算不计入。
          不申请则留在佣金余额，不会自动转出。提现功能待接入。结算天数与观察期仍待批准。
        </p>
        <WithdrawButton balance={ledger.withdrawable} />
      </div>
    </>
  );
}
