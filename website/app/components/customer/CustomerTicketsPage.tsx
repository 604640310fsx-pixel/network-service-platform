import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useI18n, useT, type Messages } from "../../lib/i18n";
import { getMyServiceListing, PaymentApiError, type MyServiceListing } from "../../lib/payment-api";
import {
  TICKET_BODY_MAX,
  TICKET_IMAGE_MAX_BYTES,
  TICKET_IMAGE_TYPES,
  TICKET_IMAGES_PER_MESSAGE,
  TICKET_SUBJECT_MAX,
  TicketApiError,
  createMyTicket,
  getMyTicket,
  isTicketRef,
  listMyTickets,
  replyToMyTicket,
  ticketErrorMessage,
  type TicketAttachment,
  type TicketAttachmentUpload,
  type TicketDetail,
  type TicketImageContentType,
  type TicketPage,
  type TicketServiceLink,
  type TicketStatus,
  type TicketSummary,
} from "../../lib/tickets-api";
import "./customer-orders.css";
import "./customer-tickets.css";

/* /tickets 客户中心「工单」页：列表、新建、详情与回复（文字 + 最多 3 张图片）。数据只来自
   /api/me/tickets*；正文一律按纯文本渲染（React 文本节点 + pre-wrap），不渲染 HTML；
   图片只从同源工单接口读取。不承诺响应时效、通知或满意度。 */

type TicketCopy = Messages["tickets"];

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

type ServiceLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: MyServiceListing }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

/* ---------- 图片：选择、预览、移除 ---------- */

type PickedImage = {
  readonly id: number;
  readonly name: string;
  readonly file: File;
  readonly contentType: TicketImageContentType;
  readonly previewUrl: string;
};

function isTicketImageType(value: string): value is TicketImageContentType {
  return TICKET_IMAGE_TYPES.includes(value as TicketImageContentType);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("read_failed"));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/* 客户端只做类型 / 体积 / 数量的预检，真实图片结构由服务端按字节复核。
   预览用 object URL，移除或卸载时释放。 */
function useImagePicker(copy: TicketCopy) {
  const [images, setImages] = useState<readonly PickedImage[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const nextId = useRef(1);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), []);

  function add(files: FileList | null) {
    if (files === null || files.length === 0) return;
    let error: string | null = null;
    const accepted: PickedImage[] = [];
    for (const file of Array.from(files)) {
      if (images.length + accepted.length >= TICKET_IMAGES_PER_MESSAGE) {
        error = copy.errors.invalidAttachments(TICKET_IMAGES_PER_MESSAGE);
        break;
      }
      if (!isTicketImageType(file.type)) {
        error = copy.errors.invalidImage;
        continue;
      }
      if (file.size === 0 || file.size > TICKET_IMAGE_MAX_BYTES) {
        error = file.size === 0 ? copy.errors.invalidImage : copy.errors.imageTooLarge;
        continue;
      }
      accepted.push({ id: nextId.current++, name: file.name, file, contentType: file.type, previewUrl: URL.createObjectURL(file) });
    }
    setPickError(error);
    if (accepted.length > 0) setImages([...images, ...accepted]);
  }

  function remove(id: number) {
    const target = images.find((image) => image.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    setImages(images.filter((image) => image.id !== id));
    setPickError(null);
  }

  function clear() {
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setImages([]);
    setPickError(null);
  }

  async function uploads(): Promise<TicketAttachmentUpload[]> {
    return Promise.all(images.map(async (image) => ({ contentType: image.contentType, dataBase64: await readBase64(image.file) })));
  }

  return { images, pickError, add, remove, clear, uploads };
}

function ImagePicker({
  picker,
  disabled,
}: {
  picker: ReturnType<typeof useImagePicker>;
  disabled: boolean;
}) {
  const copy = useT().tickets;
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const full = picker.images.length >= TICKET_IMAGES_PER_MESSAGE;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    picker.add(event.target.files);
    // 允许再次选择同一文件。
    event.target.value = "";
  }

  return (
    <div className="cc-tk-images" role="group" aria-label={copy.imagesLabel}>
      <div className="cc-tk-images-head">
        <span className="cc-tk-images-label">{copy.imagesLabel}</span>
        <span className="cc-tk-images-count">{copy.imageCount(picker.images.length, TICKET_IMAGES_PER_MESSAGE)}</span>
      </div>
      <p id={hintId} className="cc-tk-images-hint">{copy.imagesHint(TICKET_IMAGES_PER_MESSAGE)}</p>
      {picker.images.length > 0 && (
        <ul className="cc-tk-thumbs">
          {picker.images.map((image) => (
            <li key={image.id}>
              <img src={image.previewUrl} alt="" />
              <span className="cc-tk-thumb-name">{image.name}</span>
              <button
                type="button"
                className="cc-tk-thumb-remove"
                disabled={disabled}
                aria-label={copy.removeImage(image.name)}
                onClick={() => picker.remove(image.id)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        className="cc-tk-file-input"
        type="file"
        accept={TICKET_IMAGE_TYPES.join(",")}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
      />
      <button
        type="button"
        className="cc-ord-ghost cc-tk-add-images"
        disabled={disabled || full}
        aria-describedby={hintId}
        onClick={() => inputRef.current?.click()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M7 15l3.5-3.5 3 3 2-2 3 3" /><circle cx="9" cy="9.5" r="1.3" /></svg>
        {copy.addImages}
      </button>
      {picker.pickError && <p className="cc-tk-error" role="alert">{picker.pickError}</p>}
    </div>
  );
}

function MessageImages({ attachments, copy }: { attachments: readonly TicketAttachment[]; copy: TicketCopy }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="cc-tk-attachments">
      {attachments.map((attachment, index) => (
        <li key={attachment.ref}>
          <a href={attachment.url} target="_blank" rel="noopener noreferrer" aria-label={copy.openImage(index + 1)}>
            <img src={attachment.url} alt={copy.imageAlt(index + 1)} loading="lazy" />
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ---------- 草稿：发送失败或会话失效后保留文字与关联 ---------- */

type DraftFields = Record<string, string>;

/* 文字草稿存在本标签页的 sessionStorage，按登录邮箱 + 目标（新建 / 工单号）隔离，发送成功即清除；
   图片不进草稿（体积大且可能含敏感截图），恢复时提示重新添加。存储不可用时静默降级为仅内存。 */
function useTicketDraft(target: string, initial: DraftFields) {
  const { principal } = useAuth();
  const key = principal ? `nsp.ticket-draft:${principal.email}:${target}` : null;
  const [restored, setRestored] = useState<{ readonly fields: DraftFields; readonly hadImages: boolean } | null>(null);

  useEffect(() => {
    if (key === null) return;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      const record = parsed as { fields?: unknown; hadImages?: unknown };
      if (typeof record.fields !== "object" || record.fields === null) return;
      const fields: DraftFields = {};
      for (const name of Object.keys(initial)) {
        const value = (record.fields as Record<string, unknown>)[name];
        fields[name] = typeof value === "string" ? value : initial[name]!;
      }
      setRestored({ fields, hadImages: record.hadImages === true });
    } catch {
      // 存储不可用或内容损坏：不恢复。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function save(fields: DraftFields, hadImages: boolean) {
    if (key === null) return;
    try {
      const empty = Object.keys(fields).every((name) => fields[name] === initial[name]);
      if (empty) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, JSON.stringify({ fields, hadImages }));
    } catch {
      // 忽略：草稿只是便利功能。
    }
  }

  function clear() {
    setRestored(null);
    if (key === null) return;
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // 忽略。
    }
  }

  return { restored, save, clear };
}

function DraftNotice({ hadImages, onDiscard }: { hadImages: boolean; onDiscard: () => void }) {
  const copy = useT().tickets;
  return (
    <div className="cc-tk-draft" role="status">
      <span>{copy.draftRestored}{hadImages ? ` ${copy.draftImagesNotSaved}` : ""}</span>
      <button type="button" className="cc-tk-draft-discard" onClick={onDiscard}>{copy.discardDraft}</button>
    </div>
  );
}

function linkValue(link: TicketServiceLink): string {
  if (link === null) return "";
  return link.kind === "purchase" ? `p:${link.orderRef}` : `g:${link.grantId}`;
}

function parseLinkValue(value: string, listing: MyServiceListing | null): TicketServiceLink | undefined {
  if (value === "") return null;
  if (listing === null) return undefined;
  if (value.startsWith("p:")) {
    const orderRef = value.slice(2);
    return listing.services.some((service) => service.orderRef === orderRef) ? { kind: "purchase", orderRef } : undefined;
  }
  if (value.startsWith("g:")) {
    const grantId = Number(value.slice(2));
    return listing.grants.some((grant) => grant.grantId === grantId) ? { kind: "grant", grantId } : undefined;
  }
  return undefined;
}

function ticketLinkText(ticket: TicketSummary, copy: TicketCopy): string {
  if (ticket.serviceOrderRef !== null) return ticket.serviceOrderRef;
  if (ticket.serviceGrantId != null) return copy.giftRef(ticket.serviceGrantId);
  return copy.noService;
}

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
                  <span>{ticketLinkText(item, copy)}</span>
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
  const [linkChoice, setLinkChoice] = useState("");
  const [services, setServices] = useState<ServiceLoad>({ kind: "loading" });
  const [servicesReload, setServicesReload] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const picker = useImagePicker(copy);
  const draft = useTicketDraft("new", { subject: "", body: "", link: "" });

  // 恢复上次未成功提交的文字草稿（只在挂载时读取一次）。
  useEffect(() => {
    if (draft.restored === null) return;
    setSubject(draft.restored.fields.subject ?? "");
    setBody(draft.restored.fields.body ?? "");
    setLinkChoice(draft.restored.fields.link ?? "");
  }, [draft.restored]);

  useEffect(() => {
    draft.save({ subject, body, link: linkChoice }, picker.images.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, body, linkChoice, picker.images.length]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setServices({ kind: "loading" });
    void getMyServiceListing(controller.signal)
      .then((listing) => {
        if (!stopped) setServices({ kind: "ready", value: listing });
      })
      .catch((loadError: unknown) => {
        if (stopped) return;
        if (loadError instanceof PaymentApiError && loadError.code === "unauthorized") {
          setServices({ kind: "unauthorized" });
        } else {
          setServices({ kind: "error" });
        }
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [servicesReload]);

  const subjectValid = subject.trim().length > 0 && subject.trim().length <= TICKET_SUBJECT_MAX && !/[\r\n]/.test(subject);
  const bodyValid = body.trim().length > 0 && body.trim().length <= TICKET_BODY_MAX;
  const link = parseLinkValue(linkChoice, services.kind === "ready" ? services.value : null);
  const canSubmit = csrfToken !== null && subjectValid && bodyValid && link !== undefined && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || csrfToken === null || link === undefined) return;
    setSubmitting(true);
    setError(null);
    try {
      let attachments: TicketAttachmentUpload[];
      try {
        attachments = await picker.uploads();
      } catch {
        setError(copy.imageReadFailed);
        return;
      }
      const ticket = await createMyTicket(csrfToken, { subject: subject.trim(), body: body.trim(), link, attachments });
      // 先清空字段再清草稿：否则清图片触发的保存会把已发送的文字重新写回草稿。
      setSubject("");
      setBody("");
      setLinkChoice("");
      picker.clear();
      draft.clear();
      setSearchParams({ ref: ticket.ref });
    } catch (submitError) {
      // 失败时不清空：文字、关联与已选图片都留在表单里，文字另存草稿。
      if (isUnauthorized(submitError)) setSignedOut(true);
      else setError(ticketErrorMessage(submitError, copy.errors));
    } finally {
      setSubmitting(false);
    }
  }

  function discardDraft() {
    draft.clear();
    setSubject("");
    setBody("");
    setLinkChoice("");
  }

  if (signedOut || services.kind === "unauthorized") return <SignedOutNotice />;
  return (
    <section className="cc-ord-panel">
      <PanelHead title={copy.newTicket} />
      <form className="cc-tk-form" onSubmit={handleSubmit}>
        {draft.restored && <DraftNotice hadImages={draft.restored.hadImages} onDiscard={discardDraft} />}
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
        <select id={serviceId} value={linkChoice} disabled={submitting || services.kind !== "ready"} onChange={(event) => setLinkChoice(event.target.value)}>
          <option value="">{copy.noServiceOption}</option>
          {services.kind === "ready" && services.value.services.length > 0 && (
            <optgroup label={copy.purchasedGroup}>
              {services.value.services.map((service) => (
                <option key={service.orderRef} value={linkValue({ kind: "purchase", orderRef: service.orderRef })}>
                  {service.planLabel ? `${service.planLabel} · ` : ""}{service.orderRef} · {service.serviceStatus === "open" ? copy.serviceOpen : copy.servicePending}
                </option>
              ))}
            </optgroup>
          )}
          {services.kind === "ready" && services.value.grants.length > 0 && (
            <optgroup label={copy.giftGroup}>
              {services.value.grants.map((grant) => (
                <option key={grant.grantId} value={linkValue({ kind: "grant", grantId: grant.grantId })}>
                  {grant.label} · {copy.giftRef(grant.grantId)} · {grant.deliveryStatus === "open" ? copy.serviceOpen : copy.servicePending}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {services.kind === "loading" && <p className="cc-tk-service-state" role="status">{copy.serviceLoading}</p>}
        {services.kind === "error" && (
          <div className="cc-tk-service-state" role="alert">
            <span>{copy.serviceLoadFailed}</span>
            <button type="button" className="cc-ord-ghost" onClick={() => setServicesReload((n) => n + 1)}>{copy.reload}</button>
          </div>
        )}
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
        <ImagePicker picker={picker} disabled={submitting} />
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
  const picker = useImagePicker(copy);
  const draft = useTicketDraft(ticketRef, { reply: "" });

  useEffect(() => {
    if (draft.restored !== null) setReply(draft.restored.fields.reply ?? "");
  }, [draft.restored]);

  useEffect(() => {
    draft.save({ reply }, picker.images.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply, picker.images.length]);

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
      let attachments: TicketAttachmentUpload[];
      try {
        attachments = await picker.uploads();
      } catch {
        setError(copy.imageReadFailed);
        return;
      }
      const updated = await replyToMyTicket(csrfToken, ticket.ref, reply.trim(), attachments);
      setReply("");
      picker.clear();
      draft.clear();
      setState({ kind: "ready", value: updated });
    } catch (replyError) {
      // 失败时保留回复文字与已选图片；文字另存草稿，会话失效重新登录后可恢复。
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
          <small>
            {copy.createdAt(formatDate(ticket.createdAt, copy.dateLocale))}
            {ticket.serviceOrderRef ? copy.linkedService(ticket.serviceOrderRef) : ticket.serviceGrantId != null ? copy.linkedGift(ticket.serviceGrantId) : ""}
          </small>
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
            <MessageImages attachments={message.attachments} copy={copy} />
          </li>
        ))}
      </ol>
      {ticket.status === "closed" ? (
        <p className="cc-tk-closed">{copy.closedNotice}</p>
      ) : (
        <form className="cc-tk-form" onSubmit={handleReply}>
          {draft.restored && (
            <DraftNotice
              hadImages={draft.restored.hadImages}
              onDiscard={() => {
                draft.clear();
                setReply("");
              }}
            />
          )}
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
          <ImagePicker picker={picker} disabled={sending} />
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
