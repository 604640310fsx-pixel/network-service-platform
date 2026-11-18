import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useCatalogText, useT, type Messages } from "../../lib/i18n";
import {
  PAYMENT_MAX_SINGLE_FEN_FRONTEND,
  PaymentApiError,
  bindOrderAccess,
  clearCheckoutAttempt,
  createPaymentOrder,
  getOrCreateCheckoutAttempt,
  getQuote,
  isValidCouponCode,
  normalizeCouponCode,
  shouldClearAttemptAfterError,
  type OrderCredentials,
  type QuoteResult,
  type RequirementDraft,
} from "../../lib/payment-api";
import type { CatalogSelection } from "../../lib/resolveSelection";
import type { SelectionSummary } from "./useSubscriptionSelection";

/* 使用场景为需求信息里的可选多选项，仅用于让人工在确认阶段了解客户用途，
   不写入 catalog、不参与选择逻辑与定价。 */
const SCENARIO_IDS = ["ai", "social", "work", "other"] as const;

function formatFen(amountFen: number) {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function paymentErrorMessage(error: unknown, messages: Messages["subscribe"]["form"]): string {
  const m = messages.errors;
  if (!(error instanceof PaymentApiError)) return m.generic;
  switch (error.code) {
    case "price_changed":
      return error.currentAmountFen === null ? m.priceChanged : m.priceUpdated(formatFen(error.currentAmountFen));
    case "amount_limit_exceeded":
      return m.amountLimit;
    case "plan_unavailable":
      return m.planUnavailable;
    case "sold_out":
      return m.soldOut;
    case "coupon_invalid":
      return messages.couponInvalid;
    case "invalid_selection":
      return m.invalidSelection;
    case "contact_required":
      return m.contactRequired;
    case "unauthorized":
      return m.unauthorized;
    case "csrf_invalid":
      return m.csrfInvalid;
    case "payment_unavailable":
      return m.paymentUnavailable;
    case "idempotency_key_conflict":
      return m.idempotencyConflict;
    case "rate_limited":
      return m.rateLimited;
    case "storage_unavailable":
      return m.storageUnavailable;
    case "network_error":
      return m.network;
    case "invalid_response":
      return m.invalidResponse;
    default:
      return m.generic;
  }
}

/* 提交方案需求：已选方案只读确认 + 需求信息表单。
   只有最终 CTA 才创建订单并跳转支付；表单不触碰选择状态。 */
export function RequirementForm({
  summary,
  selection,
}: {
  summary: SelectionSummary;
  selection: CatalogSelection;
}) {
  const navigate = useNavigate();
  const t = useT();
  const copy = t.subscribe.form;
  const ct = useCatalogText();
  const recapValue = (value: string) => (value ? ct(value) : "—");
  // 新建订单必须登录（服务端同样强制）；检查中与未登录都不允许提交。
  const { status: authStatus, csrfToken } = useAuth();
  const signedIn = authStatus === "authenticated" && csrfToken !== null;
  const [contact, setContact] = useState("");
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [contactTouched, setContactTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [appliedQuote, setAppliedQuote] = useState<{ code: string | null; quote: QuoteResult } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const contactId = useId();
  const notesId = useId();
  const couponId = useId();

  // 选择变化（返回方案页改选后再次进入）后，任何已应用的报价一律作废，避免用旧选择的报价支付新方案。
  useEffect(() => {
    setAppliedQuote(null);
    setQuoteError(null);
  }, [selection.typeId, selection.regionId, selection.ispId, selection.specId, selection.durationId]);

  const contactMissing = contactTouched && contact.trim() === "";
  const normalizedCouponInput = normalizeCouponCode(couponInput);
  // 优惠码输入一旦不再等于已应用报价对应的规范化码，旧报价立即失效——必须重新点击"应用"。
  const activeQuote =
    appliedQuote !== null && appliedQuote.code === normalizedCouponInput ? appliedQuote.quote : null;

  // 优惠码是可选增强：只有成功报价才改变金额；未应用或无效时始终回退实时原价。
  const priceKnown = activeQuote !== null || summary.total !== null;
  const amountFen = activeQuote
    ? activeQuote.amountFen
    : summary.total !== null
      ? Math.round(summary.total * 100)
      : null;
  const listPriceFen = activeQuote?.listPriceFen ?? (summary.total === null ? null : Math.round(summary.total * 100));
  const discountFen = activeQuote?.discountFen ?? 0;
  const overPaymentLimit = amountFen !== null && amountFen > PAYMENT_MAX_SINGLE_FEN_FRONTEND;
  const canSubmit =
    signedIn && priceKnown && amountFen !== null && !overPaymentLimit && contact.trim() !== "" && !submitting && !quoteLoading;

  function toggleScenario(id: string) {
    setScenarios((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  async function handleApplyCoupon() {
    setQuoteError(null);
    if (normalizedCouponInput === null) {
      setAppliedQuote(null);
      return;
    }
    if (!isValidCouponCode(normalizedCouponInput)) {
      setAppliedQuote(null);
      setQuoteError(copy.couponInvalid);
      return;
    }
    setQuoteLoading(true);
    try {
      const quote = await getQuote(selection, normalizedCouponInput);
      setAppliedQuote({ code: normalizedCouponInput, quote });
    } catch (error) {
      setAppliedQuote(null);
      if (error instanceof PaymentApiError && error.code === "coupon_invalid") {
        setQuoteError(copy.couponInvalid);
      } else {
        setQuoteError(paymentErrorMessage(error, copy));
      }
    } finally {
      setQuoteLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContactTouched(true);
    setSubmitError(null);
    if (!signedIn || csrfToken === null || submitting || contact.trim() === "" || amountFen === null || overPaymentLimit) return;

    const draft: RequirementDraft = {
      selection,
      contact: contact.trim(),
      scenarios,
      notes: notes.trim(),
      couponCode: activeQuote ? normalizedCouponInput : null,
      acknowledgedAmountFen: amountFen,
    };
    setSubmitting(true);
    let credentials: OrderCredentials | null = null;
    try {
      // 先持久化需求指纹与凭证（不保存明文需求），再发请求；刷新或响应丢失后可安全重试。
      credentials = await getOrCreateCheckoutAttempt(draft);
      const result = await createPaymentOrder(draft, credentials, csrfToken);
      bindOrderAccess(result.orderRef, credentials);
      // 站内跳转到订单页；首个支付结果（含 payUrl）只通过内存 navigation state 携带，
      // 供 iframe 打开支付宝电脑网站收银台，不写入本站 URL / localStorage。
      navigate(`/subscribe/request?orderRef=${encodeURIComponent(result.orderRef)}`, {
        replace: true,
        state: { paymentResult: result },
      });
    } catch (error) {
      if (credentials !== null && shouldClearAttemptAfterError(error)) {
        try {
          clearCheckoutAttempt(credentials);
        } catch {
          // 保留原始请求错误；本地存储不可用时无法额外清理。
        }
      }
      if (error instanceof PaymentApiError && error.code === "coupon_invalid") {
        setAppliedQuote(null);
        setQuoteError(copy.couponInvalidRestored);
        setSubmitError(copy.confirmListPrice);
      } else {
        setSubmitError(paymentErrorMessage(error, copy));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sub-request">
      <div className="sub-request-recap" aria-label={copy.recapLabel}>
        <div className="sub-request-recap-grid">
          <div><span>{t.subscribe.summary.type}</span><b>{recapValue(summary.type)}</b></div>
          <div><span>{t.subscribe.summary.region}</span><b>{recapValue(summary.region)}</b></div>
          <div><span>{t.subscribe.summary.isp}</span><b>{recapValue(summary.isp)}</b></div>
          <div><span>{t.subscribe.summary.spec}</span><b>{recapValue(summary.spec)}</b></div>
          <div><span>{copy.term}</span><b>{recapValue(summary.duration)}</b></div>
        </div>
        <div className="sub-request-recap-price">
          <span>{copy.amountDue}</span>
          <b>{priceKnown && amountFen !== null ? formatFen(amountFen) : "—"}</b>
          {!priceKnown && <small>{t.subscribe.pricePending}</small>}
        </div>
      </div>

      <div className="sub-field sub-coupon-field">
        <label htmlFor={couponId}>{copy.couponLabel} <em>{copy.optional}</em></label>
        <div className="sub-coupon-row">
          <input
            id={couponId}
            type="text"
            value={couponInput}
            onChange={(event) => {
              setCouponInput(event.target.value);
              setAppliedQuote(null);
              setQuoteError(null);
            }}
            placeholder={copy.couponPlaceholder}
            autoComplete="off"
            disabled={submitting}
          />
          <button
            type="button"
            className="sub-coupon-apply"
            onClick={handleApplyCoupon}
            disabled={submitting || quoteLoading || normalizedCouponInput === null}
            aria-busy={quoteLoading}
          >
            {quoteLoading ? copy.applying : copy.apply}
          </button>
        </div>
        {quoteError && <p className="sub-field-error" role="alert">{quoteError}</p>}
        {activeQuote && listPriceFen !== null && (
          <div className="sub-price-breakdown">
            <div><span>{copy.listPrice}</span><b>{formatFen(listPriceFen)}</b></div>
            <div><span>{copy.discount}</span><b>-{formatFen(discountFen)}</b></div>
            <div><span>{copy.finalAmount}</span><b>{formatFen(activeQuote.amountFen)}</b></div>
          </div>
        )}
      </div>

      <form className="sub-request-form" onSubmit={handleSubmit}>
        <div className="sub-field">
          <label htmlFor={contactId}>{copy.contactLabel} <em>{copy.required}</em></label>
          <input
            id={contactId}
            type="text"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            onBlur={() => setContactTouched(true)}
            placeholder={copy.contactPlaceholder}
            autoComplete="off"
            disabled={submitting}
            aria-invalid={contactMissing || undefined}
            aria-describedby={contactMissing ? `${contactId}-err` : undefined}
          />
          {contactMissing && (
            <p id={`${contactId}-err`} className="sub-field-error" role="alert">
              {copy.contactMissing}
            </p>
          )}
        </div>

        <div className="sub-field">
          <label>{copy.scenariosLabel} <em>{copy.optionalMulti}</em></label>
          <div className="sub-scenario-chips" role="group" aria-label={copy.scenariosLabel}>
            {SCENARIO_IDS.map((id) => {
              const active = scenarios.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={`sub-scenario-chip ${active ? "is-active" : ""}`.trim()}
                  aria-pressed={active}
                  disabled={submitting}
                  onClick={() => toggleScenario(id)}
                >
                  {copy.scenarios[id]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sub-field">
          <label htmlFor={notesId}>{copy.notesLabel} <em>{copy.optional}</em></label>
          <textarea
            id={notesId}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder={copy.notesPlaceholder}
            disabled={submitting}
          />
        </div>

        <div className="sub-request-submit">
          {authStatus === "unauthenticated" && (
            <p>
              {copy.loginBefore}<Link to="/login">{copy.loginLink}</Link>{copy.loginAfter}
            </p>
          )}
          <button type="submit" disabled={!canSubmit} aria-busy={submitting}>
            {submitting
              ? copy.submitting
              : overPaymentLimit
                ? copy.overLimit
                : priceKnown && amountFen !== null
                  ? copy.submit(formatFen(amountFen))
                  : t.subscribe.pricePending}
          </button>
          <p>{copy.afterPay}</p>
          {submitError && <p className="sub-field-error" role="alert">{submitError}</p>}
        </div>
      </form>
    </div>
  );
}
