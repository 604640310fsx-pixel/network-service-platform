import { useEffect, useState } from "react";
import { InvitesApiError, getMyInvites, personalInviteLink, type MyInvites } from "../../lib/invites-api";
import "./customer-orders.css";
import "./customer-invites.css";

/* /invites 邀请中心（仅本人）：展示自己的个人邀请码、可复制/分享的本站注册链接、
   直接邀请人数。不展示被邀请人的任何信息，不作奖励或多级分成承诺；
   推广/佣金相关内容保留在独立的 /referrals。 */

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: MyInvites }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

function PanelHead({ tag }: { tag: string }) {
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>INVITES</em>
        <h2>我的邀请</h2>
      </div>
      <span className="cc-ord-tag">{tag}</span>
    </div>
  );
}

export function CustomerInvitesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyInvites(controller.signal)
      .then((value) => !stopped && setState({ kind: "ready", value }))
      .catch((error: unknown) => {
        if (stopped) return;
        setState(error instanceof InvitesApiError && error.code === "unauthorized" ? { kind: "unauthorized" } : { kind: "error" });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reload]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`已复制${label}。`);
    } catch {
      setCopyStatus(`复制失败，请手动选择并复制${label}。`);
    }
  }

  async function share(link: string) {
    try {
      await navigator.share({ title: "注册邀请", url: link });
    } catch {
      // The person cancelled or sharing is unavailable; the copy button still works.
    }
  }

  if (state.kind === "loading") {
    return (
      <main className="cc-ord-page">
        <div className="cc-ord-layout">
          <section className="cc-ord-panel" role="status" aria-live="polite" aria-busy="true">
            <PanelHead tag="加载中" />
            <p className="cc-ord-status-text">正在读取你的邀请码…</p>
          </section>
        </div>
      </main>
    );
  }
  if (state.kind === "unauthorized") {
    return (
      <main className="cc-ord-page">
        <div className="cc-ord-layout">
          <section className="cc-ord-panel" role="alert">
            <PanelHead tag="登录失效" />
            <div className="cc-ord-notice">
              <p className="cc-ord-notice-title">登录状态已失效，请重新登录。</p>
              <div className="cc-ord-notice-actions">
                <a className="cc-ord-primary" href="/login">重新登录</a>
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="cc-ord-page">
        <div className="cc-ord-layout">
          <section className="cc-ord-panel" role="alert">
            <PanelHead tag="读取失败" />
            <div className="cc-ord-notice">
              <p className="cc-ord-notice-title">暂时无法读取邀请信息，请稍后重试。</p>
              <div className="cc-ord-notice-actions">
                <button type="button" className="cc-ord-primary" onClick={() => setReload((n) => n + 1)}>重新加载</button>
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const { code, directInviteCount } = state.value;
  const link = personalInviteLink(window.location.origin, code);
  const canShare = typeof navigator.share === "function";
  return (
    <main className="cc-ord-page">
      <div className="cc-ord-layout">
        <section className="cc-ord-panel">
          <PanelHead tag="仅本人可见" />
          <dl className="cc-inv-facts">
            <div>
              <dt>我的个人邀请码</dt>
              <dd><code className="cc-inv-code">{code}</code></dd>
            </div>
            <div>
              <dt>注册链接</dt>
              <dd><code className="cc-inv-link">{link}</code></dd>
            </div>
            <div>
              <dt>已直接邀请</dt>
              <dd><strong>{directInviteCount}</strong> 人</dd>
            </div>
          </dl>
          <div className="cc-ord-notice-actions">
            <button type="button" className="cc-ord-primary" onClick={() => void copy(link, "注册链接")}>复制注册链接</button>
            <button type="button" className="cc-ord-ghost" onClick={() => void copy(code, "邀请码")}>复制邀请码</button>
            {canShare && <button type="button" className="cc-ord-ghost" onClick={() => void share(link)}>分享</button>}
          </div>
          {copyStatus && <p className="cc-inv-status" role="status">{copyStatus}</p>}
          <ul className="cc-inv-notes">
            <li>好友通过你的邀请码或注册链接完成注册后，你会成为其直接邀请人；每个账户只有一位直接邀请人，之后不会更改。</li>
            <li>邀请码只能用于注册新账户，不能登录你的账户，也不会让对方看到你的任何信息。</li>
            <li>这里只显示直接邀请人数，不显示被邀请人的身份信息。</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
