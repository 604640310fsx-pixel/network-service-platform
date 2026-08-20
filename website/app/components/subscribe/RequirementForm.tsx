import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  PAYMENT_MAX_SINGLE_FEN_FRONTEND,
  PaymentApiError,
  bindOrderAccess,
  clearCheckoutAttempt,
  createPaymentOrder,
  getOrCreateCheckoutAttempt,
  shouldClearAttemptAfterError,
  type OrderCredentials,
  type RequirementDraft,
} from "../../lib/payment-api";
import type { CatalogSelection } from "../../lib/resolveSelection";
import type { SelectionSummary } from "./useSubscriptionSelection";

/* 使用场景为需求信息里的可选多选项，仅用于让人工在确认阶段了解客户用途，
   不写入 catalog、不参与选择逻辑与定价。 */
const SCENARIOS = [
  { id: "ai", label: "AI 工具" },
  { id: "social", label: "TikTok / 社媒" },
  { id: "work", label: "跨境办公" },
  { id: "other", label: "其他" },
] as const;

function recapValue(value: string) {
  return value || "—";
}

function formatFen(amountFen: number) {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function paymentErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法发起付款，请稍后重试。";
  switch (error.code) {
    case "price_changed":
      return error.currentAmountFen === null
        ? "方案价格已变化，请返回方案页重新确认后再支付。"
        : `方案价格已更新为 ${formatFen(error.currentAmountFen)}，请返回重新确认后再支付。`;
    case "amount_limit_exceeded":
      return "该方案超过当前在线支付限额，暂不支持在线购买。";
    case "invalid_selection":
      return "方案信息已失效，请返回方案页重新选择。";
    case "contact_required":
      return "请填写联系方式后再支付。";
    case "payment_unavailable":
      return "支付服务暂未开放，请稍后再试。";
    case "idempotency_key_conflict":
      return "本次提交凭证已失效，请重新点击支付。";
    case "rate_limited":
      return "提交过于频繁，请稍后再试。";
    case "storage_unavailable":
      return "浏览器无法保存订单查询凭证，请允许本地存储后再支付。";
    case "network_error":
      return "网络连接失败，未确认是否已创建订单；再次点击会安全重试。";
    case "invalid_response":
      return "支付服务返回异常，尚未发起扣款，请稍后重试。";
    default:
      return "暂时无法发起付款，请稍后重试。";
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
  const [contact, setContact] = useState("");
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [contactTouched, setContactTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const contactId = useId();
  const notesId = useId();

  const contactMissing = contactTouched && contact.trim() === "";
  const priceKnown = summary.total !== null;
  const amountFen = summary.total === null ? null : Math.round(summary.total * 100);
  const overPaymentLimit = amountFen !== null && amountFen > PAYMENT_MAX_SINGLE_FEN_FRONTEND;
  const canSubmit = priceKnown && !overPaymentLimit && contact.trim() !== "" && !submitting;

  function toggleScenario(id: string) {
    setScenarios((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContactTouched(true);
    setSubmitError(null);
    if (submitting || contact.trim() === "" || amountFen === null || overPaymentLimit) return;

    const draft: RequirementDraft = {
      selection,
      contact: contact.trim(),
      scenarios,
      notes: notes.trim(),
      acknowledgedAmountFen: amountFen,
    };
    setSubmitting(true);
    let credentials: OrderCredentials | null = null;
    try {
      // 先持久化需求指纹与凭证（不保存明文需求），再发请求；刷新或响应丢失后可安全重试。
      credentials = await getOrCreateCheckoutAttempt(draft);
      const result = await createPaymentOrder(draft, credentials);
      bindOrderAccess(result.orderRef, credentials);
      if (result.status === "pending" && result.payUrl !== null) {
        window.location.assign(result.payUrl);
        return;
      }
      navigate(`/subscribe/request?orderRef=${encodeURIComponent(result.orderRef)}`, { replace: true });
    } catch (error) {
      if (credentials !== null && shouldClearAttemptAfterError(error)) {
        try {
          clearCheckoutAttempt(credentials);
        } catch {
          // 保留原始请求错误；本地存储不可用时无法额外清理。
        }
      }
      setSubmitError(paymentErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sub-request">
      <div className="sub-request-recap" aria-label="已选方案确认">
        <div className="sub-request-recap-grid">
          <div><span>网络类型</span><b>{recapValue(summary.type)}</b></div>
          <div><span>国家/地区</span><b>{recapValue(summary.region)}</b></div>
          <div><span>运营商</span><b>{recapValue(summary.isp)}</b></div>
          <div><span>规格</span><b>{recapValue(summary.spec)}</b></div>
          <div><span>周期</span><b>{recapValue(summary.duration)}</b></div>
        </div>
        <div className="sub-request-recap-price">
          <span>应付金额</span>
          <b>{priceKnown ? `¥${summary.total}` : "—"}</b>
          {!priceKnown && <small>价格待确认</small>}
        </div>
      </div>

      <form className="sub-request-form" onSubmit={handleSubmit}>
        <div className="sub-field">
          <label htmlFor={contactId}>联系方式 <em>必填</em></label>
          <input
            id={contactId}
            type="text"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            onBlur={() => setContactTouched(true)}
            placeholder="微信号 / Telegram 用户名 / 邮箱"
            autoComplete="off"
            disabled={submitting}
            aria-invalid={contactMissing || undefined}
            aria-describedby={contactMissing ? `${contactId}-err` : undefined}
          />
          {contactMissing && (
            <p id={`${contactId}-err`} className="sub-field-error" role="alert">
              请填写联系方式，方便我们与你确认方案。
            </p>
          )}
        </div>

        <div className="sub-field">
          <label>使用场景 <em>可选 · 多选</em></label>
          <div className="sub-scenario-chips" role="group" aria-label="使用场景">
            {SCENARIOS.map((scenario) => {
              const active = scenarios.includes(scenario.id);
              return (
                <button
                  key={scenario.id}
                  type="button"
                  className={`sub-scenario-chip ${active ? "is-active" : ""}`.trim()}
                  aria-pressed={active}
                  disabled={submitting}
                  onClick={() => toggleScenario(scenario.id)}
                >
                  {scenario.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sub-field">
          <label htmlFor={notesId}>补充说明 <em>可选</em></label>
          <textarea
            id={notesId}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="使用人数、目标平台、特殊需求等，便于我们判断适配方案。"
            disabled={submitting}
          />
        </div>

        <div className="sub-request-submit">
          <button type="submit" disabled={!canSubmit} aria-busy={submitting}>
            {submitting
              ? "正在发起付款…"
              : overPaymentLimit
                ? "暂不支持在线购买"
                : priceKnown
                  ? `提交需求并立即支付 ¥${summary.total}`
                  : "价格待确认"}
          </button>
          <p>付款成功后可在本页查看服务状态；已登录用户也可在用户中心查看。</p>
          {submitError && <p className="sub-field-error" role="alert">{submitError}</p>}
        </div>
      </form>
    </div>
  );
}
