import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { InvitesApiError, ensureMyInvites, getMyInvites, personalInviteLink, type MyInvites } from "../../lib/invites-api";
import "./customer-orders.css";
import "./customer-invites.css";

/* /invites 邀请中心（仅本人）：展示自己的个人邀请码、可复制/分享的本站注册链接、
   直接邀请人数。不展示被邀请人的任何信息，不作奖励或多级分成承诺；
   推广/佣金相关内容保留在独立的 /referrals。
   读取（GET）不写入；尚无邀请码的既有账户由本页显式调用一次受 CSRF 保护的
   生成接口（POST，幂等，不会更换已有邀请码），成功后重新读取并展示。不轮询。 */

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "provisioning" }
  | { readonly kind: "ready"; readonly value: MyInvites }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

function PanelHead({ tag }: { tag: string }) {
  const t = useT();
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>INVITES</em>
        <h2>{t.invites.title}</h2>
      </div>
      <span className="cc-ord-tag">{tag}</span>
    </div>
  );
}

export function CustomerInvitesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const { csrfToken } = useAuth();
  const copyText = useT().invites;
  // The explicit ensure write runs at most once per load attempt (reload resets it).
  const ensureAttempted = useRef(-1);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    const fail = (error: unknown) => {
      if (stopped) return;
      setState(error instanceof InvitesApiError && error.code === "unauthorized" ? { kind: "unauthorized" } : { kind: "error" });
    };
    void (async () => {
      try {
        let current = await getMyInvites(controller.signal);
        if (current.status === "uninitialized") {
          if (ensureAttempted.current === reload || csrfToken === null) throw new InvitesApiError("uninitialized");
          ensureAttempted.current = reload;
          if (!stopped) setState({ kind: "provisioning" });
          await ensureMyInvites(csrfToken, controller.signal);
          current = await getMyInvites(controller.signal);
          if (current.status !== "ready") throw new InvitesApiError("uninitialized");
        }
        if (!stopped) setState({ kind: "ready", value: current.invites });
      } catch (error) {
        fail(error);
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reload, csrfToken]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(copyText.copied(label));
    } catch {
      setCopyStatus(copyText.copyFailed(label));
    }
  }

  async function share(link: string) {
    try {
      await navigator.share({ title: copyText.shareTitle, url: link });
    } catch {
      // The person cancelled or sharing is unavailable; the copy button still works.
    }
  }

  if (state.kind === "loading" || state.kind === "provisioning") {
    return (
      <main className="cc-ord-page">
        <div className="cc-ord-layout">
          <section className="cc-ord-panel" role="status" aria-live="polite" aria-busy="true">
            <PanelHead tag={state.kind === "provisioning" ? copyText.provisioningTag : copyText.loadingTag} />
            <p className="cc-ord-status-text">{state.kind === "provisioning" ? copyText.provisioning : copyText.loading}</p>
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
            <PanelHead tag={copyText.signedOutTag} />
            <div className="cc-ord-notice">
              <p className="cc-ord-notice-title">{copyText.signedOut}</p>
              <div className="cc-ord-notice-actions">
                <a className="cc-ord-primary" href="/login">{copyText.signInAgain}</a>
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
            <PanelHead tag={copyText.loadFailedTag} />
            <div className="cc-ord-notice">
              <p className="cc-ord-notice-title">{copyText.loadFailed}</p>
              <div className="cc-ord-notice-actions">
                <button type="button" className="cc-ord-primary" onClick={() => setReload((n) => n + 1)}>{copyText.reload}</button>
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
          <PanelHead tag={copyText.privateTag} />
          <dl className="cc-inv-facts">
            <div>
              <dt>{copyText.code}</dt>
              <dd><code className="cc-inv-code">{code}</code></dd>
            </div>
            <div>
              <dt>{copyText.link}</dt>
              <dd><code className="cc-inv-link">{link}</code></dd>
            </div>
            <div>
              <dt>{copyText.invited}</dt>
              <dd><strong>{directInviteCount}</strong>{copyText.peopleSuffix}</dd>
            </div>
          </dl>
          <div className="cc-ord-notice-actions">
            <button type="button" className="cc-ord-primary" onClick={() => void copy(link, copyText.link)}>{copyText.copyLink}</button>
            <button type="button" className="cc-ord-ghost" onClick={() => void copy(code, copyText.code)}>{copyText.copyCode}</button>
            {canShare && <button type="button" className="cc-ord-ghost" onClick={() => void share(link)}>{copyText.share}</button>}
          </div>
          {copyStatus && <p className="cc-inv-status" role="status">{copyStatus}</p>}
          <ul className="cc-inv-notes">
            {copyText.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>
      </div>
    </main>
  );
}
