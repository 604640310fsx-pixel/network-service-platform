import { useEffect, useState } from "react";
import {
  PaymentApiError,
  getAdminPendingServices,
  openAdminService,
  type AdminPendingServiceItem,
} from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";

const SCENARIO_LABELS: Record<string, string> = {
  ai: "AI 工具",
  social: "TikTok / 社媒",
  work: "跨境办公",
  other: "其他",
};

function formatFen(amountFen: number) {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function adminErrorMessage(error: unknown) {
  if (!(error instanceof PaymentApiError)) return "暂时无法读取待开通服务，请稍后重试。";
  switch (error.code) {
    case "unauthorized": return "管理员登录状态已失效。";
    case "forbidden": return "当前账户没有人工开通权限。";
    case "csrf_invalid": return "安全校验已失效，请刷新页面后重试。";
    case "invalid_transition": return "该服务状态已变化，请刷新后确认。";
    case "invalid_response": return "待开通服务数据返回异常。";
    default: return "暂时无法处理待开通服务，请稍后重试。";
  }
}

export function AdminPendingServices({ csrfToken }: { csrfToken: string | null }) {
  const [items, setItems] = useState<AdminPendingServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void getAdminPendingServices(controller.signal)
      .then((nextItems) => {
        if (stopped) return;
        setItems(nextItems);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!stopped) setError(adminErrorMessage(loadError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  async function markOpen(serviceId: number) {
    if (openingId !== null) return;
    if (csrfToken === null) {
      setError("安全校验尚未就绪，请刷新页面后重试。");
      return;
    }
    setOpeningId(serviceId);
    setError(null);
    try {
      await openAdminService(serviceId, csrfToken);
      setItems((current) => current.filter((item) => item.serviceId !== serviceId));
    } catch (openError) {
      setError(adminErrorMessage(openError));
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-services-title">
      <h2 id="dash-admin-services-title"><em>DELIVERY</em>待开通服务<span>{loading ? "读取中" : `${items.length} 项`}</span></h2>
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      {!loading && items.length === 0 && error === null && (
        <div className="dash-service"><div className="dash-service-head"><div><strong>—</strong><small>当前没有待开通服务</small></div><span className="dash-tag">已处理</span></div></div>
      )}
      <div className="dash-admin-list">
        {items.map((item) => {
          const { summary } = resolveSelection({
            typeId: item.typeId,
            regionId: item.regionId,
            ispId: item.ispId,
            specId: item.specId,
            durationId: item.durationId,
          });
          const scenarios = item.scenarios.length === 0
            ? "—"
            : item.scenarios.map((scenario) => SCENARIO_LABELS[scenario] ?? scenario).join("、");
          return (
            <article className="dash-service" key={item.serviceId}>
              <div className="dash-service-head">
                <div><strong>{item.orderRef}</strong><small>{formatDate(item.createdAt)}</small></div>
                <span className="dash-tag">待开通</span>
              </div>
              <dl className="dash-service-facts">
                <div><dt>网络类型</dt><dd>{summary.type}</dd></div>
                <div><dt>国家/地区</dt><dd>{summary.region}</dd></div>
                <div><dt>运营商</dt><dd>{summary.isp}</dd></div>
                <div><dt>规格</dt><dd>{summary.spec}</dd></div>
                <div><dt>周期</dt><dd>{summary.duration}</dd></div>
                <div><dt>支付金额</dt><dd>{formatFen(item.amountFen)}</dd></div>
                <div><dt>联系方式</dt><dd>{item.contact}</dd></div>
                <div><dt>使用场景</dt><dd>{scenarios}</dd></div>
                <div><dt>补充说明</dt><dd>{item.notes?.trim() || "—"}</dd></div>
              </dl>
              <div className="dash-service-foot">
                <p>确认真实服务已处理完成后，再标记为已开通。</p>
                <button
                  type="button"
                  className="dash-primary-link"
                  disabled={openingId !== null}
                  aria-busy={openingId === item.serviceId}
                  onClick={() => void markOpen(item.serviceId)}
                >
                  {openingId === item.serviceId ? "正在更新…" : "标记已开通"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
