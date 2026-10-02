import { useState } from "react";
import {
  ENTRY_THRESHOLD_FEN,
  REFERRAL_DATA_PENDING,
  REFERRAL_LINK_PENDING,
  REFERRAL_TIERS,
  WITHDRAW_MIN_FEN,
  copyReferralLink,
  formatYuan,
  formatYuanWhole,
  levelProgress,
  tierOf,
  withdrawalGate,
  type ClipboardWriter,
  type CopyOutcome,
  type ReferralCenterData,
  type ReferralCandidatesState,
  type ReferralLinkState,
} from "./referralModel";
import { useT, type Messages } from "../../lib/i18n";
import { ReferralDialog } from "./ReferralDialog";
import { ReferralRecords, nextTabIndex } from "./ReferralRecords";
import { Money, WithdrawButton, useInfoToggle } from "./referralParts";
import "./referral-center.css";

/* 推荐返佣中心（正式组件）。
   - 放在 CustomerCenterShell 内使用；本组件不注册路由、不修改导航。
   - 生产默认：data / link 均为 pending，只显示“—”与待接入占位，不发起任何请求。
   - 数据由调用方注入；隔离 fixture 只存在于 ./preview 与测试中。 */

export type ReferralCenterNotice = "pending" | "fixture";

export type ReferralCenterProps = {
  readonly data?: ReferralCenterData;
  readonly candidates?: ReferralCandidatesState;
  readonly onCandidatePageChange?: (page: number) => void;
  readonly link?: ReferralLinkState;
  /** 未传入时在点击时读取 navigator.clipboard；传 null 表示当前环境不可写入。 */
  readonly clipboard?: ClipboardWriter | null;
  readonly notice?: ReferralCenterNotice;
  readonly onRetry?: () => void;
};

// 仅供开发预览页使用的中文标题；正式路由的标题由 DashboardShell 的 i18n 页面标题提供。
export { REFERRAL_CENTER_DESCRIPTION, REFERRAL_CENTER_TITLE } from "./referralModel";

type ReferralCopy = Messages["referral"];

function tierLabel(copy: ReferralCopy, name: string): string {
  return copy.tierNames[name] ?? name;
}

export function ReferralCenter({
  data = REFERRAL_DATA_PENDING,
  candidates = { status: "pending" },
  onCandidatePageChange,
  link = REFERRAL_LINK_PENDING,
  clipboard,
  notice = "pending",
  onRetry,
}: ReferralCenterProps) {
  const [strategicOpen, setStrategicOpen] = useState(false);
  const copy = useT().referral;

  return (
    <main className="rfc-page">
      <div className="rfc-layout">
        <PageNotice variant={notice} />

        <section className="rfc-hero" aria-label={copy.heroLabel}>
          <div className="rfc-hero-grid">
            <EarningsCards data={data} onRetry={onRetry} />
          </div>
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-share-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title">
              <h2 id="rfc-share-title">{copy.shareTitle}</h2>
              {notice === "fixture" ? <span className="rfc-tag">{copy.fixtureLinkTag}</span> : null}
            </div>
            <p>{copy.shareLead}</p>
          </div>
          <ShareCard link={link} dataStatus={data.status} clipboard={clipboard} />
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-level-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title">
              <h2 id="rfc-level-title">{copy.levelTitle}</h2>
              <span className="rfc-tag">{copy.officialRates}</span>
            </div>
            <p>{copy.levelLead}</p>
          </div>
          <LevelCard data={data} />
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-records-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title"><h2 id="rfc-records-title">{copy.recordsTitle}</h2></div>
            <p>{copy.recordsLead}</p>
          </div>
          <ReferralRecords data={data} candidates={candidates} onCandidatePageChange={onCandidatePageChange} />
        </section>

        <div className="rfc-bottom">
          <div className="rfc-bottom-grid">
            <section className="rfc-sec" aria-labelledby="rfc-strategic-title">
              <div className="rfc-sec-head">
                <div className="rfc-sec-title">
                  <h2 id="rfc-strategic-title">{copy.strategicTitle}</h2>
                  <span className="rfc-tag">{copy.strategicTag}</span>
                </div>
              </div>
              <div className="rfc-card rfc-strategic">
                <p className="rfc-strategic-kicker">{copy.strategicKicker}</p>
                <p className="rfc-strategic-title">{copy.strategicName}<em>{copy.ratePending}</em></p>
                <p className="rfc-strategic-lead">{copy.strategicLead}</p>
                <ul className="rfc-points">
                  {copy.strategicPoints.map((point) => <li key={point.title}><b>{point.title}</b><span>{point.body}</span></li>)}
                </ul>
                <div className="rfc-strategic-foot">
                  <p>{copy.strategicFoot}</p>
                  <button type="button" className="rfc-ghost" onClick={() => setStrategicOpen(true)}>{copy.strategicMore}</button>
                </div>
              </div>
            </section>

            <section className="rfc-sec" aria-labelledby="rfc-faq-title">
              <div className="rfc-sec-head">
                <div className="rfc-sec-title">
                  <h2 id="rfc-faq-title">{copy.faqTitle}</h2>
                  <span className="rfc-tag">{copy.faqTag}</span>
                </div>
              </div>
              <FaqCard />
            </section>
          </div>
        </div>
      </div>

      <ReferralDialog
        open={strategicOpen}
        onClose={() => setStrategicOpen(false)}
        eyebrow={copy.strategicKicker}
        title={copy.dialogTitle}
        wide
      >
        <StrategicDialogBody />
      </ReferralDialog>
    </main>
  );
}

/* ---------------- 页首标识 ---------------- */

function PageNotice({ variant }: { variant: ReferralCenterNotice }) {
  const copy = useT().referral;
  const text = variant === "fixture" ? copy.noticeFixture : copy.noticePending;
  return (
    <details className="rfc-demo">
      <summary>
        {variant === "fixture"
          ? <span className="rfc-demo-mark">{copy.fixtureMark}</span>
          : <span className="rfc-demo-mark">{copy.pendingMark}</span>}
        <span className="rfc-demo-mark">{copy.keepPendingMark}</span>
        <span className="rfc-demo-toggle">{copy.explain}</span>
      </summary>
      <p>
        {text} {copy.noticeTail}
      </p>
    </details>
  );
}

/* ---------------- 收益：余额卡 + 本月卡 ---------------- */

function EarningsCards({ data, onRetry }: { data: ReferralCenterData; onRetry?: () => void }) {
  const copy = useT().referral;
  const cash = useInfoToggle(copy.settledBalance, copy.noteCash);
  const est = useInfoToggle(copy.monthEstimate, copy.noteEstimate);
  const snapshot = data.status === "ready" ? data.snapshot : null;
  const salesInfo = useInfoToggle(
    copy.effectiveSales,
    (snapshot ? copy.salesNoteMonth(snapshot.month) : "") + copy.salesNote,
  );
  const tierInfo = useInfoToggle(copy.currentTier, copy.noteTier);

  if (data.status === "loading") {
    return (
      <>
        <article className="rfc-card rfc-wallet" aria-busy="true">
          <div className="rfc-card-head"><span className="rfc-eyebrow">{copy.loading}</span></div>
          <div className="rfc-wallet-amount"><span className="rfc-skeleton is-hero" /></div>
          <div className="rfc-meter"><span className="rfc-skeleton is-line" /></div>
        </article>
        <article className="rfc-card rfc-month-card" aria-busy="true">
          <div className="rfc-card-head"><span className="rfc-eyebrow">{copy.loading}</span></div>
          <span className="rfc-skeleton is-value" /><span className="rfc-skeleton is-line" />
        </article>
      </>
    );
  }

  if (data.status === "error") {
    return (
      <article className="rfc-card rfc-card-error" role="alert">
        <div className="rfc-notice">
          <h3>{copy.errorTitle}</h3>
          <p>{copy.errorBody}</p>
          {onRetry ? (
            <div className="rfc-notice-actions">
              <button type="button" className="rfc-primary" onClick={onRetry}>{copy.reload}</button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const ledger = snapshot ? snapshot.ledger : null;
  const gate = ledger ? withdrawalGate(ledger.withdrawable) : null;
  const tier = snapshot ? tierOf(snapshot.sales) : null;

  return (
    <>
      <article className="rfc-card rfc-wallet" aria-label={copy.settledBalance}>
        <div className="rfc-card-head">
          <span className="rfc-eyebrow"><i className="rfc-dot" aria-hidden="true" />{copy.settledBalance}</span>
          {cash.button}
        </div>
        {cash.note}
        <div className="rfc-wallet-amount">
          {ledger ? <Money fen={ledger.withdrawable} size="hero" /> : <span className="rfc-plain is-hero">—</span>}
        </div>
        <div className="rfc-wallet-action"><WithdrawButton balance={ledger ? ledger.withdrawable : null} /></div>
        <div className="rfc-meter">
          <div
            className="rfc-meter-track"
            role="img"
            aria-label={ledger && gate
              ? gate.met
                ? copy.meterMet(formatYuan(ledger.withdrawable), formatYuan(WITHDRAW_MIN_FEN))
                : copy.meterShort(formatYuan(ledger.withdrawable), formatYuan(WITHDRAW_MIN_FEN), formatYuan(gate.shortfall))
              : copy.balancePending}
          >
            <i style={{ width: `${gate ? gate.fill.toFixed(2) : 0}%` }} />
          </div>
          <div className="rfc-meter-legend">
            {ledger && gate ? (
              gate.met
                ? <span>{copy.legendMetBefore}<b>{formatYuan(WITHDRAW_MIN_FEN)}</b>{copy.legendMetAfter}</span>
                : <span>{copy.legendShortBefore}<b>{formatYuan(gate.shortfall)}</b>{copy.legendShortAfter}</span>
            ) : (
              <span>{copy.balancePending}</span>
            )}
            <span>{copy.threshold(formatYuan(WITHDRAW_MIN_FEN))}</span>
          </div>
        </div>
        <dl className="rfc-kv is-quiet">
          <div><dt>{copy.pendingSettlement}</dt><dd>{ledger ? formatYuan(ledger.pending) : "—"}</dd></div>
          <div><dt>{copy.withdrawn}</dt><dd>{ledger ? formatYuan(ledger.withdrawn) : "—"}</dd></div>
        </dl>
      </article>

      <article className="rfc-card rfc-month-card" aria-label={copy.monthEstimateLabel}>
        <div className="rfc-card-head">
          <span className="rfc-eyebrow">{copy.monthEstimate}</span>
          {snapshot ? <span className="rfc-month-chip">{snapshot.month}</span> : null}
          {est.button}
        </div>
        {est.note}
        {!snapshot
          ? <span className="rfc-plain is-hero">—</span>
          : snapshot.estimate === "unknown"
            ? <span className="rfc-plain is-hero">{copy.pending}</span>
            : <Money fen={snapshot.estimate} size="lg" />}
        {snapshot ? (
          <span className="rfc-state">{snapshot.estimate === "unknown" ? copy.estimateUnknownState : copy.estimateState}</span>
        ) : (
          <span className="rfc-state">{copy.dataPending}</span>
        )}
        <div className="rfc-kv-gap" aria-hidden="true" />
        <dl className="rfc-kv">
          <div>
            <dt>{copy.effectiveSales} {salesInfo.button}</dt>
            <dd>
              {snapshot ? formatYuan(snapshot.sales) : "—"}
              {snapshot?.original ? <small>{copy.refundAdjusted}</small> : snapshot?.zero ? <small>{copy.zeroMonth}</small> : null}
            </dd>
          </div>
          <div>
            <dt>{copy.currentTier} {tierInfo.button}</dt>
            <dd>
              {!snapshot ? "—" : tier ? <>{tier.rate}%<small>{tierLabel(copy, tier.name)}</small></> : <>{copy.pending}<small>{copy.belowEntry}</small></>}
            </dd>
          </div>
        </dl>
        {salesInfo.note}
        {tierInfo.note}
      </article>
    </>
  );
}

/* ---------------- 推荐链接 ---------------- */

function copyMessage(outcome: CopyOutcome, copy: ReferralCopy): { tone: "ok" | "error"; text: string } | null {
  if (outcome.kind === "copied") return { tone: "ok", text: copy.copied };
  if (outcome.kind === "missing") return null;
  return outcome.reason === "unsupported"
    ? { tone: "error", text: copy.copyUnsupported }
    : { tone: "error", text: copy.copyRejected };
}

function ShareCard({
  link,
  dataStatus,
  clipboard,
}: {
  link: ReferralLinkState;
  dataStatus: ReferralCenterData["status"];
  clipboard?: ClipboardWriter | null;
}) {
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const copy = useT().referral;
  const codeId = "rfc-link-text";

  if (dataStatus === "loading") {
    return <div className="rfc-card rfc-share"><span className="rfc-skeleton is-block" style={{ height: 46 }} /></div>;
  }
  if (dataStatus === "error") {
    return (
      <div className="rfc-card rfc-share">
        <div className="rfc-notice" role="alert">
          <h3>{copy.linkErrorTitle}</h3>
          <p>{copy.linkErrorBody}</p>
        </div>
      </div>
    );
  }

  const ready = link.status === "ready";
  const reason = link.status === "pending" ? copy.linkPendingReason : copy.linkUnavailableReason;

  function selectLink() {
    const node = document.getElementById(codeId);
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    node.focus();
  }

  async function onCopy() {
    const writer = clipboard !== undefined
      ? clipboard
      : typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null;
    const outcome = await copyReferralLink(link, writer);
    const next = copyMessage(outcome, copy);
    setMessage(next);
    if (next?.tone === "error") selectLink();
  }

  return (
    <div className="rfc-card rfc-share">
      <div className="rfc-share-row">
        <div className={`rfc-link-field${ready ? "" : " is-empty"}`}>
          <code id={codeId} tabIndex={0}>{ready ? link.url : link.status === "pending" ? copy.linkPending : copy.linkUnavailable}</code>
        </div>
        <button type="button" className="rfc-primary" onClick={() => void onCopy()} disabled={!ready} title={ready ? undefined : reason}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></svg>
          {copy.copyLink}
        </button>
      </div>
      <p className={`rfc-copy-status${message ? (message.tone === "ok" ? " is-ok" : " is-error") : ""}`} role="status" aria-live="polite">
        {message ? (
          <>
            {message.tone === "ok"
              ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.6v5M12 16.2h.01" /></svg>}
            <span>{message.text}</span>
          </>
        ) : ready ? null : reason}
      </p>
      <p className="rfc-share-meta">
        <span>{copy.metaCandidatesBefore}<b>{copy.metaCandidates}</b></span>
        <span>{copy.metaInviteOnly}<b className="is-pending">{copy.metaQrPending}</b></span>
      </p>
    </div>
  );
}

/* ---------------- 伙伴等级 ---------------- */

function LevelCard({ data }: { data: ReferralCenterData }) {
  const copy = useT().referral;
  if (data.status === "loading") {
    return <div className="rfc-card rfc-level"><span className="rfc-skeleton is-block" /></div>;
  }
  const sales = data.status === "ready" ? data.snapshot.sales : null;
  const progress = levelProgress(sales);
  const current = progress.current;

  return (
    <div className="rfc-card rfc-level">
      {sales !== null ? (
        <div className="rfc-level-head">
          {current ? (
            <>
              <span className="rfc-level-now">{copy.levelCurrent}<b>{tierLabel(copy, current.name)} · {current.rate}%</b></span>
              <span className="rfc-level-next">
                {progress.next && progress.toNext !== null
                  ? <>{copy.levelToNext(tierLabel(copy, progress.next.name), progress.next.rate)}<b>{formatYuan(progress.toNext)}</b></>
                  : copy.levelTop}
              </span>
            </>
          ) : (
            <span className="rfc-level-now">{copy.levelCurrent}<b>{copy.belowEntryTier}</b></span>
          )}
        </div>
      ) : null}

      <ol className="rfc-steps">
        {REFERRAL_TIERS.map((tier, index) => {
          const isCurrent = current?.key === tier.key;
          return (
            <li key={tier.key} className={`rfc-step${isCurrent ? " is-current" : ""}`} aria-current={isCurrent ? "true" : undefined}>
              <span className="rfc-step-bar" aria-hidden="true"><i style={{ width: `${progress.fills[index].toFixed(1)}%` }} /></span>
              <span className="rfc-step-name">{tierLabel(copy, tier.name)}{isCurrent ? <span className="rfc-step-now">{copy.levelCurrent}</span> : null}</span>
              <span className="rfc-step-rate">{tier.rate}%</span>
              <span className="rfc-step-min">{copy.salesMin(formatYuanWhole(tier.min))}</span>
            </li>
          );
        })}
      </ol>

      {data.status === "error" ? (
        <p className="rfc-level-state">{copy.levelError}</p>
      ) : data.status === "pending" ? (
        <p className="rfc-level-state">{copy.levelPending}</p>
      ) : sales !== null && !current ? (
        <p className="rfc-level-state">
          {copy.levelBelow(formatYuan(sales), formatYuan(ENTRY_THRESHOLD_FEN), formatYuan(ENTRY_THRESHOLD_FEN - sales))}
        </p>
      ) : null}

      <p className="rfc-level-foot">{copy.levelFoot}</p>
    </div>
  );
}

/* ---------------- 战略合作说明 ---------------- */

function StrategicDialogBody() {
  const copy = useT().referral;
  const [tab, setTab] = useState<0 | 1>(0);
  const labels = copy.strategicTabs;
  return (
    <>
      <div className="rfc-tablist" role="tablist" aria-label={copy.strategicTabsLabel}>
        {labels.map((label, index) => (
          <button
            key={index}
            type="button"
            className="rfc-tab"
            role="tab"
            id={`rfc-stab-${index}`}
            aria-controls={`rfc-spanel-${index}`}
            aria-selected={tab === index}
            tabIndex={tab === index ? 0 : -1}
            onClick={() => setTab(index as 0 | 1)}
            onKeyDown={(event) => {
              const next = nextTabIndex(event.key, index, labels.length);
              if (next === null) return;
              event.preventDefault();
              setTab(next as 0 | 1);
              document.getElementById(`rfc-stab-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="rfc-spanel-0" aria-labelledby="rfc-stab-0" tabIndex={0} hidden={tab !== 0}>
        <div className="rfc-block">
          <h3>{copy.statusTitle}</h3>
          <p>{copy.statusBody}<br /><b>{copy.statusClosed}</b></p>
        </div>
        <div className="rfc-compare">
          <article>
            <h3>{copy.regularPartner}</h3>
            <ul>
              {copy.regularPoints.map((point) => <li key={point}>{point}</li>)}
            </ul>
          </article>
          <article className="is-strategic">
            <h3>{copy.strategicName}</h3>
            <ul>
              {copy.strategicPartnerPoints.map((point) => <li key={point}>{point}</li>)}
            </ul>
          </article>
        </div>
        <div className="rfc-block">
          <h3>{copy.directionTitle}</h3>
          <ul>
            {copy.directions.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <p>{copy.directionFoot}</p>
        </div>
        <div className="rfc-block">
          <h3>{copy.formsTitle}</h3>
          <p>{copy.formsLead}</p>
          <div className="rfc-chips">{copy.forms.map((form) => <span key={form}>{form}</span>)}</div>
        </div>
        <div className="rfc-block is-warn">
          <h3>{copy.clarifyTitle}</h3>
          <ul>
            {copy.clarify.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>
      <div role="tabpanel" id="rfc-spanel-1" aria-labelledby="rfc-stab-1" tabIndex={0} hidden={tab !== 1}>
        <div className="rfc-block is-warn">
          <h3>{copy.applyClosedTitle}</h3>
          <p>{copy.applyClosedBody}</p>
        </div>
      </div>
    </>
  );
}

/* ---------------- 规则与常见问题 ---------------- */

function FaqCard() {
  const faq = useT().referral.faq;
  return (
    <div className="rfc-card rfc-faq-card">
      <details className="rfc-faq">
        <summary>{faq.tierQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.tierLeadBefore}<b>{faq.tierLeadStrong}</b>{faq.tierLeadAfter}</p>
          <table className="rfc-faq-table">
            <thead><tr><th>{faq.tableSales}</th><th>{faq.tableTier}</th><th className="is-num">{faq.tableRate}</th></tr></thead>
            <tbody>
              {faq.rows.map(([sales, tier, rate], index) => (
                <tr key={sales} className={index === 0 ? "is-unknown" : undefined}><td>{sales}</td><td>{tier}</td><td className="is-num">{rate}</td></tr>
              ))}
            </tbody>
          </table>
          <p>{faq.tierFoot}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.capQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.capA}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.statesQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.statesA1}</p>
          <p>{faq.statesA2}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.withdrawQ}</summary>
        <div className="rfc-faq-body">
          <p><b>{faq.withdrawStrong}</b>{faq.withdrawA1}</p>
          <p>{faq.withdrawA2}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.refundQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.refundA1}</p>
          <p>{faq.refundA2}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.attributionQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.attributionA1}</p>
          <p>{faq.attributionA2}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.strategicQ}</summary>
        <div className="rfc-faq-body">
          <p>{faq.strategicA1Before}<b>{faq.strategicA1Strong}</b>{faq.strategicA1After}</p>
          <p>{faq.strategicA2}</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>{faq.paramsQ}</summary>
        <div className="rfc-faq-body">
          <ul>
            {faq.params.map((param) => (
              <li key={param.text}>{param.text}{param.strong ? <b>{param.strong}</b> : null}</li>
            ))}
          </ul>
          <p>{faq.paramsFoot}</p>
        </div>
      </details>
    </div>
  );
}
