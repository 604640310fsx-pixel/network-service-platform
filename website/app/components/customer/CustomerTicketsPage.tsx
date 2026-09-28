import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { getMyServices, type MyServiceItem } from "../../lib/payment-api";
import {
  TICKET_BODY_MAX,
  TICKET_STATUS_LABEL,
  TICKET_SUBJECT_MAX,
  TicketApiError,
  createMyTicket,
  getMyTicket,
  isTicketRef,
  listMyTickets,
  replyToMyTicket,
  ticketErrorMessage,
  type TicketDetail,
  type TicketPage,
  type TicketStatus,
  type TicketSummary,
} from "../../lib/tickets-api";
import "./customer-orders.css";
import "./customer-tickets.css";

/* /tickets 客户中心「工单」页：列表、新建、详情与文字回复。数据只来自
   /api/me/tickets*；正文一律按纯文本渲染（React 文本节点 + pre-wrap），
   不渲染 HTML。不承诺响应时效、不展示附件、通知或满意度。 */

const STATUS_MODIFIER: Record<TicketStatus, string> = {
  open: "is-pending",
  answered: "is-paid",
  closed: "is-closed",
};

function formatDate(value: string): string {
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof TicketApiError && error.code === "unauthorized";
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-ord-page">
      <div className="cc-ord-layout">{children}</div>
    </main>
  );
}

function PanelHead({ title, tag }: { title: string; tag: string }) {
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>TICKETS</em>
        <h2>{title}</h2>
      </div>
      <span className="cc-ord-tag">{tag}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`cc-ord-badge ${STATUS_MODIFIER[status]}`}>{TICKET_STATUS_LABEL[status]}</span>;
}

// 会话失效时整页导航到 /login，强制重新检查会话（与订单页一致）。
function SignedOutNotice() {
  return (
    <section className="cc-ord-panel" role="alert">
      <PanelHead title="工单" tag="登录失效" />
      <div className="cc-ord-notice">
        <p className="cc-ord-notice-title">登录状态已失效，请重新登录。</p>
        <p className="cc-ord-notice-hint">重新登录后即可查看和提交工单。</p>
        <div className="cc-ord-notice-actions">
          <a className="cc-ord-primary" href="/login">重新登录</a>
        </div>
      </div>
    </section>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <section className="cc-ord-panel" role="alert">
      <PanelHead title="工单" tag="读取失败" />
      <div className="cc-ord-notice">
        <p className="cc-ord-notice-title">{message}</p>
        <div className="cc-ord-notice-actions">
          {onRetry && <button type="button" className="cc-ord-primary" onClick={onRetry}>重新加载</button>}
          <Link className="cc-ord-ghost" to="/tickets">返回工单列表</Link>
        </div>
      </div>
    </section>
  );
}

type Load<Value> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: Value }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

function TicketList({ page }: { page: number }) {
  const [, setSearchParams] = useSearchParams();
  const [state, setState] = useState<Load<TicketPage<TicketSummary>>>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void listMyTickets(page, controller.signal)
      .then((value) => !stopped && setState({ kind: "ready", value }))
      .catch((error: unknown) => {
        if (stopped) return;
        setState(isUnauthorized(error) ? { kind: "unauthorized" } : { kind: "error", message: ticketErrorMessage(error) });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [page, reload]);

  if (state.kind === "unauthorized") return <SignedOutNotice />;
  if (state.kind === "error") return <ErrorNotice message={state.message} onRetry={() => setReload((n) => n + 1)} />;
  if (state.kind === "loading") {
    return (
      <section className="cc-ord-panel" role="status" aria-live="polite" aria-busy="true">
        <PanelHead title="我的工单" tag="加载中" />
        <ul className="cc-ord-skeleton" aria-hidden="true"><li /><li /><li /></ul>
        <p className="cc-ord-status-text">正在读取工单…</p>
      </section>
    );
  }

  const { items, hasMore } = state.value;
  return (
    <section className="cc-ord-panel">
      <PanelHead title="我的工单" tag={`第 ${page} 页`} />
      <div className="cc-tk-toolbar">
        <Link className="cc-ord-primary" to="/tickets?new=1">新建工单</Link>
      </div>
      {items.length === 0 ? (
        <div className="cc-ord-notice">
          <p className="cc-ord-notice-title">{page === 1 ? "暂无工单" : "这一页没有工单"}</p>
          <p className="cc-ord-notice-hint">遇到服务问题时，可新建工单描述情况，客服会在工单内以文字回复。</p>
        </div>
      ) : (
        <ul className="cc-ord-list">
          {items.map((item) => (
            <li className="cc-ord-item" key={item.ref}>
              <div className="cc-ord-item-head">
                <div className="cc-ord-item-id">
                  <strong className="cc-tk-subject">{item.subject}</strong>
                  <small>{item.ref} · 更新于 {formatDate(item.updatedAt)}</small>
                </div>
                <StatusBadge status={item.status} />
              </div>
              <dl className="cc-ord-facts">
                <div><dt>消息</dt><dd>{item.messageCount} 条</dd></div>
                <div><dt>最近回复</dt><dd>{item.lastMessageRole === "admin" ? "客服" : "我"}</dd></div>
                <div><dt>关联服务</dt><dd>{item.serviceOrderRef ?? "未关联"}</dd></div>
              </dl>
              <div className="cc-ord-item-foot">
                <Link className="cc-ord-ghost" to={`/tickets?ref=${encodeURIComponent(item.ref)}`}>查看工单</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || hasMore) && (
        <nav className="cc-tk-pager" aria-label="工单分页">
          <button type="button" className="cc-ord-ghost" disabled={page <= 1} onClick={() => setSearchParams({ page: String(page - 1) })}>上一页</button>
          <button type="button" className="cc-ord-ghost" disabled={!hasMore} onClick={() => setSearchParams({ page: String(page + 1) })}>下一页</button>
        </nav>
      )}
    </section>
  );
}

function NewTicketForm() {
  const { csrfToken } = useAuth();
  const [, setSearchParams] = useSearchParams();
  const subjectId = useId();
  const bodyId = useId();
  const serviceId = useId();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [serviceOrderRef, setServiceOrderRef] = useState("");
  const [services, setServices] = useState<readonly MyServiceItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // 服务列表只用于可选关联；读取失败时仍可不关联服务提交。
    void getMyServices(controller.signal).then(setServices).catch(() => setServices([]));
    return () => controller.abort();
  }, []);

  const subjectValid = subject.trim().length > 0 && subject.trim().length <= TICKET_SUBJECT_MAX && !/[\r\n]/.test(subject);
  const bodyValid = body.trim().length > 0 && body.trim().length <= TICKET_BODY_MAX;
  const canSubmit = csrfToken !== null && subjectValid && bodyValid && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || csrfToken === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const ticket = await createMyTicket(csrfToken, {
        subject: subject.trim(),
        body: body.trim(),
        serviceOrderRef: serviceOrderRef === "" ? null : serviceOrderRef,
      });
      setSearchParams({ ref: ticket.ref });
    } catch (submitError) {
      if (isUnauthorized(submitError)) setSignedOut(true);
      else setError(ticketErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  if (signedOut) return <SignedOutNotice />;
  return (
    <section className="cc-ord-panel">
      <PanelHead title="新建工单" tag="纯文本" />
      <form className="cc-tk-form" onSubmit={handleSubmit}>
        <label htmlFor={subjectId}>主题</label>
        <input
          id={subjectId}
          type="text"
          maxLength={TICKET_SUBJECT_MAX}
          value={subject}
          disabled={submitting}
          placeholder="一句话概括问题"
          onChange={(event) => setSubject(event.target.value)}
        />
        <label htmlFor={serviceId}>关联服务（可选）</label>
        <select id={serviceId} value={serviceOrderRef} disabled={submitting} onChange={(event) => setServiceOrderRef(event.target.value)}>
          <option value="">不关联服务</option>
          {services.map((service) => (
            <option key={service.orderRef} value={service.orderRef}>
              {service.orderRef} · {service.serviceStatus === "open" ? "已开通" : "待开通"}
            </option>
          ))}
        </select>
        <label htmlFor={bodyId}>问题描述</label>
        <textarea
          id={bodyId}
          rows={6}
          maxLength={TICKET_BODY_MAX}
          value={body}
          disabled={submitting}
          placeholder="描述现象、出现时间和已尝试的操作。请勿填写密码或密钥。"
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="cc-tk-counter">{body.trim().length} / {TICKET_BODY_MAX}</p>
        {error && <p className="cc-tk-error" role="alert">{error}</p>}
        <div className="cc-ord-notice-actions">
          <button type="submit" className="cc-ord-primary" disabled={!canSubmit} aria-busy={submitting}>
            {submitting ? "正在提交…" : "提交工单"}
          </button>
          <Link className="cc-ord-ghost" to="/tickets">取消</Link>
        </div>
      </form>
    </section>
  );
}

function TicketThread({ ticketRef }: { ticketRef: string }) {
  const { csrfToken } = useAuth();
  const replyId = useId();
  const [state, setState] = useState<Load<TicketDetail>>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyTicket(ticketRef, controller.signal)
      .then((value) => !stopped && setState({ kind: "ready", value }))
      .catch((loadError: unknown) => {
        if (stopped) return;
        setState(isUnauthorized(loadError) ? { kind: "unauthorized" } : { kind: "error", message: ticketErrorMessage(loadError) });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [ticketRef, reload]);

  if (state.kind === "unauthorized") return <SignedOutNotice />;
  if (state.kind === "error") return <ErrorNotice message={state.message} onRetry={() => setReload((n) => n + 1)} />;
  if (state.kind === "loading") {
    return (
      <section className="cc-ord-panel" role="status" aria-live="polite" aria-busy="true">
        <PanelHead title="工单详情" tag="加载中" />
        <p className="cc-ord-status-text">正在读取工单…</p>
      </section>
    );
  }

  const ticket = state.value;
  const replyValid = reply.trim().length > 0 && reply.trim().length <= TICKET_BODY_MAX;

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replyValid || sending || csrfToken === null) return;
    setSending(true);
    setError(null);
    try {
      const updated = await replyToMyTicket(csrfToken, ticket.ref, reply.trim());
      setReply("");
      setState({ kind: "ready", value: updated });
    } catch (replyError) {
      if (isUnauthorized(replyError)) setState({ kind: "unauthorized" });
      else setError(ticketErrorMessage(replyError));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="cc-ord-panel">
      <PanelHead title="工单详情" tag={ticket.ref} />
      <div className="cc-ord-item-head cc-tk-detail-head">
        <div className="cc-ord-item-id">
          <strong className="cc-tk-subject">{ticket.subject}</strong>
          <small>创建于 {formatDate(ticket.createdAt)}{ticket.serviceOrderRef ? ` · 关联服务 ${ticket.serviceOrderRef}` : ""}</small>
        </div>
        <StatusBadge status={ticket.status} />
      </div>
      <ol className="cc-tk-thread" aria-label="工单消息">
        {ticket.messages.map((message, index) => (
          <li key={`${message.createdAt}-${index}`} className={message.role === "admin" ? "is-admin" : "is-customer"}>
            <div className="cc-tk-meta">
              <b>{message.role === "admin" ? "客服" : "我"}</b>
              <small>{formatDate(message.createdAt)}</small>
            </div>
            <p className="cc-tk-body">{message.body}</p>
          </li>
        ))}
      </ol>
      {ticket.status === "closed" ? (
        <p className="cc-tk-closed">该工单已由客服关闭，无法继续回复。如有新问题，请新建工单。</p>
      ) : (
        <form className="cc-tk-form" onSubmit={handleReply}>
          <label htmlFor={replyId}>回复</label>
          <textarea
            id={replyId}
            rows={4}
            maxLength={TICKET_BODY_MAX}
            value={reply}
            disabled={sending}
            placeholder="补充信息或回复客服。请勿填写密码或密钥。"
            onChange={(event) => setReply(event.target.value)}
          />
          {error && <p className="cc-tk-error" role="alert">{error}</p>}
          <div className="cc-ord-notice-actions">
            <button type="submit" className="cc-ord-primary" disabled={!replyValid || sending || csrfToken === null} aria-busy={sending}>
              {sending ? "正在发送…" : "发送回复"}
            </button>
          </div>
        </form>
      )}
      <div className="cc-ord-item-foot">
        <Link className="cc-ord-ghost" to="/tickets">返回工单列表</Link>
      </div>
    </section>
  );
}

export function CustomerTicketsPage() {
  const [searchParams] = useSearchParams();
  const ref = searchParams.get("ref");
  const pageParam = Number(searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(pageParam) && pageParam >= 1 && pageParam <= 500 ? pageParam : 1;

  return (
    <PageFrame>
      {ref !== null ? (
        isTicketRef(ref) ? <TicketThread ticketRef={ref} /> : <ErrorNotice message="未找到该工单。" />
      ) : searchParams.get("new") === "1" ? (
        <NewTicketForm />
      ) : (
        <TicketList page={page} />
      )}
    </PageFrame>
  );
}
