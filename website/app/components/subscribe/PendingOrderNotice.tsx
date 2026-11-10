import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { getMyOrders, type MyOrderItem } from "../../lib/payment-api";

/** Read-only list, never the payment-status GET that can query Alipay. */
export function PendingOrderNotice() {
  const { status } = useAuth();
  const copy = useT().subscribe.configurator;
  const [pending, setPending] = useState<readonly MyOrderItem[]>([]);
  useEffect(() => {
    setPending([]);
    if (status !== "authenticated") return;
    const controller = new AbortController();
    void getMyOrders(controller.signal).then(items => {
      if (!controller.signal.aborted) setPending(items.filter(item => item.status === "pending"));
    }).catch(() => { /* No invented count; the existing orders page exposes recovery. */ });
    return () => controller.abort();
  }, [status]);
  if (!pending.length) return null;
  return <div className="sub-pending-orders" role="status">
    <span>{copy.pendingCount(pending.length)}</span>
    <Link to={`/subscribe/request?orderRef=${encodeURIComponent(pending[0]!.orderRef)}`}>{copy.continuePayment}</Link>
    <Link to="/orders">{copy.orders}</Link>
  </div>;
}
