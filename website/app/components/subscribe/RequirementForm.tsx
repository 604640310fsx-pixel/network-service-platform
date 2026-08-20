import { useId, useState } from "react";
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

/* 提交方案需求：已选方案只读确认 + 需求信息表单。
   本包无后端，最终提交按钮保持禁用（提交功能待接入），不模拟成功态。
   表单本地态自持，不触碰 useSubscriptionSelection。 */
export function RequirementForm({ summary }: { summary: SelectionSummary }) {
  const [contact, setContact] = useState("");
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [contactTouched, setContactTouched] = useState(false);
  const contactId = useId();
  const notesId = useId();

  const contactMissing = contactTouched && contact.trim() === "";
  const priceKnown = summary.total !== null;

  function toggleScenario(id: string) {
    setScenarios((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
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

      <form className="sub-request-form" onSubmit={(event) => event.preventDefault()}>
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
          />
        </div>

        <div className="sub-request-submit">
          {/* 无真实支付后端，按钮暂保持禁用（不假扣款）；文案表达"提交需求并立即支付"。 */}
          <button type="submit" disabled>
            {priceKnown ? `提交需求并立即支付 ¥${summary.total}` : "价格待确认"}
          </button>
          <p>付款成功后，服务将进入待开通状态，请在用户中心查看进度。</p>
        </div>
      </form>
    </div>
  );
}
