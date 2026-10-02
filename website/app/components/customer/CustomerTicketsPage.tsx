import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useI18n, useT } from "../../lib/i18n";
import { getMyServices, type MyServiceItem } from "../../lib/payment-api";
import {
  TICKET_BODY_MAX,
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

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
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

function PanelHead({ title, tag, action }: { title: string; tag?: string; action?: React.ReactNode }) {
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>TICKETS</em>
        <h2>{title}</h2>
      </div>
      {action ?? (tag !== undefined && <span className="cc-ord-tag">{tag}</span>)}
    </div>
  );
}

function NewTicketLink({ className = "cc-ord-primary cc-tk-new" }: { className?: string }) {
  const t = useT();
  return (
    <Link className={className} to="/tickets?new=1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      {t.tickets.newTicket}
    </Link>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const t = useT();
  return <span className={`cc-ord-badge ${STATUS_MODIFIER[status]}`}>{t.tickets.status[status]}</span>;
}

// 会话失效时整页导航到 /login，强制重新检查会话（与订单页一致）。
function SignedOutNotice() {
  const copy = useT().tickets;
  return (
    <section className="cc-ord-panel" role="alert">
      <PanelHead title={copy.pageTitle} tag={copy.signedOutTag} />
      <div className="cc-ord-notice">
        <p className="cc-ord-notice-title">{copy.signedOutTitle}</p>
        <p className="cc-ord-notice-hint">{copy.signedOutHint}</p>
        <div className="cc-ord-notice-actions">
          <a className="cc-ord-primary" href="/login">{copy.signInAgain}</a>
        </div>
      </div>
    </section>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const copy = useT().tickets;
  return (
    <section className="cc-ord-panel" role="alert">
      <PanelHead title={copy.pageTitle} tag={copy.loadFailedTag} />
      <div className="cc-ord-notice">
        <p className="cc-ord-notice-title">{message}</p>
        <div className="cc-ord-notice-actions">
          {onRetry && <button type="button" className="cc-ord-primary" onClick={onRetry}>{copy.reload}</button>}
          <Link className="cc-ord-ghost" to="/tickets">{copy.backToList}</Link>
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
  const { t } = useI18n();
  const copy = t.tickets;
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
        setState(isUnauthorized(error) ? { kind: "unauthorized" } : { kind: "error", message: ticketErrorMessage(error, copy.errors) });
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
        <PanelHead title={copy.myTickets} tag={copy.loadingTag} />
        <ul className="cc-ord-skeleton" aria-hidden="true"><li /><li /><li /></ul>
        <p className="cc-ord-status-text">{copy.loading}</p>
      </section>
    );
  }

  const { items, hasMore } = state.value;
  return (
    <section className="cc-ord-panel">
      <PanelHead title={copy.myTickets} action={<NewTicketLink />} />
      {items.length === 0 ? (
        <div className="cc-tk-empty">
          <span className="cc-tk-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12.5h5" /></svg>
          </span>
          <p className="cc-tk-empty-title">{page === 1 ? copy.emptyFirst : copy.emptyPage}</p>
          <p className="cc-tk-empty-hint">{copy.emptyHint}</p>
          {page === 1 ? <NewTicketLink className="cc-ord-primary" /> : <Link className="cc-ord-ghost" to="/tickets">{copy.firstPage}</Link>}
        </div>
      ) : (
        <ul className="cc-tk-list">
          {items.map((item) => (
            <li key={item.ref}>
              <Link className="cc-tk-row" to={`/tickets?ref=${encodeURIComponent(item.ref)}`}>
                <span className="cc-tk-row-main">
                  <strong className="cc-tk-subject">{item.subject}</strong>
                  <small>{copy.updatedAt(item.ref, formatDate(item.updatedAt, copy.dateLocale))}</small>
                </span>
                <span className="cc-tk-row-meta">
                  <span>{copy.messageCount(item.messageCount)}</span>
                  <span>{copy.lastReply(item.lastMessageRole === "admin" ? copy.support : copy.me)}</span>
                  <span>{item.serviceOrderRef ?? copy.noService}</span>
                </span>
                <StatusBadge status={item.status} />
                <svg className="cc-tk-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || hasMore) && (
        <nav className="cc-tk-pager" aria-label={copy.pagerLabel}>
          <button type="button" className="cc-ord-ghost" disabled={page <= 1} onClick={() => setSearchParams({ page: String(page - 1) })}>{copy.prevPage}</button>
          <span className="cc-tk-page">{copy.pageNumber(page)}</span>
          <button type="button" className="cc-ord-ghost" disabled={!hasMore} onClick={() => setSearchParams({ page: String(page + 1) })}>{copy.nextPage}</button>
        </nav>
      )}
    </section>
  );
}

function NewTicketForm() {
  const { csrfToken } = useAuth();
  const copy = useT().tickets;
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
      else setError(ticketErrorMessage(submitError, copy.errors));
    } finally {
      setSubmitting(false);
    }
  }

  if (signedOut) return <SignedOutNotice />;
  return (
    <section className="cc-ord-panel">
      <PanelHead title={copy.newTicket} tag={copy.plainTextTag} />
      <form className="cc-tk-form" onSubmit={handleSubmit}>
        <label htmlFor={subjectId}>{copy.subjectLabel}</label>
        <input
          id={subjectId}
          type="text"
          maxLength={TICKET_SUBJECT_MAX}
          value={subject}
          disabled={submitting}
          placeholder={copy.subjectPlaceholder}
          onChange={(event) => setSubject(event.target.value)}
        />
        <label htmlFor={serviceId}>{copy.serviceLabel}</label>
        <select id={serviceId} value={serviceOrderRef} disabled={submitting} onChange={(event) => setServiceOrderRef(event.target.value)}>
          <option value="">{copy.noServiceOption}</option>
          {services.map((service) => (
            <option key={service.orderRef} value={service.orderRef}>
              {service.orderRef} · {service.serviceStatus === "open" ? copy.serviceOpen : copy.servicePending}
            </option>
          ))}
        </select>
        <label htmlFor={bodyId}>{copy.bodyLabel}</label>
        <textarea
          id={bodyId}
          rows={6}
          maxLength={TICKET_BODY_MAX}
          value={body}
          disabled={submitting}
          placeholder={copy.bodyPlaceholder}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="cc-tk-counter">{body.trim().length} / {TICKET_BODY_MAX}</p>
        {error && <p className="cc-tk-error" role="alert">{error}</p>}
        <div className="cc-ord-notice-actions">
          <button type="submit" className="cc-ord-primary" disabled={!canSubmit} aria-busy={submitting}>
            {submitting ? copy.submitting : copy.submit}
          </button>
          <Link className="cc-ord-ghost" to="/tickets">{copy.cancel}</Link>
        </div>
      </form>
    </section>
  );
}

function TicketThread({ ticketRef }: { ticketRef: string }) {
  const { csrfToken } = useAuth();
  const copy = useT().tickets;
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
        setState(isUnauthorized(loadError) ? { kind: "unauthorized" } : { kind: "error", message: ticketErrorMessage(loadError, copy.errors) });
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
        <PanelHead title={copy.detailTitle} tag={copy.loadingTag} />
        <p className="cc-ord-status-text">{copy.loading}</p>
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
      else setError(ticketErrorMessage(replyError, copy.errors));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="cc-ord-panel">
      <PanelHead title={copy.detailTitle} tag={ticket.ref} />
      <div className="cc-ord-item-head cc-tk-detail-head">
        <div className="cc-ord-item-id">
          <strong className="cc-tk-subject">{ticket.subject}</strong>
          <small>{copy.createdAt(formatDate(ticket.createdAt, copy.dateLocale))}{ticket.serviceOrderRef ? copy.linkedService(ticket.serviceOrderRef) : ""}</small>
        </div>
        <StatusBadge status={ticket.status} />
      </div>
      <ol className="cc-tk-thread" aria-label={copy.threadLabel}>
        {ticket.messages.map((message, index) => (
          <li key={`${message.createdAt}-${index}`} className={message.role === "admin" ? "is-admin" : "is-customer"}>
            <div className="cc-tk-meta">
              <b>{message.role === "admin" ? copy.support : copy.me}</b>
              <small>{formatDate(message.createdAt, copy.dateLocale)}</small>
            </div>
            <p className="cc-tk-body">{message.body}</p>
          </li>
        ))}
      </ol>
      {ticket.status === "closed" ? (
        <p className="cc-tk-closed">{copy.closedNotice}</p>
      ) : (
        <form className="cc-tk-form" onSubmit={handleReply}>
          <label htmlFor={replyId}>{copy.replyLabel}</label>
          <textarea
            id={replyId}
            rows={4}
            maxLength={TICKET_BODY_MAX}
            value={reply}
            disabled={sending}
            placeholder={copy.replyPlaceholder}
            onChange={(event) => setReply(event.target.value)}
          />
          {error && <p className="cc-tk-error" role="alert">{error}</p>}
          <div className="cc-ord-notice-actions">
            <button type="submit" className="cc-ord-primary" disabled={!replyValid || sending || csrfToken === null} aria-busy={sending}>
              {sending ? copy.sending : copy.sendReply}
            </button>
          </div>
        </form>
      )}
      <div className="cc-ord-item-foot">
        <Link className="cc-ord-ghost" to="/tickets">{copy.backToList}</Link>
      </div>
    </section>
  );
}

export function CustomerTicketsPage() {
  const copy = useT().tickets;
  const [searchParams] = useSearchParams();
  const ref = searchParams.get("ref");
  const pageParam = Number(searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(pageParam) && pageParam >= 1 && pageParam <= 500 ? pageParam : 1;

  return (
    <PageFrame>
      {ref !== null ? (
        isTicketRef(ref) ? <TicketThread ticketRef={ref} /> : <ErrorNotice message={copy.notFound} />
      ) : searchParams.get("new") === "1" ? (
        <NewTicketForm />
      ) : (
        <TicketList page={page} />
      )}
    </PageFrame>
  );
}
