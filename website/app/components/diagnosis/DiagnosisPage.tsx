import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { SiteFooter } from "../home/SiteFooter";
import { SiteHeader } from "../home/SiteHeader";
import {
  DiagnosisApiError,
  submitDiagnosisRequest,
  type BusinessScenario,
  type ContactType,
  type CurrentNetworkType,
  type DiagnosisSubmission,
  type ProblemFrequency,
  type ProblemType,
} from "../../lib/diagnosis-api";
import { useThemePreference } from "../../lib/theme";
import "../home/home.css";
import "./diagnosis.css";

const contactOptions: ReadonlyArray<{ value: ContactType; label: string }> = [
  { value: "wechat", label: "微信" },
  { value: "telegram", label: "Telegram" },
  { value: "email", label: "邮箱" },
  { value: "other", label: "其他" },
];

const scenarioOptions: ReadonlyArray<{ value: BusinessScenario; label: string }> = [
  { value: "tiktok_content", label: "TikTok / 内容运营" },
  { value: "live_streaming", label: "直播" },
  { value: "social_media", label: "社媒运营" },
  { value: "ai_development", label: "AI / 开发" },
  { value: "cross_border_ecommerce", label: "跨境电商" },
  { value: "other", label: "其他" },
  { value: "unsure", label: "暂不确定" },
];

const problemOptions: ReadonlyArray<{ value: ProblemType; label: string }> = [
  { value: "access_failure", label: "无法访问或连接失败" },
  { value: "performance_instability", label: "速度、延迟或稳定性异常" },
  { value: "dns_ipv4_ipv6_udp_issue", label: "DNS、IPv4 / IPv6 或 UDP 问题" },
  { value: "platform_environment_issue", label: "目标平台或环境异常" },
  { value: "live_content_account_environment", label: "直播、内容或账号环境问题" },
  { value: "existing_network_suitability", label: "判断现有网络是否适用" },
  { value: "new_network_plan", label: "需要新的网络方案" },
  { value: "other_or_unsure", label: "其他或暂不确定" },
];

const networkOptions: ReadonlyArray<{ value: CurrentNetworkType; label: string }> = [
  { value: "home_broadband", label: "家庭宽带" },
  { value: "enterprise_network", label: "企业网络" },
  { value: "vps_server", label: "VPS / 服务器" },
  { value: "proxy_network", label: "代理网络" },
  { value: "unknown", label: "不清楚" },
  { value: "other", label: "其他" },
];

const frequencyOptions: ReadonlyArray<{ value: ProblemFrequency; label: string }> = [
  { value: "one_time", label: "仅发生一次" },
  { value: "intermittent", label: "偶尔发生" },
  { value: "frequent", label: "频繁发生" },
  { value: "continuous", label: "持续发生" },
  { value: "unknown", label: "不清楚" },
];

type FormState = {
  contactType: ContactType;
  contactValue: string;
  businessScenario: BusinessScenario;
  targetRegion: string;
  problemTypes: ProblemType[];
  problemDescription: string;
  currentRegion: string;
  currentIsp: string;
  currentNetworkType: "" | CurrentNetworkType;
  problemFrequency: "" | ProblemFrequency;
  existingCustomer: "" | "yes" | "no";
  preferredContactWindow: string;
  extraNotes: string;
  safetyAcknowledged: boolean;
};

const initialForm: FormState = {
  contactType: "wechat",
  contactValue: "",
  businessScenario: "unsure",
  targetRegion: "",
  problemTypes: [],
  problemDescription: "",
  currentRegion: "",
  currentIsp: "",
  currentNetworkType: "",
  problemFrequency: "",
  existingCustomer: "",
  preferredContactWindow: "",
  extraNotes: "",
  safetyAcknowledged: false,
};

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function submissionFromState(state: FormState): DiagnosisSubmission {
  const currentRegion = optionalText(state.currentRegion);
  const currentIsp = optionalText(state.currentIsp);
  const preferredContactWindow = optionalText(state.preferredContactWindow);
  const extraNotes = optionalText(state.extraNotes);

  return {
    contactType: state.contactType,
    contactValue: state.contactValue.trim(),
    businessScenario: state.businessScenario,
    targetRegion: state.targetRegion.trim(),
    problemTypes: state.problemTypes,
    problemDescription: state.problemDescription.trim(),
    safetyAcknowledged: true,
    ...(currentRegion === undefined ? {} : { currentRegion }),
    ...(currentIsp === undefined ? {} : { currentIsp }),
    ...(state.currentNetworkType === "" ? {} : { currentNetworkType: state.currentNetworkType }),
    ...(state.problemFrequency === "" ? {} : { problemFrequency: state.problemFrequency }),
    ...(state.existingCustomer === "" ? {} : { isExistingCustomer: state.existingCustomer === "yes" }),
    ...(preferredContactWindow === undefined ? {} : { preferredContactWindow }),
    ...(extraNotes === undefined ? {} : { extraNotes }),
  };
}

function submissionErrorMessage(error: unknown): string {
  if (!(error instanceof DiagnosisApiError)) {
    return "暂时无法提交诊断信息，请稍后重试。";
  }
  switch (error.code) {
    case "invalid_request":
      return "请检查必填项和文字长度后再提交。";
    case "rate_limited":
      return "当前网络提交次数较多，请稍后再试。";
    case "origin_rejected":
      return "当前页面来源无法提交，请从官网重新打开诊断页面。";
    case "network_error":
    case "diagnosis_unavailable":
      return "诊断服务暂时不可用，请稍后重试。";
    default:
      return "暂时无法提交诊断信息，请稍后重试。";
  }
}

export function DiagnosisPage() {
  const { theme, toggleTheme } = useThemePreference();
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleProblem(problem: ProblemType) {
    setForm((current) => ({
      ...current,
      problemTypes: current.problemTypes.includes(problem)
        ? current.problemTypes.filter((item) => item !== problem)
        : [...current.problemTypes, problem],
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (form.problemTypes.length === 0) {
      setError("请至少选择一个需要判断的问题。");
      return;
    }
    if (!form.safetyAcknowledged) {
      setError("请先确认安全提示。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await submitDiagnosisRequest(submissionFromState(form));
      setSubmitted(true);
      window.scrollTo({ top: 0 });
    } catch (submitError) {
      setError(submissionErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cc-shell cc-home diagnosis-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />
      <main className="diagnosis-main">
        <section className="diagnosis-intro">
          <div className="home-wrap diagnosis-intro-grid">
            <div>
              <p className="home-eyebrow"><i aria-hidden="true" />DIAGNOSIS INTAKE</p>
              <h1>先把网络问题说清楚</h1>
              <p>
                本入口用于申请人工初步判断。提交不等于已经完成诊断；
                正式诊断的范围和费用需要另行确认。
              </p>
            </div>
            <aside className="diagnosis-safety" aria-labelledby="diagnosis-safety-title">
              <span aria-hidden="true">安全提示</span>
              <div>
                <h2 id="diagnosis-safety-title">不要填写任何敏感凭据</h2>
                <p>
                  请勿提交密码、验证码、密钥、会话、支付资料、未经脱敏的客户或生产信息；
                  也不要填写 Cookie 或远程控制凭据。
                </p>
              </div>
            </aside>
          </div>
        </section>

        <section className="diagnosis-form-section">
          <div className="home-wrap">
            {submitted ? (
              <div className="diagnosis-result" role="status">
                <span>SUBMITTED</span>
                <h2>提交成功</h2>
                <p>诊断需求已提交。我们会先进行人工初步判断，并通过你提供的联系方式回复下一步建议。</p>
                <div>
                  <Link to="/" className="diagnosis-secondary-button">返回首页</Link>
                  <button
                    type="button"
                    className="diagnosis-primary-button"
                    onClick={() => {
                      setForm(initialForm);
                      setSubmitted(false);
                    }}
                  >
                    提交另一项问题
                  </button>
                </div>
              </div>
            ) : (
              <form className="diagnosis-form" onSubmit={(event) => void submit(event)}>
                <header>
                  <div>
                    <span>INTAKE FORM</span>
                    <h2>网络环境与问题概况</h2>
                  </div>
                  <p><b>*</b> 为必填项</p>
                </header>

                <fieldset>
                  <legend><span>01</span>联系方式</legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>联系方式类型 <b>*</b></span>
                      <select value={form.contactType} onChange={(event) => update("contactType", event.target.value as ContactType)} required>
                        {contactOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>联系方式 <b>*</b></span>
                      <input
                        type="text"
                        inputMode={form.contactType === "email" ? "email" : undefined}
                        value={form.contactValue}
                        onChange={(event) => update("contactValue", event.target.value)}
                        maxLength={200}
                        autoComplete={form.contactType === "email" ? "email" : "off"}
                        placeholder={form.contactType === "email" ? "name@example.com" : "请输入可联系到你的账号"}
                        required
                      />
                    </label>
                    <label>
                      <span>方便联系的时间</span>
                      <input value={form.preferredContactWindow} onChange={(event) => update("preferredContactWindow", event.target.value)} maxLength={80} placeholder="例如：工作日 14:00–18:00" />
                    </label>
                    <label>
                      <span>是否现有客户</span>
                      <select value={form.existingCustomer} onChange={(event) => update("existingCustomer", event.target.value as FormState["existingCustomer"])}>
                        <option value="">暂不说明</option>
                        <option value="yes">是</option>
                        <option value="no">否</option>
                      </select>
                    </label>
                  </div>
                </fieldset>

                <fieldset>
                  <legend><span>02</span>业务与问题</legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>业务场景 <b>*</b></span>
                      <select value={form.businessScenario} onChange={(event) => update("businessScenario", event.target.value as BusinessScenario)} required>
                        {scenarioOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>目标国家或地区 <b>*</b></span>
                      <input value={form.targetRegion} onChange={(event) => update("targetRegion", event.target.value)} maxLength={80} placeholder="例如：日本、新加坡、美国" required />
                    </label>
                  </div>

                  <div className="diagnosis-problem-group" role="group" aria-labelledby="diagnosis-problem-label" aria-invalid={form.problemTypes.length === 0 && error !== null}>
                    <span id="diagnosis-problem-label">需要判断的问题 <b>*</b><small>可多选</small></span>
                    <div className="diagnosis-check-grid">
                      {problemOptions.map((option) => (
                        <label key={option.value}>
                          <input type="checkbox" checked={form.problemTypes.includes(option.value)} onChange={() => toggleProblem(option.value)} />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="diagnosis-wide-field">
                    <span>问题描述 <b>*</b><small>{form.problemDescription.length}/2000</small></span>
                    <textarea
                      value={form.problemDescription}
                      onChange={(event) => update("problemDescription", event.target.value)}
                      minLength={10}
                      maxLength={2000}
                      rows={6}
                      placeholder="请描述出现了什么、从什么时候开始、哪些设备或平台受影响，以及已经尝试过什么。"
                      required
                    />
                  </label>
                </fieldset>

                <fieldset>
                  <legend><span>03</span>当前网络 <small>选填</small></legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>当前国家或地区</span>
                      <input value={form.currentRegion} onChange={(event) => update("currentRegion", event.target.value)} maxLength={80} />
                    </label>
                    <label>
                      <span>当前运营商 / ISP</span>
                      <input value={form.currentIsp} onChange={(event) => update("currentIsp", event.target.value)} maxLength={120} />
                    </label>
                    <label>
                      <span>当前网络类型</span>
                      <select value={form.currentNetworkType} onChange={(event) => update("currentNetworkType", event.target.value as FormState["currentNetworkType"])}>
                        <option value="">暂不说明</option>
                        {networkOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>问题频率</span>
                      <select value={form.problemFrequency} onChange={(event) => update("problemFrequency", event.target.value as FormState["problemFrequency"])}>
                        <option value="">暂不说明</option>
                        {frequencyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="diagnosis-wide-field">
                    <span>补充说明 <small>{form.extraNotes.length}/1000</small></span>
                    <textarea value={form.extraNotes} onChange={(event) => update("extraNotes", event.target.value)} maxLength={1000} rows={4} placeholder="可补充设备、网络拓扑或其他有助判断的信息。" />
                  </label>
                </fieldset>

                <div className="diagnosis-submit-area">
                  <label className="diagnosis-safety-check">
                    <input type="checkbox" checked={form.safetyAcknowledged} onChange={(event) => update("safetyAcknowledged", event.target.checked)} required />
                    <span>
                      我确认以上内容不包含密码、验证码、密钥、会话、支付资料、
                      未经脱敏的客户或生产信息、Cookie 或远程控制凭据。
                    </span>
                  </label>
                  {error && <p className="diagnosis-error" role="alert">{error}</p>}
                  <button type="submit" className="diagnosis-primary-button" disabled={submitting} aria-busy={submitting}>
                    {submitting ? "正在提交…" : "提交诊断信息"}
                  </button>
                  <small>本入口只受理人工初步判断申请；提交不代表诊断已经完成，正式诊断范围与费用须另行确认。</small>
                </div>
              </form>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
