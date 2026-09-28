import { useEffect, useId, useState, type FormEvent } from "react";
import {
  TICKET_BODY_MAX,
  TICKET_STATUS_LABEL,
  closeAdminTicket,
  getAdminTicket,
  listAdminTickets,
  replyToAdminTicket,
  ticketErrorMessage,
  type AdminTicketDetail,
  type AdminTicketSummary,
  type TicketStatus,
} from "../../lib/tickets-api";
import "../customer/customer-tickets.css";

/* 管理员工单处理：列表、详情、文字回复与关闭。只调用 /api/admin/tickets*，
   所有写操作携带 CSRF；正文按纯文本渲染。关闭后不可回复或重开（MVP）。 */

type Filter = TicketStatus | "all";

const FILTERS: ReadonlyArray<[Filter, string]> = [
  ["all", "全部"],
  ["open", TICKET_STATUS_LABEL.open],
  ["answered", TICKET_STATUS_LABEL.answered],
  ["closed", TICKET_STATUS_LABEL.closed],
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function TicketDetailView({
  ticketRef,
  csrfToken,
  onChanged,
}: {
  ticketRef: string;
  csrfToken: string | null;
  onChanged: (updated: AdminTicketDetail) => void;
}) {
  const replyId = useId();
  const [ticket, setTicket] = useState<AdminTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setTicket(null);
    setError(null);
    void getAdminTicket(ticketRef, controller.signal)
      .then(setTicket)
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException)) setError(ticketErrorMessage(loadError));
      });
    return () => controller.abort();
  }, [ticketRef]);

  if (error !== null && ticket === null) return <p className="dash-inline-error" role="alert">{error}</p>;
  if (ticket === null) return <p className="dash-ticket-loading" role="status">正在读取工单…</p>;
  const current = ticket;
  const replyValid = reply.trim().length > 0 && reply.trim().length <= TICKET_BODY_MAX;

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replyValid || busy || csrfToken === null) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await replyToAdminTicket(csrfToken, current.ref, reply.trim());
      setTicket(updated);
      setReply("");
      onChanged(updated);
    } catch (replyError) {
      setError(ticketErrorMessage(replyError));
    } finally {
      setBusy(false);
    }
  }

  async function handleClose() {
    if (busy || csrfToken === null) return;
    if (!window.confirm("关闭后客户与管理员都不能再回复，且无法重开。确认关闭该工单？")) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await closeAdminTicket(csrfToken, current.ref);
      setTicket(updated);
      onChanged(updated);
    } catch (closeError) {
      setError(ticketErrorMessage(closeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dash-ticket-detail">
      <ol className="cc-tk-thread" aria-label={`工单 ${current.ref} 消息`}>
        {current.messages.map((message, index) => (
          <li key={`${message.createdAt}-${index}`} className={message.role === "admin" ? "is-admin" : "is-customer"}>
            <div className="cc-tk-meta">
              <b>{message.role === "admin" ? "客服" : "客户"}</b>
              <small>{formatDate(message.createdAt)}</small>
            </div>
            <p className="cc-tk-body">{message.body}</p>
          </li>
        ))}
      </ol>
      {current.status === "closed" ? (
        <p className="cc-tk-closed">该工单已关闭{current.closedAt ? `（${formatDate(current.closedAt)}）` : ""}，不可回复或重开。</p>
      ) : (
        <form className="cc-tk-form" onSubmit={handleReply}>
          <label htmlFor={replyId}>回复客户</label>
          <textarea
            id={replyId}
            rows={3}
            maxLength={TICKET_BODY_MAX}
            value={reply}
            disabled={busy}
            onChange={(event) => setReply(event.target.value)}
          />
          <div className="dash-coupon-controls">
            <button type="submit" disabled={!replyValid || busy || csrfToken === null}>
              {busy ? "正在处理…" : "发送回复"}
            </button>
            <button type="button" disabled={busy || csrfToken === null} onClick={() => void handleClose()}>
              关闭工单
            </button>
          </div>
        </form>
      )}
      {error !== null && <p className="dash-inline-error" role="alert">{error}</p>}
    </div>
  );
}

export function AdminTicketsPanel({ csrfToken }: { csrfToken: string | null }) {
  const filterId = useId();
  const [filter, setFilter] = useState<Filter>("open");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<readonly AdminTicketSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listAdminTickets(filter, page, controller.signal)
      .then((result) => {
        setItems(result.items);
        setHasMore(result.hasMore);
      })
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException)) setError(ticketErrorMessage(loadError));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [filter, page]);

  // 就地更新已处理的工单，保持详情展开；即使它已不再符合当前筛选，也等切换筛选或翻页时才移出列表。
  function applyUpdate(updated: AdminTicketDetail) {
    setItems((current) =>
      current.map((item) =>
        item.ref === updated.ref
          ? {
              ref: updated.ref,
              subject: updated.subject,
              status: updated.status,
              serviceOrderRef: updated.serviceOrderRef,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              closedAt: updated.closedAt,
              messageCount: updated.messageCount,
              lastMessageRole: updated.lastMessageRole,
              customerEmail: updated.customerEmail,
            }
          : item,
      ),
    );
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-tickets-title">
      <h2 id="dash-admin-tickets-title">
        <em>TICKETS</em>客户工单
        <span>{loading ? "读取中" : `第 ${page} 页 · ${items.length} 项`}</span>
      </h2>

      <div className="dash-coupon-create-grid dash-ticket-filter">
        <label htmlFor={filterId}>
          状态
          <select
            id={filterId}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
              setPage(1);
              setExpanded(null);
            }}
          >
            {FILTERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      {!loading && error === null && items.length === 0 && (
        <div className="dash-service">
          <div className="dash-service-head">
            <div>
              <strong>—</strong>
              <small>当前筛选下没有工单</small>
            </div>
          </div>
        </div>
      )}

      <div className="dash-admin-list">
        {items.map((item) => (
          <article className="dash-service" key={item.ref}>
            <div className="dash-service-head">
              <div>
                <strong className="cc-tk-subject">{item.subject}</strong>
                <small>{item.ref} · {item.customerEmail} · 更新于 {formatDate(item.updatedAt)}</small>
              </div>
              <span className="dash-tag">{TICKET_STATUS_LABEL[item.status]}</span>
            </div>
            <dl className="dash-service-facts">
              <div><dt>消息</dt><dd>{item.messageCount} 条</dd></div>
              <div><dt>最近发言</dt><dd>{item.lastMessageRole === "admin" ? "客服" : "客户"}</dd></div>
              <div><dt>关联服务</dt><dd>{item.serviceOrderRef ?? "未关联"}</dd></div>
            </dl>
            <div className="dash-coupon-controls">
              <button
                type="button"
                aria-expanded={expanded === item.ref}
                onClick={() => setExpanded((current) => (current === item.ref ? null : item.ref))}
              >
                {expanded === item.ref ? "收起" : "查看与处理"}
              </button>
            </div>
            {expanded === item.ref && (
              <TicketDetailView ticketRef={item.ref} csrfToken={csrfToken} onChanged={applyUpdate} />
            )}
          </article>
        ))}
      </div>

      {(page > 1 || hasMore) && (
        <div className="dash-coupon-controls">
          <button type="button" disabled={page <= 1 || loading} onClick={() => { setPage((p) => p - 1); setExpanded(null); }}>上一页</button>
          <button type="button" disabled={!hasMore || loading} onClick={() => { setPage((p) => p + 1); setExpanded(null); }}>下一页</button>
        </div>
      )}
    </section>
  );
}
