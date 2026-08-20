import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PaymentApiError, getMyServices, type MyServiceItem } from "../../lib/payment-api";

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

function serviceStatusLabel(status: MyServiceItem["serviceStatus"]) {
  return status === "open" ? "已开通" : "待开通";
}

function serviceErrorMessage(error: unknown) {
  if (error instanceof PaymentApiError && error.code === "unauthorized") return "登录状态已失效，请重新登录。";
  if (error instanceof PaymentApiError && error.code === "invalid_response") return "服务数据返回异常，请稍后重试。";
  return "暂时无法读取服务状态，请稍后重试。";
}

export function CurrentServicesPanel() {
  const [items, setItems] = useState<MyServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void getMyServices(controller.signal)
      .then((nextItems) => {
        if (stopped) return;
        setItems(nextItems);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (stopped) return;
        setError(serviceErrorMessage(loadError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  if (loading) {
    return (
      <div className="dash-service" role="status">
        <div className="dash-service-head"><div><strong>—</strong><small>正在读取服务状态</small></div><span className="dash-tag">加载中</span></div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="dash-service" role="alert">
        <div className="dash-service-head"><div><strong>—</strong><small>{error}</small></div><span className="dash-tag">读取失败</span></div>
        <div className="dash-service-foot"><Link className="dash-primary-link" to="/subscribe">前往套餐订阅</Link></div>
      </div>
    );
  }

  const current = [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  if (current === null) {
    return (
      <div className="dash-service">
        <div className="dash-service-head"><div><strong>—</strong><small>暂无已支付服务</small></div><span className="dash-tag">暂无服务</span></div>
        <div className="dash-service-foot">
          <p>完成付款后，可在这里查看服务开通进度。</p>
          <Link className="dash-primary-link" to="/subscribe">前往套餐订阅</Link>
        </div>
      </div>
    );
  }

  const statusLabel = serviceStatusLabel(current.serviceStatus);
  return (
    <div className="dash-service">
      <div className="dash-service-head">
        <div><strong>{current.orderRef}</strong><small>最近一项已支付服务</small></div>
        <span className="dash-tag">{statusLabel}</span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>订单编号</dt><dd>{current.orderRef}</dd></div>
        <div><dt>支付金额</dt><dd>{formatFen(current.amountFen)}</dd></div>
        <div><dt>创建时间</dt><dd>{formatDate(current.createdAt)}</dd></div>
        <div><dt>服务状态</dt><dd>{statusLabel}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>{current.serviceStatus === "open" ? "服务已完成人工开通。" : "服务正在等待人工开通，请留意状态更新。"}</p>
        <Link className="dash-primary-link" to="/subscribe">继续选择方案</Link>
      </div>
    </div>
  );
}
