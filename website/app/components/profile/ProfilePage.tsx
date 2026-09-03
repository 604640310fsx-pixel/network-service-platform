import { useAuth, type AuthPrincipal } from "../../lib/auth";
import "./profile.css";

/* /profile 只读取既有 GET /api/auth/me 会话契约。
   页面仅展示公开响应里的 user.email 与 user.role；不展示 csrfToken、内部用户编号、
   Session 字段或任何邀请、奖励与安全设置，也不在接口失败时回退 Mock。 */

const ROLE_LABEL: Readonly<Record<AuthPrincipal["role"], string>> = {
  user: "普通用户",
  admin: "管理员",
};

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-profile-page">
      <div className="cc-profile-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  return (
    <div className="cc-profile-panel-head">
      <div>
        <em>PROFILE</em>
        <h2>账号资料</h2>
      </div>
      <span className="cc-profile-tag">{tag}</span>
    </div>
  );
}

function UnavailableProfile() {
  return (
    <PageFrame>
      <section className="cc-profile-panel" role="alert">
        <PanelHead tag="登录失效" />
        <div className="cc-profile-notice">
          <p className="cc-profile-notice-title">登录状态不可用，请重新登录。</p>
          <p className="cc-profile-notice-hint">
            重新登录后即可读取当前账户资料。
          </p>
          <a className="cc-profile-primary" href="/login">
            重新登录
          </a>
        </div>
      </section>
    </PageFrame>
  );
}

export function ProfilePage() {
  const { status, principal } = useAuth();

  if (status === "checking") {
    return (
      <PageFrame>
        <section
          className="cc-profile-panel"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <PanelHead tag="加载中" />
          <div className="cc-profile-skeleton" aria-hidden="true">
            <span />
            <span />
          </div>
          <p className="cc-profile-status-text">正在读取账户资料…</p>
        </section>
      </PageFrame>
    );
  }

  if (status !== "authenticated" || principal === null) {
    return <UnavailableProfile />;
  }

  return (
    <PageFrame>
      <section className="cc-profile-panel" aria-labelledby="cc-profile-title">
        <div className="cc-profile-panel-head">
          <div>
            <em>PROFILE</em>
            <h2 id="cc-profile-title">账号资料</h2>
          </div>
          <span className="cc-profile-tag">只读</span>
        </div>

        <p className="cc-profile-intro">
          以下信息来自当前登录账户，仅供查看。
        </p>

        <dl className="cc-profile-facts">
          <div>
            <dt>登录邮箱</dt>
            <dd>{principal.email}</dd>
          </div>
          <div>
            <dt>账户类型</dt>
            <dd>{ROLE_LABEL[principal.role]}</dd>
          </div>
        </dl>
      </section>
    </PageFrame>
  );
}
