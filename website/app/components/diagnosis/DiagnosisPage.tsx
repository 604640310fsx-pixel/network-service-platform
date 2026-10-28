import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { SiteFooter } from "../home/SiteFooter";
import { SiteHeader } from "../home/SiteHeader";
import {
  DiagnosisApiError,
  DiagnosisSubmissionAttemptManager,
  submitDiagnosisRequest,
  type BusinessScenario,
  type ContactType,
  type CurrentNetworkType,
  type DiagnosisSubmission,
  type ProblemFrequency,
  type ProblemType,
} from "../../lib/diagnosis-api";
import { useT, type Messages } from "../../lib/i18n";
import { useThemePreference } from "../../lib/theme";
import { WorkbenchBanner, workbenchBannerLayoutClass } from "../WorkbenchBanner";
import "../home/home.css";
import "./diagnosis.css";

const contactOptions: readonly ContactType[] = ["wechat", "telegram", "email", "other"];
const scenarioOptions: readonly BusinessScenario[] = [
  "tiktok_content", "live_streaming", "social_media", "ai_development", "cross_border_ecommerce", "other", "unsure",
];
const problemOptions: readonly ProblemType[] = [
  "access_failure", "performance_instability", "dns_ipv4_ipv6_udp_issue", "platform_environment_issue",
  "live_content_account_environment", "existing_network_suitability", "new_network_plan", "other_or_unsure",
];
const networkOptions: readonly CurrentNetworkType[] = [
  "home_broadband", "enterprise_network", "vps_server", "proxy_network", "unknown", "other",
];
const frequencyOptions: readonly ProblemFrequency[] = ["one_time", "intermittent", "frequent", "continuous", "unknown"];

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

function submissionErrorMessage(error: unknown, messages: Messages["diagnosis"]["errors"]): string {
  if (!(error instanceof DiagnosisApiError)) {
    return messages.generic;
  }
  switch (error.code) {
    case "invalid_request":
      return messages.invalidRequest;
    case "rate_limited":
      return messages.rateLimited;
    case "origin_rejected":
      return messages.originRejected;
    case "idempotency_key_required":
    case "idempotency_key_conflict":
      return messages.idempotency;
    case "network_error":
    case "diagnosis_unavailable":
      return messages.unavailable;
    default:
      return messages.generic;
  }
}

export function DiagnosisPage() {
  const { theme, toggleTheme } = useThemePreference();
  const copy = useT().diagnosis;
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const attemptManagerRef = useRef<DiagnosisSubmissionAttemptManager | null>(
    null,
  );
  const attemptManager =
    attemptManagerRef.current ?? new DiagnosisSubmissionAttemptManager();
  attemptManagerRef.current = attemptManager;

  useEffect(
    () => () => {
      submittingRef.current = false;
      attemptManager.clear();
    },
    [],
  );

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
    if (submittingRef.current || submitting) return;
    if (form.problemTypes.length === 0) {
      setError(copy.errors.problemRequired);
      return;
    }
    if (!form.safetyAcknowledged) {
      setError(copy.errors.safetyRequired);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const submission = submissionFromState(form);
      const idempotencyKey = attemptManager.prepare(
        submission,
        () => window.crypto.randomUUID(),
      );
      await submitDiagnosisRequest(submission, idempotencyKey);
      attemptManager.clear();
      setSubmitted(true);
      window.scrollTo({ top: 0 });
    } catch (submitError) {
      attemptManager.handleFailure(submitError);
      setError(submissionErrorMessage(submitError, copy.errors));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="cc-shell cc-home diagnosis-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />
      <main className="diagnosis-main">
        <section className="diagnosis-intro">
          <div className={workbenchBannerLayoutClass}>
            <WorkbenchBanner
              kicker="DIAGNOSIS INTAKE"
              title={copy.banner.title}
              description={copy.banner.description}
              statusLabel={copy.banner.statusLabel}
              badge={copy.banner.badge}
            />
          </div>
        </section>

        <section className="diagnosis-form-section">
          <div className="home-wrap">
            {submitted ? (
              <div className="diagnosis-result" role="status">
                <span>SUBMITTED</span>
                <h2>{copy.successTitle}</h2>
                <p>{copy.successBody}</p>
                <div>
                  <Link to="/" className="diagnosis-secondary-button">{copy.backHome}</Link>
                  <button
                    type="button"
                    className="diagnosis-primary-button"
                    onClick={() => {
                      attemptManager.clear();
                      setForm(initialForm);
                      setSubmitted(false);
                    }}
                  >
                    {copy.submitAnother}
                  </button>
                </div>
              </div>
            ) : (
              <form className="diagnosis-form" onSubmit={(event) => void submit(event)}>
                <header>
                  <div>
                    <span>INTAKE FORM</span>
                    <h2>{copy.formTitle}</h2>
                  </div>
                  <p><b>*</b> {copy.requiredNote}</p>
                </header>

                <fieldset>
                  <legend><span>01</span>{copy.sections.contact}</legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>{copy.contactType} <b>*</b></span>
                      <select value={form.contactType} onChange={(event) => update("contactType", event.target.value as ContactType)} required>
                        {contactOptions.map((value) => <option value={value} key={value}>{copy.options.contact[value]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{copy.contactValue} <b>*</b></span>
                      <input
                        type="text"
                        inputMode={form.contactType === "email" ? "email" : undefined}
                        value={form.contactValue}
                        onChange={(event) => update("contactValue", event.target.value)}
                        maxLength={200}
                        autoComplete={form.contactType === "email" ? "email" : "off"}
                        placeholder={form.contactType === "email" ? "name@example.com" : copy.contactPlaceholder}
                        required
                      />
                    </label>
                    <label>
                      <span>{copy.contactWindow}</span>
                      <input value={form.preferredContactWindow} onChange={(event) => update("preferredContactWindow", event.target.value)} maxLength={80} placeholder={copy.contactWindowPlaceholder} />
                    </label>
                    <label>
                      <span>{copy.existingCustomer}</span>
                      <select value={form.existingCustomer} onChange={(event) => update("existingCustomer", event.target.value as FormState["existingCustomer"])}>
                        <option value="">{copy.notSpecified}</option>
                        <option value="yes">{copy.yes}</option>
                        <option value="no">{copy.no}</option>
                      </select>
                    </label>
                  </div>
                </fieldset>

                <fieldset>
                  <legend><span>02</span>{copy.sections.problem}</legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>{copy.scenario} <b>*</b></span>
                      <select value={form.businessScenario} onChange={(event) => update("businessScenario", event.target.value as BusinessScenario)} required>
                        {scenarioOptions.map((value) => <option value={value} key={value}>{copy.options.scenario[value]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{copy.targetRegion} <b>*</b></span>
                      <input value={form.targetRegion} onChange={(event) => update("targetRegion", event.target.value)} maxLength={80} placeholder={copy.targetRegionPlaceholder} required />
                    </label>
                  </div>

                  <div className="diagnosis-problem-group" role="group" aria-labelledby="diagnosis-problem-label" aria-invalid={form.problemTypes.length === 0 && error !== null}>
                    <span id="diagnosis-problem-label">{copy.problems} <b>*</b><small>{copy.multiple}</small></span>
                    <div className="diagnosis-check-grid">
                      {problemOptions.map((value) => (
                        <label key={value}>
                          <input type="checkbox" checked={form.problemTypes.includes(value)} onChange={() => toggleProblem(value)} />
                          <span>{copy.options.problem[value]}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="diagnosis-wide-field">
                    <span>{copy.description} <b>*</b><small>{form.problemDescription.length}/2000</small></span>
                    <textarea
                      value={form.problemDescription}
                      onChange={(event) => update("problemDescription", event.target.value)}
                      minLength={10}
                      maxLength={2000}
                      rows={6}
                      placeholder={copy.descriptionPlaceholder}
                      required
                    />
                  </label>
                </fieldset>

                <fieldset>
                  <legend><span>03</span>{copy.sections.network} <small>{copy.optional}</small></legend>
                  <div className="diagnosis-fields is-two-column">
                    <label>
                      <span>{copy.currentRegion}</span>
                      <input value={form.currentRegion} onChange={(event) => update("currentRegion", event.target.value)} maxLength={80} />
                    </label>
                    <label>
                      <span>{copy.currentIsp}</span>
                      <input value={form.currentIsp} onChange={(event) => update("currentIsp", event.target.value)} maxLength={120} />
                    </label>
                    <label>
                      <span>{copy.currentNetwork}</span>
                      <select value={form.currentNetworkType} onChange={(event) => update("currentNetworkType", event.target.value as FormState["currentNetworkType"])}>
                        <option value="">{copy.notSpecified}</option>
                        {networkOptions.map((value) => <option value={value} key={value}>{copy.options.network[value]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{copy.frequency}</span>
                      <select value={form.problemFrequency} onChange={(event) => update("problemFrequency", event.target.value as FormState["problemFrequency"])}>
                        <option value="">{copy.notSpecified}</option>
                        {frequencyOptions.map((value) => <option value={value} key={value}>{copy.options.frequency[value]}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="diagnosis-wide-field">
                    <span>{copy.extraNotes} <small>{form.extraNotes.length}/1000</small></span>
                    <textarea value={form.extraNotes} onChange={(event) => update("extraNotes", event.target.value)} maxLength={1000} rows={4} placeholder={copy.extraNotesPlaceholder} />
                  </label>
                </fieldset>

                <div className="diagnosis-submit-area">
                  <label className="diagnosis-safety-check">
                    <input type="checkbox" checked={form.safetyAcknowledged} onChange={(event) => update("safetyAcknowledged", event.target.checked)} required />
                    <span>{copy.safetyAck}</span>
                  </label>
                  {error && <p className="diagnosis-error" role="alert">{error}</p>}
                  <button type="submit" className="diagnosis-primary-button" disabled={submitting} aria-busy={submitting}>
                    {submitting ? copy.submitting : copy.submit}
                  </button>
                  <small>{copy.footnote}</small>
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
