import { useEffect, useState, type FormEvent } from "react";
import {
  createAdminInviteCode,
  getAdminInviteCodes,
  InviteAdminApiError,
  revokeAdminInviteCode,
  type AdminInviteCodeItem,
  type AdminInviteCodeStatus,
} from "../../lib/invite-admin-api";

const statusLabels: Readonly<Record<AdminInviteCodeStatus, string>> = {
  usable: "可使用",
  expired: "已过期",
  revoked: "已撤销",
  exhausted: "已耗尽",
};

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

function errorMessage(error: unknown): string {
  if (!(error instanceof InviteAdminApiError)) {
    return "邀请码操作失败，请稍后重试。";
  }
  switch (error.code) {
    case "unauthorized":
      return "管理员登录状态已失效。";
    case "forbidden":
      return "当前账户没有邀请码管理权限。";
    case "csrf_invalid":
      return "安全校验已失效，请刷新页面后重试。";
    case "invalid_request":
      return "请检查使用次数和到期时间。";
    case "not_found":
      return "该邀请码记录不存在，请刷新列表。";
    default:
      return "邀请码服务暂时不可用，请稍后重试。";
  }
}

export function AdminInviteCodesPanel({
  csrfToken,
}: {
  readonly csrfToken: string | null;
}) {
  const [items, setItems] = useState<readonly AdminInviteCodeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setLoading(true);
    setError(null);
    void getAdminInviteCodes(controller.signal)
      .then((result) => {
        if (!stopped) {
          setItems(result.items);
          setTotal(result.total);
        }
      })
      .catch((loadError: unknown) => {
        if (
          !stopped &&
          !(loadError instanceof DOMException && loadError.name === "AbortError")
        ) {
          setItems([]);
          setTotal(0);
          setError(errorMessage(loadError));
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCopyStatus(null);
    if (csrfToken === null) {
      setError("安全校验尚未就绪，请刷新页面后重试。");
      return;
    }
    const parsedMaxUses = Number(maxUses);
    const parsedExpiry = new Date(expiresAt);
    if (
      !Number.isSafeInteger(parsedMaxUses) ||
      parsedMaxUses < 1 ||
      !Number.isFinite(parsedExpiry.getTime()) ||
      parsedExpiry.getTime() <= Date.now()
    ) {
      setError("请填写有效的使用次数和未来到期时间。");
      return;
    }
    setCreating(true);
    try {
      const created = await createAdminInviteCode(
        csrfToken,
        parsedMaxUses,
        parsedExpiry.toISOString(),
      );
      setCreatedCode(created.inviteCode);
      setItems((current) => [
        created.item,
        ...current.filter((item) => item.id !== created.item.id),
      ]);
      setTotal((current) => current + 1);
      setMaxUses("1");
      setExpiresAt("");
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inviteCodeId: number) {
    setError(null);
    if (csrfToken === null) {
      setError("安全校验尚未就绪，请刷新页面后重试。");
      return;
    }
    setRevokingId(inviteCodeId);
    try {
      const revoked = await revokeAdminInviteCode(inviteCodeId, csrfToken);
      setItems((current) =>
        current.map((item) => (item.id === revoked.id ? revoked : item)),
      );
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    } finally {
      setRevokingId(null);
    }
  }

  async function copyCreatedCode() {
    if (createdCode === null) return;
    try {
      await navigator.clipboard.writeText(createdCode);
      setCopyStatus("已复制。");
    } catch {
      setCopyStatus("复制失败，请手动选择并复制。");
    }
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-invites-title">
      <h2 id="dash-admin-invites-title">
        <em>INVITES</em>邀请码管理
        <span>{loading ? "读取中" : `最近 ${items.length} / 共 ${total} 项`}</span>
      </h2>

      <form className="dash-coupon-create" onSubmit={handleCreate}>
        <div className="dash-coupon-create-grid">
          <label>
            可使用次数
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={maxUses}
              disabled={creating}
              onChange={(event) => setMaxUses(event.target.value)}
            />
          </label>
          <label>
            到期时间
            <input
              type="datetime-local"
              value={expiresAt}
              disabled={creating}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
        </div>
        <div className="dash-coupon-create-foot">
          <button
            type="submit"
            className="dash-primary-link"
            disabled={creating}
          >
            {creating ? "正在创建…" : "创建邀请码"}
          </button>
          <small>明文只显示一次，系统不会保存或再次展示。</small>
        </div>
      </form>

      {createdCode !== null && (
        <div className="dash-invite-created" role="status">
          <strong>新邀请码（仅显示一次）</strong>
          <code>{createdCode}</code>
          <div>
            <button type="button" onClick={copyCreatedCode}>复制邀请码</button>
            <button
              type="button"
              onClick={() => {
                setCreatedCode(null);
                setCopyStatus(null);
              }}
            >
              已保存，关闭
            </button>
            {copyStatus && <small>{copyStatus}</small>}
          </div>
        </div>
      )}

      {error && <p className="dash-inline-error" role="alert">{error}</p>}
      {!loading && error === null && items.length === 0 && (
        <div className="dash-service">
          <div className="dash-service-head">
            <div>
              <strong>—</strong>
              <small>当前没有邀请码记录</small>
            </div>
          </div>
        </div>
      )}

      <div className="dash-admin-list">
        {items.map((item) => (
          <article className="dash-service" key={item.id}>
            <div className="dash-service-head">
              <div>
                <strong>邀请码 #{item.id}</strong>
                <small>创建于 {formatDate(item.createdAt)}</small>
              </div>
              <span className="dash-tag">
                {item.isBootstrap ? "初始 · " : ""}
                {statusLabels[item.status]}
              </span>
            </div>
            <dl className="dash-service-facts">
              <div>
                <dt>使用情况</dt>
                <dd>{item.usedCount} / {item.maxUses}</dd>
              </div>
              <div>
                <dt>到期时间</dt>
                <dd>{formatDate(item.expiresAt)}</dd>
              </div>
            </dl>
            {item.status !== "revoked" && (
              <div className="dash-coupon-controls">
                <button
                  type="button"
                  disabled={revokingId === item.id}
                  onClick={() => void handleRevoke(item.id)}
                >
                  {revokingId === item.id ? "正在撤销…" : "撤销邀请码"}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
