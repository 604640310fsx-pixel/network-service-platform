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

export const REFERRAL_CENTER_TITLE = "推荐返佣中心";
export const REFERRAL_CENTER_DESCRIPTION = "推荐来源与客户记录";

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

  return (
    <main className="rfc-page">
      <div className="rfc-layout">
        <PageNotice variant={notice} />

        <section className="rfc-hero" aria-label="佣金余额与本月收益">
          <div className="rfc-hero-grid">
            <EarningsCards data={data} onRetry={onRetry} />
          </div>
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-share-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title">
              <h2 id="rfc-share-title">推荐链接</h2>
              {notice === "fixture" ? <span className="rfc-tag">演示链接 · 不可访问</span> : null}
            </div>
            <p>推荐链接状态以实际接口为准；当前仅开放邀请注册，推荐链接中的代码同时是你的个人邀请码，只能用于注册，不能登录你的账户。</p>
          </div>
          <ShareCard link={link} dataStatus={data.status} clipboard={clipboard} />
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-level-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title">
              <h2 id="rfc-level-title">伙伴等级</h2>
              <span className="rfc-tag">正式费率</span>
            </div>
            <p>当月等级由当月有效月销决定，不沿用上月结果。</p>
          </div>
          <LevelCard data={data} />
        </section>

        <section className="rfc-sec" aria-labelledby="rfc-records-title">
          <div className="rfc-sec-head">
            <div className="rfc-sec-title"><h2 id="rfc-records-title">佣金记录</h2></div>
            <p>待确认推荐仅显示匿名标识；正式佣金与结算记录尚未接入。</p>
          </div>
          <ReferralRecords data={data} candidates={candidates} onCandidatePageChange={onCandidatePageChange} />
        </section>

        <div className="rfc-bottom">
          <div className="rfc-bottom-grid">
            <section className="rfc-sec" aria-labelledby="rfc-strategic-title">
              <div className="rfc-sec-head">
                <div className="rfc-sec-title">
                  <h2 id="rfc-strategic-title">战略推广合作</h2>
                  <span className="rfc-tag">候选 · 暂未开放</span>
                </div>
              </div>
              <div className="rfc-card rfc-strategic">
                <p className="rfc-strategic-kicker">独立合作 · 需人工审核</p>
                <p className="rfc-strategic-title">战略推广伙伴<em>比例待确认</em></p>
                <p className="rfc-strategic-lead">
                  面向拥有真实推广渠道、愿意开展持续推广合作的伙伴。具体比例、适用商品及合作要求以批准方案为准。合作方案筹备中，暂未开放资格授予。
                </p>
                <ul className="rfc-points">
                  <li><b>不是第五档</b><span>与 10% / 15% / 20% / 30% 四档相互独立，不会因月销自动获得。</span></li>
                  <li><b>需人工审核</b><span>需可核验的持续推广合作、人工审核并签署合作协议。</span></li>
                  <li><b>仍是候选</b><span>比例上限、适用商品、保级与退出条件尚未冻结。</span></li>
                </ul>
                <div className="rfc-strategic-foot">
                  <p>普通伙伴可自由推荐、无需申请，两者不冲突。</p>
                  <button type="button" className="rfc-ghost" onClick={() => setStrategicOpen(true)}>了解战略合作</button>
                </div>
              </div>
            </section>

            <section className="rfc-sec" aria-labelledby="rfc-faq-title">
              <div className="rfc-sec-head">
                <div className="rfc-sec-title">
                  <h2 id="rfc-faq-title">规则与常见问题</h2>
                  <span className="rfc-tag">含候选参数</span>
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
        eyebrow="独立合作 · 需人工审核"
        title="战略推广伙伴｜比例待确认"
        wide
      >
        <StrategicDialogBody />
      </ReferralDialog>
    </main>
  );
}

/* ---------------- 页首标识 ---------------- */

function PageNotice({ variant }: { variant: ReferralCenterNotice }) {
  const text = variant === "fixture"
    ? "本页客户、订单、金额与比例均为合成演示数据，仅用于界面验证。"
    : "推荐链接与待确认推荐按实际接口展示；佣金余额、明细与结算数据尚未接入，不展示示例数值。";
  return (
    <details className="rfc-demo">
      <summary>
        {variant === "fixture"
          ? <span className="rfc-demo-mark">演示数据 · 非报价</span>
          : <span className="rfc-demo-mark">数据待接入</span>}
        <span className="rfc-demo-mark">未接入项保持待确认</span>
        <span className="rfc-demo-toggle">说明</span>
      </summary>
      <p>
        {text}提现门槛：已结算余额满 ¥1,000.00（功能开放后适用）。
        四档费率与等级门槛已经批准；商品上限、低于 ¥59 的计佣方式、结算天数与战略合作条件等未冻结细则仍保持待确认。本页不构成报价或已生效合同。
      </p>
    </details>
  );
}

/* ---------------- 收益：余额卡 + 本月卡 ---------------- */

const NOTE_CASH = "只包含已结算期间的佣金；本月预估与待结算都不计入。提现门槛：已结算余额满 ¥1,000.00（功能开放后适用）。" +
  "未申请的已结算余额保留，不会自动转出。提现功能暂未开放。";
const NOTE_EST = "预估与待结算金额不计入已结算佣金余额；计佣方式、商品上限及结算安排尚未配置或确认。";
const NOTE_TIER = "等级按当月有效月销确定，月内为预估；四档比例与月销门槛已经批准；" +
  "月销低于 ¥59 的计佣方式待确认。";

function EarningsCards({ data, onRetry }: { data: ReferralCenterData; onRetry?: () => void }) {
  const cash = useInfoToggle("已结算佣金余额", NOTE_CASH);
  const est = useInfoToggle("本月预估佣金", NOTE_EST);
  const snapshot = data.status === "ready" ? data.snapshot : null;
  const salesInfo = useInfoToggle(
    "有效月销",
    (snapshot ? `本月指 ${snapshot.month}。` : "") +
      "有效月销数据尚未接入；退款与拒付的具体调整展示待确认。",
  );
  const tierInfo = useInfoToggle("当前等级", NOTE_TIER);

  if (data.status === "loading") {
    return (
      <>
        <article className="rfc-card rfc-wallet" aria-busy="true">
          <div className="rfc-card-head"><span className="rfc-eyebrow">读取中…</span></div>
          <div className="rfc-wallet-amount"><span className="rfc-skeleton is-hero" /></div>
          <div className="rfc-meter"><span className="rfc-skeleton is-line" /></div>
        </article>
        <article className="rfc-card rfc-month-card" aria-busy="true">
          <div className="rfc-card-head"><span className="rfc-eyebrow">读取中…</span></div>
          <span className="rfc-skeleton is-value" /><span className="rfc-skeleton is-line" />
        </article>
      </>
    );
  }

  if (data.status === "error") {
    return (
      <article className="rfc-card rfc-card-error" role="alert">
        <div className="rfc-notice">
          <h3>暂时无法读取返佣数据</h3>
          <p>读取失败不等于“暂无记录”，因此不显示 ¥0.00，也不会回退到任何示例数值。</p>
          {onRetry ? (
            <div className="rfc-notice-actions">
              <button type="button" className="rfc-primary" onClick={onRetry}>重新加载</button>
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
      <article className="rfc-card rfc-wallet" aria-label="已结算佣金余额">
        <div className="rfc-card-head">
          <span className="rfc-eyebrow"><i className="rfc-dot" aria-hidden="true" />已结算佣金余额</span>
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
                ? `已结算佣金余额 ${formatYuan(ledger.withdrawable)}，已达提现门槛 ${formatYuan(WITHDRAW_MIN_FEN)}，功能暂未开放`
                : `已结算佣金余额 ${formatYuan(ledger.withdrawable)}，距提现门槛 ${formatYuan(WITHDRAW_MIN_FEN)} 还差 ${formatYuan(gate.shortfall)}，功能暂未开放`
              : "佣金余额数据尚未接入"}
          >
            <i style={{ width: `${gate ? gate.fill.toFixed(2) : 0}%` }} />
          </div>
          <div className="rfc-meter-legend">
            {ledger && gate ? (
              gate.met
                ? <span>已达 <b>{formatYuan(WITHDRAW_MIN_FEN)}</b> 门槛 · 提现功能暂未开放</span>
                : <span>距门槛还差 <b>{formatYuan(gate.shortfall)}</b> · 提现功能暂未开放</span>
            ) : (
              <span>佣金余额数据尚未接入</span>
            )}
            <span>门槛 {formatYuan(WITHDRAW_MIN_FEN)}</span>
          </div>
        </div>
        <dl className="rfc-kv is-quiet">
          <div><dt>待结算</dt><dd>{ledger ? formatYuan(ledger.pending) : "—"}</dd></div>
          <div><dt>已提现</dt><dd>{ledger ? formatYuan(ledger.withdrawn) : "—"}</dd></div>
        </dl>
      </article>

      <article className="rfc-card rfc-month-card" aria-label="本月预估">
        <div className="rfc-card-head">
          <span className="rfc-eyebrow">本月预估佣金</span>
          {snapshot ? <span className="rfc-month-chip">{snapshot.month}</span> : null}
          {est.button}
        </div>
        {est.note}
        {!snapshot
          ? <span className="rfc-plain is-hero">—</span>
          : snapshot.estimate === "unknown"
            ? <span className="rfc-plain is-hero">待确认</span>
            : <Money fen={snapshot.estimate} size="lg" />}
        {snapshot ? (
          <span className="rfc-state">{snapshot.estimate === "unknown" ? "计佣方式待确认" : "未结算 · 不可提现"}</span>
        ) : (
          <span className="rfc-state">数据待接入</span>
        )}
        <div className="rfc-kv-gap" aria-hidden="true" />
        <dl className="rfc-kv">
          <div>
            <dt>有效月销 {salesInfo.button}</dt>
            <dd>
              {snapshot ? formatYuan(snapshot.sales) : "—"}
              {snapshot?.original ? <small>含退款调整</small> : snapshot?.zero ? <small>本月暂无有效消费</small> : null}
            </dd>
          </div>
          <div>
            <dt>当前等级 {tierInfo.button}</dt>
            <dd>
              {!snapshot ? "—" : tier ? <>{tier.rate}%<small>{tier.name}</small></> : <>待确认<small>未达 ¥59 门槛</small></>}
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

function copyMessage(outcome: CopyOutcome): { tone: "ok" | "error"; text: string } | null {
  if (outcome.kind === "copied") return { tone: "ok", text: "已复制到剪贴板。" };
  if (outcome.kind === "missing") return null;
  return outcome.reason === "unsupported"
    ? { tone: "error", text: "复制失败：当前浏览器上下文不提供剪贴板写入。链接已选中，可手动复制。" }
    : { tone: "error", text: "复制失败：浏览器拒绝了剪贴板写入。链接已选中，可手动复制。" };
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
  const codeId = "rfc-link-text";

  if (dataStatus === "loading") {
    return <div className="rfc-card rfc-share"><span className="rfc-skeleton is-block" style={{ height: 46 }} /></div>;
  }
  if (dataStatus === "error") {
    return (
      <div className="rfc-card rfc-share">
        <div className="rfc-notice" role="alert">
          <h3>推荐链接读取失败</h3>
          <p>未能取得推荐链接，复制已禁用；失败态不展示占位链接。</p>
        </div>
      </div>
    );
  }

  const ready = link.status === "ready";
  const reason = link.status === "pending" ? "推荐链接尚未接入，暂不可复制。" : "当前账户没有可用的推荐链接，暂不可复制。";

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
    const next = copyMessage(outcome);
    setMessage(next);
    if (next?.tone === "error") selectLink();
  }

  return (
    <div className="rfc-card rfc-share">
      <div className="rfc-share-row">
        <div className={`rfc-link-field${ready ? "" : " is-empty"}`}>
          <code id={codeId} tabIndex={0}>{ready ? link.url : link.status === "pending" ? "推荐链接尚未接入" : "暂无可用推荐链接"}</code>
        </div>
        <button type="button" className="rfc-primary" onClick={() => void onCopy()} disabled={!ready} title={ready ? undefined : reason}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></svg>
          复制链接
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
        <span>实际接口仅展示<b>待确认候选</b></span>
        <span>仅限邀请注册 · 推广二维码 <b className="is-pending">待接入</b></span>
      </p>
    </div>
  );
}

/* ---------------- 伙伴等级 ---------------- */

function LevelCard({ data }: { data: ReferralCenterData }) {
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
              <span className="rfc-level-now">当前<b>{current.name} · {current.rate}%</b></span>
              <span className="rfc-level-next">
                {progress.next && progress.toNext !== null
                  ? <>距 {progress.next.name} {progress.next.rate}% 还差 <b>{formatYuan(progress.toNext)}</b></>
                  : "已达最高月销档"}
              </span>
            </>
          ) : (
            <span className="rfc-level-now">当前<b>未达入门门槛</b></span>
          )}
        </div>
      ) : null}

      <ol className="rfc-steps">
        {REFERRAL_TIERS.map((tier, index) => {
          const isCurrent = current?.key === tier.key;
          return (
            <li key={tier.key} className={`rfc-step${isCurrent ? " is-current" : ""}`} aria-current={isCurrent ? "true" : undefined}>
              <span className="rfc-step-bar" aria-hidden="true"><i style={{ width: `${progress.fills[index].toFixed(1)}%` }} /></span>
              <span className="rfc-step-name">{tier.name}{isCurrent ? <span className="rfc-step-now">当前</span> : null}</span>
              <span className="rfc-step-rate">{tier.rate}%</span>
              <span className="rfc-step-min">月销 ≥ {formatYuanWhole(tier.min)}</span>
            </li>
          );
        })}
      </ol>

      {data.status === "error" ? (
        <p className="rfc-level-state">本月有效月销读取失败，当前等级无法确定。</p>
      ) : data.status === "pending" ? (
        <p className="rfc-level-state">有效月销数据尚未接入，当前等级暂无法确定。</p>
      ) : sales !== null && !current ? (
        <p className="rfc-level-state">
          本月有效月销 <b>{formatYuan(sales)}</b>，低于入门门槛 <b>{formatYuan(ENTRY_THRESHOLD_FEN)}</b>（还差 <b>{formatYuan(ENTRY_THRESHOLD_FEN - sales)}</b>）。
          该区间的计佣方式待确认，不按 0% 或 10% 处理，因此本月不展示预估佣金。
        </p>
      ) : null}

      <p className="rfc-level-foot">
        轨道按四档分段展示，不是等比例坐标；有效月销与佣金数据尚未接入，退款与拒付的调整方式待确认。战略推广合作是独立候选方案，不在本路径内。
      </p>
    </div>
  );
}

/* ---------------- 战略合作说明 ---------------- */

function StrategicDialogBody() {
  const [tab, setTab] = useState<0 | 1>(0);
  const labels = ["合作说明", "申请入口"] as const;
  return (
    <>
      <div className="rfc-tablist" role="tablist" aria-label="战略合作分类">
        {labels.map((label, index) => (
          <button
            key={label}
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
          <h3>当前状态</h3>
          <p>战略推广伙伴方案筹备中。具体比例、适用商品及合作要求以未来批准方案为准。<br /><b>暂未开放资格授予。</b></p>
        </div>
        <div className="rfc-compare">
          <article>
            <h3>普通伙伴</h3>
            <ul>
              <li>自由推荐，无需申请</li>
              <li>按当月有效月销自动确定正式档位（10% / 15% / 20% / 30%）</li>
              <li>商品佣金上限尚待批准</li>
            </ul>
          </article>
          <article className="is-strategic">
            <h3>战略推广伙伴</h3>
            <ul>
              <li>通过明确、持续、可核验的推广合作获得单独合作待遇</li>
              <li>需人工审核与合作协议，不由月销自动升级</li>
              <li>具体比例与适用商品待批准</li>
            </ul>
          </article>
        </div>
        <div className="rfc-block">
          <h3>合作方向（非最终契约）</h3>
          <ul>
            <li>真实、可核验的推广渠道</li>
            <li>约定的持续推广内容</li>
            <li>适用商品范围与利润验证</li>
            <li>人工审核</li>
            <li>合作协议</li>
          </ul>
          <p>以上为当前保留的合作方向；具体义务、期限、保级、退出与权益尚未冻结。</p>
        </div>
        <div className="rfc-block">
          <h3>合作形式示意</h3>
          <p>仅为示意，不要求每个伙伴全部具备：</p>
          <div className="rfc-chips"><span>社群</span><span>内容</span><span>网站</span><span>已有服务场景</span></div>
        </div>
        <div className="rfc-block is-warn">
          <h3>需要澄清的几点</h3>
          <ul>
            <li>不是月销四档之外的“第五档”，不会因月销达到某个数值自动获得。</li>
            <li>不可通过缴费购买资格。</li>
            <li>未来若开放申请，仍需人工审核并签署合作协议。</li>
            <li>适用商品与比例按批准方案执行，并非所有商品统一同一比例。</li>
          </ul>
        </div>
      </div>
      <div role="tabpanel" id="rfc-spanel-1" aria-labelledby="rfc-stab-1" tabIndex={0} hidden={tab !== 1}>
        <div className="rfc-block is-warn">
          <h3>申请入口未开放</h3>
          <p>合作方案筹备中，暂未开放资格授予，因此不提供申请入口，也不收集任何申请资料。</p>
        </div>
      </div>
    </>
  );
}

/* ---------------- 规则与常见问题 ---------------- */

function FaqCard() {
  return (
    <div className="rfc-card rfc-faq-card">
      <details className="rfc-faq">
        <summary>等级和比例怎么确定？</summary>
        <div className="rfc-faq-body">
          <p>按<b>当月有效月销</b>确定当月等级，不使用“上月决定下月”。以下四档费率与门槛已经批准：</p>
          <table className="rfc-faq-table">
            <thead><tr><th>当月有效月销</th><th>等级</th><th className="is-num">佣金率</th></tr></thead>
            <tbody>
              <tr className="is-unknown"><td>月销 &lt; ¥59.00</td><td>未达入门门槛</td><td className="is-num">待确认</td></tr>
              <tr><td>¥59.00 ≤ 月销 &lt; ¥999.00</td><td>入门伙伴</td><td className="is-num">10%</td></tr>
              <tr><td>¥999.00 ≤ 月销 &lt; ¥1,999.00</td><td>进阶伙伴</td><td className="is-num">15%</td></tr>
              <tr><td>¥1,999.00 ≤ 月销 &lt; ¥3,999.00</td><td>核心伙伴</td><td className="is-num">20%</td></tr>
              <tr><td>月销 ≥ ¥3,999.00</td><td>高级伙伴</td><td className="is-num">30%</td></tr>
            </tbody>
          </table>
          <p>月销低于 ¥59 的计佣方式尚未最终确认，因此显示“待确认”，不按 0% 或 10% 处理。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>商品佣金上限如何影响实际比例？</summary>
        <div className="rfc-faq-body">
          <p>商品佣金上限尚未配置，实际计佣方式仍待确认；暂不展示推测比例或金额。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>预估、待结算、可提现、已提现有什么区别？</summary>
        <div className="rfc-faq-body">
          <p>“预估”只是准确性提示，不是新的账务状态；正式佣金与结算数据尚未接入。</p>
          <p>本月预估与待结算金额不计入已结算佣金余额；结算安排与观察期仍待批准。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>提现门槛是什么？</summary>
        <div className="rfc-faq-body">
          <p><b>提现门槛：已结算余额满 ¥1,000.00（功能开放后适用）。</b>本月预估与待结算金额不计入该余额。</p>
          <p>未申请的已结算余额保留，不会自动转出。提现功能暂未开放：当前不能提交申请，也不会创建任何提现单。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>退款或拒付会怎样调整？</summary>
        <div className="rfc-faq-body">
          <p>退款与拒付不计入有效消费；具体佣金调整方式待确认。</p>
          <p>当前没有接入正式佣金与调整记录，不展示推测金额。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>推荐归属怎么算？我能看到客户什么信息？</summary>
        <div className="rfc-faq-body">
          <p>当前仅展示实际接口返回的待确认候选；正式客户归属与后续计佣规则尚待确认。</p>
          <p>待确认候选只显示匿名标识、状态与注册时间，不含姓名、手机号、邮箱、真实资源或网络配置。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>战略推广伙伴和普通四档有什么不同？</summary>
        <div className="rfc-faq-body">
          <p>普通四档按当月有效月销确定，无需申请；战略推广伙伴是<b>独立的候选合作方案</b>，具体比例与条件待批准。</p>
          <p>它不是月销的第五档，不会自动获得，也不能通过缴费购买；目前没有申请入口。</p>
        </div>
      </details>
      <details className="rfc-faq">
        <summary>哪些参数仍未批准？</summary>
        <div className="rfc-faq-body">
          <ul>
            <li>月销低于 ¥59 的计佣方式：<b>待确认</b></li>
            <li>四档费率与各档门槛：<b>已批准</b></li>
            <li>商品佣金上限清单：待批准</li>
            <li>结算天数与观察期：待批准（提现门槛 ¥1,000.00 已冻结，不在此列）</li>
            <li>战略推广合作的准入、保级与退出契约：待批准</li>
          </ul>
          <p>未批准参数继续显示“待确认”，不写入计佣配置，也不以 0 或其他推测数值替代。</p>
        </div>
      </details>
    </div>
  );
}
