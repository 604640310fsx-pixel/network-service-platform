import { useEffect, useState } from "react";
import {
  classifyAdminDiagnosisRequest,
  DiagnosisApiError,
  getAdminDiagnosisRequests,
  type AdminDiagnosisItem,
  type DiagnosisClassification,
  type DiagnosisStatus,
} from "../../lib/diagnosis-api";

const contactLabels = {
  wechat: "微信",
  telegram: "Telegram",
  email: "邮箱",
  other: "其他",
} as const;

const scenarioLabels = {
  tiktok_content: "TikTok / 内容运营",
  live_streaming: "直播",
  social_media: "社媒运营",
  ai_development: "AI / 开发",
  cross_border_ecommerce: "跨境电商",
  other: "其他",
  unsure: "暂不确定",
} as const;

const problemLabels = {
  access_failure: "无法访问或连接失败",
  performance_instability: "速度、延迟或稳定性异常",
  dns_ipv4_ipv6_udp_issue: "DNS、IPv4 / IPv6 或 UDP 问题",
  platform_environment_issue: "目标平台或环境异常",
  live_content_account_environment: "直播、内容或账号环境问题",
  existing_network_suitability: "判断现有网络是否适用",
  new_network_plan: "需要新的网络方案",
  other_or_unsure: "其他或暂不确定",
} as const;

const networkLabels = {
  home_broadband: "家庭宽带",
  enterprise_network: "企业网络",
  vps_server: "VPS / 服务器",
  proxy_network: "代理网络",
  unknown: "不清楚",
  other: "其他",
} as const;

const frequencyLabels = {
  one_time: "仅发生一次",
  intermittent: "偶尔发生",
  frequent: "频繁发生",
  continuous: "持续发生",
  unknown: "不清楚",
} as const;

const classificationOptions: ReadonlyArray<{
  value: DiagnosisClassification;
  label: string;
}> = [
  { value: "continue_as_is", label: "保持现状" },
  { value: "local_optimization", label: "局部优化" },
  { value: "need_more_info", label: "需要补充信息" },
  { value: "formal_diagnosis", label: "进入正式诊断" },
  { value: "network_plan", label: "提供网络方案" },
  { value: "out_of_scope", label: "超出服务范围" },
];

type Draft = {
  readonly classification: "" | DiagnosisClassification;
  readonly adminNote: string;
};

const emptyDraft: Draft = { classification: "", adminNote: "" };

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function classificationLabel(value: DiagnosisClassification | null): string {
  return classificationOptions.find((item) => item.value === value)?.label ?? "—";
}

function adminErrorMessage(error: unknown): string {
  if (!(error instanceof DiagnosisApiError)) {
    return "暂时无法处理诊断请求，请稍后重试。";
  }
  switch (error.code) {
    case "unauthorized": return "管理员登录状态已失效。";
    case "forbidden": return "当前账户没有诊断请求管理权限。";
    case "csrf_invalid": return "安全校验已失效，请刷新页面后重试。";
    case "invalid_transition": return "该请求已被处理，请刷新列表。";
    case "not_found": return "该诊断请求不存在，请刷新列表。";
    case "invalid_request": return "请选择有效分类，并检查管理员备注。";
    case "invalid_response": return "诊断请求数据返回异常。";
    default: return "暂时无法处理诊断请求，请稍后重试。";
  }
}

export function AdminDiagnosisPanel({ csrfToken }: { csrfToken: string | null }) {
  const [status, setStatus] = useState<DiagnosisStatus>("new");
  const [items, setItems] = useState<AdminDiagnosisItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setLoading(true);
    setError(null);
    void getAdminDiagnosisRequests(status, controller.signal)
      .then((nextItems) => {
        if (!stopped) setItems(nextItems);
      })
      .catch((loadError: unknown) => {
        if (!stopped && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setItems([]);
          setError(adminErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadKey, status]);

  function draftFor(requestId: number): Draft {
    return drafts[requestId] ?? emptyDraft;
  }

  function changeStatus(nextStatus: DiagnosisStatus) {
    if (nextStatus === status) return;
    setStatus(nextStatus);
    setItems([]);
    setError(null);
    setDrafts({});
    setRowErrors({});
  }

  function updateDraft(requestId: number, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [requestId]: { ...(current[requestId] ?? emptyDraft), ...patch },
    }));
  }

  async function markHandled(item: AdminDiagnosisItem) {
    const draft = draftFor(item.id);
    if (draft.classification === "") {
      setRowErrors((current) => ({ ...current, [item.id]: "请先选择处理分类。" }));
      return;
    }
    if (csrfToken === null) {
      setRowErrors((current) => ({ ...current, [item.id]: "安全校验尚未就绪，请刷新页面后重试。" }));
      return;
    }

    setSavingId(item.id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    try {
      const note = draft.adminNote.trim();
      await classifyAdminDiagnosisRequest(
        item.id,
        csrfToken,
        draft.classification,
        note === "" ? null : note,
      );
      setItems((current) => current.filter((request) => request.id !== item.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } catch (saveError) {
      setRowErrors((current) => ({ ...current, [item.id]: adminErrorMessage(saveError) }));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-diagnosis-title">
      <h2 id="dash-admin-diagnosis-title">
        <em>DIAGNOSIS</em>诊断请求
        <span>{loading ? "读取中" : `${items.length} 项`}</span>
      </h2>
      <div className="dash-diagnosis-toolbar" role="group" aria-label="诊断请求状态">
        <button type="button" className={status === "new" ? "is-active" : undefined} aria-pressed={status === "new"} onClick={() => changeStatus("new")}>新请求</button>
        <button type="button" className={status === "handled" ? "is-active" : undefined} aria-pressed={status === "handled"} onClick={() => changeStatus("handled")}>已处理</button>
        <button type="button" className="dash-diagnosis-refresh" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}>刷新</button>
      </div>
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      {!loading && error === null && items.length === 0 && (
        <div className="dash-service">
          <div className="dash-service-head">
            <div><strong>—</strong><small>{status === "new" ? "当前没有新的诊断请求" : "当前没有已处理的诊断请求"}</small></div>
            <span className="dash-tag">{status === "new" ? "待提交" : "已处理"}</span>
          </div>
        </div>
      )}
      <div className="dash-admin-list">
        {items.map((item) => {
          const draft = draftFor(item.id);
          return (
            <article className="dash-service dash-diagnosis-card" key={item.id}>
              <div className="dash-service-head">
                <div>
                  <strong>#{item.id} · {item.targetRegion}</strong>
                  <small>{formatDate(item.createdAt)}</small>
                </div>
                <span className={`dash-tag${item.status === "handled" ? " is-handled" : ""}`}>{item.status === "new" ? "新请求" : "已处理"}</span>
              </div>
              <dl className="dash-service-facts dash-diagnosis-facts">
                <div><dt>联系方式</dt><dd>{contactLabels[item.contactType]} · {item.contactValue}</dd></div>
                <div><dt>业务场景</dt><dd>{scenarioLabels[item.businessScenario]}</dd></div>
                <div><dt>问题类型</dt><dd>{item.problemTypes.map((problem) => problemLabels[problem]).join("、")}</dd></div>
                <div><dt>现有客户</dt><dd>{item.isExistingCustomer === null ? "—" : item.isExistingCustomer ? "是" : "否"}</dd></div>
                <div><dt>当前地区</dt><dd>{item.currentRegion ?? "—"}</dd></div>
                <div><dt>运营商 / ISP</dt><dd>{item.currentIsp ?? "—"}</dd></div>
                <div><dt>当前网络</dt><dd>{item.currentNetworkType === null ? "—" : networkLabels[item.currentNetworkType]}</dd></div>
                <div><dt>问题频率</dt><dd>{item.problemFrequency === null ? "—" : frequencyLabels[item.problemFrequency]}</dd></div>
                <div><dt>方便联系时间</dt><dd>{item.preferredContactWindow ?? "—"}</dd></div>
              </dl>
              <div className="dash-diagnosis-copy">
                <section><h3>问题描述</h3><p>{item.problemDescription}</p></section>
                {item.extraNotes && <section><h3>补充说明</h3><p>{item.extraNotes}</p></section>}
              </div>

              {item.status === "new" ? (
                <fieldset className="dash-diagnosis-form">
                  <legend>分类并标记为已处理</legend>
                  <div>
                    <label>
                      <span>处理分类</span>
                      <select value={draft.classification} onChange={(event) => updateDraft(item.id, { classification: event.target.value as Draft["classification"] })} disabled={savingId !== null}>
                        <option value="">请选择分类</option>
                        {classificationOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="dash-diagnosis-note">
                      <span>管理员备注 <small>{draft.adminNote.length}/500</small></span>
                      <textarea value={draft.adminNote} onChange={(event) => updateDraft(item.id, { adminNote: event.target.value })} maxLength={500} rows={3} disabled={savingId !== null} placeholder="选填，仅用于内部处理记录" />
                    </label>
                  </div>
                  {rowErrors[item.id] && <p className="dash-inline-error" role="alert">{rowErrors[item.id]}</p>}
                  <button type="button" className="dash-primary-link" disabled={savingId !== null || draft.classification === ""} aria-busy={savingId === item.id} onClick={() => void markHandled(item)}>
                    {savingId === item.id ? "正在处理…" : "分类并标记已处理"}
                  </button>
                </fieldset>
              ) : (
                <dl className="dash-diagnosis-resolution">
                  <div><dt>处理分类</dt><dd>{classificationLabel(item.classification)}</dd></div>
                  <div><dt>管理员备注</dt><dd>{item.adminNote ?? "—"}</dd></div>
                  <div><dt>处理时间</dt><dd>{item.handledAt === null ? "—" : formatDate(item.handledAt)}</dd></div>
                </dl>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
