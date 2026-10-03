import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { EmailChangePanel, PasswordChangePanel } from "./AccountSecurityForms";
import "./profile.css";

/* /profile 的账号资料卡片只读取 GET /api/auth/me 会话契约，只展示 user.email 与
   user.role；不展示 csrfToken、内部用户编号或 Session 字段，也不在接口失败时回退 Mock。
   其下的「修改密码」「修改邮箱」只调用 /api/me/password/change 与
   /api/me/email/change/{start,confirm}。 */

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-profile-page">
      <div className="cc-profile-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  const t = useT();
  return (
    <div className="cc-profile-panel-head">
      <div>
        <em>PROFILE</em>
        <h2>{t.profile.title}</h2>
      </div>
      <span className="cc-profile-tag">{tag}</span>
    </div>
  );
}

function UnavailableProfile() {
  const copy = useT().profile;
  return (
    <PageFrame>
      <section className="cc-profile-panel" role="alert">
        <PanelHead tag={copy.signedOutTag} />
        <div className="cc-profile-notice">
          <p className="cc-profile-notice-title">{copy.signedOutTitle}</p>
          <p className="cc-profile-notice-hint">{copy.signedOutHint}</p>
          <a className="cc-profile-primary" href="/login">
            {copy.signInAgain}
          </a>
        </div>
      </section>
    </PageFrame>
  );
}

export function ProfilePage() {
  const { status, principal } = useAuth();
  const copy = useT().profile;

  if (status === "checking") {
    return (
      <PageFrame>
        <section
          className="cc-profile-panel"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <PanelHead tag={copy.loadingTag} />
          <div className="cc-profile-skeleton" aria-hidden="true">
            <span />
            <span />
          </div>
          <p className="cc-profile-status-text">{copy.loading}</p>
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
            <h2 id="cc-profile-title">{copy.title}</h2>
          </div>
        </div>

        <p className="cc-profile-intro">{copy.intro}</p>

        <dl className="cc-profile-facts">
          <div>
            <dt>{copy.email}</dt>
            <dd>{principal.email}</dd>
          </div>
          <div>
            <dt>{copy.accountType}</dt>
            <dd>{copy.roles[principal.role]}</dd>
          </div>
        </dl>
      </section>
      <PasswordChangePanel />
      <EmailChangePanel currentEmail={principal.email} />
    </PageFrame>
  );
}
